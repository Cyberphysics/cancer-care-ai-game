# 架构设计

本文档描述 CancerCare AI Game 的已部署架构，以及 Phase 3 引入 Amazon Bedrock AgentCore 的设计方案。

**阅读提示**：文中所有关于 AgentCore 的具体事实都标注了验证状态。**未经证实的部分已显式标记**——在技术写作中，说明「我尚未验证什么」比含糊其辞更有价值。

---

## 1. 目标与非目标

### 目标

- 用 Amazon Bedrock AgentCore 展示**多 Agent 协作 + 长期记忆 + 工具调用 + 状态管理**
- 让玩家在互动剧情中学习癌症预防、诊断、治疗支持与家庭照护知识
- 演示一个**有状态、有记忆、有工具、有规则约束**的智能游戏角色系统

### 非目标（硬性边界）

- ❌ 医疗诊断
- ❌ 个体治疗方案推荐
- ❌ 药物推荐
- ❌ 生存期预测

所有医学内容使用公开资料，标注来源，并引导玩家咨询专业医生。仓库中不得出现真实患者资料。

---

## 2. 系统上下文

```
   玩家（家庭健康守护者，非医生）
            │
            ▼
   模拟照护一个虚拟肺癌患者
            │
            ▼
   目标：最大化生活质量（QoL），而非治愈率
```

---

## 3. 已部署架构（Phase 0）

### 3.1 组件图

```
                        ┌──────────────────────────┐
                        │        CloudFront        │
                        │  (OAC 签名回源, HTTPS)    │
                        └────────────┬─────────────┘
                                     │
                        ┌────────────▼─────────────┐
                        │  S3 — WebBucket (私有)    │
                        │  Vite 构建产物            │
                        └──────────────────────────┘

   ┌─────────────────────────────────────────────────────────┐
   │  HTTP API v2  (8 条路由, CORS 已开)                       │
   └────────────────────────┬────────────────────────────────┘
                            │
                 ┌──────────▼───────────┐
                 │  Lambda  game-api     │        ┌──────────────────┐
                 │  Node 22 / ARM64      │───────►│ S3 GameAssets    │
                 │  零运行时依赖 / X-Ray  │        │ (Phase 2 填充)    │
                 └──────────┬───────────┘        └──────────────────┘
                            │
                 ┌──────────▼───────────┐
                 │  DynamoDB 单表        │
                 │  PK/SK + GSI1 (稀疏)  │
                 └──────────────────────┘
                            │
                 ┌──────────▼───────────┐
                 │  CloudWatch Logs      │
                 │  + X-Ray Traces       │
                 └──────────────────────┘
```

### 3.2 为什么是三个 Stack

| Stack | 内容 | 变更频率 |
|---|---|---|
| `CancercareGameMvp-Data` | DynamoDB 单表 | 极低，**绝不能被误删** |
| `CancercareGameMvp-Api` | Lambda + HTTP API | 每次后端改动 |
| `CancercareGameMvp-Frontend` | S3 + CloudFront + BucketDeployment | 每次前端改动 |

拆分的核心理由：**CloudFront 的创建与更新需要 5–15 分钟**。若三者同栈，Phase 2 期间改一行后端代码也要等 CloudFront，开发循环会被彻底摧毁。同时，分离后可以单独销毁前端栈以控制成本，而不会碰到数据表。

跨栈引用**直接传递 construct**（`{ table: dataStack.table }`），而非经 `CfnOutput` / `Fn.importValue` 往返。本项目的 `cdk.json` 已启用 `@aws-cdk/core:defaultCrossStackReferences: "weak"`，因此不会为跨栈引用生成 CloudFormation Export，也就不会出现「export 被占用导致无法改名/删除」的经典问题。

### 3.3 请求链路：提交一次玩家选择（Phase 2 已实现）

```
玩家点击选项
   │
   ├─► POST /api/v1/sessions/{sessionId}/choices
   │
   ├─► API Gateway 路由匹配 → Lambda 集成
   │
   ├─► Lambda 解包（rawPath / method）→ router.ts 分发
   │
   ├─► 读取 GameSession（校验 status、activeEventSk、version）
   ├─► 按 activeEventSk 读取活跃事件，校验 eventId 匹配
   ├─► 读取 PatientState（拿 health、version）
   │
   ├─► domain/engine.applyChoice()  ← 纯函数，无 I/O
   │        └─ clampHealth 计算新健康值 + 推导下一事件
   │
   ├─► **一次 TransactWrite 原子提交 4 项**
   │     ├─ 患者   条件 version = :expected
   │     ├─ 事件   条件 attribute_not_exists(chosenChoiceId)
   │     ├─ 下一事件 条件 attribute_not_exists(PK)
   │     └─ 会话   条件 version = :expected
   │        └─ 冲突 → TransactionCanceledException → 409，调用方重读
   │
   └─► 返回更新后的状态、impact、rationale 与下一事件
```

