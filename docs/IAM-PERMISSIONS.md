# IAM 权限

本项目的部署身份为 IAM 用户 `cancercare-dev-robot`（profile `cancercare-game-mvp`，账号 `016998011445`）。

> **本文的结论来自实测，而非推测。** 方法：用 `aws iam simulate-principal-policy` 做权限预演，
> 并直接读取 `DeveloperFullAccessPolicy` 的策略原文逐条比对。

---

## A. 现在就需要（部署 Phase 0 骨架）

### A.1 已有权限盘点

已挂载的 `DeveloperFullAccessPolicy` 实际只授予 **10 项全权**：

`apigateway:*` · `ecr:*` · `ssm:*` · `iam:*` · `logs:*` · `dynamodb:*` · `s3:*` · `cloudformation:*` · `lambda:*` · `ses:*`

外加 AWS 托管策略 `IAMFullAccess`，以及一条 SES 内联策略。

**结论：本项目需要的 CloudFormation / S3 / DynamoDB / Lambda / API Gateway / IAM / Logs 权限
已全部覆盖，无需补充。**

### A.2 缺口（仅两项，均为 `implicitDeny` 实测确认）

| 缺失动作 | 为什么需要 | 精确资源范围 |
|---|---|---|
| `sts:AssumeRole`<br>`sts:TagSession` | CDK 部署的本质是**承担 bootstrap 创建的部署角色**。当前策略中**没有任何 sts 条目**，因此 `cdk deploy` 会失败。`TagSession` 是必需的：CDK 会给会话打标签，缺少它会报 AccessDenied | `arn:aws:iam::016998011445:role/cdk-hnb659fds-*` |
| `cloudfront:*` | 前端栈需要创建 CloudFront 分发、OAC 与 **CloudFront Function**（SPA 回退用）。当前策略中**完全没有 cloudfront 条目** | `*`（CloudFront 为全球服务） |

> 已核对 bootstrap 角色的信任策略：委托方为 `arn:aws:iam::016998011445:root` 且无 ExternalId 条件。
> **因此只要给该用户补上 sts 权限即可生效，无需改动角色本身。**

### A.3 可直接挂载的策略

