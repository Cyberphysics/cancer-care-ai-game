# MVP Git Roadmap

对应 GDD §14 的 Phase 1–5，另加 Phase 0 记录**已完成的这一轮**。

---

## 里程碑总览

| Phase | 范围 | 退出标准 | 标签 |
|---|---|---|---|
| **0** ✅ | 文档 + CDK 骨架 + 桩 API + 静态前端托管 | CloudFront 页面可访问；`/health` 返回 200；DynamoDB 表与 GSI 存在 | `v0.1.0` |
| **1** | 基础项目收尾（GDD 原定内容） | 由 Phase 0 大部分覆盖，仅补齐缺口 | `v0.2.0` |
| **2** ✅ | 游戏核心：PatientState 演进、Event Engine、Choice System | 不依赖任何 LLM，用规则引擎跑通完整五阶段流程 | `v0.3.0` |
| **3** | Agent：AgentCore Runtime、GameMaster、工具、Memory | Gateway 工具调用能**经校验**变更状态，并有审计轨迹 | `v0.4.0` |
| **4** | 前端：首页、患者创建、游戏界面、状态面板、AI 对话 | 五个页面全部接真实 API | `v0.5.0` |
| **5** | 部署收尾：bootstrap 校验、部署、演示脚本 | 按 README 冷启动可完整跑通 5 分钟 Demo | `v1.0.0` |

---

## Phase 0 — 项目骨架 ✅ 已完成

**目标**：建立可部署、可验证、但**不含游戏业务逻辑**的骨架。

**交付物**

- `README.md`、`docs/`（ARCHITECTURE / DATA-MODEL / AGENT-DESIGN / ROADMAP / IAM-PERMISSIONS）
- `infra/cdk`：`CancercareGameMvp-{Data,Api,Frontend}` 三个 Stack
- DynamoDB 单表（PK/SK + 稀疏 GSI1 + TTL + PITR）
- HTTP API 8 条路由（`/health` 真实 200，其余 501 桩）
- Lambda：Node 22 / ARM64 / esbuild 打包 / 零运行时依赖
- `frontend/`：Vite + React + TS 最小壳
- CDK 单元测试（16 条）

**退出标准**

- [x] `npx cdk synth` 成功生成三个模板
- [x] 模板中不含任何 `AWS::BedrockAgentCore::*` 资源（Phase 3 边界）
- [x] `npm test` 全绿
- [ ] 部署后 `/api/v1/health` 返回 200 —— **依赖 IAM 权限补齐**
- [ ] CloudFront 域名可打开占位页 —— **依赖 IAM 权限补齐**

**明确不做**：游戏逻辑、Agent 代码、玩家鉴权、自定义域名、CI/CD

---

## Phase 1 — 基础项目收尾

GDD 原定的 Phase 1（初始化 React、初始化 CDK、创建 AWS 资源、创建 DynamoDB 模型）
已由 Phase 0 覆盖。本阶段只补剩余缺口。

**范围**

- 若 Phase 0 遗留：补齐 `cdk.context.json` 或环境变量的说明
- 引入代码规范工具（ESLint + Prettier），统一 `infra` 与 `frontend`
- 增加 CI（GitHub Actions）：`npm run build`、`npm test`、`cdk synth`

**退出标准**：CI 在 PR 上运行 `synth` 与 `test` 并通过

**明确不做**：任何游戏功能

---

## Phase 2 — 游戏核心 ✅ 已完成

**目标**：**完全不依赖 LLM**，用规则引擎跑通完整五阶段流程。

**交付物**

- `domain/engine.ts`：纯函数规则引擎（事件选择、选择应用、阶段推进），不 import 任何 AWS SDK
- `domain/health.ts`：`clampHealth`（游戏内截断）与 `applyValidatedDelta`（外部提议拒绝）两种语义
- `content/`：3 个合成病例模板 + 13 个事件（覆盖五阶段）
- `repo.ts`：四项原子 `TransactWrite`（双乐观锁 + 幂等条件）
- 7 条路由从 501 桩变为真实实现
- CloudFront 新增 `/api/*` behavior 反代 API Gateway
- 79 条单元测试；`scripts/smoke.sh` + `scripts/game-loop-check.py` 端到端冒烟

**退出标准**