细节见 [GAME-RULES.md](GAME-RULES.md) §5 与 [DATA-MODEL.md](DATA-MODEL.md) §9。

Phase 3 会在「applyChoice」这一步旁路插入 AgentCore 生成内容——见第 5 节。

### 3.4 为什么前端用相对路径调用 API

CloudFront 上有一条 `/api/*` behavior 反向代理到 API Gateway。这带来四个具体收益：

1. **无需把 API 地址烘焙进前端构建产物**，因此没有「先部署 API 还是先构建前端」的顺序约束
2. **完全不涉及 CORS**——浏览器看到的是同源请求
3. 演示只需要一个 URL
4. 本地开发走 Vite 的同名代理，线上走 CloudFront，**同一份前端代码**

代价是必须正确配置 `OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER`：CloudFront 必须以 **API Gateway 的域名**作为 `Host` 头，转发 viewer 的 Host 会让 API Gateway 以 403 拒绝。这是该模式最经典的坑，已在 `frontend-stack.test.ts` 与冒烟脚本中各有一处断言。

---

## 4. 数据层

完整设计见 [DATA-MODEL.md](DATA-MODEL.md)。要点：

- **单表**，`PK`/`SK` 复合键，四个实体共用一张表
- **`sessionId` 作为会话的分区键**，使「加载游戏界面」退化为一次 Query
- **稀疏 GSI1 `PlayerSessionsIndex`**，只索引 GameSession 条目
- **乐观锁 `version`** 是「Agent 不得直接改状态」的落地机制

---

## 5. Phase 3：AgentCore（Runtime 与 Memory 已实现并部署；Gateway 未实现）

> **实现状态（2026-10-16）。**
>
> - **Runtime 与 Memory 已实现并部署**（`CancercareGameMvp-Agent` 栈）。三个角色共用同一个 Runtime，
>   按请求的 `kind` 分派：`choice` / `summary`（叙事，Stage A）、`extract` / `question`（Stage C）。
>   契约见 [AGENT-DESIGN.md](AGENT-DESIGN.md)。
> - **Gateway 未实现**（§5.4、§5.6、§5.7）。Stage C 有意选择**直连工具循环**——同样的 handler、
>   同样的工具声明，只是不经 MCP。理由见 [ROADMAP.md](ROADMAP.md)。
> - §5.1–§5.3 与 §5.5 描述的服务事实仍然准确；**§5.4 / §5.6 / §5.7 是未实现的设计**，
>   其中 §5.7 的代码示例**未经验证，不要照抄**。

### 5.1 AgentCore 是什么

Amazon Bedrock AgentCore 于 **2025-10-13 正式 GA**，`us-east-1` 在支持区域内。

**已验证**：在本项目所属账号 `016998011445` 的 `us-east-1` 中，以下 CloudFormation 资源类型
**已注册可用**（经由 `aws cloudformation describe-type` 实测确认）：

- `AWS::BedrockAgentCore::Runtime`
- `AWS::BedrockAgentCore::RuntimeEndpoint`
- `AWS::BedrockAgentCore::Memory`
- `AWS::BedrockAgentCore::Gateway`

**已验证**：CDK 的 AgentCore 模块已从 alpha 转为正式模块
`aws-cdk-lib/aws-bedrockagentcore`（需 `aws-cdk-lib` ≥ 2.255.0）。
本项目钉在 `2.273.0`，该模块已确认存在于 `node_modules/aws-cdk-lib/aws-bedrockagentcore/`。

### 5.2 Runtime —— GameMaster Agent 的执行环境

| 项 | 事实 |
|---|---|
| 架构 | **仅 ARM64**（这是硬约束，不是建议） |
| 部署方式 A | 容器镜像（ECR） |
| 部署方式 B | **zip → S3 直接代码部署**（`AgentRuntimeArtifact.fromCodeAsset()` / `fromS3()`） |
| HTTP 端口 | `8080`，`POST /invocations` + `GET /ping` |
| MCP 端口 | `8000` |
| A2A 端口 | `9000` |
| 会话空闲超时 | 默认 900 秒 |
| 会话最长生命周期 | 28800 秒（8 小时） |
| 网络模式 | `PUBLIC` 或 `VPC` |

