# Agent 设计

本文档定义三个 Agent 的职责、工具契约与约束。对应 GDD §7–§9。

> **实现状态（2026-10-16）：部分实现。**
>
> | Agent | 状态 |
> |---|---|
> | **GameMaster** | 已实现。Stage A 只有叙事（`choice` / `summary`）；Stage C 增加了知识抽取角色（`extract`），把剧情中的术语归纳成笔记 |
> | **Medical Education** | 已实现，**只读**。固定两段式工具循环：强制调 `query_medical_knowledge`，再强制禁用工具产出带引用的答案 |
> | **Care Assistant** | **未实现**。§4 与 §5 中它的部分仍是设计 |
>
> 与实现有出入处，以 `docs/ROADMAP.md` 与代码为准。本文保留原始设计意图，包括**尚未实现**的
> Gateway 工具面（见 §6）——Stage C 选择直连工具循环，理由见 ROADMAP。

---

## 1. 总体架构

```
                      玩家
                        │
                        ▼
                   游戏前端
                        │
                        ▼
                  API Gateway
                        │
                        ▼
              AgentCore Runtime
                        │
        ┌───────────────┼───────────────┐
        ▼               ▼               ▼
   GameMaster    Medical Education   Care Assistant
   游戏导演          医学教育           照护助手
        │               │               │
        └───────────────┼───────────────┘
                        ▼
              AgentCore Gateway (MCP)
                        │
                        ▼
                 后端校验 Lambda      ◄── 唯一持有 DynamoDB 权限
                        │
                        ▼
                   DynamoDB
                        │
              AgentCore Memory（长期偏好，非数据库）
```

---

## 2. Agent 1：GameMaster（游戏导演）

**职责**：创建事件、推进剧情、判断玩家行为影响、生成下一步任务。

**输入**：当前 `PatientState`、最近事件、玩家的选择
**输出**：事件影响评估、下一事件、任务列表

| 工具 | 输入 | 输出 | 幂等 |
|---|---|---|---|
| `get_patient_state` | `{ sessionId }` | `PatientState` | ✅ 是 |
| `update_patient_state` | `{ sessionId, expectedVersion, delta: { qualityOfLife?, energy?, stress?, nutrition? } }` | `{ newVersion, health }` 或 `409 冲突` | ❌ 否（乐观锁保护） |
| `generate_event` | `{ sessionId, stage, context }` | `Event` | ❌ 否 |

**约束**：

- `update_patient_state` **必须**携带 `expectedVersion`，由后端执行带条件的写入
- 后端强制所有健康维度落在 0–100；越界即拒绝，而非截断
- Agent **不持有 DynamoDB 凭证**，只能通过工具间接变更状态

---

## 3. Agent 2：Medical Education（医学教育）

**职责**：解释医学概念。回答「什么是肺癌筛查？」「为什么需要病理？」「什么是靶向治疗？」这类问题。

| 工具 | 输入 | 输出 | 幂等 |
|---|---|---|---|
| `query_medical_knowledge` | `{ question }` | `{ passages[], sources[] }` | ✅ 是 |

**实现说明（Stage C）**：`stage` **不在模型的工具 schema 里**。实测（2026-10-16）给模型一个自由文本的
`stage` 字段，它会填进「用户提问概念解释」这类散文——所以阶段改由后端从会话注入。这条同样适用于
§5 里所有带 `stage?` 的工具。

检索面是两层：**打包进 agent zip 的静态语料**（14 条，每条带出处）与**本会话剧情中沉淀的知识笔记**
（由 GameMaster 的 `extract` 角色产出）。每段都带 `label`（`S1`、`S2`…），模型只被允许引用这些 label；
后端再校验被引 label 确实存在，**编造的引用直接丢弃**——幻觉引用是归因失败，不是显示问题。

会话笔记的出处如实写成「本会话剧情中的知识笔记（由游戏导演归纳）」，**不伪装成临床指南**。

**限制（硬性）**：

