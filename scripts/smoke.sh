#!/usr/bin/env bash
#
# Post-deploy smoke test.
#
# Covers the deployed system end to end:
#   1. CloudFormation stack status
#   2. Static hosting through CloudFront (SPA routing, asset guard)
#   3. The CloudFront → API Gateway proxy
#   4. The DynamoDB table shape
#   5. The game loop, via scripts/game-loop-check.py
#
# Usage:  ./scripts/smoke.sh [profile] [--full]
#         --full  additionally plays a complete five-stage session
#
# Honours AWS_PROFILE; defaults to cancercare-game-mvp.

set -euo pipefail

PROFILE="${AWS_PROFILE:-cancercare-game-mvp}"
REGION="${AWS_REGION:-us-east-1}"
PREFIX="CancercareGameMvp"
FULL=""

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

for arg in "$@"; do
  case "$arg" in
    --full) FULL="--full" ;;
    -*) echo "Unknown option: $arg" >&2; exit 2 ;;
    *) PROFILE="$arg" ;;
  esac
done

pass=0
fail=0

check() { # <label> <expected> <actual>
  if [ "$2" = "$3" ]; then
    printf '  \033[32m✓\033[0m %-46s %s\n' "$1" "$3"
    pass=$((pass + 1))
  else
    printf '  \033[31m✗\033[0m %-46s expected %s, got %s\n' "$1" "$2" "$3"
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
  # `UPDATE_COMPLETE` is the normal state after a redeploy — only a stack stuck
  # mid-update or rolled back is a problem.
  case "$status" in
    CREATE_COMPLETE|UPDATE_COMPLETE) check "$PREFIX-$stack" "$status" "$status" ;;
    *) check "$PREFIX-$stack" "CREATE_COMPLETE or UPDATE_COMPLETE" "$status" ;;
  esac
done

API=$(output "$PREFIX-Api" ApiBaseUrl)
DIST="https://$(output "$PREFIX-Frontend" DistributionDomainName)"
TABLE=$(output "$PREFIX-Data" TableName)

echo
echo "── CloudFront 静态托管  ($DIST) ──"
check "GET  /" 200 "$(code "$DIST/")"
check "GET  /deep/spa/route (SPA 回退)" 200 "$(code "$DIST/deep/spa/route")"
# 缺失资源必须【不】被伪装成 200 的 index.html。
check "GET  /nope.js (缺失资源不被伪装)" 403 "$(code "$DIST/nope.js")"
if curl -s "$DIST/" | grep -q "CancerCare AI Game"; then
  check "首页内容" "CancerCare AI Game" "CancerCare AI Game"
else
  check "首页内容" "CancerCare AI Game" "(未找到预期标题)"
fi

echo
echo "── CloudFront → API Gateway 代理 ──"
# 这一项同时验证 Host 头配置。若 originRequestPolicy 未排除 viewer 的 Host，
# API Gateway 会以 403 拒绝，此处即会暴露。
check "GET  /api/v1/health 经 CloudFront" 200 "$(code "$DIST/api/v1/health")"
check "GET  /api/v1/unknown 经 CloudFront" 404 "$(code "$DIST/api/v1/unknown")"

echo
echo "── DynamoDB  ($TABLE) ──"
check "表状态" ACTIVE "$(aws dynamodb describe-table --table-name "$TABLE" \
  --profile "$PROFILE" --region "$REGION" --query 'Table.TableStatus' --output text)"
check "GSI" "PlayerSessionsIndex" "$(aws dynamodb describe-table --table-name "$TABLE" \
  --profile "$PROFILE" --region "$REGION" --query 'Table.GlobalSecondaryIndexes[0].IndexName' --output text)"
check "TTL 属性" "expiresAt" "$(aws dynamodb describe-time-to-live --table-name "$TABLE" \
  --profile "$PROFILE" --region "$REGION" --query 'TimeToLiveDescription.AttributeName' --output text)"

echo
echo "── 游戏循环 ──"
RESULT_FILE=$(mktemp)
trap 'rm -f "$RESULT_FILE"' EXIT

set +e
python3 "$SCRIPT_DIR/game-loop-check.py" "$API" --profile "$PROFILE" $FULL | tee "$RESULT_FILE"
set -e

PYPASS=$(sed -n 's/.*GAME_LOOP_RESULT pass=\([0-9]*\) fail=\([0-9]*\).*/\1/p' "$RESULT_FILE" | tail -1)
PYFAIL=$(sed -n 's/.*GAME_LOOP_RESULT pass=\([0-9]*\) fail=\([0-9]*\).*/\2/p' "$RESULT_FILE" | tail -1)

if [ -z "$PYPASS" ]; then
  echo "  (游戏循环检查未返回结果，视为失败)" >&2
  PYFAIL=1
  PYPASS=0
fi

pass=$((pass + PYPASS))
fail=$((fail + PYFAIL))

echo
if [ "$fail" -eq 0 ]; then
  printf '\033[32m═══ ALL CHECKS PASSED (%d) ═══\033[0m\n' "$pass"
else
  printf '\033[31m═══ %d passed, %d FAILED ═══\033[0m\n' "$pass" "$fail"
  exit 1
fi