**本项目推荐 zip → S3 路径**（方式 B）。理由：无需 Docker、无需 ECR 仓库、部署更快，
对本项目的代码规模完全够用。容器路径保留为逃生通道。

Python handler 契约：

```python
from bedrock_agentcore.runtime import BedrockAgentCoreApp

app = BedrockAgentCoreApp()

@app.entrypoint
def invoke(payload, context):
    return {"result": ...}

if __name__ == "__main__":
    app.run()   # 监听 0.0.0.0:8080
```

> 与 Lambda 架构一致性的考量：本项目 Lambda 已选 ARM64，正是为了在 Phase 3 引入
> AgentCore Runtime（仅 ARM64）时不出现架构混用带来的意外。

### 5.3 Memory —— 长期记忆（**不是数据库**）

**资源模型**：

- 一个 Memory 资源 = 一个有名字的容器
- **短期记忆 = 事件（events）**，以 `actorId`（用户/Agent/系统）与 `sessionId` 划分
- **长期记忆 = 记忆记录**，由 LLM **异步**从事件中抽取，组织进 namespace

**内建策略**：`SEMANTIC`（事实与语义检索）、`SUMMARIZATION`（按 actor/session 摘要）、
`USER_PREFERENCE`（用户偏好）、`EPISODIC`、`CUSTOM`。

**数据面操作**（已核实的命名，注意不是想当然的 `retrieve_memories`）：
`create_event`、`list_events`、`list_actors`、`list_sessions`、
`retrieve_memory_records`（语义检索，`topK` 默认 10）、`get_memory_record`、
`list_memory_records`、`batch_create/update/delete_memory_records`、`start_memory_extraction_job`。

**⚠️ 架构边界（必须大声说明）**：

> **Memory 不是唯一数据库，也不是事实来源。DynamoDB 才是。**
>
> - **DynamoDB** 保存权威游戏状态：患者属性、事件历史、会话进度、分数
> - **Memory** 只保存**软性长期信号**：玩家偏好（喜欢详细解释 / 偏好高难度 / 关注营养管理）等

这条边界是刻意的。若让 Memory 承载游戏状态，会失去事务性、乐观锁与可审计性，
而这三者正是本项目的安全底线。

### 5.4 Gateway —— 工具调用面（MCP）

Gateway 暴露游戏工具，协议**始终是 MCP**。

**目标类型**：`lambda`、`openApiSchema`、`smithyModel`、`apiGateway`、`mcpServer`。

**Lambda 目标**必须提供 `toolSchema`，每个工具需含 `name`（必填）、`description`（必填）、
`inputSchema`（必填，JSON Schema）、`outputSchema`（可选）。

**⚠️ 工具命名约定**：Gateway 会为工具名加上目标名前缀，形如
`<targetName>__<toolName>`（例如 `game-tools__get_patient_state`）。
Lambda handler 需要剥离该前缀；对 OpenAPI/Smithy 目标则由 Gateway 自动处理。

**入站鉴权**：`CUSTOM_JWT`（Cognito / Entra ID / Okta）或 `AWS_IAM`（SigV4）。

> **本项目推荐 `CUSTOM_JWT`**。这是一个有意的回避：我**未能证实** SigV4 签名调用
> Gateway 的 MCP 端点所使用的具体 IAM action 名称（两个 CLI 面上都不存在
> `invoke-gateway` 之类的操作）。围绕一个无法确认的权限名做设计是危险的，
> 而 JWT 路径是成熟且有充分文档的。
>
> —— 遗留待确认项，见 §5.8。

### 5.5 三个 Agent

| Agent | 职责 | 工具 | 写权限 |
|---|---|---|---|
| **GameMaster** | 游戏导演：创建事件、推进剧情、评估玩家行为影响、生成下一步任务 | `get_patient_state`、`update_patient_state`、`generate_event` | **仅通过受校验的工具** |
| **Medical Education** | 医学知识解释：什么是肺癌筛查？为什么需要病理？什么是靶向治疗？ | `query_medical_knowledge` | **只读** |
| **Care Assistant** | 家庭照护助手：日常任务、情绪支持、康复建议 | `create_task`、`get_tasks` | 仅任务类 |

各工具的完整输入输出契约见 [AGENT-DESIGN.md](AGENT-DESIGN.md)。

