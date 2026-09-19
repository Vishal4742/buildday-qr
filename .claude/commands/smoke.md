---
description: Detect the stack and run lint, types, tests and the smoke script; report PASS/FAIL with real output
allowed-tools: Bash(pytest:*), Bash(python -m pytest:*), Bash(ruff:*), Bash(pyright:*), Bash(mypy:*), Bash(npm test:*), Bash(npm run lint:*), Bash(npm run test:*), Bash(npx tsc:*), Bash(cargo test:*), Bash(cargo clippy:*), Bash(go test:*), Bash(go vet:*), Bash(scripts/smoke.sh:*), Read, Grep
---

## Context
- Branch: !`git branch --show-current`
- Uncommitted: !`git status --porcelain | wc -l`
- Stack markers: !`ls pyproject.toml package.json Cargo.toml go.mod 2>/dev/null | tr '\n' ' '`

## Task
Pick the checks for the stack markers present and run them in order (activate the project environment first if `CLAUDE.md` names one):
- `pyproject.toml`: `ruff check . && ruff format --check .`, `pyright` (or `mypy`), `pytest -q --cov`
- `package.json`: `npm run lint`, `npx tsc --noEmit`, `npm test`
- `Cargo.toml`: `cargo clippy -- -D warnings`, `cargo test`
- `go.mod`: `go vet ./...`, `go test ./...`
- `scripts/smoke.sh` if it exists

Report a table: step | PASS/FAIL | one-line evidence (counts, coverage, first failing assertion). Never claim PASS without the command output. If anything fails, propose the fix; apply it only if asked.
