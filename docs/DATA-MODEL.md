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
| `score` | N | 累积得分 |
| `qol` | N | 当前生活质量 |
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
| `choices` | L | `[{ id, text }]` |
| `chosenChoiceId` | S? | 玩家选择 |
| `impact` | M | 对 `qualityOfLife` / `energy` / `stress` / `nutrition` 的增量 |
| `agentRationale` | S? | Agent 给出的解释（Phase 3） |
| `source` | S | `rule`（Phase 2 规则引擎）\| `agent`（Phase 3） |
| `timestamp` | S | ISO-8601 UTC |

---

## 8. 访问模式

设计已支撑的查询。**全部走 GetItem / Query，无 Scan。**

| # | 场景 | 操作 |
|---|---|---|
| 1 | 读取玩家 | `GetItem` PK=`PLAYER#<pid>`，SK=`PROFILE` |
| 2 | 写入/更新玩家 | `PutItem` |
| 3 | 列出某玩家的所有会话 | `Query` PK=`PLAYER#<pid>`, `begins_with(SK,'SESSION#')` ⚠️ 见下 |
| 4 | 按 sessionId 读取会话 | `GetItem` PK=`SESSION#<sid>`, SK=`META` |
| 5 | 列出某玩家的所有会话（走索引） | `Query` GSI1, GSI1PK=`PLAYER#<pid>` |
| 6 | 读取患者状态 | `GetItem` PK=`SESSION#<sid>`, SK=`PATIENT#<patid>` |
| 7 | **加载游戏界面**（患者状态 + 最近事件） | **一次** `Query` PK=`SESSION#<sid>`, `ScanIndexForward:false`, `Limit:20` |
| 8 | 完整事件时间线（正序） | `Query` PK=`SESSION#<sid>`, `begins_with(SK,'EVENT#')`, `ScanIndexForward:true` |
| 9 | 追加事件 | `PutItem` + `attribute_not_exists(PK)` |
| 10 | 受校验的状态更新 | `UpdateItem` + `version` 条件，见第 9 节 |

> ⚠️ **第 3 行与第 4 行不兼容**：游戏中 GameSession 的 PK 是 `SESSION#<sid>`，不在
> player 分区下，因此 `begins_with(SK,'SESSION#')` 查不到任何东西。**「列出某玩家的会话」
> 一律走 GSI1（第 5 行）**，第 3 行仅在早期草案中存在，保留在此以说明取舍。
> 实现时请勿使用第 3 行。

---

## 9. 乐观锁：Agent 不能直接改状态

GDD §17 原则 5 要求「Agent 不能直接修改关键状态，必须经过后端校验」。落地机制就是**版本号乐观锁**：

```ts
await docClient.update({
  TableName: tableName,
  Key: { PK: `SESSION#${sessionId}`, SK: `PATIENT#${patientId}` },
  UpdateExpression: 'SET #health = :health, #v = #v + :one, updatedAt = :now',
  ConditionExpression: '#v = :expected',
  ExpressionAttributeNames: { '#health': 'health', '#v': 'version' },
  ExpressionAttributeValues: {
    ':health': validatedHealth,   // 后端已做 0–100 边界校验
    ':expected': expectedVersion,
    ':one': 1,
    ':now': nowIso(),
  },
});
```

要点：

- Agent 提出的状态变更**先经后端校验**（`stress` / `nutrition` / `qualityOfLife` 等强制落在 0–100）
- 校验通过后由后端执行带 `ConditionExpression` 的写入
- 版本冲突时抛 `ConditionalCheckFailedException`，调用方需重新读取再试
- **Agent 的执行角色不持有任何 DynamoDB 权限**——它只能调用工具，工具再经后端

这条不变量写进了 [ARCHITECTURE.md](ARCHITECTURE.md)，是 Phase 3 的核心安全设计。

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