### 5.6 ⚠️ 校验边界：核心安全不变量

> **Agent 绝不直接修改关键状态。Agent 的执行角色不持有任何 DynamoDB 权限。**

```
   GameMaster Agent
        │
        │  1. 调用工具（提议变更，而非执行变更）
        ▼
   AgentCore Gateway (MCP)
        │
        ▼
   后端校验 Lambda          ◄── 唯一持有 DynamoDB 权限的一方
        │
        ├─ 边界校验：stress / nutrition / qualityOfLife 强制落在 0–100
        ├─ 阶段合法性：拒绝非法的阶段跳跃
        ├─ 安全过滤：拒绝任何暗示诊断 / 治疗建议 / 药物名 / 生存预测的文本
        │
        ▼
   DynamoDB (UpdateItem + ConditionExpression: version = :expected)
        │
        └─ 冲突 → ConditionalCheckFailedException → 409 → Agent 重读后重试
```

**为什么这条不变量重要**：如果给 Gateway 的 Lambda 目标一个宽泛的 DynamoDB 权限，
Phase 3 的开发过程中极易无意间绕过校验——这是本项目最大的架构风险。
因此明确规定：**工具 Lambda 用窄权限角色 + 后端校验；AgentCore 执行角色零 DynamoDB 权限。**

### 5.7 CDK 资源映射

> **以 `infra/cdk/lib/agent-stack.ts` 为准**——那是唯一已部署、已验证的来源。下面只作说明用途，
> 且 Gateway 部分**未实现**。

```ts
import * as agentcore from 'aws-cdk-lib/aws-bedrockagentcore';

// 这一段是真实写法（与 agent-stack.ts 一致）。注意不是
// `ManagedMemoryStrategy.userPreference()`：构造器是 `MemoryStrategy.using*`，
// 且必须传 strategyName 与自定义 namespaces——内建的
// `/strategies/{memoryStrategyId}/actors/{actorId}` 布局里，{memoryStrategyId}
// 只有服务端在写入时才知道，读者无法重构该路径。
const memory = new agentcore.Memory(this, 'GameMemory', {
  memoryName: agentCoreName('player_memory'),
  memoryStrategies: [
    agentcore.MemoryStrategy.usingUserPreference({
      strategyName: 'player_preferences',
      namespaces: ['/players/{actorId}'],
    }),
    agentcore.MemoryStrategy.usingSemantic({
      strategyName: 'player_facts',
      namespaces: ['/players/{actorId}'],
    }),
  ],
});

const gateway = new agentcore.Gateway(this, 'GameToolGateway', {
  gatewayName: 'game-tools',
  // 入站鉴权：CUSTOM_JWT（推荐）
});

const runtime = new agentcore.Runtime(this, 'GameMasterRuntime', {
  runtimeName: 'game-master',
  agentRuntimeArtifact: agentcore.AgentRuntimeArtifact.fromCodeAsset({
    path: 'agents/game-master',
    runtime: agentcore.AgentCoreRuntime.PYTHON_3_13,
    entrypoint: ['main.py'],
  }),
  // 注意：executionRole 不授予任何 DynamoDB 权限
});

runtime.addEndpoint('live');
```

> ⚠️ 上述代码是**设计示意**，尚未验证可编译。`AgentRuntimeArtifact` 的工厂方法签名
> （`fromCodeAsset` / `fromS3` / `fromImageUri` / `fromEcrRepository` / `fromAsset`）来自
> 对 `runtime-artifact.d.ts` 的读取，属可靠来源；但 `Memory` 与 `Gateway` 的构造签名
> 尚未逐一核对。**Phase 3 动手前应先读一遍 `node_modules/aws-cdk-lib/aws-bedrockagentcore/` 的
> `.d.ts`**，不要照抄本节代码。

### 5.8 已验证 vs 待确认

