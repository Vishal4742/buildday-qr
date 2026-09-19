#!/usr/bin/env bash
# PostToolUse hook: format + lint-fix the file Claude just wrote or edited. Never blocks.
set -u
file="$(python3 -c 'import json,sys
try:
    print(json.load(sys.stdin).get("tool_input", {}).get("file_path", ""))
except Exception:
    print("")' 2>/dev/null || python -c 'import json,sys
try:
    print(json.load(sys.stdin).get("tool_input", {}).get("file_path", ""))
except Exception:
    print("")' 2>/dev/null)"
[ -n "$file" ] && [ -f "$file" ] || exit 0

find_tool() {  # prefer a project-local tool, then a venv next to the project, then PATH
  for c in "./node_modules/.bin/$1" "./.venv/bin/$1" "${VIRTUAL_ENV:-/nonexistent}/bin/$1" "$HOME/.venvs/$(basename "$PWD")/bin/$1"; do
    [ -x "$c" ] && { echo "$c"; return; }
  done
  command -v "$1" 2>/dev/null || true
}

case "$file" in
  *.py)
    RUFF="$(find_tool ruff)"; [ -n "$RUFF" ] && { "$RUFF" format -q -- "$file"; "$RUFF" check --fix -q -- "$file"; } >/dev/null 2>&1 ;;
  *.ts|*.tsx|*.js|*.jsx|*.json|*.css|*.md)
    P="$(find_tool prettier)"; [ -n "$P" ] && "$P" --write --log-level silent -- "$file" >/dev/null 2>&1 ;;
  *.go)
    command -v gofmt >/dev/null 2>&1 && gofmt -w -- "$file" >/dev/null 2>&1 ;;
  *.rs)
    command -v rustfmt >/dev/null 2>&1 && rustfmt -- "$file" >/dev/null 2>&1 ;;
esac
exit 0
