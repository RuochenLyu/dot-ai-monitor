#!/bin/zsh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CACHE_DIR="$SCRIPT_DIR/.cache"
ERROR_LOG="$CACHE_DIR/dot_notify_usage.error.log"

cd "$SCRIPT_DIR"
mkdir -p "$CACHE_DIR"

# Find node: check fnm, nvm, homebrew, system paths
export HOME="${HOME:-$(eval echo ~)}"
NODE_BIN=""

# fnm
if [ -z "$NODE_BIN" ]; then
  FNM_DIR="$HOME/.local/share/fnm/aliases/default/bin"
  [ -x "$FNM_DIR/node" ] && NODE_BIN="$FNM_DIR/node"
fi

# fnm (fallback: pick latest installed version)
if [ -z "$NODE_BIN" ]; then
  for d in "$HOME/.local/share/fnm/node-versions"/*/installation/bin/node; do
    [ -x "$d" ] && NODE_BIN="$d"
  done
fi

# nvm
if [ -z "$NODE_BIN" ]; then
  NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
  for d in "$NVM_DIR/versions/node"/*/bin/node; do
    [ -x "$d" ] && NODE_BIN="$d"
  done
fi

# homebrew / system
for p in /opt/homebrew/bin/node /usr/local/bin/node; do
  [ -z "$NODE_BIN" ] && [ -x "$p" ] && NODE_BIN="$p"
done

# last resort
[ -z "$NODE_BIN" ] && NODE_BIN="$(command -v node 2>/dev/null || true)"

if [ -z "$NODE_BIN" ] || [ ! -x "$NODE_BIN" ]; then
  echo "$(date): node not found" >> "$ERROR_LOG"
  exit 1
fi

"$NODE_BIN" "$SCRIPT_DIR/dot_notify.js" --usage > /dev/null 2>> "$ERROR_LOG"
