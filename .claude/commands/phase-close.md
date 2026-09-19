---
description: Close a build phase with the full loop — fresh-context review, verification loop, ponytail audit, notes, CLAUDE.md prune
argument-hint: <phase number or name>
allowed-tools: Bash(git status:*), Bash(git diff:*), Bash(git log:*), Read, Grep, Glob, Edit, Write
---

## Context
- Phase: $ARGUMENTS
- Changed files since the last phase commit: !`git diff --name-only HEAD~1 2>/dev/null | head -40`

## Task
Run these, collecting real output for each; do not skip a step because "it should be fine":
1. `/code-review` (ECC, fresh context): fix CRITICAL and HIGH findings, list MEDIUM ones.
2. `verification-loop` (ECC): lint, types, tests with coverage, secret grep, diff review.
3. Launch the `verify-app` agent and paste its verdict.
4. `/ponytail-audit`: apply the safe cuts, list the rest under "left alone" with reasons.
5. Write `notes/phase-$ARGUMENTS.md`: built / verified (real output) / decisions / open / next.
6. Prune "Mistakes and rules" in `CLAUDE.md`: merge duplicates, delete rules that no longer apply.
7. `/commit-phase` with a conventional message.