| 事项 | 状态 |
|---|---|
| AgentCore GA 于 2025-10-13；us-east-1 支持 | ✅ 已确认 |
| 四个 `AWS::BedrockAgentCore::*` 资源类型在本账号 us-east-1 已注册 | ✅ **实测确认** |
| CDK 模块 `aws-cdk-lib/aws-bedrockagentcore` 存在于 2.273.0 | ✅ **实测确认** |
| Runtime 仅 ARM64；容器与 zip 两种部署路径 | ✅ 已确认 |
| Handler 契约（8080 / `/invocations` / `/ping`） | ✅ 已确认 |
| Memory 的 actorId/sessionId 模型与长期策略 | ✅ 已确认 |
| `aws-cdk` CLI 2.1145.0 与 `aws-cdk-lib` 2.273.0 可协同 | ✅ **本项目实测**（synth 通过） |
| `policy/*` 构造在稳定模块中可用，无需 alpha 包 | ✅ **实测确认** |
| SigV4 调用 Gateway MCP 的 IAM action 名 | ✅ **实测确认**：`bedrock-agentcore:InvokeGateway`（CDK 的 `GATEWAY_INVOKE_PERMS`） |
| `GatewayAuthorizer.usingAwsIam()` 存在 | ✅ **实测确认**：稳定模块里有，不必再回避到 Cognito |
| 命名空间模板支持 `{sessionId}` 而不只是 `{actorId}` | ✅ **实测确认**（SDK `memory/session.py`） |
| `list_events` 的 metadata 过滤**不需要**预先声明 `indexedKeys` | ✅ **实测确认**（`scripts/memory-event-probe.py` 4/4） |
| DeepSeek 兑现具名 `tool_choice` | ✅ **实测确认**（`finish_reason=tool_calls`） |
| **`parallel_tool_calls: false` 被 DeepSeek 接受后忽略** | ✅ **实测确认**——一轮多调用是常态 |
| `extraction_mode="SKIP"` 是否真被服务端兑现 | ✅ **实测确认**（对照法，`scripts/memory-skip-probe.py`） |
| 长期记忆抽取的延迟量级 | ✅ **实测约 90 秒**（异步）。这也是知识笔记走强一致 `list_events` 而非长期记录的原因 |
| Gateway 工具名的**前缀分隔符**（`__` vs `___`） | ⚠️ **文档互相矛盾**，只能在运行时确认 |
| Gateway 的**响应信封形状** | ⚠️ **未证实** |
| Claude 模型推理配置文件 ID 的**确切字符串** | ⚠️ **未证实**。见 §6 |
| `InvokeAgentRuntime` 的**资源 ARN 格式** | ⚠️ **未证实**。故 IAM 策略暂用 `*` |

---

## 6. Phase 3 的模型选择

> 本节全部结论来自**对本账号的实测**与官方资料核实，不是推测。测试日期 2026-10-15。

### 6.1 先回答三个常见误解

| 问题 | 结论 |
|---|---|
| Bedrock 能中转我自己的 DeepSeek API key 吗？ | **不能。** Bedrock 是模型托管服务，只运行 AWS 侧托管的模型，认证模型是 SigV4/IAM。不存在「自带外部 API key」这种模式。 |
| DeepSeek 在 Bedrock 上吗？ | **在**，而且是全托管 serverless（不是需要预置 GPU 端点的 Marketplace 版本）。见 6.2。 |
| AgentCore Runtime 只能用 Bedrock 模型吗？ | **不是。** AWS 明确声明 AgentCore 是模型无关的，可用 Bedrock 生态之外的模型。见 6.4。 |

### 6.2 Bedrock 上的可用模型（us-east-1 实测）

```
DeepSeek   deepseek.v3.2        ON_DEMAND        ACTIVE   ← 可直接 InvokeModel，无需推理配置文件
DeepSeek   deepseek.r1-v1:0     需 us. 前缀的推理配置文件
Anthropic  anthropic.claude-*   全部为 INFERENCE_PROFILE 类型（必须走跨区域配置文件）
```

值得注意的是 `deepseek.v3.2` 是 **`ON_DEMAND`** 类型——比 Claude 那条路简单，不需要
跨区域推理配置文件，也就没有「配置文件 ARN + 各路由区域基础模型 ARN 双重授权」的陷阱。

### 6.3 ⚠️ 本账号当前被 allowlisting 阻断（Phase 3 的头号阻塞项）

实测调用 `deepseek.v3.2` 返回：

```
To access Amazon Bedrock, you must provide further information so we can verify
you are a corporate customer and that we can grant you access given applicable
law and internal policy. Please submit a request here:
  https://support.console.aws.amazon.com/support/home#/case/create?...bedrock-allowlisting
```

**这是账号级的门槛，不是 IAM 问题。** 实测中 `bedrock:ListFoundationModels` 与
`bedrock:InvokeModel` 在 IAM 模拟中均为 `allowed`，但真实调用依然被拒。

这恰好印证了一直以来的判断：**模型访问是账号级授权，IAM 无法替代。**

