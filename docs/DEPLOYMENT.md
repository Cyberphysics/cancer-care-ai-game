# 部署指南

面向从零开始部署本项目的操作手册。

---

## 0. 概要

| 栈 | 内容 | 部署耗时 |
|---|---|---|
| `CancercareGameMvp-Data` | DynamoDB 单表 | ~1 分钟 |
| `CancercareGameMvp-Agent` | AgentCore Memory + Runtime | ~3–5 分钟 |
| `CancercareGameMvp-Api` | Lambda + HTTP API | ~2 分钟 |
| `CancercareGameMvp-Frontend` | S3 + CloudFront | ~5–15 分钟 |

依赖关系：`Data` ← `Api` ← `Frontend`，以及 `Agent` ← `Api`。CDK 会自动解析顺序。

> **两个构建产物必须先于 `cdk synth` 存在**，否则 synth 会以与本因无关的资源错误失败：
> - `frontend/dist/`（`npm run build:web`）
> - `agents/game-master/dist/game-master.zip`（`npm run build:agent`）

---

## 1. 一次性准备

### 1.1 写入 DeepSeek API key

key **不进入代码仓库、不进环境变量、不进对话记录**，而是存进 SSM Parameter Store：

```bash
aws ssm put-parameter \
  --name /cancercare-game-mvp/deepseek-api-key \
  --type SecureString \
  --value 'sk-你的真实key' \
  --region us-east-1 \
  --profile cancercare-game-mvp
```

Agent 在**运行时**读取它（`ssm:GetParameter` + `WithDecryption`），而不是在部署时注入。
理由：Runtime 的环境变量对任何有控制面读权限的人可见，也会显示在控制台上。

更新 key 用同一条命令加 `--overwrite`。Agent 会缓存它，因此更新后需要触发一次新的
runtime 版本（重新 `cdk deploy`）或等待 microVM 回收。

### 1.2 挂载 AgentCore IAM 权限

部署身份需要以下权限。**建议作为客户管理策略**（如 `CancerCareGameMvp-AgentCorePolicy`）挂载，
**不要**使用 AWS 托管策略 `BedrockAgentCoreFullAccess` —— 它含有
`bedrock-agentcore:InvokeAgentRuntimeCommand`，该动作可在 Runtime 的 microVM 内以 root
执行 shell 并读取执行角色凭据。

```json
{
  "Version": "2012-10-17",
  "Statement": [{
    "Sid": "AgentCoreForCancercareGame",
    "Effect": "Allow",
    "Action": [
      "bedrock-agentcore:CreateAgentRuntime", "bedrock-agentcore:GetAgentRuntime",
      "bedrock-agentcore:UpdateAgentRuntime", "bedrock-agentcore:DeleteAgentRuntime",
      "bedrock-agentcore:ListAgentRuntimes",
      "bedrock-agentcore:CreateAgentRuntimeEndpoint", "bedrock-agentcore:GetAgentRuntimeEndpoint",
      "bedrock-agentcore:UpdateAgentRuntimeEndpoint", "bedrock-agentcore:DeleteAgentRuntimeEndpoint",
      "bedrock-agentcore:ListAgentRuntimeEndpoints",
      "bedrock-agentcore:CreateMemory", "bedrock-agentcore:GetMemory",
      "bedrock-agentcore:UpdateMemory", "bedrock-agentcore:DeleteMemory",
      "bedrock-agentcore:ListMemories",
      "bedrock-agentcore:CreateGateway", "bedrock-agentcore:GetGateway",
      "bedrock-agentcore:UpdateGateway", "bedrock-agentcore:DeleteGateway",
      "bedrock-agentcore:ListGateways",
      "bedrock-agentcore:CreateGatewayTarget", "bedrock-agentcore:GetGatewayTarget",
      "bedrock-agentcore:UpdateGatewayTarget", "bedrock-agentcore:DeleteGatewayTarget",
      "bedrock-agentcore:ListGatewayTargets", "bedrock-agentcore:SynchronizeGatewayTargets",
      "bedrock-agentcore:InvokeAgentRuntime",
      "bedrock-agentcore:TagResource", "bedrock-agentcore:UntagResource",
      "bedrock-agentcore:ListTagsForResource"
    ],
    "Resource": "*"
  }]
}
```

连同 [IAM-PERMISSIONS.md](IAM-PERMISSIONS.md) §A 中的 `STS-and-Cloudfront` 策略一起生效。

