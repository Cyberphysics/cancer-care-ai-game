# MVP Git Roadmap

对应 GDD §14 的 Phase 1–5，另加 Phase 0 记录**已完成的这一轮**。

---

## 里程碑总览

| Phase | 范围 | 退出标准 | 标签 |
|---|---|---|---|
| **0** ✅ | 文档 + CDK 骨架 + 桩 API + 静态前端托管 | CloudFront 页面可访问；`/health` 返回 200；DynamoDB 表与 GSI 存在 | `v0.1.0` |
| **1** | 基础项目收尾（GDD 原定内容） | 由 Phase 0 大部分覆盖，仅补齐缺口 | `v0.2.0` |
| **2** | 游戏核心：PatientState 演进、Event Engine、Choice System | 不依赖任何 LLM，用规则引擎跑通完整五阶段流程 | `v0.3.0` |
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

## Phase 2 — 游戏核心

**目标**：**完全不依赖 LLM**，用规则引擎跑通完整五阶段流程。

**范围**

- `PatientState` 演进逻辑（健康维度 0–100 边界强制）
- Event Engine：按阶段生成事件，事件池由数据驱动
- Choice System：玩家选择 → 计算 `impact` → 更新状态 → 追加 `EventHistory`
- 乐观锁 `version` 的实际启用（`ConditionExpression`）
- 单测覆盖：边界校验、版本冲突、事件顺序（时间戳定宽格式）
- 前端的 API 调用雏形（已知晓 API 地址即可）

**退出标准**：一条脚本可在无 LLM 情况下从预防阶段走到康复阶段，状态与事件历史正确落库

**明确不做**：任何 Agent / Bedrock 调用

---

## Phase 3 — Agent

**目标**：引入 AgentCore，且**状态变更必须经后端校验**。

**范围**

- AgentCore Runtime（**zip → S3** 部署路径优先，ARM64）
- GameMaster Agent（Python，`BedrockAgentCoreApp`）
- AgentCore Gateway + Lambda 工具目标（`get_patient_state` 等）
- AgentCore Memory（`USER_PREFERENCE` + `SEMANTIC` 策略，`actorId = playerId`）
- 后端校验 Lambda：边界校验、阶段合法性、内容安全过滤
- **审计轨迹**：每次 Agent 发起的状态变更都记录来源与理由

**前置条件（阻塞项）**

- [ ] **提交 Anthropic 模型访问用例申报表单**（账号级 + 区域级，非 IAM 权限，需提前数周）
- [ ] 补齐 Bedrock / AgentCore IAM 权限，见 [IAM-PERMISSIONS.md](IAM-PERMISSIONS.md) §B
- [ ] 用 `aws bedrock list-foundation-models` 现场核实模型 ID，**不要照抄文档中的示例字符串**
- [ ] 确认 `policy/*` 构造在稳定模块中的可用性

**退出标准**：一次 Gateway 工具调用能经后端校验后变更状态，并留下可追溯的审计记录

**明确不做**：多癌种、多玩家协作

---

## Phase 4 — 前端

**范围**：首页 · 患者创建 · 游戏界面 · 状态面板 · AI 聊天窗口（GDD §14 Phase 4）

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
