import * as path from 'node:path';
import * as cdk from 'aws-cdk-lib';
import * as apigatewayv2 from 'aws-cdk-lib/aws-apigatewayv2';
import * as integrations from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdaNode from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';
import { AppConfig } from './config';
import { resourceName } from './naming';

export interface ApiStackProps extends cdk.StackProps {
  readonly config: AppConfig;
  /** Table from the Data stack — passed as a construct so the IAM grant stays scoped. */
  readonly table: dynamodb.Table;
  /** ARN of the GameMaster agent runtime, invoked by the narration route. */
  readonly agentRuntimeArn: string;
}

const API_PREFIX = '/api/v1';

/**
 * Stateless layer: one Lambda behind an HTTP API.
 *
 * HTTP API (v2) rather than REST API: cheaper, lower latency, and it has the JWT
 * authorizer Phase 3 needs. The REST-only features that are missing here —
 * usage plans, request validators, WAF — are not required for this project, and
 * CloudFront already provides edge caching.
 */
export class ApiStack extends cdk.Stack {
  /** Full invoke URL, e.g. `https://abc123.execute-api.us-east-1.amazonaws.com`. */
  public readonly apiEndpoint: string;

  /**
   * Host only, no scheme — what a CloudFront origin needs.
   *
   * Derived from `apiId` rather than parsed out of `apiEndpoint`, so the value
   * stays a plain CFN join instead of a token-splitting expression.
   */
  public readonly apiDomainName: string;

  constructor(scope: Construct, id: string, props: ApiStackProps) {
    super(scope, id, props);

    const { config, table, agentRuntimeArn } = props;

    const logGroup = new logs.LogGroup(this, 'GameApiLogs', {
      logGroupName: `/aws/lambda/${resourceName('api')}`,
      retention: config.logRetention,
      removalPolicy: config.removalPolicy,
    });

    const fn = new lambdaNode.NodejsFunction(this, 'GameApiFunction', {
      functionName: resourceName('api'),
      description: 'CancerCare AI Game API — Phase 0 skeleton (health is live, all game routes 501)',
      entry: path.join(__dirname, '..', 'lambda', 'game-api', 'src', 'index.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_22_X,
      // Graviton: cheaper per GB-second, and consistent with AgentCore Runtime,
      // which is ARM64-only. Keeping the whole project on one architecture avoids
      // a nasty surprise when the agent code lands in Phase 3.
      architecture: lambda.Architecture.ARM_64,
      memorySize: 512,
      // Sized for the narration route, which waits on the agent runtime and the
      // model. The binding limit is API Gateway's ~30 s integration timeout —
      // go over that and the caller sees an opaque 504 instead of the real
      // error. The agent's own provider timeout is set below both.
      timeout: cdk.Duration.seconds(29),
      tracing: lambda.Tracing.ACTIVE,
      logGroup,
      environment: {
        TABLE_NAME: table.tableName,
        STAGE: config.stage,
        LOG_LEVEL: config.stage === 'prod' ? 'info' : 'debug',
        AGENT_RUNTIME_ARN: agentRuntimeArn,
      },
      bundling: {
        minify: true,
        sourceMap: true,
        target: 'node22',
        // Bundle the AWS SDK rather than relying on the one baked into the
        // Node 22 runtime. CDK externalises `@aws-sdk/*` by default, which
        // leaves the function depending on whatever SDK version AWS happens to
        // ship — and it is not documented that every package we use (notably
        // `@aws-sdk/lib-dynamodb`) is present in the runtime at all. A missing
        // package would surface as `MODULE_NOT_FOUND` on cold start and nothing
        // sooner. Bundling trades a larger artifact for a pinned, verifiable
        // dependency set.
        externalModules: [],
      },
    });

    // Least privilege: read/write on this one table, nothing else.
    table.grantReadWriteData(fn);

    // Invoke the agent runtime. Scoped to the runtime and its endpoints — the
    // runtime ARN alone is not sufficient, AgentCore also authorises the
    // `/runtime-endpoint/*` form.
    //
    // Both actions are needed, and they are not interchangeable: the Lambda
    // passes `runtimeUserId` so Memory is scoped to the right actor, and that
    // user context is what makes the service demand `InvokeAgentRuntimeForUser`.
    // Granting only `InvokeAgentRuntime` produces an AccessDenied at call time.
    fn.addToRolePolicy(
      new iam.PolicyStatement({
        sid: 'InvokeGameMasterRuntime',
        actions: [
          'bedrock-agentcore:InvokeAgentRuntime',
          'bedrock-agentcore:InvokeAgentRuntimeForUser',
        ],
        resources: [agentRuntimeArn, `${agentRuntimeArn}/*`],
      }),
    );

    const api = new apigatewayv2.HttpApi(this, 'GameApi', {
      apiName: resourceName('api'),
      description: 'CancerCare AI Game — game loop API',
      createDefaultStage: true,
      corsPreflight: {
        // Phase 2 narrows this to the CloudFront distribution domain.
        allowOrigins: ['*'],
        allowMethods: [apigatewayv2.CorsHttpMethod.ANY],
        allowHeaders: ['content-type'],
      },
    });

    const integration = new integrations.HttpLambdaIntegration('GameApiIntegration', fn);

    const routes: ReadonlyArray<{
      readonly path: string;
      readonly methods: readonly apigatewayv2.HttpMethod[];
    }> = [
      { path: `${API_PREFIX}/health`, methods: [apigatewayv2.HttpMethod.GET] },
      { path: `${API_PREFIX}/players`, methods: [apigatewayv2.HttpMethod.POST] },
      { path: `${API_PREFIX}/players/{playerId}`, methods: [apigatewayv2.HttpMethod.GET] },
      { path: `${API_PREFIX}/sessions`, methods: [apigatewayv2.HttpMethod.POST] },
      { path: `${API_PREFIX}/sessions/{sessionId}`, methods: [apigatewayv2.HttpMethod.GET] },
      {
        path: `${API_PREFIX}/sessions/{sessionId}/events`,
        methods: [apigatewayv2.HttpMethod.GET],
      },
      {
        path: `${API_PREFIX}/sessions/{sessionId}/choices`,
        methods: [apigatewayv2.HttpMethod.POST],
      },
      {
        path: `${API_PREFIX}/sessions/{sessionId}/advance`,
        methods: [apigatewayv2.HttpMethod.POST],
      },
      {
        path: `${API_PREFIX}/sessions/{sessionId}/narration`,
        methods: [apigatewayv2.HttpMethod.POST],
      },
    ];

    for (const route of routes) {
      api.addRoutes({ path: route.path, methods: [...route.methods], integration });
    }

    this.apiEndpoint = api.apiEndpoint;
    this.apiDomainName = `${api.apiId}.execute-api.${this.region}.amazonaws.com`;

    new cdk.CfnOutput(this, 'ApiBaseUrl', {
      value: api.apiEndpoint,
      description: 'Base URL of the game API (no trailing slash)',
    });

    new cdk.CfnOutput(this, 'FunctionName', {
      value: fn.functionName,
      description: 'Lambda function serving the game API',
    });
  }
}
