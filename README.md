# CancerCare AI Game

**生命守护者** — 一个由 AI Agent 驱动的肿瘤健康照护模拟游戏

> 面向 AWS User Group China Challenge · 基于 Amazon Bedrock AgentCore

---

## ⚠️ 当前状态：Phase 0 — 项目骨架

**本仓库目前是一个基础设施骨架，不是可玩的游戏。** 已就绪的是部署链路、数据模型定义与路由契约；游戏逻辑与 Agent 尚未实现。

| 已实现 | 尚未实现 |
|---|---|
| CDK 三栈基础设施（Data / Api / Frontend） | 任何游戏业务逻辑（事件引擎、选择判定） |
| DynamoDB 单表 + 稀疏 GSI | AgentCore Runtime / Memory / Gateway |
| HTTP API 8 条路由（1 条真实、7 条 501 桩） | 前端游戏界面（当前仅占位页） |
| S3 + CloudFront（OAC）静态托管 | 玩家鉴权 |

---

## 这是什么 / 不是什么

**是**：健康教育游戏 · 家庭照护模拟训练 · 肿瘤生命周期科普体验 · AI Agent 驱动的互动故事。

**不是**：AI 医生 · 癌症预测工具 · 治疗方案推荐系统 · 临床决策辅助系统。

> **安全边界（硬性约束）**
>
> 本游戏仅用于健康教育，**不提供**医疗诊断、个体治疗方案、药物推荐或生存预测。
> 所有病例均为**合成病例**，仓库中不得出现真实患者资料。
> 游戏目标是提升患者**生活质量（QoL）**，而非癌症治愈率——这是刻意的设计选择，用以避免医疗误导。

---

## MVP 范围

- **单一癌种**：肺癌
- **玩家身份**：家庭健康守护者（不是医生）
- **五个阶段**：预防 → 筛查 → 诊断 → 治疗 → 康复
- **核心指标**：Quality of Life（生活质量）

---

## 架构

### 当前已部署（Phase 0）

```
                        CloudFront  ──────►  S3 (React 构建产物)
                             │
                             │  (Phase 2 起前端才调用 API)
                             ▼
   玩家 ──►  CloudFront ──► API Gateway (HTTP API v2)
                                    │
                                    ▼
                                 Lambda            ──►  S3 (游戏资源，Phase 2 填充)
                              (Node 22 / ARM64)
                                    │
                                    ▼
                                DynamoDB
                              (单表 PK/SK + GSI)
```

### 完整目标形态（Phase 3 加入 AgentCore）

```
   前端 ──► API Gateway ──► Lambda ──► DynamoDB
                              │
                              ▼
                    AgentCore Runtime  ◄──►  AgentCore Memory
                     (GameMaster Agent)      (长期偏好，非数据库)
                              │
                              ▼
                       AgentCore Gateway (MCP 工具面)
                              │
                              ▼
                        Bedrock Models
```

> AgentCore 部分**尚未编写任何 CDK 代码**，为 Phase 3 交付项。设计详见
> [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)，三个 Agent 的职责与工具契约详见
> [docs/AGENT-DESIGN.md](docs/AGENT-DESIGN.md)。

---

## 仓库结构

```
cancer-care-ai-game/
├── frontend/                    # Vite + React + TypeScript 最小壳
│   └── src/
│       ├── App.tsx              # Phase 0 占位页
│       └── data/stages.ts       # 五阶段常量
├── infra/cdk/                   # AWS CDK (TypeScript)
│   ├── bin/app.ts               # 三栈装配
│   ├── lib/
│   │   ├── config.ts            # 账号/区域/阶段/删除策略
│   │   ├── naming.ts            # 资源命名与键名的单一事实来源
│   │   ├── data-stack.ts        # DynamoDB 单表
│   │   ├── api-stack.ts         # HTTP API + Lambda
│   │   └── frontend-stack.ts    # S3 + CloudFront + OAC
│   ├── lambda/game-api/         # API Lambda 源码（零运行时依赖）
│   └── test/                    # CDK 单元测试
├── docs/
│   ├── ARCHITECTURE.md          # 架构与 Phase 3 AgentCore 设计
│   ├── DATA-MODEL.md            # DynamoDB 单表设计
│   ├── AGENT-DESIGN.md          # 三个 Agent 的职责与工具契约
│   ├── ROADMAP.md               # MVP Git roadmap
│   └── IAM-PERMISSIONS.md       # 部署所需 IAM 权限
├── chatgpt-analisys-doc.md      # 原始 GDD（项目输入文档）
└── local-dev-env-info.md        # AWS 开发环境信息
```