建议作为**客户管理策略**（如 `CancerCareGameMvp-DeployPolicy`）创建后挂载，而非内联 JSON——
可版本化、可 diff、可复用，这才是「最小权限」原则真正要求的形态。

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "AssumeCdkBootstrapRoles",
      "Effect": "Allow",
      "Action": ["sts:AssumeRole", "sts:TagSession"],
      "Resource": "arn:aws:iam::016998011445:role/cdk-hnb659fds-*"
    },
    {
      "Sid": "CloudFrontForFrontendStack",
      "Effect": "Allow",
      "Action": [
        "cloudfront:CreateDistribution", "cloudfront:UpdateDistribution",
        "cloudfront:GetDistribution", "cloudfront:GetDistributionConfig",
        "cloudfront:DeleteDistribution", "cloudfront:ListDistributions",
        "cloudfront:CreateOriginAccessControl", "cloudfront:UpdateOriginAccessControl",
        "cloudfront:GetOriginAccessControl", "cloudfront:DeleteOriginAccessControl",
        "cloudfront:ListOriginAccessControls",
        "cloudfront:CreateFunction", "cloudfront:UpdateFunction",
        "cloudfront:PublishFunction", "cloudfront:DescribeFunction",
        "cloudfront:GetFunction", "cloudfront:DeleteFunction",
        "cloudfront:CreateInvalidation", "cloudfront:GetInvalidation",
        "cloudfront:TagResource", "cloudfront:UntagResource",
        "cloudfront:ListTagsForResource"
      ],
      "Resource": "*"
    }
  ]
}
```

**dev 环境想省事的话**，第二条可简化为 `"Action": "cloudfront:*"`。

### A.4 如果部署仍被拒绝

上面的清单是**推导所得**——我已确认这两项当前缺失，但无法穷举 CDK 在部署全过程中
可能需要的每一个动作。若 `cdk deploy` 仍报 `AccessDenied`：

1. **读错误信息**，它会直接给出缺失的 action 名
2. 追加到上面的策略中
3. 重新部署

同理，若 `DeveloperFullAccessPolicy` 的范围比你预期的窄，可按下表补充对应服务的动作：

| 服务 | 动作 |
|---|---|
| DynamoDB | `CreateTable` `DescribeTable` `UpdateTable` `DeleteTable` `DescribeTimeToLive` `UpdateTimeToLive` `DescribeContinuousBackups` `UpdateContinuousBackups` `TagResource` `UntagResource` `ListTagsOfResource` |
| Lambda | `CreateFunction` `UpdateFunctionCode` `UpdateFunctionConfiguration` `GetFunction` `DeleteFunction` `AddPermission` `RemovePermission` `PublishVersion` `TagResource` |
| API Gateway (v2) | `POST`/`PATCH`/`DELETE`/`GET` on `arn:aws:apigateway:us-east-1::/v2/apis*` |
| CloudWatch Logs | `CreateLogGroup` `DeleteLogGroup` `PutRetentionPolicy` `TagResource` `DescribeLogGroups` |

> ⚠️ **不要**授予 `cloudformation:*` on `*`。当前策略中的 `cloudformation:*` 已经比较宽泛，
> 同账号下存在其他项目（如 `OncoCareMvpStack`）。如条件允许，可将其收敛到
> `arn:aws:cloudformation:us-east-1:016998011445:stack/CancercareGameMvp-*/*` 与 `.../CDKToolkit/*`。

---

## B. Phase 3 才需要（Bedrock / AgentCore）

> ⚠️ **首要认知：Anthropic 模型在 Bedrock 上的访问权不是 IAM 权限。**
>
> 它是**账号级 + 区域级**授权，须通过 Bedrock 控制台的 Model access 用例申报表单开通。
> **任何 IAM 策略都无法替代它，且审批需要时间——应在 Phase 3 开始前数周提交。**
>
> 典型症状：`bedrock:ListFoundationModels` 成功，但 `InvokeModel` 返回
> `AccessDeniedException: model access not granted`。

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "BedrockModels",
      "Effect": "Allow",
      "Action": [
        "bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream",
        "bedrock:Converse", "bedrock:ConverseStream",
        "bedrock:GetFoundationModel", "bedrock:ListFoundationModels",
        "bedrock:GetInferenceProfile", "bedrock:ListInferenceProfiles",
        "bedrock:GetFoundationModelAvailability"
      ],
      "Resource": "*"
    },
    {
      "Sid": "AgentCoreControlPlane",
      "Effect": "Allow",
      "Action": [
        "bedrock-agentcore:CreateAgentRuntime", "bedrock-agentcore:UpdateAgentRuntime",
        "bedrock-agentcore:DeleteAgentRuntime", "bedrock-agentcore:GetAgentRuntime",
        "bedrock-agentcore:ListAgentRuntimes", "bedrock-agentcore:ListAgentRuntimeVersions",
        "bedrock-agentcore:CreateAgentRuntimeEndpoint", "bedrock-agentcore:UpdateAgentRuntimeEndpoint",
        "bedrock-agentcore:DeleteAgentRuntimeEndpoint", "bedrock-agentcore:GetAgentRuntimeEndpoint",
        "bedrock-agentcore:ListAgentRuntimeEndpoints",
        "bedrock-agentcore:CreateMemory", "bedrock-agentcore:UpdateMemory",
        "bedrock-agentcore:DeleteMemory", "bedrock-agentcore:GetMemory",
        "bedrock-agentcore:ListMemories",
        "bedrock-agentcore:CreateGateway", "bedrock-agentcore:UpdateGateway",
        "bedrock-agentcore:DeleteGateway", "bedrock-agentcore:GetGateway",
        "bedrock-agentcore:ListGateways",
        "bedrock-agentcore:CreateGatewayTarget", "bedrock-agentcore:UpdateGatewayTarget",
        "bedrock-agentcore:DeleteGatewayTarget", "bedrock-agentcore:GetGatewayTarget",
        "bedrock-agentcore:ListGatewayTargets", "bedrock-agentcore:SynchronizeGatewayTargets",
        "bedrock-agentcore:TagResource", "bedrock-agentcore:UntagResource",
        "bedrock-agentcore:ListTagsForResource"
      ],
      "Resource": "*"
    },
    {
      "Sid": "AgentCoreDataPlane",
      "Effect": "Allow",
      "Action": [
        "bedrock-agentcore:InvokeAgentRuntime",
        "bedrock-agentcore:StopRuntimeSession",
        "bedrock-agentcore:CreateEvent", "bedrock-agentcore:GetEvent",
        "bedrock-agentcore:ListEvents", "bedrock-agentcore:DeleteEvent",
        "bedrock-agentcore:ListSessions", "bedrock-agentcore:ListActors",
        "bedrock-agentcore:RetrieveMemoryRecords", "bedrock-agentcore:GetMemoryRecord",
        "bedrock-agentcore:ListMemoryRecords",
        "bedrock-agentcore:BatchCreateMemoryRecords",
        "bedrock-agentcore:BatchUpdateMemoryRecords",
        "bedrock-agentcore:BatchDeleteMemoryRecords",
        "bedrock-agentcore:StartMemoryExtractionJob",
        "bedrock-agentcore:ListMemoryExtractionJobs"
      ],
      "Resource": "*"
    },
    {
      "Sid": "AgentCorePassRole",
      "Effect": "Allow",
      "Action": "iam:PassRole",
      "Resource": "arn:aws:iam::016998011445:role/*AgentCore*",
      "Condition": {
        "StringEquals": { "iam:PassedToService": "bedrock-agentcore.amazonaws.com" }
      }
    }
  ]
}
```

### B.1 关于这份策略的诚实说明

- **动作名基本可靠**：由 CLI 的实际操作名（kebab-case）机械转换为 IAM CamelCase
  （如 `retrieve-memory-records` → `RetrieveMemoryRecords`），这个过程不易出错。
- **⚠️ `InvokeAgentRuntime` 的资源 ARN 格式未证实**：因此上表中用了 `"Resource": "*"`。
  在 Phase 3 能用 `aws bedrock-agentcore-control get-agent-runtime` 读到真实 ARN 后再收敛。
  **故意留宽，好过猜一个不匹配的 ARN 格式——后者会产生令人困惑的运行时 AccessDenied。**
- **SigV4 调用 Gateway MCP 的 IAM action 名未证实**：两个 CLI 面上都不存在 `invoke-gateway`
  类操作。这正是 [ARCHITECTURE.md](ARCHITECTURE.md) §5.4 推荐 `CUSTOM_JWT` 入站鉴权的原因。
- **`policy/*` 与 `evaluation/*` 相关动作已省略**：其稳定性尚有冲突（正式模块 vs alpha 包），
  确认前不要使用。

### B.2 安全提示：不要直接挂载 `BedrockAgentCoreFullAccess`

AWS 托管策略 `BedrockAgentCoreFullAccess` 内含 `bedrock-agentcore:InvokeAgentRuntimeCommand`，
该动作可在 Runtime 的 microVM 内**以 root 执行 shell 命令**，并可从实例元数据端点读取执行角色的
凭据。这是一种权限提升路径。

**建议**：使用上面的自定义策略（按需增补），或用 SCP 显式收敛该动作，不要整条挂载托管策略。

### B.3 跨区域推理的授权陷阱

当前 Claude 模型在 Bedrock 上普遍要求跨区域推理（inference profile）。调用 `InvokeModel` 需要
**同时**在以下两处获得授权：

1. 推理配置文件 ARN
2. **该配置文件路由到的每一个区域的底层基础模型 ARN**

这是「IAM 策略看起来完全正确却仍然 AccessDenied」的最常见原因。

---

## C. 相关资源

- Bootstrap 状态：qualifier `hnb659fds`，BootstrapVersion `32`，资产桶
  `cdk-hnb659fds-assets-016998011445-us-east-1`
- 完整的 CDK bootstrap 角色清单：
  `cdk-hnb659fds-{deploy,file-publishing,image-publishing,lookup,cfn-exec}-role-016998011445-us-east-1`
- 部署与清理命令见 [README.md](../README.md)
