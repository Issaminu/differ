#!/usr/bin/env bash
# Run Differ's real GPUI window under a visible, repeatable performance load.
#
# This is deliberately headful: use it to watch the actual toolbar, editors,
# syntax highlighter, diff tints, change map, and GPU paint path while it emits
# p50/p95/p99 timings to stderr. It is not a substitute for the fast core
# benchmark; it catches the integration costs the core benchmark cannot see.
#
# Examples:
#   scripts/bench-native-headful.sh typing
#   scripts/bench-native-headful.sh paint --lines 30000 --changed 50
#   scripts/bench-native-headful.sh paste --lines 50000 --paste-lines 50000 --verify
#   scripts/bench-native-headful.sh find --lines 50000 --query item_
#   scripts/bench-native-headful.sh replace --lines 50000 --query item_ --replacement entry_ --quit
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MODE="${1:-typing}"
shift || true

LINES=15000
CHANGED=30
KEYSTROKES=500
CADENCE=40
FRAMES=300
WARMUP=30
QUERY=item_
REPLACEMENT=entry_
PASTE_LINES=
QUIT=0
VERIFY=0

usage() {
  sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'
  cat <<'EOF'

Options:
  --lines N          lines in each generated pane (default: 15000)
  --changed PCT      changed-line percentage, 0..100 (default: 30)
  --keystrokes N     typing scenario edits (default: 500)
  --cadence MS       gap between edits (default: 40)
  --frames N         measured frames for paint mode (default: 300)
  --warmup N         discarded frames before paint measurement (default: 30)
  --query TEXT       Find query for find/replace modes (default: item_)
  --replacement TEXT Replacement text for replace mode (default: entry_)
  --paste-lines N    lines inserted by paste mode (default: --lines)
  --quit             close automatically after recording results
  --verify           require a passing find/replace result; implies --quit
EOF
}

case "$MODE" in
  typing|paint|paste|find|replace) ;;
  -h|--help|help) usage; exit 0 ;;
  *) echo "unknown mode: $MODE (expected typing, paint, paste, find, or replace)" >&2; exit 2 ;;
esac

while [ "$#" -gt 0 ]; do
  case "$1" in
    --lines) LINES="$2"; shift 2 ;;
    --changed) CHANGED="$2"; shift 2 ;;
    --keystrokes) KEYSTROKES="$2"; shift 2 ;;
    --cadence) CADENCE="$2"; shift 2 ;;
    --frames) FRAMES="$2"; shift 2 ;;
    --warmup) WARMUP="$2"; shift 2 ;;
    --query) QUERY="$2"; shift 2 ;;
    --replacement) REPLACEMENT="$2"; shift 2 ;;
    --paste-lines) PASTE_LINES="$2"; shift 2 ;;
    --quit) QUIT=1; shift ;;
    --verify) VERIFY=1; QUIT=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
done

PASTE_LINES="${PASTE_LINES:-$LINES}"

for value in "$LINES" "$CHANGED" "$KEYSTROKES" "$CADENCE" "$FRAMES" "$WARMUP" "$PASTE_LINES"; do
  case "$value" in *[!0-9]*|'') echo "all benchmark values must be non-negative integers" >&2; exit 2 ;; esac
done
[ "$CHANGED" -le 100 ] || { echo "--changed must be between 0 and 100" >&2; exit 2; }
[ -n "$QUERY" ] || { echo "--query must not be empty" >&2; exit 2; }
if [ "$VERIFY" != 0 ]; then
  case "$MODE" in
    paste|find|replace) ;;
    *) echo "--verify is only valid for paste, find, or replace" >&2; exit 2 ;;
  esac
fi

cd "$ROOT"
echo "[headful] mode=$MODE lines=$LINES changed=$CHANGED%"
case "$MODE" in
  paste) echo "[headful] paste-lines=$PASTE_LINES" ;;
  find|replace) echo "[headful] query=$QUERY replacement=$REPLACEMENT" ;;
esac
if [ "$QUIT" = 1 ]; then
  echo "[headful] window closes after the report"
else
  echo "[headful] window remains open after the report; use --quit for automation"
fi

ENV=(
  DIFFER_PERF=1
  DIFFER_BENCH=1
  DIFFER_BENCH_LINES="$LINES"
  DIFFER_BENCH_CHANGED="$CHANGED"
)
[ "$QUIT" = 1 ] && ENV+=(DIFFER_BENCH_QUIT=1)

if [ "$MODE" = typing ]; then
  ENV+=(DIFFER_STRESS="$KEYSTROKES" DIFFER_STRESS_MS="$CADENCE")
elif [ "$MODE" = paint ]; then
  ENV+=(DIFFER_FRAMEBENCH="$FRAMES" DIFFER_FRAMEBENCH_WARMUP="$WARMUP")
elif [ "$MODE" = paste ]; then
  ENV+=(DIFFER_PASTE_STRESS_LINES="$PASTE_LINES")
else
  ENV+=(
    DIFFER_SEARCH_STRESS="$MODE"
    DIFFER_SEARCH_QUERY="$QUERY"
    DIFFER_SEARCH_REPLACEMENT="$REPLACEMENT"
  )
fi

if [ "$VERIFY" = 1 ]; then
  LOG="$(mktemp -t differ-headful.XXXXXX.log)"
  trap 'rm -f "$LOG"' EXIT
  env "${ENV[@]}" cargo run --release --manifest-path native/Cargo.toml 2>&1 | tee "$LOG"
  case "$MODE" in
    paste) PASS_PATTERN="^\[paste-stress\] PASS: lines=$PASTE_LINES$" ;;
    find|replace) PASS_PATTERN="^\[search-stress\] PASS: mode=$MODE matches=[1-9][0-9]*$" ;;
  esac
  if ! rg -q "$PASS_PATTERN" "$LOG"; then
    echo "[headful] verification failed: $MODE did not report a passing real-window run" >&2
    exit 1
  fi
else
  env "${ENV[@]}" cargo run --release --manifest-path native/Cargo.toml
fi
