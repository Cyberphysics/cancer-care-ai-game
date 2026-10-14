# CancerCare AI Game

**生命守护者** — 一个由 AI Agent 驱动的肿瘤健康照护模拟游戏

> 面向 AWS User Group China Challenge · 基于 Amazon Bedrock AgentCore

---

## 当前状态：Phase 2 — 游戏核心

**游戏机制已完整可玩（通过 API），但还没有游戏界面。** 五阶段照护循环由规则引擎驱动，**完全不依赖任何 LLM**；Agent 将在 Phase 3 引入。

| 已实现 | 尚未实现 |
|---|---|
| 五阶段规则引擎（事件池、选择判定、状态演进） | AgentCore Runtime / Memory / Gateway（Phase 3） |
| HTTP API 8 条路由全部真实实现 | 前端游戏界面（Phase 4） |
| DynamoDB 单表 + 稀疏 GSI + 四项原子事务 | 玩家鉴权（Phase 3 计划引入 Cognito） |
| 双乐观锁 + 幂等提交保护 | 多癌种、成就系统 |
| S3 + CloudFront（OAC）+ `/api/*` 反代 | |
| 79 条单元测试 + 端到端冒烟脚本 | |

### 快速试玩

```bash
./scripts/smoke.sh --full   # 完整通关一遍五阶段流程，并校验落库结果
```

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

### 当前已部署（Phase 2）

```
   玩家 ──►  CloudFront  ──── / 与 /assets/* ────►  S3 (React 构建产物)
                 │
                 └─── /api/*（反代，同源无 CORS）──►  API Gateway (HTTP API v2)
                                                        │
                                                        ▼
                                             Lambda (Node 22 / ARM64)
                                             规则引擎 + 四项原子事务
                                                        │
                                                        ▼
                                                  DynamoDB 单表
                                               PK/SK + 稀疏 GSI + 乐观锁
```

前端用**相对路径** `/api/v1/...` 调用，因此无需把 API 地址烘焙进构建产物、无构建顺序约束、无 CORS。
本地开发走 Vite 同名代理，线上走 CloudFront，同一份代码。

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
│   │   └── frontend-stack.ts    # S3 + CloudFront + OAC + /api/* 反代
│   ├── lambda/game-api/src/
│   │   ├── router.ts            # 路由分发 + 领域错误 → HTTP 状态码
│   │   ├── handlers.ts          # 7 条路由的组装层
│   │   ├── repo.ts              # 唯一接触 DynamoDB 的模块
│   │   ├── domain/              # ★ 纯函数：规则引擎与健康值语义
│   │   ├── content/             # ★ 合成病例与事件池（纯数据）
│   │   └── lib/                 # 键构造、时间戳、DynamoDB 客户端
│   └── test/                    # 79 条单元测试（CDK + 规则引擎）
├── frontend/                    # Vite + React + TypeScript
│   └── src/api/client.ts        # 相对路径的 API 客户端
├── scripts/
│   ├── smoke.sh                 # 部署后冒烟（栈 / 静态托管 / DynamoDB / 游戏循环）
│   └── game-loop-check.py       # 游戏循环端到端检查
├── docs/
│   ├── ARCHITECTURE.md          # 架构、Phase 2 链路、Phase 3 AgentCore 与模型选型
│   ├── GAME-RULES.md            # ★ 规则引擎：阶段流转、健康模型、事务与并发
│   ├── DATA-MODEL.md            # DynamoDB 单表设计
│   ├── AGENT-DESIGN.md          # 三个 Agent 的职责与工具契约
│   ├── ROADMAP.md               # MVP Git roadmap
│   └── IAM-PERMISSIONS.md       # 部署所需 IAM 权限
├── chatgpt-analisys-doc.md      # 原始 GDD（项目输入文档）
└── local-dev-env-info.md        # AWS 开发环境信息
```

---

## API 路由

全部已实现。基路径 `/api/v1`。

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/health` | 存活检查，返回事件池规模与阶段列表 |
| `POST` | `/players` | 创建玩家（家庭健康守护者） |
| `GET` | `/players/{playerId}` | 读取玩家档案 |
| `POST` | `/sessions` | 创建会话：一次事务原子写入会话 + 合成患者 + 首个事件 |
| `GET` | `/sessions/{sessionId}` | 读取会话、患者状态与当前事件 |
| `GET` | `/sessions/{sessionId}/events` | 完整事件时间线 |
| `POST` | `/sessions/{sessionId}/choices` | **核心游戏循环**：提交选择 |
| `POST` | `/sessions/{sessionId}/advance` | 推进到下一阶段（需当前阶段事件已答完） |