- ❌ 不能诊断
- ❌ 不能推荐治疗方案
- ❌ 不能推荐药物
- ❌ 不能预测生存期
- ✅ 必须标注资料来源
- ✅ 必须引导用户咨询专业医生

**设计说明**：这是唯一一个**只读** Agent。它没有任何写工具，因此在架构层面就不可能
影响游戏状态——这比依赖提示词约束更可靠。

---

## 4. Agent 3：Care Assistant（照护助手）

**职责**：生成日常任务、提供情绪支持、给出康复建议。

| 工具 | 输入 | 输出 | 幂等 |
|---|---|---|---|
| `create_task` | `{ sessionId, title, dueAt?, category }` | `{ taskId }` | ❌ 否（需幂等键，见下） |
| `get_tasks` | `{ sessionId, status? }` | `Task[]` | ✅ 是 |

**约束**：

- `create_task` 应接受 `clientToken` 以实现幂等，避免 Agent 重试导致任务重复
- 任务内容不得包含药物名称或剂量

---

## 5. 工具契约总表

> **Stage C 只实现了只读的那一半。** 「状态」一列标注了实际情况。未实现的那些连同 §6 的 Gateway
> 工具面一起，都还是设计——Stage C 有意选择直连工具循环，理由见 `docs/ROADMAP.md`。
> 特别是 `update_patient_state` 这条**写**路径：`applyValidatedDelta()` 至今仍然零调用方。

| 工具 | 所属 Agent | 后端 Lambda | IAM 需要 | 写 DynamoDB | 状态 |
|---|---|---|---|---|---|
| `query_medical_knowledge` | Medical Education | 进程内（无回程调用） | 无 | 否 | ✅ 已实现 |
| `save_knowledge_notes` | GameMaster | 进程内（写 AgentCore Memory） | `bedrock-agentcore:CreateEvent` / `ListEvents` | 否 | ✅ 已实现 |
| `get_patient_state` | GameMaster | `game-tools` | `dynamodb:GetItem` | 否 | 未实现 |
| `update_patient_state` | GameMaster | `game-tools` | `dynamodb:UpdateItem` | ✅ 经校验 | 未实现 |
| `generate_event` | GameMaster | `game-tools` | `dynamodb:PutItem` | ✅ | 未实现 |
| `create_task` | Care Assistant | `game-tools` | `dynamodb:PutItem` | ✅ | 未实现 |
| `get_tasks` | Care Assistant | `game-tools` | `dynamodb:Query` | 否 | 未实现 |

> **AgentCore 执行角色不在这张表中**——它不需要任何 DynamoDB 权限，因为它只能调用工具，
> 不能直接访问数据。这是 §7 安全边界的直接体现。

---

## 6. Gateway 工具暴露

> **未实现——Stage C 有意跳过。** 本节是设计。Stage C 走的是**直连工具循环**：同样的 handler、
> 同样的工具声明，只是不经 Gateway。`agents/game-master/app/tools.py` 里的 `ToolSpec` 就是接入点——
> 暴露成 MCP 是**重新声明同一组工具**，不是重写 handler。
>
> 日后再做时，以下已在稳定模块 `aws-cdk-lib/aws-bedrockagentcore` 中实测确认：
> `GatewayAuthorizer.usingAwsIam()`（不必再回避到 Cognito）、
> `addLambdaTarget(id, { lambdaFunction, toolSchema })`、
> `GATEWAY_INVOKE_PERMS = ['bedrock-agentcore:InvokeGateway']`。
> 剩余未知量只有运行时的**工具名前缀分隔符**与**响应信封形状**。

Gateway 协议**始终是 MCP**。本项目使用 **Lambda 目标**，每个工具需提供 `toolSchema`
（含 `name`、`description`、`inputSchema`，可选 `outputSchema`）。

**⚠️ 工具名前缀**：Gateway 会在工具名前加上目标名，形如
`game-tools__get_patient_state`。Lambda handler 必须剥离该前缀。

