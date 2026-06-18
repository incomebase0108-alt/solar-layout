#!/usr/bin/env bash
# SessionStart hook: ワークログの「直前の流れ」をセッション文脈へ自動注入する。
#   1. best-effort で git pull（他PCの更新を取り込む）。失敗してもセッションは止めない。
#   2. CURRENT.md を出力（上限行まで）。SessionStart の stdout は文脈に追加される。
set -u
PROJECT_DIR="${CLAUDE_PROJECT_DIR:-}"
if [ -z "$PROJECT_DIR" ]; then
  PROJECT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
fi
cd "$PROJECT_DIR" 2>/dev/null || exit 0

if command -v git >/dev/null 2>&1 && [ -d .git ]; then
  git pull --ff-only --quiet 2>/dev/null || true
fi

if [ -f "$HOME/.claude/scripts/update_project_index.sh" ]; then
  bash "$HOME/.claude/scripts/update_project_index.sh" "$PROJECT_DIR" >/dev/null 2>&1 || true
fi

WL=".claude/worklog/CURRENT.md"
MAX_LINES=200
if [ -f "$WL" ]; then
  echo "=== Claudeワークログ（直前の作業の流れ / .claude/worklog/CURRENT.md）==="
  echo "（古い記録は .claude/worklog/archive/ に圧縮保存されています）"
  echo ""
  head -n "$MAX_LINES" "$WL"
  total=$(wc -l < "$WL" 2>/dev/null || echo 0)
  if [ "$total" -gt "$MAX_LINES" ]; then
    echo ""
    echo "... （CURRENT.md が $MAX_LINES 行を超過。古いエントリは /worklog で archive へ圧縮してください）"
  fi
fi
exit 0