- [x] 一条脚本可在无 LLM 情况下从预防阶段走到康复阶段
- [x] 状态与事件历史正确落库（含稀疏索引写入正确性）
- [x] 重复提交被幂等条件拒绝（409）
- [x] 未答完当前阶段时拒绝推进（409）
- [x] 经 CloudFront 的 `/api/v1/health` 返回 200

**明确不做**：任何 Agent / Bedrock 调用 —— 已遵守

**过程中修复的两个真实缺陷**（均由端到端测试发现，单元测试未覆盖）

1. `stageEventIndex` 语义不一致导致「答一题就跳过整个阶段」——现在由 `session-lifecycle.test.ts` 守护
2. `advanceStageTransaction` 把**推进前**的阶段写回数据库，导致会话在两个阶段间死循环——现在由 `transaction-expressions.test.ts` 守护

---

## Phase 3 — Agent

**目标**：引入 AgentCore，且**状态变更必须经后端校验**。

**范围**

- AgentCore Runtime（**zip → S3** 部署路径优先，ARM64）
- GameMaster Agent（Python，`BedrockAgentCoreApp`）
- AgentCore Gateway + Lambda 工具目标（`get_patient_state` 等）
- AgentCore Memory（`USER_PREFERENCE` + `SEMANTIC` 策略，`actorId = playerId`）
- **可插拔 ModelProvider**：`BedrockProvider` / `ExternalApiProvider` 两种实现
- 复用 Phase 2 已实现的 `applyValidatedDelta()` 做外部提议的边界校验（它目前尚无调用方）
- **审计轨迹**：每次 Agent 发起的状态变更都记录来源与理由

**前置条件（按优先级）**

- [x] ✅ **补齐 `bedrock-agentcore:*` IAM 权限** —— 2026-10-15 已挂载，Agent 栈部署成功
- [x] ✅ **确认模型选择**：走 `DeepSeekProvider` 直连 `api.deepseek.com`，端到端已验证
      （首次 10s：Runtime 冷启动 + 生成；二次 1s 命中缓存）
- [x] ✅ `policy/*` 构造在稳定模块 `aws-cdk-lib/aws-bedrockagentcore` 中可用，无需 alpha 包
- [ ] 🔴 **提 bedrock-allowlisting 工单** —— 仍然阻断，但**与当前方案无关**：`MODEL_PROVIDER=deepseek`
      走官方 API，Bedrock 通道只是保留的可选项。实测报错见 [ARCHITECTURE.md](ARCHITECTURE.md) §6.3

**Stage A 部署时踩到的两个真实缺陷**（都不是环境问题，模板上看不出来）

1. Runtime 的 X-Ray trace 投递要求**账号级**把 trace segment destination 切成 CloudWatch Logs，
   而那是账号级设置。现由 `config.agentTracing` 控制、默认关闭。
2. 执行角色缺 `logs:PutResourcePolicy`，只在部署期以 CloudTrail AccessDenied 现形（CDK L2 不授予）。
   另：处理器传 `runtimeUserId` 时，调用要求的动作是 `InvokeAgentRuntimeForUser` 而非 `InvokeAgentRuntime`。

**Stage B（Gateway 工具面 + 审计轨迹）——按决定跳过，不是待办**

原退出标准是「一次 Gateway 工具调用能经后端校验后变更状态，并留下可追溯的审计记录」。
做过完整设计后判定：**对 Demo 与文章而言演示价值低，而未知量最集中**。具体理由：

- 工具名分隔符在文档之间自相矛盾（`AGENT-DESIGN.md` 与 `ARCHITECTURE.md` 写双下划线，
  AWS 样例与打包的 SDK 用三下划线），工具名还不在事件体里而在 client context 中；
- 响应信封形状（`{content:[…]}` vs `{statusCode, body}`）无法从文档确认；
- `aws bedrock-agentcore` **没有** `invoke-gateway` 子命令，端到端验证要在脚本里手写 SigV4
  （动作名 `bedrock-agentcore:InvokeGateway` 已由 CDK L2 的 `GATEWAY_INVOKE_PERMS` 确认）；
- 收益集中在「架构正确性」而非「看得见的效果」，而当时的瓶颈是**能演示的东西**。

