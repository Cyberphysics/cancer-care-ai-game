#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { ApiStack } from '../lib/api-stack';
import { loadConfig } from '../lib/config';
import { DataStack } from '../lib/data-stack';
import { FrontendStack } from '../lib/frontend-stack';
import { stackName } from '../lib/naming';

const app = new cdk.App();
const config = loadConfig(app);

// Explicit environment. Never `CDK_DEFAULT_ACCOUNT`: an environment-agnostic
// stack cannot publish assets, and a context lookup would make synth
// machine-dependent.
const env: cdk.Environment = { account: config.account, region: config.region };

const data = new DataStack(app, stackName(config.stackPrefix, 'Data'), { env, config });

const api = new ApiStack(app, stackName(config.stackPrefix, 'Api'), {
  env,
  config,
  table: data.table,
});

new FrontendStack(app, stackName(config.stackPrefix, 'Frontend'), {
  env,
  config,
  // Frontend proxies /api/* to the API, so it depends on the Api stack.
  apiDomainName: api.apiDomainName,
});

// Applied to every stack. Beyond tidiness this is how cost allocation reports
// prove which resources belong to this project — the account also hosts
// unrelated work.
for (const [key, value] of Object.entries(config.tags)) {
  cdk.Tags.of(app).add(key, value);
}
