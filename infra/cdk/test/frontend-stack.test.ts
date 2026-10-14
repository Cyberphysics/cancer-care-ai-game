import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { FrontendStack } from '../lib/frontend-stack';
import { testConfig, testEnv } from './helpers';

// NOTE: the stack reads `frontend/dist` via `Source.asset`, which CDK validates
// at synth time. Run `npm --prefix frontend run build` before `npm test`.
function buildTemplate(): Template {
  const app = new cdk.App();
  return Template.fromStack(
    new FrontendStack(app, 'TestFrontendStack', {
      env: testEnv(),
      config: testConfig(),
      apiDomainName: 'abc123.execute-api.us-east-1.amazonaws.com',
    }),
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

  test('adds exactly the /assets/* and /api/* behaviors', () => {
    const distributions = template.findResources('AWS::CloudFront::Distribution');
    const [distribution] = Object.values(distributions);
    const behaviors = distribution.Properties.DistributionConfig.CacheBehaviors ?? [];
    expect(behaviors.map((b: { PathPattern: string }) => b.PathPattern).sort()).toEqual([
      '/api/*',
      '/assets/*',
    ]);
  });

  test('proxies /api/* to API Gateway without leaking the viewer Host header', () => {
    const distributions = template.findResources('AWS::CloudFront::Distribution');
    const [distribution] = Object.values(distributions);
    const behaviors = distribution.Properties.DistributionConfig.CacheBehaviors ?? [];
    const api = behaviors.find((b: { PathPattern: string }) => b.PathPattern === '/api/*');

    expect(api).toBeDefined();

    // Load-bearing: without this policy CloudFront forwards the viewer's Host
    // header and API Gateway rejects the request with an opaque 403.
    expect(api.OriginRequestPolicyId).toBeDefined();
    expect(api.AllowedMethods).toContain('POST');
    expect(api.ViewerProtocolPolicy).toBe('redirect-to-https');

    // The API must not share the assets' cache policy. Asserting they differ is
    // stronger than naming either one: it survives a CDK default changing.
    const assets = behaviors.find((b: { PathPattern: string }) => b.PathPattern === '/assets/*');
    expect(api.CachePolicyId).toBeDefined();
    expect(api.CachePolicyId).not.toBe(assets.CachePolicyId);

    const origins = distribution.Properties.DistributionConfig.Origins;
    const apiOrigin = origins.find(
      (o: { DomainName: unknown }) =>
        typeof o.DomainName === 'string' && o.DomainName.includes('execute-api'),
    );
    expect(apiOrigin).toBeDefined();
    // A custom origin (not an S3 origin), reached over TLS only.
    expect(apiOrigin.CustomOriginConfig).toMatchObject({
      OriginProtocolPolicy: 'https-only',
    });
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
