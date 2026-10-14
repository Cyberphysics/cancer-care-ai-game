# 数据模型：DynamoDB 单表设计

对应实现：`infra/cdk/lib/data-stack.ts`、`infra/cdk/lib/naming.ts`

---

## 1. 为什么是单表

GDD 定义了四个实体（Player / GameSession / PatientState / EventHistory），它们天然围绕**一次游戏会话**聚簇：玩家在某个会话中的所有状态与事件，几乎总是在同一次请求里被一起读取。

单表设计让「加载游戏界面」退化为**一次 Query**：以 `SESSION#<sessionId>` 为分区键，一次取回会话元数据、患者状态和事件时间线。若拆成四张表，同一操作需要 3–4 次往返。

---

## 2. 表配置

| 项 | 取值 | 理由 |
|---|---|---|
| 分区键 | `PK`（S） | 实体前缀 + 标识符 |
| 排序键 | `SK`（S） | 实体类型 / 时间序 |
| 计费模式 | `PAY_PER_REQUEST` | 演示流量不可预测，无需容量规划 |
| TTL 属性 | `expiresAt` | Phase 0 已接线但未写入；Phase 2 起用于让演示会话自动过期 |
| 时间点恢复 | 启用 | 成本极低，防止一次误操作毁掉演示 |
| 删除策略 | dev `DESTROY` / prod `RETAIN` | 由 `config.ts` 按 stage 派生 |
| 物理表名 | **由 CloudFormation 生成** | 硬编码表名会在 destroy 后短期内阻止重建 |

---

## 3. 键模式

| 实体 | PK | SK | GSI1PK | GSI1SK |
|---|---|---|---|---|
| Player | `PLAYER#<playerId>` | `PROFILE` | *(不写入)* | *(不写入)* |
| GameSession | `SESSION#<sessionId>` | `META` | `PLAYER#<playerId>` | `<createdAt>` |
| PatientState | `SESSION#<sessionId>` | `PATIENT#<patientId>` | *(不写入)* | *(不写入)* |
| EventHistory | `SESSION#<sessionId>` | `EVENT#<iso8601>#<eventId>` | *(不写入)* | *(不写入)* |

分区键选择的核心考量：**`sessionId` 而非 `playerId` 作为会话的分区键**。游戏循环以会话为中心，玩家同时只会活跃在一个会话里，因此以会话分区能最大化「一次 Query 拿到游戏界面全部数据」的收益。而「查某玩家的所有会话」是低频操作，用 GSI 承担即可。

---

## 4. GSI1：`PlayerSessionsIndex`

| 项 | 取值 |
|---|---|
| 分区键 | `GSI1PK` |
| 排序键 | `GSI1SK` |
| 投影 | `ALL` |
| 稀疏 | **是**——仅 GameSession 条目写入 GSI1 属性 |

**为什么投影是 ALL**：该索引的用途是「按 sessionId 或 playerId 直接取出完整会话条目」，如果只投影键，每次查询后还要回表拿数据，等于多一次往返。

**为什么是稀疏索引**：Player 与 EventHistory 条目不写 `GSI1PK`，因此它们**根本不进入这个索引**。这让索引体积远小于主表，写入放大也更低——这是相对「用 `entityType` 当索引键」的关键优势。

---

## 5. ⚠️ 稀疏索引的空字符串陷阱

**DynamoDB 拒绝空字符串作为键属性。** 写入 Player 或 EventHistory 条目时，`GSI1PK` / `GSI1SK` 必须**完全省略**，而不能写成 `''`、`null` 或 `undefined`。

这个错误有两个恶劣的性质：

1. **`cdk synth` 不会发现**——它是纯运行时错误，只有真正写入时才会抛异常
2. 报错信息（`ValidationException: One or more parameter values were invalid`）不会指向 GSI

Phase 2 实现写入逻辑时，必须为 `DynamoDBDocumentClient` 配置：

```ts
const docClient = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: {
    removeUndefinedValues: true,  // ← 关键：剥离 undefined 属性
  },
});
```

并在构建条目时用一个剥离函数确保稀疏键不被写入。**这是一个值得单独写单元测试的点。**

