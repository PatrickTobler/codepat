#!/bin/sh
# Copies this repo's skills to where the coordinator (Codex), Codex workers and Claude find them.
set -eu
src="$(cd "$(dirname "$0")/.." && pwd)/skills"
for dest in "$HOME/.local/share/codepat/orchestrator/.agents/skills" "$HOME/.agents/skills" "$HOME/.claude/skills"; do
  mkdir -p "$dest"
  for skill in "$src"/*/; do
    name="$(basename "$skill")"
    rm -rf "${dest:?}/$name"
    cp -R "$skill" "$dest/$name"
  done
  echo "skills -> $dest"
done
