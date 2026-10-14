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

### 3.3 请求链路：提交一次玩家选择

Phase 2 实现后的目标链路（当前返回 501）：

```
玩家点击选项
   │
   ├─► POST /api/v1/sessions/{sessionId}/choices
   │
   ├─► API Gateway 路由匹配 → Lambda 集成
   │
   ├─► Lambda 解包（rawPath / method）→ router.ts 分发
   │
   ├─► 读取当前 PatientState + version
   │
   ├─► 计算 impact，做 0–100 边界校验
   │
   ├─► UpdateItem + ConditionExpression(version = :expected)
   │        └─ 冲突 → 409，调用方重读
   │
   ├─► PutItem 写入 EventHistory（SK = EVENT#<iso8601>#<eventId>）
   │
   └─► 返回更新后的状态与下一事件
```

Phase 3 会在「计算 impact」这一步插入 AgentCore——见第 5 节。

---

## 4. 数据层

完整设计见 [DATA-MODEL.md](DATA-MODEL.md)。要点：

- **单表**，`PK`/`SK` 复合键，四个实体共用一张表
- **`sessionId` 作为会话的分区键**，使「加载游戏界面」退化为一次 Query
- **稀疏 GSI1 `PlayerSessionsIndex`**，只索引 GameSession 条目
- **乐观锁 `version`** 是「Agent 不得直接改状态」的落地机制

---

## 5. Phase 3：AgentCore 设计（尚未编写 CDK）

> 本节是设计文档。**本轮未创建任何 AgentCore 资源**——`cdk synth` 产物中不含任何
> `AWS::BedrockAgentCore::*` 资源，这一点由测试与构建流程校验。

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

### 5.7 CDK 资源映射（Phase 3 使用）

```ts
import * as agentcore from 'aws-cdk-lib/aws-bedrockagentcore';

const memory = new agentcore.Memory(this, 'GameMemory', {
  memoryName: 'cancercare-player-preferences',
  memoryStrategies: [
    agentcore.ManagedMemoryStrategy.userPreference(),
    agentcore.ManagedMemoryStrategy.semantic(),
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
| Gateway 为 MCP；Lambda 目标需 toolSchema；`<target>__<tool>` 前缀 | ✅ 已确认 |
| `aws-cdk` CLI 2.1145.0 与 `aws-cdk-lib` 2.273.0 可协同 | ✅ **本项目实测**（synth 通过） |
| Claude 模型推理配置文件 ID 的**确切字符串** | ⚠️ **未证实**。见 §6 |
| `InvokeAgentRuntime` 的**资源 ARN 格式** | ⚠️ **未证实**。故 IAM 策略暂用 `*` |
| SigV4 调用 Gateway MCP 的 IAM action 名 | ⚠️ **未证实**。故推荐 CUSTOM_JWT |
| `policy/*` 构造的稳定性（正式模块 vs alpha 包） | ⚠️ **有冲突**，Phase 3 前需核对 |

---

## 6. ⚠️ Bedrock 模型访问（Phase 3 阻塞项）

**关键认知：Anthropic 模型在 Bedrock 上的访问权不是 IAM 权限。**

它是**账号级 + 区域级**的授权，通过 Bedrock 控制台的 Model access 用例申报表单开通，
**任何 IAM 策略都无法替代**，且审批需要时间。

> **因此：应在 Phase 3 开始前数周就提交 Anthropic 用例申报表单。**
>
> 典型症状：`bedrock:ListFoundationModels` 因 IAM 允许而成功，但 `InvokeModel` 返回
> `AccessDeniedException: model access not granted`——这正是申报表单未提交的表现。

此外，当前 Claude 模型在 Bedrock 上普遍要求**跨区域推理（cross-region inference）**，
模型 ID 形如 `us.anthropic.claude-<name>-<version>`，`us.` 前缀锁定美国区域。

> ⚠️ **这些 ID 字符串来自搜索摘要而非官方页面直读，本项目中未经验证。**
> Phase 3 硬编码之前，必须先执行：
>
> ```bash
> aws bedrock list-foundation-models --region us-east-1 --profile cancercare-game-mvp
> aws bedrock list-inference-profiles --region us-east-1 --profile cancercare-game-mvp
> ```
>
> 另一个常见陷阱：跨区域推理配置文件调用 `InvokeModel` 需要在**推理配置文件 ARN**
> 与**其路由到的每个区域的底层基础模型 ARN** 上都获得授权。这是「IAM 策略看起来完全
> 正确却仍然 AccessDenied」的最常见原因。

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
