import * as cdk from 'aws-cdk-lib';
import * as logs from 'aws-cdk-lib/aws-logs';

/**
 * Deployment configuration.
 *
 * Account and region are pinned deliberately rather than read from
 * `CDK_DEFAULT_ACCOUNT` / `CDK_DEFAULT_REGION`. An environment-agnostic stack
 * cannot publish assets, and resolving the environment through a context lookup
 * makes `cdk synth` machine-dependent. These are the verified values for the
 * `cancercare-game-mvp` profile.
 */
export const AWS_ACCOUNT = '016998011445';
export const AWS_REGION = 'us-east-1';

/** Short slug used for AWS resource names. */
export const APP_NAME = 'cancercare-game-mvp';

/**
 * SSM Parameter Store name holding the DeepSeek API key as a SecureString.
 *
 * Deliberately not an environment variable: env vars on a runtime version are
 * readable by anyone with control-plane read access, and they surface in the
 * console. The value is created out-of-band — see docs/DEPLOYMENT.md.
 */
export const DEEPSEEK_API_KEY_PARAMETER = '/cancercare-game-mvp/deepseek-api-key';

/** PascalCase prefix used for CloudFormation stack names. */
export const STACK_PREFIX = 'CancercareGameMvp';

export const SUPPORTED_STAGES = ['dev', 'prod'] as const;
export type Stage = (typeof SUPPORTED_STAGES)[number];

export interface AppConfig {
  readonly account: string;
  readonly region: string;
  readonly stage: Stage;
  readonly appName: string;
  readonly stackPrefix: string;
  /** `DESTROY` in dev so the stack can be torn down; `RETAIN` in prod. */
  readonly removalPolicy: cdk.RemovalPolicy;
  /** Empty S3 buckets on delete. Never combined with `RETAIN` — see below. */
  readonly autoDeleteObjects: boolean;
  readonly pointInTimeRecovery: boolean;
  readonly logRetention: logs.RetentionDays;
  readonly tags: { readonly [key: string]: string };
}

/**
 * Build the config for this app.
 *
 * `stage` comes from CDK context (`-c stage=prod`), defaulting to `dev`. The
 * removal policy and `autoDeleteObjects` are derived from the *same* branch on
 * purpose: `autoDeleteObjects` with `RemovalPolicy.RETAIN` is contradictory and
 * would silently destroy retained data.
 */
export function loadConfig(app: cdk.App): AppConfig {
  const raw = app.node.tryGetContext('stage') ?? 'dev';
  if (!SUPPORTED_STAGES.includes(raw)) {
    throw new Error(
      `Unsupported stage "${raw}". Expected one of: ${SUPPORTED_STAGES.join(', ')}`,
    );
  }
  const stage = raw as Stage;
  const isProd = stage === 'prod';

  return {
    account: AWS_ACCOUNT,
    region: AWS_REGION,
    stage,
    appName: APP_NAME,
    stackPrefix: STACK_PREFIX,
    removalPolicy: isProd ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
    autoDeleteObjects: !isProd,
    pointInTimeRecovery: true,
    logRetention: isProd ? logs.RetentionDays.ONE_MONTH : logs.RetentionDays.ONE_WEEK,
    tags: {
      Project: 'CancerCareAIGame',
      Stage: stage,
      ManagedBy: 'CDK',
      Repository: 'cancer-care-ai-game',
    },
  };
}