需要时可以按原设计继续：Gateway 用 `agentcore.Gateway` + `addLambdaTarget`，
**入站认证必须显式传 `GatewayAuthorizer.usingAwsIam()`**——L2 的默认授权器是 Cognito，
不传会静默建出用户池、资源服务器、客户端与域名。
`applyValidatedDelta()`（外部提议路径）目前仍**没有调用方**，是这条路径的入口。

**Stage C（多 Agent 参与：知识沉淀 + 医学教育问答）——已实现，尚未部署**

Stage B 跳过后，改用**直连工具循环**替代 Gateway 来推进「更多 agent 参与」。契约已写入
[AGENT-DESIGN.md](AGENT-DESIGN.md)。

- **两个新角色**与 GameMaster 共用同一个 Runtime，按请求的 `kind` 分派：
  - `extract` —— GameMaster 把剧情中出现的医学术语归纳成知识笔记，写入 AgentCore Memory
  - `question` —— **只读**的 Medical Education，为玩家提问做**带出处**的解答
- **打包语料** 14 条医学概念，每条带出处，随 agent zip 发布（`app/knowledge/corpus.json`）
- **工具循环是固定形状，不是通用 ReAct**：第一次强制具名 `tool_choice`，第二次强制禁用工具。
  两次调用封顶，延迟预算才可证；具名强制也一次性消灭「模型不调工具」与「无据作答」两类退化
- **同一把护栏管住答案与笔记**：两者都要过 `find_violations`；编造的引用直接丢弃
- 后端新增 `POST /sessions/{id}/questions` 与 `POST /sessions/{id}/knowledge`。后者由客户端在
  `/advance` **之后**调用，**绝不嵌进** `/advance`——推进必须保持快且不依赖 agent

**实测推翻的两条原假设**（两条都会让功能「看起来正常但实际错」）：

1. `parallel_tool_calls: false` 被 DeepSeek **接受后忽略**——一轮多调用是**常态**而非边界情况，
   循环必须给**每个** tool call id 都作答，否则下一次请求直接失败
2. 降低 `max_tokens` **不是**延迟杠杆：300/400 直接 `finish_reason=length` 截断在句中，而延迟**没有下降**
   （300 / 400 / 900 token 实测都在 3.0–3.8 秒）。一次完整的两段式循环实测约 **2.9 秒**——
   原计划里「一次调用约 10 秒」那个数字是端到端（含 Runtime 冷启动），不是模型

**线上人工试玩发现并修复的三个问题**（这类问题单元测试看不见，只有真跑一遍界面才会暴露）：

1. **出处列表里同一个出版方重复出现**——不是重复数据，是呈现问题：5 条语料共用美国癌症协会、
   4 条共用 NCCN，两条同源就显示成两行一样的来源串。改成概念名在上、依据在下。同时补上国家卫健委
   那三条缺失的链接与**发文字号**（对中文公文而言这才是标准定位方式）。
2. **「没有定位到段落」**——根子是语料正文是**我们自己编写的概念说明，不是原文摘录**，标「出处」是在
   暗示一种不存在的精确度。改称「依据」并明说。
3. **advance 看不出 agent 做了什么**——判断正确且是设计如此：`/advance` 全程规则引擎。但 agent 确实
   在推进时归纳了笔记，而客户端把回答**丢掉**了，界面上完全不可见。现在 `/knowledge` 返回归纳出的
   术语，界面显示出来，并明说剧情推进由规则引擎完成。

**以及一个质量缺陷**：归纳出的「术语」其实是剧情复述（事件标题、玩家选项原文），且同一阶段内同一
想法出现四种措辞。这些会进检索池被当作「依据」引用。修法是两道独立的闸（提示词收紧 + 代码层的
复述检测与近似去重），因为提示词是请求、不是约束。

**已验证**：`extraction_mode="SKIP"` 确实被服务端兑现。用对照法测得（`scripts/memory-skip-probe.py`）：
一条不带 SKIP 的事件所带的标记约 **90 秒**后出现在长期记忆里，另一条带 SKIP 的标记始终没有出现。
对照组排除了「抽取还没跑」这种解释。

这条之所以要专门验，是因为失败是**静默的**——若 SKIP 被忽略，知识笔记会漂进 `/players/{actorId}`，
`recall_preferences` 就会开始把医学术语当作玩家偏好返回，而没有任何东西会报错。

