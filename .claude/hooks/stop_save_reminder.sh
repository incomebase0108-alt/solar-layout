#!/usr/bin/env bash
# Stop hook: 保存し忘れ防止。未保存/未pushの変更があれば気づかせる。
#   既定: 非ブロッキングでやさしく通知。
#   WORKLOG_REMINDER_STRICT=1: 同じ状態につき一度だけ stop をブロック（ループしない）。
set -u
PROJECT_DIR="${CLAUDE_PROJECT_DIR:-}"
if [ -z "$PROJECT_DIR" ]; then
  PROJECT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
fi
cd "$PROJECT_DIR" 2>/dev/null || exit 0
command -v git >/dev/null 2>&1 || exit 0
git rev-parse --is-inside-work-tree >/dev/null 2>&1 || exit 0

dirty=$(git status --porcelain 2>/dev/null | wc -l | tr -d ' ')
ahead=0
up=$(git rev-parse --abbrev-ref --symbolic-full-name '@{u}' 2>/dev/null || echo "")
if [ -n "$up" ]; then
  ahead=$(git rev-list --count '@{u}..HEAD' 2>/dev/null || echo 0)
fi
if [ "$dirty" -eq 0 ] && [ "$ahead" -eq 0 ]; then
  exit 0
fi
msg="未保存の変更が ${dirty} 件"
[ "$ahead" -gt 0 ] && msg="${msg}、未送信(未push)のコミットが ${ahead} 件"
msg="${msg} あります。「保存して」と言えば残せます。"
if [ "${WORKLOG_REMINDER_STRICT:-0}" = "1" ]; then
  state="$(git rev-parse HEAD 2>/dev/null)-${dirty}-${ahead}"
  marker=".git/.worklog_reminder_state"
  last="$(cat "$marker" 2>/dev/null || echo "")"
  if [ "$state" != "$last" ]; then
    echo "$state" > "$marker"
    printf '{"decision":"block","reason":"%s 不要ならそのまま終了して構いません。"}\n' "$msg"
  fi
  exit 0
else
  echo "💾 ${msg}"
  exit 0
fi
