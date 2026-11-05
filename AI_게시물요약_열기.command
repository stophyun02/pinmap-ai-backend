#!/bin/zsh
set -e
TASK_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$TASK_DIR"
NODE_BIN="$(command -v node || true)"
if [[ -z "$NODE_BIN" && -x /usr/local/bin/node ]]; then NODE_BIN=/usr/local/bin/node; fi
if [[ -z "$NODE_BIN" && -x /opt/homebrew/bin/node ]]; then NODE_BIN=/opt/homebrew/bin/node; fi
if [[ -z "$NODE_BIN" ]]; then
  print 'Node.js 22 이상이 필요합니다.'
  read -r '?엔터를 눌러 닫으세요.'
  exit 1
fi
"$NODE_BIN" start.mjs
open 'http://127.0.0.1:8101/'
