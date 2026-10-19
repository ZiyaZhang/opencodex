#!/bin/bash
# OpenCodex's daily run with no one at the desk, started by launchd (com.opencodex.daily.plist). It starts a DSH profile headless in
# run-once mode: OpenCodex checks once as soon as it has started, lets the automatic research run out and replaces last-run.json, and this
# script then ends DSH. The README has it copied out of the plugin package, so that removing or upgrading the plugin leaves the job alone.
#
# Exit codes: 0 last-run.json was written; 2 the time limit passed first; 3 the run could not start, or DSH ended without writing it.
#
# Settings come from the environment (the plist's EnvironmentVariables). launchd reads no shell profile such as ~/.zshrc, and this script
# needs none:
#   DSH_BIN                  the DSH CLI; the desktop app's by default
#   DSH_PROFILE              the profile to start; opencodex by default
#   DSH_HOME                 DSH's home; ~/.dsh by default. OpenCodex's data directory is its opencodex/
#   OPENCODEX_TIMEOUT_MIN    the time limit in minutes, decimals allowed; 120 by default
#   OPENCODEX_POLL_SEC       how often last-run.json is looked at, in seconds; 20 by default
#   OPENCODEX_KILL_WAIT_SEC  how long DSH gets to exit after SIGTERM before it gets SIGKILL, in seconds; 60 by default
set -euo pipefail
# The data directory holds reports and logs: what this script creates there is the owner's only, as what the plugin creates is.
umask 077

DSH_BIN="${DSH_BIN:-/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh}"
DSH_PROFILE="${DSH_PROFILE:-opencodex}"
# Exported, so that DSH, and OpenCodex in it, use the data directory this script watches.
export DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
TIMEOUT_MIN="${OPENCODEX_TIMEOUT_MIN:-120}"
POLL_SEC="${OPENCODEX_POLL_SEC:-20}"
KILL_WAIT_SEC="${OPENCODEX_KILL_WAIT_SEC:-60}"

DATA_DIR="$DSH_HOME/opencodex"
LAST_RUN="$DATA_DIR/last-run.json"
LOG_DIR="$DATA_DIR/logs"
LOG="$LOG_DIR/daily-$(date +%Y-%m-%d).log"
DSH_PID=''

log() { printf '%s %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" >> "$LOG"; }
fail() { log "$*"; exit 3; }

# What tells one last-run.json from the next: the plugin replaces the file by a rename, so a new one has a new inode besides its mtime,
# and one written within the same second as the last is still told apart. 0 while there is none.
signature() { stat -f '%m %i' "$LAST_RUN" 2> /dev/null || echo 0; }

# A sleep that this script waits for rather than runs, so that a signal to the script is handled at once, not once the sleep is over.
nap() { sleep "$1" & wait "$!" || true; }

# SIGTERM lets DSH unload OpenCodex, which lets go of the data-directory lock; SIGKILL only when that takes longer than KILL_WAIT_SEC.
stop_dsh() {
  local waited=0 status=0
  kill -TERM "$DSH_PID" 2> /dev/null || true
  while kill -0 "$DSH_PID" 2> /dev/null; do
    if (( waited >= KILL_WAIT_SEC )); then
      log "DSH 收到 SIGTERM 后 ${KILL_WAIT_SEC} 秒还没退出，发 SIGKILL"
      kill -KILL "$DSH_PID" 2> /dev/null || true
      break
    fi
    nap 1
    waited=$(( waited + 1 ))
  done
  wait "$DSH_PID" 2> /dev/null || status=$?
  log "DSH 已退出（退出码 $status）"
  DSH_PID=''
}

# However this script ends, an error or a signal included, DSH is not left running headless with nothing to end it.
cleanup() { if [[ -n "$DSH_PID" ]]; then stop_dsh; fi; }

if ! mkdir -p "$LOG_DIR"; then
  echo "opencodex-daily: 没能创建日志目录 $LOG_DIR" >&2
  exit 3
fi
# Logs from more than 30 days ago go; failing at that is no reason to skip the run.
find "$LOG_DIR" -maxdepth 1 -type f -name 'daily-*.log' -mtime +30 -delete 2> /dev/null || true
trap cleanup EXIT
trap 'log "收到 SIGTERM，结束"; exit 143' TERM
trap 'log "收到 SIGINT，结束"; exit 130' INT
trap 'log "收到 SIGHUP，结束"; exit 129' HUP

# In variables, as bash 3.2 (macOS's /bin/bash) matches them; no leading zeros, which bash arithmetic would read as octal.
MINUTES='^[0-9]+([.][0-9]+)?$'
POSITIVE='^[1-9][0-9]*$'
WHOLE='^(0|[1-9][0-9]*)$'
[[ "$TIMEOUT_MIN" =~ $MINUTES ]] || fail "OPENCODEX_TIMEOUT_MIN 要是分钟数：$TIMEOUT_MIN"
TIMEOUT_SEC="$(awk -v minutes="$TIMEOUT_MIN" 'BEGIN { printf "%d", minutes * 60 }')"
(( TIMEOUT_SEC > 0 )) || fail "OPENCODEX_TIMEOUT_MIN 不到 1 秒：$TIMEOUT_MIN"
[[ "$POLL_SEC" =~ $POSITIVE ]] || fail "OPENCODEX_POLL_SEC 要是正整数秒数：$POLL_SEC"
[[ "$KILL_WAIT_SEC" =~ $WHOLE ]] || fail "OPENCODEX_KILL_WAIT_SEC 要是整数秒数：$KILL_WAIT_SEC"
[[ -x "$DSH_BIN" ]] || fail "找不到能运行的 DSH：$DSH_BIN"

BEFORE="$(signature)"
log "开始：$DSH_BIN --profile $DSH_PROFILE，数据目录 $DATA_DIR，时限 $TIMEOUT_MIN 分钟"
OPENCODEX_RUN_ONCE=1 "$DSH_BIN" --profile "$DSH_PROFILE" --no-open --port 0 < /dev/null >> "$LOG" 2>&1 &
DSH_PID=$!
log "DSH 已启动（pid $DSH_PID）"
# No idle sleep while DSH runs; caffeinate ends with it. Closing the lid, or Sleep in the menu, still puts the Mac to sleep.
if command -v caffeinate > /dev/null 2>&1; then caffeinate -i -w "$DSH_PID" & fi
DEADLINE=$(( $(date +%s) + TIMEOUT_SEC ))

while :; do
  if [[ "$(signature)" != "$BEFORE" ]]; then
    log "last-run.json 已更新，结束 DSH"
    stop_dsh
    exit 0
  fi
  if ! kill -0 "$DSH_PID" 2> /dev/null; then
    status=0
    wait "$DSH_PID" 2> /dev/null || status=$?
    DSH_PID=''
    # It may have written the file and ended on its own since the look above.
    if [[ "$(signature)" != "$BEFORE" ]]; then
      log "last-run.json 已更新，DSH 已自己退出（退出码 $status）"
      exit 0
    fi
    log "DSH 没写出 last-run.json 就退出了（退出码 $status）"
    exit 3
  fi
  now=$(date +%s)
  if (( now >= DEADLINE )); then
    log "超过 $TIMEOUT_MIN 分钟还没写出 last-run.json，结束 DSH"
    stop_dsh
    exit 2
  fi
  left=$(( DEADLINE - now ))
  nap $(( left < POLL_SEC ? left : POLL_SEC ))
done