错误语义：`404` 资源不存在 · `400` 请求本身有误 · **`409` 请求合法但处于冲突状态（重复提交、版本过期、未答完就推进），客户端应重读后重试**。

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
| Bedrock | LLM 推理（`deepseek.v3.2` 或 Claude） | Phase 3（**当前被 allowlisting 阻断**） |
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

一键冒烟测试，覆盖栈状态、静态托管、CloudFront→API 反代、DynamoDB 结构与完整游戏循环：

```bash
./scripts/smoke.sh          # 基础检查 + 游戏循环（约 38 项）
./scripts/smoke.sh --full   # 额外完整通关五阶段（约 44 项）
```

同时验证**行为**与**落库结果**——例如它不仅检查 `POST /choices` 返回 200，还会直接查 DynamoDB 确认 Player 条目确实不含稀疏索引属性（这一点 synth 与类型系统都发现不了）。

手动验证：

```bash
API=$(aws cloudformation describe-stacks --stack-name CancercareGameMvp-Api \
  --query 'Stacks[0].Outputs[?OutputKey==`ApiBaseUrl`].OutputValue' --output text \
  --profile cancercare-game-mvp)

curl -s "$API/api/v1/health"                     # → 200，含事件池规模
PID=$(curl -s -X POST "$API/api/v1/players" \
      -H 'content-type: application/json' \
      -d '{"nickname":"守护者"}' | python3 -c 'import sys,json;print(json.load(sys.stdin)["playerId"])')
curl -s -X POST "$API/api/v1/sessions" \
     -H 'content-type: application/json' -d "{\"playerId\":\"$PID\"}"
# → 201，含合成患者、首事件与选项；事件不含 impact（答案不外泄）

DIST=$(aws cloudformation describe-stacks --stack-name CancercareGameMvp-Frontend \
  --query 'Stacks[0].Outputs[?OutputKey==`DistributionDomainName`].OutputValue' --output text \
  --profile cancercare-game-mvp)
open "https://$DIST"                             # 占位页 + API 连通性卡片
```

单元测试：

```bash
npm --prefix infra/cdk test     # 79 条
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

> 游戏机制（步骤 0–5）已通过 API 完整可用；图形界面在 Phase 4，Agent 生成内容在 Phase 3。

| # | 步骤 | 当前状态 |
|---|---|---|
| 0 | 打开 CloudFront 域名，看到项目首页与 API 连通性卡片 | ✅ |
| 1 | 创建角色：55 岁男性，长期吸烟 | ✅ `POST /players` |
| 2 | 触发事件：持续咳嗽两个月 | ✅ `POST /sessions` |
| 3 | 玩家选择：主动预约检查，立即看到 impact 与解释 | ✅ `POST /choices` |
| 4 | 走完一个阶段，显式推进；重复提交被拒 | ✅ `POST /advance` |
| 5 | 完成五阶段，得到最终 QoL 与完整事件时间线 | ✅ |
| 6 | Agent 生成个性化反馈与总结 | ⏳ Phase 3 |

一键跑完上述全部流程：

```bash
./scripts/smoke.sh --full
```

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

## 已知限制

- API **无鉴权**，任何持有 URL 的人都能调用（Phase 3 计划引入 Cognito + JWT）
- API 自身的 CORS 仍允许任意来源 `*`。经 CloudFront 访问时是同源、不涉及 CORS；这一项只在直接调用 API Gateway 时生效（Phase 3 一并收敛）
- 前端是占位页，只做连通性检查，**没有游戏界面**（Phase 4）
- 未配置自定义域名与 ACM 证书，直接使用 `*.cloudfront.net`
- 无 CI/CD 流水线
- **Bedrock 不可用**：账号被 bedrock-allowlisting 阻断，Phase 3 的前置阻塞项，详见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) §6.3
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
| [docs/GAME-RULES.md](docs/GAME-RULES.md) | 规则引擎：四维健康模型、阶段流转、事件池、事务与并发 |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | 架构、Phase 2 请求链路、Phase 3 AgentCore 设计与模型选型 |
| [docs/DATA-MODEL.md](docs/DATA-MODEL.md) | DynamoDB 单表键模式、GSI、访问模式、乐观锁 |
| [docs/AGENT-DESIGN.md](docs/AGENT-DESIGN.md) | GameMaster / Medical Education / Care Assistant 三个 Agent |
| [docs/ROADMAP.md](docs/ROADMAP.md) | Phase 0–5 里程碑与 Git 规范 |
| [docs/IAM-PERMISSIONS.md](docs/IAM-PERMISSIONS.md) | 部署所需 IAM 权限（现在 vs Phase 3） |
| [chatgpt-analisys-doc.md](chatgpt-analisys-doc.md) | 原始 GDD（项目输入文档，权威需求来源） |

---

## 许可

MIT
