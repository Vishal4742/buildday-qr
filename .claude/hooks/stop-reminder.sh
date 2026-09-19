#!/usr/bin/env bash
# Stop hook: non-blocking reminder when source changed but was not verified. Never blocks.
set -u
cd "${CLAUDE_PROJECT_DIR:-.}" 2>/dev/null || exit 0
git rev-parse --is-inside-work-tree >/dev/null 2>&1 || exit 0
changed="$(git status --porcelain 2>/dev/null | grep -vE '^\?\? (notes|docs)/|\.md$' | wc -l | tr -d ' ')"
if [ "${changed:-0}" -gt 0 ]; then
  printf '{"systemMessage":"%s uncommitted change(s): run /smoke and /ponytail-review before committing."}\n' "$changed"
fi
exit 0