> 判据不能用「长期记录里有没有出现笔记术语」：长期记录是从会话总结抽取的，而总结描述的正是
> 同一段剧情，用词本来就重叠。第一版 `memory-dump.py` 正是这样报了一个**假警报**。

**明确不做**：多癌种、多玩家协作

---

## Phase 4 — 前端

**范围**：首页 · 患者创建 · 游戏界面 · 状态面板 · AI 聊天窗口（GDD §14 Phase 4）

**已做（最小可玩版）**：单页状态机覆盖完整闭环——创建角色 → 逐题选择（立即看到影响与
解释）→ 五阶段推进 → 完成页时间线 → AI 结局总结。无路由、无独立页面，复用了既有
`data/stages.ts` 与整套 API。

**未做**：README 所述五个页面的拆分、状态面板的独立视图、AI 对话窗口（当前是「一键点评 / 一键总结」而非多轮对话）。

**退出标准**：五个页面全部接真实 API，可在浏览器完成一次完整游玩

**明确不做**：移动端适配、国际化

---

## Phase 5 — 部署与演示

**范围**

- `cdk bootstrap` 状态校验脚本
- 一键部署脚本（含正确的「先构建前端」顺序）
- `scripts/smoke.sh`：部署后自动冒烟（health → 路由桩 → CloudFront）
- 5 分钟 Demo 脚本，含演示前检查清单与降级预案

**退出标准**：按 README 从零冷启动，可在演示网络上完整跑通 5 分钟 Demo

**明确不做**：多区域部署、蓝绿发布

---

## Git 规范

### 分支模型

**GitHub Flow**，非 GitFlow。`main` 始终可部署，特性分支短生命周期。

| 分支 | 用途 |
|---|---|
| `main` | 始终可部署 |
| `feat/<phase>-<topic>` | 新功能，如 `feat/p2-event-engine` |
| `fix/<topic>` | 缺陷修复 |
| `docs/<topic>` | 文档 |
| `infra/<topic>` | 基础设施 |
| `chore/<topic>` | 杂项、依赖升级 |

### 提交信息

Conventional Commits，scope 与仓库结构对应：

```
feat(api): 实现玩家选择提交路由
feat(infra): 为 DynamoDB 表启用时间点恢复
feat(web): 添加状态面板组件
feat(agent): 接入 GameMaster AgentCore Runtime
docs: 补充 Phase 3 校验边界设计
test(infra): 覆盖稀疏 GSI 空字符串场景
chore(deps): 升级 aws-cdk-lib 至 2.274.0
```

### 提交粒度

- 一个提交只做一件逻辑上完整的事
- `feat(infra)` 提交必须包含通过的 `npm run synth` 与更新的测试

### 标签

每个 Phase 结束时打带注释的标签：`v0.1.0` … `v1.0.0`。

**实际已建立的标签**

| 标签 | 提交 | 标记的里程碑 |
|---|---|---|
| `v0.1` | `9458ea7` | **纯规则引擎版**：五阶段流程由规则引擎完整驱动，即使 AI 完全不可用也能从头玩到尾；AgentCore 叙事层是可选的叠加层。含四个栈、最小可玩网页、`docs/ARTICLE.md` |

> `v0.1` 与上表的 Phase 编号约定不一致（`v0.1.0` 原指 Phase 0 骨架）。它标记的是
> 另一个维度上的里程碑——「游戏可完整游玩」，而不是某个 Phase 的收尾。之所以并存，
> 是因为这两个维度都在被独立推进（Phase 3 的 Stage B 已按决定跳过，而前端已可玩）。

### PR 检查清单

- [ ] `npm --prefix infra/cdk run build` 通过（类型检查）
- [ ] `npm --prefix infra/cdk test` 通过
- [ ] `npx cdk synth` 通过，且**不引入 Bedrock/AgentCore 资源**（除非是 Phase 3）
- [ ] 未提交真实患者数据（仅合成病例）
- [ ] 安全边界未被突破（无诊断 / 治疗建议 / 药物推荐 / 生存预测）
- [ ] 新增 IAM 通配符权限已说明理由
- [ ] 基础设施变更附上 `cdk diff` 输出

### 首次提交注意事项

`.gitignore` **必须先于任何 `npm install` 提交**，否则 `node_modules` 会被纳入版本控制。
本仓库已按此顺序初始化。
