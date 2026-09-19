---
description: End-of-session sweep for duplicated code, dead code and over-engineering (ponytail ladder applied to what exists)
allowed-tools: Bash(git diff:*), Bash(git log:*), Read, Grep, Glob
---

## Context
- Today's commits: !`git log --since=midnight --oneline`
- Source size: !`git ls-files | grep -E '\.(py|ts|tsx|js|go|rs)$' | xargs wc -l 2>/dev/null | tail -1`

## Task
Use subagents to explore in parallel. Find, ranked biggest cut first:
1. `delete:` dead code, unused flags, speculative features (grep every `def`/`function` for callers).
2. `stdlib:` / `native:` hand-rolled things the standard library or platform already provides.
3. `yagni:` abstractions with one implementation, config nobody sets, layers with one caller.
4. `shrink:` same logic in fewer lines (show the shorter form).

One line per finding: `<tag> <what to cut>. <replacement>. [path:line]`. Apply only cuts that keep the checks green, then run `/smoke`. End with `net: -<N> lines`.
