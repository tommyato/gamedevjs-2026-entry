#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DIST_DIR="$REPO_ROOT/dist-tommyato"

if [[ ! -f "$DIST_DIR/index.html" ]]; then
  echo "dist-tommyato/index.html missing. Run npm run build:tommyato first." >&2
  exit 1
fi

SOURCE_SHA="$(git -C "$REPO_ROOT" rev-parse --short HEAD)"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

git clone --branch gh-pages --depth 1 git@github.com:tommyato/gamedevjs-2026-entry.git "$TMP_DIR/ghp"
find "$TMP_DIR/ghp" -mindepth 1 -maxdepth 1 ! -name '.git' -exec rm -rf {} +
cp -R "$DIST_DIR"/. "$TMP_DIR/ghp/"

git -C "$TMP_DIR/ghp" add -A
if git -C "$TMP_DIR/ghp" diff --cached --quiet; then
  echo "gh-pages already matches dist-tommyato."
  exit 0
fi

git -C "$TMP_DIR/ghp" commit --author='tommyato <tommyato@supertommy.com>' -m "deploy: dist-tommyato $SOURCE_SHA"
git -C "$TMP_DIR/ghp" push origin gh-pages