---

## AWS 服务职责

| 服务 | 用途 | 引入阶段 |
|---|---|---|
| S3 | 游戏资源、图片、配置；前端静态产物 | **Phase 0** |
| CloudFront | 静态资源加速（OAC 签名回源） | **Phase 0** |
| API Gateway | HTTP API (v2) 入口 | **Phase 0** |
| Lambda | 业务逻辑（Node 22 / ARM64） | **Phase 0** |
| DynamoDB | 游戏状态（唯一权威存储） | **Phase 0** |
| IAM | 最小权限角色与策略 | **Phase 0** |
| CloudWatch / X-Ray | 日志、指标、链路追踪 | **Phase 0**（已启用 tracing） |
| Bedrock | LLM 推理 | Phase 3 |
| AgentCore Runtime | Agent 执行环境（GameMaster） | Phase 3 |
| AgentCore Memory | 长期记忆（玩家偏好，**非**数据库） | Phase 3 |
| AgentCore Gateway | 工具调用面（MCP） | Phase 3 |

---

## 前置条件

- Node.js ≥ 20（推荐 22 LTS，见 `.nvmrc`）
- 已配置 AWS profile `cancercare-game-mvp`（账号 `016998011445`，区域 `us-east-1`）
- 该账号已完成 CDK bootstrap（qualifier `hnb659fds`）——**本仓库开发时已确认就绪**
- **部署前需先挂载一项 IAM 策略**，见 [docs/IAM-PERMISSIONS.md](docs/IAM-PERMISSIONS.md)

验证环境：

```bash
aws sts get-caller-identity --profile cancercare-game-mvp
aws cloudformation describe-stacks --stack-name CDKToolkit --profile cancercare-game-mvp
```

---

## 部署步骤

> **顺序很重要。** CDK 在 **synth 阶段**就会校验 `frontend/dist` 是否存在——
> 如果前端没先构建，`cdk synth` 会直接失败并报一个与真实原因无关的资源错误。

```bash
# 1. 安装依赖（前端与 CDK 是两套独立的 package.json，无 workspace 提升）
npm run install:all

# 2. 构建前端 —— 必须在 cdk deploy 之前
npm run build:web

# 3. 预览将要创建的资源
npm run synth
npm run diff

# 4. 部署（建议按依赖顺序分栈部署，便于定位失败点）
npm --prefix infra/cdk run deploy:data      # ~1 分钟
npm --prefix infra/cdk run deploy:api       # ~2 分钟
npm --prefix infra/cdk run deploy:frontend  # ~5–15 分钟（CloudFront 较慢，属正常）

# 或一次部署全部
npm run deploy
```

部署完成后读取输出：

```bash
aws cloudformation describe-stacks \
  --stack-name CancercareGameMvp-Frontend \
  --query 'Stacks[0].Outputs' --output table --profile cancercare-game-mvp
```

### 验证

一键冒烟测试（覆盖栈状态、API 路由、CloudFront SPA 回退、DynamoDB 结构，共 17 项）：

```bash
./scripts/smoke.sh
# 或指定 profile：./scripts/smoke.sh my-profile
```

手动验证：

```bash
API=$(aws cloudformation describe-stacks --stack-name CancercareGameMvp-Api \
  --query 'Stacks[0].Outputs[?OutputKey==`ApiBaseUrl`].OutputValue' --output text \
  --profile cancercare-game-mvp)

curl -s "$API/api/v1/health"                    # → 200 JSON
curl -s -o /dev/null -w '%{http_code}\n' \
     -X POST "$API/api/v1/sessions"             # → 501（预期的桩响应）

DIST=$(aws cloudformation describe-stacks --stack-name CancercareGameMvp-Frontend \
  --query 'Stacks[0].Outputs[?OutputKey==`DistributionDomainName`].OutputValue' --output text \
  --profile cancercare-game-mvp)
open "https://$DIST"                            # 浏览器打开占位页
```

