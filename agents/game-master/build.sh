#!/usr/bin/env bash
#
# Build the ARM64 deployment zip for the GameMaster agent.
#
#   ./agents/game-master/build.sh
#   -> agents/game-master/dist/game-master.zip
#
# WHY THIS IS NOT `pip install -t`
# ---------------------------------
# AgentCore Runtime is ARM64-only, and this is routinely developed on x86_64
# machines (this repo's machine included). Installing wheels for the *local*
# architecture and uploading them produces a function that fails at runtime with
# an `exec format error` -- a failure a long way from its cause.
#
# So dependencies are cross-resolved for aarch64-manylinux2014 and restricted to
# prebuilt wheels. `--only-binary :all:` is the important flag: without it pip
# will happily download a source distribution and try to compile it for the
# local machine, which is exactly the bug above, arriving silently.
#
# No Docker required.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BUILD_DIR="$SCRIPT_DIR/.build"
DIST_DIR="$SCRIPT_DIR/dist"
ZIP_PATH="$DIST_DIR/game-master.zip"

TARGET_PLATFORM="aarch64-manylinux2014"
TARGET_PYTHON="3.13"

echo "-- Building GameMaster agent zip --"
echo "   source : $SCRIPT_DIR"
echo "   target : $TARGET_PLATFORM / python $TARGET_PYTHON"

if ! command -v uv >/dev/null 2>&1; then
  echo "uv is required (it resolves cross-platform wheels reliably)." >&2
  echo "Install: brew install uv   or   curl -LsSf https://astral.sh/uv/install.sh | sh" >&2
  exit 1
fi

rm -rf "$BUILD_DIR"
mkdir -p "$BUILD_DIR" "$DIST_DIR"
rm -f "$ZIP_PATH"

echo
echo "-- Resolving dependencies --"
uv pip install \
  --target "$BUILD_DIR" \
  --python-platform "$TARGET_PLATFORM" \
  --python-version "$TARGET_PYTHON" \
  --only-binary :all: \
  --no-cache \
  -r "$SCRIPT_DIR/requirements.txt" \
  2>&1 | tail -5

echo
echo "-- Verifying native extensions are ARM64 --"
# The single check that would have caught a wrong-architecture build. Any .so
# compiled for x86_64 here means the function will fail to start.
BAD=0
while IFS= read -r so; do
  if ! file -b "$so" | grep -q "ARM aarch64"; then
    echo "   [FAIL] not ARM64: ${so#"$BUILD_DIR"/}"
    BAD=1
  fi
done < <(find "$BUILD_DIR" -name "*.so")
if [ "$BAD" -eq 1 ]; then
  echo "Aborting: the zip would not run on AgentCore Runtime." >&2
  exit 1
fi
SO_COUNT=$(find "$BUILD_DIR" -name "*.so" | wc -l | tr -d ' ')
echo "   [ OK ] all $SO_COUNT native extension(s) are ARM aarch64"

echo
echo "-- Adding agent source --"
cp "$SCRIPT_DIR/main.py" "$BUILD_DIR/"
cp -R "$SCRIPT_DIR/app" "$BUILD_DIR/"
find "$BUILD_DIR" -name '__pycache__' -type d -prune -exec rm -rf {} + 2>/dev/null || true
find "$BUILD_DIR" -name '*.pyc' -delete 2>/dev/null || true

echo
echo "-- Zipping --"
# Entrypoint is `main.py`, so it must sit at the zip root alongside the
# dependencies (which must also be importable from the root).
( cd "$BUILD_DIR" && zip -qr "$ZIP_PATH" . -x '*.pyc' -x '__pycache__/*' )

SIZE=$(du -h "$ZIP_PATH" | cut -f1)
echo "   [ OK ] $ZIP_PATH ($SIZE)"

# AgentCore code deploy limits: 250 MB zipped / 750 MB unzipped.
BYTES=$(wc -c < "$ZIP_PATH" | tr -d ' ')
LIMIT=$((250 * 1024 * 1024))
if [ "$BYTES" -gt "$LIMIT" ]; then
  echo "[FAIL] zip exceeds the 250 MB AgentCore code-deploy limit" >&2
  exit 1
fi

echo
echo "Done -- deploy with: npm --prefix infra/cdk run deploy:agent"
