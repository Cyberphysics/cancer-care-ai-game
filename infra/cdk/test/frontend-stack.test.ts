import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { FrontendStack } from '../lib/frontend-stack';
import { testConfig, testEnv } from './helpers';

// NOTE: the stack reads `frontend/dist` via `Source.asset`, which CDK validates
// at synth time. Run `npm --prefix frontend run build` before `npm test`.
function buildTemplate(): Template {
  const app = new cdk.App();
  return Template.fromStack(
    new FrontendStack(app, 'TestFrontendStack', { env: testEnv(), config: testConfig() }),
  );
}

describe('FrontendStack', () => {
  const template = buildTemplate();

  test('creates a web bucket and a game-assets bucket', () => {
    template.resourceCountIs('AWS::S3::Bucket', 2);
  });

  test('keeps every bucket private and TLS-only', () => {
    const buckets = template.findResources('AWS::S3::Bucket');
    for (const bucket of Object.values(buckets)) {
      expect(bucket.Properties.PublicAccessBlockConfiguration).toEqual({
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      });
    }
    template.resourceCountIs('AWS::S3::BucketPolicy', 2);
  });

  test('uses Origin Access Control, not the legacy Origin Access Identity', () => {
    template.resourceCountIs('AWS::CloudFront::OriginAccessControl', 1);
    template.resourceCountIs('AWS::CloudFront::CloudFrontOriginAccessIdentity', 0);

    template.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: Match.objectLike({
        Origins: Match.arrayWith([
          Match.objectLike({ OriginAccessControlId: Match.anyValue() }),
        ]),
      }),
    });
  });

  test('serves /assets/* from a cache-optimized behavior alongside the default', () => {
    const distributions = template.findResources('AWS::CloudFront::Distribution');
    const [distribution] = Object.values(distributions);
    const behaviors = distribution.Properties.DistributionConfig.CacheBehaviors ?? [];
    expect(behaviors).toHaveLength(1);
    expect(behaviors[0].PathPattern).toBe('/assets/*');
  });

  test('ships a CloudFront Function for SPA routing, bound to the default behavior only', () => {
    template.resourceCountIs('AWS::CloudFront::Function', 1);

    const distributions = template.findResources('AWS::CloudFront::Distribution');
    const [distribution] = Object.values(distributions);
    const defaultBehavior = distribution.Properties.DistributionConfig.DefaultCacheBehavior;
    expect(defaultBehavior.FunctionAssociations).toHaveLength(1);

    const behaviors = distribution.Properties.DistributionConfig.CacheBehaviors ?? [];
    for (const behavior of behaviors) {
      expect(behavior.FunctionAssociations ?? []).toHaveLength(0);
    }
  });

  test('redirects viewers to HTTPS', () => {
    template.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: Match.objectLike({
        DefaultCacheBehavior: Match.objectLike({
          ViewerProtocolPolicy: 'redirect-to-https',
        }),
      }),
    });
  });
});