---

## 6. ⚠️ 时间戳格式约束

`EventHistory` 的 SK 形如 `EVENT#2026-10-14T22:24:00.000Z#evt-001`。它依赖**字典序等于时间序**这一前提，因此时间戳必须满足：

- **UTC**（`Z` 后缀），不能是本地时间
- **定宽**，毫秒位补齐（`.000Z`，不能省略）
- 单一来源：所有写入必须经由同一个 `nowIso()` 辅助函数

一旦有人写入本地时间或不等宽的时间戳（如去掉毫秒），**事件排序会静默错乱**——不报错，只是顺序不对。这类 bug 在演示现场极难排查。

> 备选方案是 ULID。本项目选 ISO-8601 的理由：在 DynamoDB 控制台里人眼可读，
> 演示时可以直接指着屏幕讲解时间线。

---

## 7. 属性字典

所有条目共有：`PK`、`SK`、`entityType`、`createdAt`、`updatedAt`、`expiresAt?`，以及稀疏的 `GSI1PK` / `GSI1SK`。

### Player

| 属性 | 类型 | 说明 |
|---|---|---|
| `playerId` | S | 玩家标识 |
| `nickname` | S | 昵称 |
| `locale` | S? | 界面语言 |

### GameSession

| 属性 | 类型 | 说明 |
|---|---|---|
| `sessionId` | S | 会话标识 |
| `playerId` | S | 所属玩家 |
| `patientId` | S | 本会话的合成患者 |
| `currentStage` | S | `prevention` \| `screening` \| `diagnosis` \| `treatment` \| `recovery` |
| `stageIndex` | N | 0–4，便于排序与比较 |
| `stageEventIndex` | N | **当前活跃事件**在阶段事件池中的下标（不是已消费数量）。见 [GAME-RULES.md](GAME-RULES.md) §2 |
| `activeEventSk` | S? | 待作答事件的完整 SK，使选择提交走一次 GetItem 而非 Query。阶段池耗尽时该属性被 **REMOVE** |
| `awaitingAdvance` | B | 阶段事件已耗尽，等待玩家显式推进 |
| `score` | N | 累积得分 |
| `qol` | N | 当前生活质量（镜像 `patient.health.qualityOfLife`，使列表查询无需二次读取） |
| `status` | S | `active` \| `completed` \| `abandoned` |
| `startedAt` | S | ISO-8601 UTC |
| `completedAt` | S? | ISO-8601 UTC |
| `version` | N | 乐观锁版本号，见第 9 节 |

### PatientState

| 属性 | 类型 | 说明 |
|---|---|---|
| `patientId` | S | 患者标识 |
| `sessionId` | S | 所属会话 |
| `profile` | M | `{ age, gender, riskFactors[] }` |
| `health` | M | `{ qualityOfLife, energy, stress, nutrition }`，均为 0–100 |
| `care` | M | `{ medicalRecords[], tasks[], appointments[] }` |
| `relationship` | M | `{ familySupport }` |
| `timeline` | L | 阶段流转记录 |
| `version` | N | 乐观锁版本号 |

### EventHistory

| 属性 | 类型 | 说明 |
|---|---|---|
| `eventId` | S | 事件标识 |
| `sessionId` | S | 所属会话 |
| `stage` | S | 所属阶段 |
| `type` | S | `medical` \| `care` \| `emotion` |
| `title` / `description` | S | 展示文案 |
| `choices` | L | `[{ id, text }]`，**不含** impact/score |
| `choiceOutcomes` | M | 各选项的影响，键为 choice id：`{ impact, score, rationale }`。**绝不出现在未作答事件的 API 响应中** |
| `chosenChoiceId` | S? | 玩家选择；同时是防重复提交的条件键 |
| `impact` | M? | 实际施加的增量（作答后写入） |
| `agentRationale` | S? | 展示给玩家的解释（Phase 2 来自模板，Phase 3 可由 Agent 生成） |
| `source` | S | `rule`（Phase 2 规则引擎）\| `agent`（Phase 3） |
| `timestamp` | S | ISO-8601 UTC |

---

## 8. 访问模式

