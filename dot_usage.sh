#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CACHE_DIR="$SCRIPT_DIR/.cache"
ERROR_LOG="$CACHE_DIR/dot_usage.error.log"
STATUS_FILE="$CACHE_DIR/last_usage_push.json"

mkdir -p "$CACHE_DIR"

log() {
  printf '[%s] %s\n' "$(date '+%Y-%m-%dT%H:%M:%S%z')" "$*"
}

check_status() {
  if [ ! -f "$STATUS_FILE" ]; then
    log "dot_usage failed: status file missing"
    return 1
  fi

  local parsed result summary
  parsed="$("$NODE_BIN" -e '
const fs = require("fs");
const file = process.argv[1];
try {
  const status = JSON.parse(fs.readFileSync(file, "utf8"));
  const result = status.result || "unknown";
  const keys = ["displayMode", "activeSessions", "error"];
  const fields = keys
    .filter((key) => status[key] !== undefined && status[key] !== null && status[key] !== "")
    .map((key) => `${key}=${String(status[key]).replace(/\s+/g, " ")}`);
  console.log(`${result}\t${fields.join(" ")}`);
} catch (err) {
  console.log(`parse_error\tmessage=${err.message}`);
}
' "$STATUS_FILE" 2>/dev/null || true)"

  result="${parsed%%$'\t'*}"
  summary="${parsed#*$'\t'}"

  if [ "$result" = "pushed" ]; then
    log "dot_usage ok${summary:+: $summary}"
    return 0
  fi

  log "dot_usage failed: result=${result:-missing}${summary:+ $summary}"
  return 1
}

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

log "dot_usage start"

if [ -z "$NODE_BIN" ] || [ ! -x "$NODE_BIN" ]; then
  log "dot_usage failed: node not found"
  echo "$(date): node not found" >> "$ERROR_LOG"
  exit 1
fi

export DOTENV_CONFIG_QUIET=true

if "$NODE_BIN" "$SCRIPT_DIR/dot_notify.js" --usage 2>> "$ERROR_LOG"; then
  check_status
else
  rc=$?
  log "dot_usage failed: dot_notify.js exited rc=$rc"
  if [ -s "$ERROR_LOG" ]; then
    log "recent stderr:"
    tail -n 20 "$ERROR_LOG"
  fi
  exit "$rc"
fi
