#!/bin/zsh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CACHE_DIR="$SCRIPT_DIR/.cache"
ERROR_LOG="$CACHE_DIR/dot_notify_usage.error.log"

cd "$SCRIPT_DIR"
mkdir -p "$CACHE_DIR"

# Load user's shell profile to pick up node from nvm/fnm/brew/etc
export HOME="${HOME:-$(eval echo ~)}"
[[ -f "$HOME/.zshrc" ]] && source "$HOME/.zshrc" 2>/dev/null || true

NODE_BIN="$(command -v node 2>/dev/null || true)"

if [ -z "$NODE_BIN" ] || [ ! -x "$NODE_BIN" ]; then
  echo "$(date): node not found" >> "$ERROR_LOG"
  exit 1
fi

"$NODE_BIN" "$SCRIPT_DIR/dot_notify.js" --usage > /dev/null 2>> "$ERROR_LOG"