设计已支撑的查询。**全部走 GetItem / Query，无 Scan。**

| # | 场景 | 操作 | 实现位置 |
|---|---|---|---|
| 1 | 读取玩家 | `GetItem` PK=`PLAYER#<pid>`, SK=`PROFILE` | `repo.getPlayer` |
| 2 | 写入玩家 | `PutItem` + `attribute_not_exists(PK)` | `repo.putPlayer` |
| 3 | 按 sessionId 读取会话 | `GetItem` PK=`SESSION#<sid>`, SK=`META` | `repo.getSession` |
| 4 | **列出某玩家的所有会话** | `Query` GSI1, GSI1PK=`PLAYER#<pid>` | 待 Phase 4 使用 |
| 5 | 读取患者状态 | `GetItem` PK=`SESSION#<sid>`, SK=`PATIENT#<patid>` | `repo.getItemAt` |
| 6 | **加载游戏界面** | 上述两次 GetItem（会话 + 患者），加上按 `activeEventSk` 的第三次 GetItem 取当前事件 | `handlers.handleGetSession` |
| 7 | 按 activeEventSk 读取当前事件 | `GetItem` PK=`SESSION#<sid>`, SK=`<activeEventSk>` | 同上 |
| 8 | 完整事件时间线（正序） | `Query` PK=`SESSION#<sid>`, `begins_with(SK,'EVENT#')`, `ScanIndexForward:true` | `repo.listEvents` |
| 9 | 创建会话 + 患者 + 首个事件 | `TransactWrite` 三项 | `repo.createSessionTransaction` |
| 10 | 提交选择（4 项原子） | `TransactWrite` 四项 + 双乐观锁 + 幂等条件 | `repo.submitChoiceTransaction` |
| 11 | 推进阶段 | `TransactWrite` 会话 + 患者时间线（+ 可选下一事件） | `repo.advanceStageTransaction` |

**全部操作走 GetItem / Query / TransactWrite，无 Scan。**

> **一个被推翻的早期设想**：草案里曾让 GameSession 的 PK 为 `PLAYER#<pid>`，用
> `begins_with(SK,'SESSION#')` 列出玩家的会话。最终选择以 `SESSION#<sid>` 为分区键，
> 因为游戏循环以会话为中心——代价是「列出某玩家的会话」必须走 GSI1（第 4 行），
> 而收益是「加载游戏界面」的会话与患者状态落在同一分区。后者是高频路径，前者是低频的。

---

## 8.1 为什么不用 Query 找「当前事件」

最直接的实现是 `Query PK=SESSION#<sid>` 取回分区内所有条目再筛出未作答的事件。但那样每次提交选择都要读回整个会话的事件历史——随着剧情推进线性变差。

改为在会话条目上维护 `activeEventSk` 指针，使读取退化为一次 `GetItem`。代价是每次推进都要更新这个指针（在同一个事务里完成），以及阶段耗尽时必须 **REMOVE** 它——指针若悬停在已作答的事件上，下一次提交就会打错目标。

---

## 9. 乐观锁：Agent 不能直接改状态

GDD §17 原则 5 要求「Agent 不能直接修改关键状态，必须经过后端校验」。

**Phase 2 已实现**（Phase 0 只是设计）。落地机制是 `repo.submitChoiceTransaction()` 里的**一次四项原子事务**：

| # | 项 | 条件 |
|---|---|---|
| 0 | `Update` 患者状态（新健康值） | `version = :expected` |
| 1 | `Update` 已作答事件（写 chosenChoiceId / impact / rationale） | `attribute_not_exists(chosenChoiceId)` |
| 2 | `Update` 会话（score / stageEventIndex / awaitingAdvance / activeEventSk） | `version = :expected` |
| 3 | `Put` 下一事件 | `attribute_not_exists(PK)` |

**两个乐观锁而非一个**：会话与患者是各自独立可变的实体。只锁其中一个，并发写入仍能从另一个溜过去。

**幂等由条件写免费获得**：`attribute_not_exists(chosenChoiceId)` 让重复提交同一选择直接失败，不需要单独的幂等键或去重表。

### 事务失败的处理