**入站鉴权**：推荐 `CUSTOM_JWT`（Cognito）。

> 选择 JWT 而非 `AWS_IAM`（SigV4）是有意的：SigV4 调用 Gateway MCP 端点所需的
> 具体 IAM action 名称**尚未证实**（两个 CLI 面上都不存在 `invoke-gateway` 类操作）。
> 不围绕无法验证的权限名做设计。

---

## 7. ⚠️ 安全边界（最重要的一节）

### 7.1 状态变更的唯一合法路径

```
Agent 提议变更
   → Gateway 工具调用
   → 后端 Lambda（校验：边界 / 阶段合法性 / 内容安全）
   → DynamoDB（乐观锁 version 条件写入）
```

**禁止**：给 Agent 的执行角色授予 DynamoDB 权限。一旦授予，Phase 3 的开发过程中
极容易无意间绕过校验逻辑，而这条路径一旦被绕过，乐观锁、边界校验与安全过滤同时失效。

### 7.2 内容安全过滤

后端在写入前必须拒绝任何包含以下意图的文本：

| 拒绝类型 | 示例 |
|---|---|
| 诊断 | 「您患的是早期肺腺癌」 |
| 治疗建议 | 「建议优先选择靶向治疗」 |
| 药物推荐 | 「服用 XX 药，每日 YY 毫克」 |
| 生存预测 | 「五年生存率约为 ZZ%」 |

拒绝时应返回明确的错误码，让 Agent 有机会重新生成合规内容——而不是静默截断。

### 7.3 数据约束

- **仅使用合成病例**，仓库与数据库中不得出现真实患者资料
- Memory 中只存玩家**偏好**，不存任何可识别信息

---

## 8. 记忆策略

| 用途 | 存储 | 一致性 |
|---|---|---|
| 游戏状态（患者属性、事件历史、进度、分数） | **DynamoDB**（唯一权威） | 强 |
| 玩家长期偏好（喜欢详细解释 / 偏好高难度 / 关注营养管理） | **AgentCore Memory** 长期记录（`actorId = playerId`） | 异步抽取，最终一致 |
| **本会话剧情知识笔记**（Stage C） | **AgentCore Memory 短期事件**，打 `noteKind=knowledge` 标签 | 强（`list_events`，不依赖抽取） |

内建策略选择：`USER_PREFERENCE`（偏好）+ `SEMANTIC`（跨会话事实）。

**知识笔记为什么走短期事件而不是长期记录。** 长期记录由服务端**异步**从事件抽取，读不到刚写进去的笔记；
而「玩家推进一个阶段后立刻提问」是常规操作，不是边缘情况。所以读用 `list_events` 按 metadata 过滤——
它强一致，且**不需要**预先声明 `indexedKeys`（`scripts/memory-event-probe.py` 实测 4/4 通过）。
代价是笔记**仅限本会话**、不跨会话，也随短期记忆过期。

写入时带 `extraction_mode="SKIP"`，且**没有**为知识新增第三个策略：策略会从*每一个*事件抽取，加一个
知识命名空间的策略会让现有叙事事件也被抽进去，而知识事件反过来污染 `/players/{actorId}`——
`recall_preferences` 会开始把医学术语当成玩家偏好返回，**而失败是静默的**。

**SKIP 已实测确认生效**（`scripts/memory-skip-probe.py`，对照法）：一条不带 SKIP 的事件所带的标记约
90 秒后出现在长期记忆里，另一条带 SKIP 的标记始终没有出现。对照组排除了「抽取还没跑」这种解释。
判据不能用「长期记录里有没有笔记术语」——总结与笔记讲同一段剧情，用词本就重叠。

> Memory 是**最终一致的异步抽取**，因此绝不能用它驱动游戏逻辑判定——用它做个性化
> 文案与难度调节是合适的，用它判断「玩家当前处于哪个阶段」则是错的。
> （短期事件那条路是例外：它强一致。但它**仍然不是游戏事实来源**，只是本会话的素材。）
