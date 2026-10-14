#!/usr/bin/env bash
#
# Post-deploy smoke test.
#
# Verifies the deployed Phase 0 skeleton end to end: stack status, the live
# /health route, the 501 stubs, CloudFront SPA routing, the asset cache path,
# and the DynamoDB table shape.
#
# Usage:  ./scripts/smoke.sh [profile]
#         AWS_PROFILE is honoured; defaults to cancercare-game-mvp.

set -euo pipefail

PROFILE="${1:-${AWS_PROFILE:-cancercare-game-mvp}}"
REGION="${AWS_REGION:-us-east-1}"
PREFIX="CancercareGameMvp"

pass=0
fail=0

check() { # <label> <expected> <actual>
  if [ "$2" = "$3" ]; then
    printf '  \033[32m✓\033[0m %-48s %s\n' "$1" "$3"
    pass=$((pass + 1))
  else
    printf '  \033[31m✗\033[0m %-48s expected %s, got %s\n' "$1" "$2" "$3"
    fail=$((fail + 1))
  fi
}

output() { # <stack> <output-key>
  aws cloudformation describe-stacks \
    --stack-name "$1" --profile "$PROFILE" --region "$REGION" \
    --query "Stacks[0].Outputs[?OutputKey==\`$2\`].OutputValue" --output text
}

code() { curl -s -o /dev/null -w '%{http_code}' "$@"; }

echo "── 前提检查 ──"
if ! aws sts get-caller-identity --profile "$PROFILE" --region "$REGION" >/dev/null 2>&1; then
  echo "无法使用 profile '$PROFILE' 访问 AWS，请先配置凭据。" >&2
  exit 2
fi
echo "  profile=$PROFILE region=$REGION"

echo
echo "── Stack 状态 ──"
for stack in Data Api Frontend; do
  status=$(aws cloudformation describe-stacks --stack-name "$PREFIX-$stack" \
    --profile "$PROFILE" --region "$REGION" \
    --query 'Stacks[0].StackStatus' --output text 2>/dev/null || echo "MISSING")
  check "$PREFIX-$stack" "CREATE_COMPLETE" "$status"
done

API=$(output "$PREFIX-Api" ApiBaseUrl)
DIST="https://$(output "$PREFIX-Frontend" DistributionDomainName)"
TABLE=$(output "$PREFIX-Data" TableName)

echo
echo "── API  ($API) ──"
check "GET  /api/v1/health" 200 "$(code "$API/api/v1/health")"
check "POST /api/v1/sessions (桩)" 501 "$(code -X POST "$API/api/v1/sessions")"
check "GET  /api/v1/players/{id} (桩)" 501 "$(code "$API/api/v1/players/smoke-test")"
check "GET  /api/v1/sessions/{id}/events (桩)" 501 "$(code "$API/api/v1/sessions/smoke-test/events")"
check "POST /api/v1/sessions/{id}/choices (桩)" 501 "$(code -X POST "$API/api/v1/sessions/smoke-test/choices")"
check "POST /api/v1/sessions/{id}/advance (桩)" 501 "$(code -X POST "$API/api/v1/sessions/smoke-test/advance")"
check "GET  /api/v1/unknown → 404" 404 "$(code "$API/api/v1/unknown")"

echo
echo "── CloudFront  ($DIST) ──"
check "GET  /" 200 "$(code "$DIST/")"
check "GET  /deep/spa/route (SPA 回退)" 200 "$(code "$DIST/deep/spa/route")"
# 缺失资源必须【不】被伪装成 200 的 index.html。OAC 场景下 S3 返回 403 AccessDenied。
check "GET  /nope.js (缺失资源不被伪装)" 403 "$(code "$DIST/nope.js")"

# 首页确实是我们自己的应用，而不只是任意 200 响应。
if curl -s "$DIST/" | grep -q "CancerCare AI Game"; then
  printf '  \033[32m✓\033[0m %-48s %s\n' "首页内容" "CancerCare AI Game"
  pass=$((pass + 1))
else
  printf '  \033[31m✗\033[0m %-48s 未找到预期标题\n' "首页内容"
  fail=$((fail + 1))
fi

echo
echo "── DynamoDB  ($TABLE) ──"
check "表状态" ACTIVE "$(aws dynamodb describe-table --table-name "$TABLE" \
  --profile "$PROFILE" --region "$REGION" --query 'Table.TableStatus' --output text)"
check "GSI" "PlayerSessionsIndex" "$(aws dynamodb describe-table --table-name "$TABLE" \
  --profile "$PROFILE" --region "$REGION" --query 'Table.GlobalSecondaryIndexes[0].IndexName' --output text)"
check "TTL 属性" "expiresAt" "$(aws dynamodb describe-time-to-live --table-name "$TABLE" \
  --profile "$PROFILE" --region "$REGION" --query 'TimeToLiveDescription.AttributeName' --output text)"

echo
if [ "$fail" -eq 0 ]; then
  printf '\033[32m═══ ALL CHECKS PASSED (%d) ═══\033[0m\n' "$pass"
else
  printf '\033[31m═══ %d passed, %d FAILED ═══\033[0m\n' "$pass" "$fail"
  exit 1
fi