---

## 本地开发

```bash
npm run dev:web        # Vite 开发服务器
```

前端本地开发若要调用已部署的 API，把 API 地址写入 `frontend/.env.local`（模板见 `frontend/.env.example`）：

```
VITE_API_PROXY_TARGET=https://<api-id>.execute-api.us-east-1.amazonaws.com
```

不配置也能正常启动，只是 `/api/*` 会 404。

---

## 5 分钟 Demo 流程

> 完整可玩版本将在 Phase 2–4 落地。以下是**目标演示脚本**，当前仅有第 0 步可运行。

| # | 步骤 | 当前状态 |
|---|---|---|
| 0 | 打开 CloudFront 域名，看到项目首页与五阶段生命周期 | ✅ 可用 |
| 1 | 创建角色：55 岁男性，长期吸烟 | ⏳ Phase 2 |
| 2 | 触发事件：持续咳嗽两个月 | ⏳ Phase 2 |
| 3 | 玩家选择：主动预约检查 | ⏳ Phase 2 |
| 4 | Agent 生成反馈，解释早筛意义 | ⏳ Phase 3 |
| 5 | 进入治疗阶段，管理复查 / 饮食 / 心理 | ⏳ Phase 2–3 |
| 6 | 最终总结：照护策略优势、不足与健康教育建议 | ⏳ Phase 3 |

---

## 成本与清理

Demo 规模下开销极小：DynamoDB 按需计费 + Lambda 按调用 + CloudFront 固定费用，空闲时接近零。

**部署后请记得清理**，避免长期挂账：

```bash
npm run destroy
```

> `cdk destroy --all` **只作用于本 CDK app 中定义的栈**。同账号下的其他资源
> （例如与本项目无关的 `OncoCareMvpStack`、以及共用的 `CDKToolkit`）结构上不在其作用范围内，不会被触碰。

---

## 已知限制（Phase 0）

- API **无鉴权**，任何持有 URL 的人都能调用（Phase 3 计划引入 Cognito + JWT）
- CORS 允许任意来源 `*`（Phase 2 收敛为 CloudFront 域名）
- 前端为占位页，不调用 API
- 未配置自定义域名与 ACM 证书，直接使用 `*.cloudfront.net`
- 无 CI/CD 流水线
- **请求不存在的静态资源返回 403 而非 404**：OAC + BlockPublicAccess 下桶不授予
  `s3:ListBucket`，S3 对缺失的 key 返回 AccessDenied，CloudFront 原样透传。
  这是预期行为；关键性质是**缺失资源不会被伪装成 200 的 `index.html`**（由 CloudFront
  Function 只重写无扩展名路径来保证）。如需 404 语义，需额外提供错误页并通过
  `ResponsePagePath` 映射——Phase 0 不引入这点额外复杂度

> ⚠️ **大陆网络访问提示**：本项目面向 AWS UG China 挑战，但 CloudFront 默认的
> `*.cloudfront.net` 域名在中国大陆访问可能缓慢或不稳定，且 CloudFront 在中国大陆
> 没有边缘节点（需独立的中国区账号）。**正式演示前请务必在实际演示网络上测试**，
> 备选方案：改用非大陆网络演示、通过 VPN 演示，或临时使用 S3 静态网站端点。

---

## 文档索引

| 文档 | 内容 |
|---|---|
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | 架构设计、端到端请求链路、Phase 3 AgentCore 设计 |
| [docs/DATA-MODEL.md](docs/DATA-MODEL.md) | DynamoDB 单表键模式、GSI、访问模式 |
| [docs/AGENT-DESIGN.md](docs/AGENT-DESIGN.md) | GameMaster / Medical Education / Care Assistant 三个 Agent |
| [docs/ROADMAP.md](docs/ROADMAP.md) | Phase 0–5 里程碑与 Git 规范 |
| [docs/IAM-PERMISSIONS.md](docs/IAM-PERMISSIONS.md) | 部署所需 IAM 权限（现在 vs Phase 3） |
| [chatgpt-analisys-doc.md](chatgpt-analisys-doc.md) | 原始 GDD（项目输入文档，权威需求来源） |

---

## 许可

MIT