验证：

```bash
aws iam simulate-principal-policy \
  --policy-source-arn arn:aws:iam::016998011445:user/cancercare-dev-robot \
  --action-names bedrock-agentcore:CreateAgentRuntime bedrock-agentcore:CreateMemory \
  --resource-arns '*' --query 'EvaluationResults[].{Action:EvalActionName,Decision:EvalDecision}' \
  --output table --profile cancercare-game-mvp
```

---

## 2. 构建

```bash
npm run install:all        # 前端 + CDK 依赖
npm run build:agent        # arm64 zip（交叉打包，无需 Docker）
npm run build:web          # 前端 dist
```

### 关于 `build:agent`

AgentCore Runtime **仅支持 ARM64**，而开发机通常是 x86_64。脚本用
`uv pip install --python-platform aarch64-manylinux2014 --only-binary :all:`
交叉解析预编译 wheel，并在打包前**逐个校验 `.so` 文件的架构**——不通过就中止。

`--only-binary :all:` 是关键：没有它，pip 会悄悄回退到源码分发包并在本机编译，
产出一个架构错误的 zip，直到运行时才以 `exec format error` 爆出来。

无需 Docker、无需 CodeBuild。

---

## 3. 部署

```bash
# 按依赖顺序分栈部署，便于定位失败点
npm --prefix infra/cdk run deploy:agent      # Memory + Runtime
npm --prefix infra/cdk run deploy:api        # 含 narration 路由
npm --prefix infra/cdk run deploy:frontend

# 或一次全部
npm run deploy
```

---

## 4. 验证

```bash
./scripts/smoke.sh          # 基础设施 + 游戏循环（约 38 项）
./scripts/smoke.sh --full   # 额外完整通关
```

AI 层单独验证（第一次调用会较慢：Runtime 冷启动 + 模型生成）：

```bash
API=$(aws cloudformation describe-stacks --stack-name CancercareGameMvp-Api \
  --query 'Stacks[0].Outputs[?OutputKey==`ApiBaseUrl`].OutputValue' --output text \
  --profile cancercare-game-mvp)

# 需要先有一个走完至少一步的会话，SID 从 /sessions 拿
curl -s -X POST "$API/api/v1/sessions/$SID/narration" \
  -H 'content-type: application/json' -d '{"kind":"summary"}' | python3 -m json.tool
```

**预期**：首次 `"cached": false` 且耗时数秒；再请求一次 `"cached": true` 且立刻返回。

---

## 5. 排错

| 症状 | 原因 |
|---|---|
| `cdk synth` 报与资源无关的文件错误 | `frontend/dist` 或 `game-master.zip` 未构建 |
| `Runtime` 创建失败，提示 `exec format error` | zip 不是 ARM64 —— 见 §2 |
| Agent 栈创建 `AWS::Logs::Delivery` 失败，`InvalidRequest: X-Ray Delivery Destination is supported with CloudWatch Logs as a Trace Segment Destination` | Runtime 的 trace 投递要求**账号级**把 X-Ray 的 trace segment destination 切成 CloudWatch Logs（`aws xray update-trace-segment-destination`）。该设置是账号级的，会同时搬走同账号其他项目的 trace，所以默认关闭；确实要开再 `cdk deploy -c agentTracing=true`。见 `lib/config.ts` 的 `agentTracing` |
| narration 返回 502 `UPSTREAM_FAILED` | Agent 侧问题：SSM key 未写入/错误、模型配额、或出网被阻 |
| narration 请求 504 | 超过 API Gateway 的 30 秒集成超时（HTTP API 的硬上限，不可提升）；检查模型延迟 |
| 首次调用非常慢 | Runtime microVM 冷启动，属正常；结果会被缓存 |
| Memory 回忆始终为空 | 命名空间不匹配，见 `agents/game-master/app/memory.py` 的 `PLAYER_NAMESPACE_PREFIX` |

> **游戏本身不受 AI 层影响。** narration 返回 502 时，五阶段流程、状态更新、事件时间线
> 全部照常工作。这是刻意的设计——见 [ARCHITECTURE.md](ARCHITECTURE.md) §1。

---

## 6. 清理

```bash
npm run destroy
```

> ⚠️ Agent 栈含 Memory 与 Runtime，**不清理会持续计费**。
> `cdk destroy --all` 只作用于本 CDK app 定义的栈，同账号下的其他资源不受影响。
