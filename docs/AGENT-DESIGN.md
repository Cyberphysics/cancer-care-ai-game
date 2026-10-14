# Agent 设计

本文档定义三个 Agent 的职责、工具契约与约束。对应 GDD §7–§9。

> **实现状态：未实现。** 本文是 Phase 3 的设计输入。当前仓库中不含任何 Agent 代码。

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
| `query_medical_knowledge` | `{ question, stage? }` | `{ answer, sources[] }` | ✅ 是 |

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

| 工具 | 所属 Agent | 后端 Lambda | IAM 需要 | 写 DynamoDB |
|---|---|---|---|---|
| `get_patient_state` | GameMaster | `game-tools` | `dynamodb:GetItem` | 否 |
| `update_patient_state` | GameMaster | `game-tools` | `dynamodb:UpdateItem` | ✅ 经校验 |
| `generate_event` | GameMaster | `game-tools` | `dynamodb:PutItem` | ✅ |
| `query_medical_knowledge` | Medical Education | `knowledge` | 无（走 Bedrock KB / 静态资料） | 否 |
| `create_task` | Care Assistant | `game-tools` | `dynamodb:PutItem` | ✅ |
| `get_tasks` | Care Assistant | `game-tools` | `dynamodb:Query` | 否 |

> **AgentCore 执行角色不在这张表中**——它不需要任何 DynamoDB 权限，因为它只能调用工具，
> 不能直接访问数据。这是 §7 安全边界的直接体现。

---

## 6. Gateway 工具暴露

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

| 用途 | 存储 |
|---|---|
| 游戏状态（患者属性、事件历史、进度、分数） | **DynamoDB**（唯一权威） |
| 玩家长期偏好（喜欢详细解释 / 偏好高难度 / 关注营养管理） | **AgentCore Memory**（`actorId = playerId`） |

内建策略选择：`USER_PREFERENCE`（偏好）+ `SEMANTIC`（跨会话事实）。

> Memory 是**最终一致的异步抽取**，因此绝不能用它驱动游戏逻辑判定——用它做个性化
> 文案与难度调节是合适的，用它判断「玩家当前处于哪个阶段」则是错的。
