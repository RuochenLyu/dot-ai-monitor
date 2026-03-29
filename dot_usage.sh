#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CACHE_DIR="$SCRIPT_DIR/.cache"
ERROR_LOG="$CACHE_DIR/dot_usage.error.log"

mkdir -p "$CACHE_DIR"

# Find node: version managers → homebrew → system
HOME="${HOME:-$(eval echo ~)}"
NODE_BIN=""

find_node() {
  # fnm (default alias)
  local fnm_default="$HOME/.local/share/fnm/aliases/default/bin/node"
  [ -x "$fnm_default" ] && { NODE_BIN="$fnm_default"; return; }

  # fnm (latest installed version)
  for d in "$HOME/.local/share/fnm/node-versions"/*/installation/bin/node; do
    [ -x "$d" ] && NODE_BIN="$d"
  done
  [ -n "$NODE_BIN" ] && return

  # nvm
  local nvm_dir="${NVM_DIR:-$HOME/.nvm}"
  for d in "$nvm_dir/versions/node"/*/bin/node; do
    [ -x "$d" ] && NODE_BIN="$d"
  done
  [ -n "$NODE_BIN" ] && return

  # volta
  local volta_node="$HOME/.volta/bin/node"
  [ -x "$volta_node" ] && { NODE_BIN="$volta_node"; return; }

  # mise / rtx
  local mise_node="$HOME/.local/share/mise/installs/node/latest/bin/node"
  [ -x "$mise_node" ] && { NODE_BIN="$mise_node"; return; }

  # asdf
  local asdf_dir="${ASDF_DATA_DIR:-$HOME/.asdf}"
  for d in "$asdf_dir/installs/nodejs"/*/bin/node; do
    [ -x "$d" ] && NODE_BIN="$d"
  done
  [ -n "$NODE_BIN" ] && return

  # homebrew (macOS)
  for p in /opt/homebrew/bin/node /usr/local/bin/node; do
    [ -x "$p" ] && { NODE_BIN="$p"; return; }
  done

  # system PATH (last resort)
  NODE_BIN="$(command -v node 2>/dev/null || true)"
}

find_node

if [ -z "$NODE_BIN" ] || [ ! -x "$NODE_BIN" ]; then
  echo "$(date): node not found" >> "$ERROR_LOG"
  exit 1
fi

"$NODE_BIN" "$SCRIPT_DIR/dot_notify.js" --usage > /dev/null 2>> "$ERROR_LOG"
