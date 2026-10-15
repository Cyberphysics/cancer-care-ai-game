#!/usr/bin/env bash
#
# Post-deploy smoke test.
#
# Covers the deployed system end to end:
#   1. CloudFormation stack status
#   2. Static hosting through CloudFront (SPA routing, asset guard)
#   3. The CloudFront -> API Gateway proxy
#   4. The DynamoDB table shape
#   5. The game loop, via scripts/game-loop-check.py
#   6. The AI narration layer, via scripts/narration-check.py (skipped when the
#      optional Agent stack is not deployed)
#
# Usage:  ./scripts/smoke.sh [profile] [--full]
#         --full  additionally plays a complete five-stage session
#
# Honours AWS_PROFILE; defaults to cancercare-game-mvp.
#
# OUTPUT ENCODING NOTE
# --------------------
# Markers are plain ASCII (`[ OK ]` / `[FAIL]`) and section rules use `=` / `-`.
# Box-drawing characters, dingbats and emoji are deliberately avoided: many
# terminal fonts have no glyph for them and render mojibake, which makes a
# passing test look like a broken one. Colour is emitted only to a real TTY and
# only when NO_COLOR is unset, so piping or redirecting yields plain text.

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

# Colour only when it will be seen correctly.
if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
  C_OK=$'\033[32m'
  C_BAD=$'\033[31m'
  C_END=$'\033[0m'
else
  C_OK=''
  C_BAD=''
  C_END=''
fi

pass=0
fail=0

check() { # <label> <expected> <actual>
  if [ "$2" = "$3" ]; then
    printf '  %s[ OK ]%s %-44s %s\n' "$C_OK" "$C_END" "$1" "$3"
    pass=$((pass + 1))
  else
    printf '  %s[FAIL]%s %-44s expected %s, got %s\n' "$C_BAD" "$C_END" "$1" "$2" "$3"
    fail=$((fail + 1))
  fi
}

section() {
  printf '\n-- %s --\n' "$1"
}

output() { # <stack> <output-key>
  aws cloudformation describe-stacks \
    --stack-name "$1" --profile "$PROFILE" --region "$REGION" \
    --query "Stacks[0].Outputs[?OutputKey==\`$2\`].OutputValue" --output text
}

code() { curl -s -o /dev/null -w '%{http_code}' "$@"; }

echo "== 前提检查 =="
if ! aws sts get-caller-identity --profile "$PROFILE" --region "$REGION" >/dev/null 2>&1; then
  echo "无法使用 profile '$PROFILE' 访问 AWS，请先配置凭据。" >&2
  exit 2
fi
echo "  profile=$PROFILE region=$REGION"

section "Stack 状态"
for stack in Data Agent Api Frontend; do
  status=$(aws cloudformation describe-stacks --stack-name "$PREFIX-$stack" \
    --profile "$PROFILE" --region "$REGION" \
    --query 'Stacks[0].StackStatus' --output text 2>/dev/null || echo "MISSING")
  case "$status" in
    CREATE_COMPLETE|UPDATE_COMPLETE) check "$PREFIX-$stack" "$status" "$status" ;;
    MISSING)
      # The Agent stack is optional: the game is fully playable without it.
      printf '  [ -- ] %-44s %s\n' "$PREFIX-$stack" "未部署（AI 层为可选）"
      ;;
    *) check "$PREFIX-$stack" "CREATE_COMPLETE or UPDATE_COMPLETE" "$status" ;;
  esac
done

API=$(output "$PREFIX-Api" ApiBaseUrl)
DIST="https://$(output "$PREFIX-Frontend" DistributionDomainName)"
TABLE=$(output "$PREFIX-Data" TableName)

section "CloudFront 静态托管  ($DIST)"
check "GET  /" 200 "$(code "$DIST/")"
check "GET  /deep/spa/route (SPA 回退)" 200 "$(code "$DIST/deep/spa/route")"
# 缺失资源必须【不】被伪装成 200 的 index.html。
check "GET  /nope.js (缺失资源不被伪装)" 403 "$(code "$DIST/nope.js")"
if curl -s "$DIST/" | grep -q "CancerCare AI Game"; then
  check "首页内容" "CancerCare AI Game" "CancerCare AI Game"
else
  check "首页内容" "CancerCare AI Game" "(未找到预期标题)"
fi

section "CloudFront -> API Gateway 代理"
# 这一项同时验证 Host 头配置。若 originRequestPolicy 未排除 viewer 的 Host，
# API Gateway 会以 403 拒绝，此处即会暴露。
check "GET  /api/v1/health 经 CloudFront" 200 "$(code "$DIST/api/v1/health")"
check "GET  /api/v1/unknown 经 CloudFront" 404 "$(code "$DIST/api/v1/unknown")"

section "DynamoDB  ($TABLE)"
check "表状态" ACTIVE "$(aws dynamodb describe-table --table-name "$TABLE" \
  --profile "$PROFILE" --region "$REGION" --query 'Table.TableStatus' --output text)"
check "GSI" "PlayerSessionsIndex" "$(aws dynamodb describe-table --table-name "$TABLE" \
  --profile "$PROFILE" --region "$REGION" --query 'Table.GlobalSecondaryIndexes[0].IndexName' --output text)"
check "TTL 属性" "expiresAt" "$(aws dynamodb describe-time-to-live --table-name "$TABLE" \
  --profile "$PROFILE" --region "$REGION" --query 'TimeToLiveDescription.AttributeName' --output text)"

section "游戏循环"
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

section "AI 叙事层 (AgentCore)"
AGENT_STATUS=$(aws cloudformation describe-stacks --stack-name "$PREFIX-Agent" \
  --profile "$PROFILE" --region "$REGION" \
  --query 'Stacks[0].StackStatus' --output text 2>/dev/null || echo "MISSING")
case "$AGENT_STATUS" in
  CREATE_COMPLETE|UPDATE_COMPLETE)
    set +e
    python3 "$SCRIPT_DIR/narration-check.py" "$API" --profile "$PROFILE" | tee "$RESULT_FILE"
    set -e

    NPASS=$(sed -n 's/.*NARRATION_RESULT pass=\([0-9]*\) fail=\([0-9]*\).*/\1/p' "$RESULT_FILE" | tail -1)
    NFAIL=$(sed -n 's/.*NARRATION_RESULT pass=\([0-9]*\) fail=\([0-9]*\).*/\2/p' "$RESULT_FILE" | tail -1)
    if [ -z "$NPASS" ]; then
      echo "  (叙事层检查未返回结果，视为失败)" >&2
      NPASS=0
      NFAIL=1
    fi
    pass=$((pass + NPASS))
    fail=$((fail + NFAIL))
    ;;
  *)
    # Same contract as the Agent stack above: the game is fully playable with no
    # AI layer at all, so a missing Agent stack is a skip, not a failure.
    printf '  [ -- ] %-44s %s\n' "AgentCore 叙事层" "未部署（AI 层为可选）"
    ;;
esac

echo
if [ "$fail" -eq 0 ]; then
  printf '%s== ALL CHECKS PASSED (%d) ==%s\n' "$C_OK" "$pass" "$C_END"
else
  printf '%s== %d passed, %d FAILED ==%s\n' "$C_BAD" "$pass" "$fail" "$C_END"
  exit 1
fi
