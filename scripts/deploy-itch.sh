#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DIST_DIR="$REPO_ROOT/dist-tommyato"
VERSION="${1:-$(sed -n 's/^version = \"\\(.*\\)\"$/\\1/p' "$REPO_ROOT/wavedash.toml" | head -n 1)}"

if [[ -z "${BUTLER_API_KEY:-}" ]]; then
  echo "BUTLER_API_KEY is not set. Skipping itch.io push." >&2
  exit 0
fi

if [[ ! -f "$DIST_DIR/index.html" ]]; then
  echo "dist-tommyato/index.html missing. Run npm run build:tommyato first." >&2
  exit 1
fi

butler push "$DIST_DIR" tommyatoai/clockwork-climb:html5 --userversion "$VERSION"