> **行动项：Phase 3 动工前先提 bedrock-allowlisting 工单。** 这是唯一无法靠写代码绕过的阻塞项。

### 6.4 AgentCore Runtime 是模型无关的

AgentCore Runtime 只是运行你的 ARM64 容器/zip，不介入模型选择。因此：

- **PUBLIC 网络模式（默认）**：运行时可直接出网访问 `api.deepseek.com` 等外部端点
- **VPC 模式**：需私有子网 + NAT 网关才有出网能力（公有子网不行，这是常见误解）

### 6.5 存第三方 API key 的正确姿势

若选择直连 DeepSeek 官方 API，**不要用环境变量存 key**。AgentCore Identity 有专门为此设计的
**API key credential provider**：KMS 加密存储、按 workload identity 授权、CloudTrail 可审计，
且支持引用你已有的 Secrets Manager 密钥。

```bash
aws bedrock-agentcore-control create-api-key-credential-provider \
  --name deepseek-apikey --api-key "$DEEPSEEK_API_KEY" --region us-east-1
```

（注意该服务属于 `bedrock-agentcore:*`，本账号目前同样无权访问——见 [IAM-PERMISSIONS.md](IAM-PERMISSIONS.md) §B。）

### 6.6 设计决定：可插拔的模型 provider

三种路径各有取舍：

| 路径 | 优点 | 缺点 |
|---|---|---|
| **A. Bedrock 上的 `deepseek.v3.2`** | AWS 原生、IAM 鉴权、无需管理 key、数据不出 AWS 边界 | **当前被 allowlisting 阻断**；需等工单 |
| **B. 直连 DeepSeek 官方 API** | 立刻可用；DeepSeek 官方定价更低 | 需要管理 key；提示词离开 AWS 边界（本项目仅合成病例，无合规问题，但失去了「数据未出 AWS」的叙事） |
| **C. Bedrock 上的 Claude** | 能力最强 | 同样被 allowlisting 阻断，且必须走跨区域推理配置文件 |

**因此 Phase 3 把模型调用抽象为 provider 接口，两种实现并存**，由配置选择：

```ts
interface ModelProvider {
  complete(prompt: ModelPrompt): Promise<ModelCompletion>;
}
// BedrockProvider      — IAM 鉴权，走 deepseek.v3.2 或 us.anthropic.*
// ExternalApiProvider  — key 来自 AgentCore Identity credential provider
```

这样**不必在 allowlisting 工单通过前做不可逆的选择**，也不会因为选了其中一条而把另一条路堵死。
对本文档的读者而言，这也展示了一个更普遍的工程判断：**把一个受外部审批阻塞的依赖隔离在接口之后。**

### 6.7 ⚠️ 仍待证实的部分

- Phase 3 硬编码模型 ID 前，仍应现场核实（虽然本轮已实测 `deepseek.v3.2` 存在）：
  ```bash
  aws bedrock list-foundation-models --region us-east-1 --profile cancercare-game-mvp
  ```
- `InvokeAgentRuntime` 的资源 ARN 格式尚未证实，故 [IAM-PERMISSIONS.md](IAM-PERMISSIONS.md) §B 中该动作仍用 `Resource: "*"`
- AgentCore Identity 相关 API 本账号无权调用，未能实测

---

## 7. 可观测性

**Phase 0 已启用**：

- Lambda 的 X-Ray 主动追踪（`Tracing.ACTIVE`）
- CloudWatch Logs，日志组统一名为 `/aws/lambda/cancercare-game-mvp-api`，dev 保留 7 天

**Phase 3 计划**：AgentCore 自带 Runtime / Memory / Gateway 的 CloudWatch 指标。
更深入的追踪需要在 agent 代码中接入 ADOT/OpenTelemetry。

> 前置条件：需**一次性**启用 CloudWatch Transaction Search（控制台或
> `PutResourcePolicy` + `UpdateTraceSegmentDestination`），否则 span 不会落盘。

---

## 8. 环境与成本

- **环境**：账号 `016998011445` / `us-east-1` / stage `dev`
- **所有资源打统一标签**：`Project=CancerCareAIGame`、`Stage`、`ManagedBy=CDK`、`Repository`
  —— 同账号下还有其他无关项目，标签是成本归属与资源盘点的依据
- **成本**：Demo 规模下空闲时接近零。DynamoDB 按需 + Lambda 按调用 + CloudFront 固定费用
- **清理**：`npm run destroy`（仅作用于本 CDK app 的栈）
