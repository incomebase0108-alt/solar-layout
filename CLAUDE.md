# CLAUDE.md

## ワークログ（Claudeメモリー）運用

このリポジトリは、4台のPCを行き来する作業の「直前の流れ」を引き継ぐため、
**Git連動の自己要約ワークログ**を備えています。

- **起動時**: SessionStart フックが `git pull` して `.claude/worklog/CURRENT.md` を
  自動でセッション文脈に注入します。手動で読む必要はありません。
- **記録**: 意味のある作業の区切り・セッション終了前・PCを移る前に、`/worklog` スキルを
  実行して成果を記録してください（追記 → 肥大化時は archive へ圧縮 → commit & push）。
- **肥大化を防ぐ**: `CURRENT.md` は「常時読む記憶」なので**小さく保つ**こと。
  詳細・過去経緯・PDF等は `archive/` と `attachments/`（=必要時に読む記憶）へ逃がす。

詳細な手順は `.claude/skills/worklog/SKILL.md` を参照（このファイル自体は薄く保つ）。
