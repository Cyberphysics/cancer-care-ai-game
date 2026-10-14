# 游戏规则

规则引擎的实现位于 `infra/cdk/lambda/game-api/src/domain/engine.ts`，内容数据位于 `src/content/`。

**Phase 2 的规则引擎完全不调用任何 LLM。** 这是刻意的：先证明游戏机制本身成立、状态机正确、并发安全，Phase 3 再让 Agent 生成更丰富的内容。这样任何问题都能被清晰地归因到「机制」或「模型」其中之一。

---

## 1. 四维健康模型

患者状态由四个维度构成，每个都约束在 **0–100**：

| 维度 | 含义 |
|---|---|
| `qualityOfLife` | 生活质量（**游戏的最终目标指标**，不是治愈率） |
| `energy` | 精力 |
| `stress` | 压力（越高越差） |
| `nutrition` | 营养状况 |

### ⚠️ 两条路径，两种语义

| 函数 | 位置 | 用于 | 行为 |
|---|---|---|---|
| `clampHealth()` | `domain/health.ts` | **规则引擎内部**计算 impact | 截断到 0–100，**永不失败** |
| `applyValidatedDelta()` | `domain/health.ts` | **外部提议**（Phase 3 的 Agent 工具调用） | 越界即**拒绝**并抛 `HealthValidationError` |

**为什么必须分开**：玩家的选择是游戏机制，理应总能得到一个结果，所以引擎内部溢出就饱和到边界。但 Agent 提议的变更不同——如果它要求 +150 却被静默截断成 +100，调用方永远不会知道自己的状态判断是错的。**静默修正会掩盖 bug**。

---

## 2. 阶段流转

五个阶段固定顺序：

```
prevention → screening → diagnosis → treatment → recovery
```

每个阶段的**事件池**由 `content/events.ts` 定义，按顺序消费。

### 状态机

```
进入阶段 N
   └─ stageEventIndex = 0，生成事件池[0]，awaitingAdvance = false
        │
        ├─ 玩家提交选择 → stageEventIndex + 1
        │     ├─ 池中还有事件 → 生成下一个事件
        │     └─ 池已耗尽     → awaitingAdvance = true，清除 activeEventSk
        │
        └─ 玩家调用 /advance（仅当 awaitingAdvance）
              ├─ 非末阶段 → 进入阶段 N+1
              └─ 末阶段   → status = completed，记录 completedAt
```

**关键设计：阶段边界只能由玩家显式动作跨越。** 答完一个阶段最后一个事件，不会自动进入下一阶段——引擎只置 `awaitingAdvance` 标志。这让「推进」成为一个有意义的选择点，也让前端能明确地展示阶段小结。

> ⚠️ **`stageEventIndex` 的语义是「当前活跃事件在池中的下标」，不是「已消费的事件数」。** 会话创建时它是 `0`。
> 这个区别会造成一个隐蔽的 bug：若初始化为 1，第一次作答后 `+1` 得到 2，直接越过整个阶段——表现为「答一题就跳过整段剧情」。这个 bug 真实发生过，现在由 `test/lambda/session-lifecycle.test.ts` 守护。

---

## 3. 事件池

`content/events.ts` 导出类型化的 `EventTemplate[]`，共 13 个事件：

| 阶段 | 事件数 | 覆盖内容 |
|---|---|---|
| prevention | 2 | 持续咳嗽、生活方式调整 |
| screening | 3 | 异常影像、资料整理、进一步检查 |
| diagnosis | 2 | 理解病理报告、家庭沟通 |
| treatment | 3 | 用药记录、营养管理、情绪支持 |
| recovery | 3 | 作息、定期复查、照护可持续性 |

### 选项结构

每个选项包含：

```ts
{
  id: 'B',
  text: '预约医院做进一步检查',            // 玩家可见
  impact: { qualityOfLife: 5, energy: -3, stress: 8 },  // 隐藏
  score: 20,                                // 隐藏
  rationale: '对长期吸烟者而言…',            // 作答后才展示
}
```

### ⚠️ 答案泄露防护

