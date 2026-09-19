---
description: Close a unit of work — verification gate, ponytail review, grill me, notes + CLAUDE.md, then a conventional commit
argument-hint: <type>: <description>   e.g. feat: lens search with face-verified ranking
allowed-tools: Bash(git status:*), Bash(git diff:*), Bash(git log:*), Bash(git add:*), Bash(git commit:*), Bash(pytest:*), Bash(ruff:*), Bash(pyright:*), Bash(npm test:*), Bash(npx tsc:*), Bash(cargo test:*), Bash(go test:*), Read, Edit, Write
---

## Context (pre-computed, no model calls)
- Status: !`git status --porcelain`
- Diff stat vs HEAD: !`git diff --stat HEAD | tail -20`
- Last commits: !`git log --oneline -5`

## Task
1. Verification gate: run the `/smoke` checks for this stack. If anything fails, stop and report; do not commit.
2. `/ponytail-review` on the diff: list what can be deleted or simplified; apply the safe ones and re-run the gate.
3. Grill me: the three riskiest changes in this diff as questions I must answer (behaviour changes, hashing/canonicalization, anything touching money, keys or user data). Wait for my answers.
4. Update `notes/phase-N.md` (what was built, what was verified with real output, decisions, open issues, next phase needs) and add any new rule learned to "Mistakes and rules" in `CLAUDE.md`.
5. Stage only files that belong to this change (never `.env`, keys, generated output), commit with message `$ARGUMENTS`, show `git log --oneline -1`.