`TransactionCanceledException` 的 `CancellationReasons` 是一个**按位置对应 TransactItems 的数组**——索引 N 描述第 N 项。一次冲突可能同时触发多个条件，因此解析时要把全部原因收集起来，不要假设只有一项失败。`repo.sendTransaction` 会把它转成 `TransactionConflictError`，路由层映射为 **409**，客户端应重新读取状态后重试。

### 关于健康值的两种语义

边界校验有两套语义，**不要混用**：

| 场景 | 函数 | 行为 |
|---|---|---|
| 规则引擎内部计算 impact | `clampHealth()` | 截断到 0–100，永不失败 |
| 外部（Phase 3 Agent）提议的变更 | `applyValidatedDelta()` | 越界即拒绝，抛 `HealthValidationError` |

Phase 3 的 Agent 工具调用必须走后者：静默把 +150 截断成 +100，会让调用方以为自己的状态判断成立。详见 [GAME-RULES.md](GAME-RULES.md) §1。

**Agent 的执行角色不持有任何 DynamoDB 权限**——它只能调用工具，工具再经后端写入。这条不变量写进了 [ARCHITECTURE.md](ARCHITECTURE.md)，是 Phase 3 的核心安全设计。

---

## 10. 条目样例

### Player

```json
{
  "PK": "PLAYER#p-001",
  "SK": "PROFILE",
  "entityType": "Player",
  "playerId": "p-001",
  "nickname": "小王的女儿",
  "locale": "zh-CN",
  "createdAt": "2026-10-14T08:00:00.000Z",
  "updatedAt": "2026-10-14T08:00:00.000Z"
}
```

注意：**没有** `GSI1PK` / `GSI1SK` / `GSI1PK: ""` —— 完全省略。

### GameSession

```json
{
  "PK": "SESSION#s-001",
  "SK": "META",
  "entityType": "GameSession",
  "sessionId": "s-001",
  "playerId": "p-001",
  "patientId": "pat-001",
  "currentStage": "screening",
  "stageIndex": 1,
  "score": 40,
  "qol": 68,
  "status": "active",
  "startedAt": "2026-10-14T08:05:00.000Z",
  "version": 3,
  "GSI1PK": "PLAYER#p-001",
  "GSI1SK": "2026-10-14T08:05:00.000Z",
  "createdAt": "2026-10-14T08:05:00.000Z",
  "updatedAt": "2026-10-14T08:20:00.000Z"
}
```

### PatientState

```json
{
  "PK": "SESSION#s-001",
  "SK": "PATIENT#pat-001",
  "entityType": "PatientState",
  "patientId": "pat-001",
  "sessionId": "s-001",
  "profile": { "age": 55, "gender": "male", "riskFactors": ["smoking", "sedentary"] },
  "health": { "qualityOfLife": 68, "energy": 60, "stress": 55, "nutrition": 70 },
  "care": { "medicalRecords": [], "tasks": [], "appointments": [] },
  "relationship": { "familySupport": 60 },
  "timeline": [],
  "version": 3,
  "createdAt": "2026-10-14T08:05:00.000Z",
  "updatedAt": "2026-10-14T08:20:00.000Z"
}
```

### EventHistory

```json
{
  "PK": "SESSION#s-001",
  "SK": "EVENT#2026-10-14T08:10:00.000Z#evt-001",
  "entityType": "EventHistory",
  "eventId": "evt-001",
  "sessionId": "s-001",
  "stage": "prevention",
  "type": "medical",
  "title": "持续咳嗽两个月",
  "description": "王先生最近持续咳嗽两个月，偶尔带血丝。",
  "choices": [
    { "id": "A", "text": "认为只是小问题，继续观察" },
    { "id": "B", "text": "预约医院检查" }
  ],
  "chosenChoiceId": "B",
  "impact": { "qualityOfLife": 5, "energy": -3, "stress": 8, "nutrition": 0 },
  "source": "rule",
  "timestamp": "2026-10-14T08:10:00.000Z",
  "createdAt": "2026-10-14T08:10:00.000Z",
  "updatedAt": "2026-10-14T08:10:00.000Z"
}
```