`impact` / `score` / `rationale` 会**持久化进事件条目**（使记录自包含，编辑目录不会追溯改变历史事件的含义），但**绝不出现在未作答事件的 API 响应中**。

`handlers.ts` 的 `toEventResponse()` 只有在该事件已有 `chosenChoiceId` 时才附上这些字段。这是有意的投影，不是碰巧：一处不小心的对象展开就会把答案键交给玩家。

---

## 4. 计分

- 每个选项带 `score`，可为负（例如「自行购买止咳药」为 -5）
- 分数累加在 `GameSession.score`
- **分数不影响健康值**，两者独立——分数衡量照护决策的质量，健康值模拟患者状态

---

## 5. 提交选择的完整流程

```
POST /api/v1/sessions/{sessionId}/choices  { eventId, choiceId }
  │
  ├─ 读取会话（校验 status、activeEventSk）
  ├─ 读取活跃事件，校验 eventId 匹配
  ├─ 读取患者状态
  │
  ├─ engine.applyChoice()  ← 纯函数
  │     ├─ 校验该事件尚未作答（AlreadyAnsweredError）
  │     ├─ 校验选项存在（ChoiceNotFoundError）
  │     ├─ clampHealth 计算新健康值
  │     └─ 推导新的 stageEventIndex 与下一个事件模板
  │
  └─ **一次 TransactWrite 原子提交 4 项**：
       ├─ Update 患者      条件 version = :expected
       ├─ Update 已答事件  条件 attribute_not_exists(chosenChoiceId)
       ├─ Put    下一事件  条件 attribute_not_exists(PK)
       └─ Update 会话      条件 version = :expected
```

### 两个乐观锁 + 一个幂等守卫

| 条件 | 性质 |
|---|---|
| 患者 `version = :expected` | 乐观锁（GDD §17 原则 5 的落地） |
| 会话 `version = :expected` | 乐观锁 |
| 事件 `attribute_not_exists(chosenChoiceId)` | **防重复提交** |
| 下一事件 `attribute_not_exists(PK)` | 防重复插入 |

**为什么是两项乐观锁而不是一项**：会话与患者是各自独立可变的，只锁其中一个，并发写入仍能从另一个溜过去。

**为什么用事务而不是多次单写**：这四项必须同生共死。分次写在中间失败时会留下「患者状态已变但事件未记录」的脏数据，而这种不一致很难在事后发现。

事务冲突抛 `TransactionCanceledException`，`CancellationReasons` **是按位置对应 TransactItems 的数组**——解析时不要假设只有一项失败，一次冲突可能同时触发多个条件。映射为 **409**，客户端应重新读取当前状态后重试。

---

## 6. 会话生命周期

| 状态 | 含义 |
|---|---|
| `active` | 进行中 |
| `completed` | 走完 recovery 阶段并推进 |
| `abandoned` | 预留，当前 API 不会主动设置 |

已完成的会话：
- 拒绝提交选择 → 409
- 拒绝推进 → 409

会话及其全部条目写入 `expiresAt`（now + 7 天），由 Phase 0 已启用的 DynamoDB TTL 自动清理。

---

## 7. 内容安全边界（GDD §16）

所有事件文案遵循：

- ✅ 只解释**概念**（什么是低剂量螺旋 CT、为什么需要活检）
- ✅ 引导咨询专业医生
- ❌ 不出现具体药物名或剂量
- ❌ 不出现生存率 / 治愈率数字
- ❌ 不推荐个体治疗方案

这条边界由 `test/lambda/engine.test.ts` **机械校验**（正则扫描全部 rationale），而不是依赖人工审阅。

---

## 8. 把内容迁到 S3

引擎以参数接收事件目录（依赖注入），而非直接 import：

```ts
applyChoice({ catalog: EVENT_CATALOG, ... })
```

因此改为从 S3 加载只需要在 `handlers.ts` 的组装处换一次数据来源，`domain/` 一行都不用改。Phase 2 选择内置 TS 常量，是因为规则引擎的单测价值最高，引入运行时 S3 读取会让测试必须 mock 且增加一个失败面。
