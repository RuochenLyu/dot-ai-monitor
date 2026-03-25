#!/bin/zsh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CACHE_DIR="$SCRIPT_DIR/.cache"
ERROR_LOG="$CACHE_DIR/dot_notify_usage.error.log"
export PATH="/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

cd "$SCRIPT_DIR"
mkdir -p "$CACHE_DIR"

NODE_BIN=""
NVM_DIR="${NVM_DIR:-$HOME/.nvm}"

if [ -s "$NVM_DIR/nvm.sh" ]; then
  . "$NVM_DIR/nvm.sh"
  if nvm use --silent default >/dev/null 2>&1; then
    NODE_BIN="$(nvm which default 2>/dev/null || true)"
  fi
fi

if [ -z "$NODE_BIN" ] || [ ! -x "$NODE_BIN" ]; then
  if [ -x /usr/local/bin/node ]; then
    NODE_BIN="/usr/local/bin/node"
  else
    NODE_BIN="$(command -v node)"
  fi
fi

"$NODE_BIN" "$SCRIPT_DIR/dot_notify.js" --usage > /dev/null 2>> "$ERROR_LOG"
