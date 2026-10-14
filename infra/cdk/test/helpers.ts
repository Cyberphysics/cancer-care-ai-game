import * as cdk from 'aws-cdk-lib';
import * as logs from 'aws-cdk-lib/aws-logs';
import { AppConfig, AWS_ACCOUNT, AWS_REGION, STACK_PREFIX } from '../lib/config';

/**
 * A deterministic config for tests. Mirrors the `dev` stage so the assertions
 * describe the environment that actually gets deployed.
 */
export function testConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    account: AWS_ACCOUNT,
    region: AWS_REGION,
    stage: 'dev',
    appName: 'cancercare-game-mvp',
    stackPrefix: STACK_PREFIX,
    removalPolicy: cdk.RemovalPolicy.DESTROY,
    autoDeleteObjects: true,
    pointInTimeRecovery: true,
    logRetention: logs.RetentionDays.ONE_WEEK,
    tags: { Project: 'CancerCareAIGame', Stage: 'dev' },
    ...overrides,
  };
}

export function testEnv(): cdk.Environment {
  return { account: AWS_ACCOUNT, region: AWS_REGION };
}
