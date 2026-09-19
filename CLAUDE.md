# CLAUDE.md — buildday-qr

## What this is
A check-in gate that hands out sponsor credits at a developer event (Fable 5.1 Build Day, Bhopal) to approved attendees only. A desk display shows a QR code that changes every time it is opened. Scanning it asks for the registered email, and an approved, unused email gets one credit link or code from a pool. The attendees are developers, so assume every one of them reads this repo and probes the live site. The constraint that shapes everything: it has to work on event day, run by volunteers, on the free or $5 Cloudflare plan, with no database to set up.

- Design / decisions: `README.md`, section "Security", and the comments in `src/worker.js` (each non-obvious line says why)
- Build log: `notes/` (one file per phase, updated after every phase commit)

## Commands
- Environment: `npm install`
- Run: `npm run dev` (wrangler dev on port 8787, keys come from `.dev.vars`)
- Tests: `npm test` in a second terminal while the dev server runs, about 10 seconds · lint/format: none configured · types: none, plain JavaScript
- Deploy: `npx wrangler deploy`, only after `npm test` exits 0
- Private URLs: `node urls.mjs <site> <ADMIN_KEY> <DISPLAY_KEY>`
- Smoke: `/smoke`

## Conventions
- Plain JavaScript ES modules on Cloudflare Workers. One source file, `src/worker.js`. One runtime dependency, bundled at deploy time. No CDN scripts, no build step beyond wrangler.
- Two layers. The outer Worker is the gate: routing, admin auth, Origin check, body caps, and every answer that needs no data. The Durable Object `Gate` holds all state and makes every claim decision. It trusts `X-Role` / `X-Base` only because the gate builds that request from scratch.
- `scan()` must stay free of `await`. That is what makes check, assign and burn one atomic step.
- `findEmails` and `xlsxText` are injected into the admin page with `toString()`. Keep them self-contained: no module helpers, no named inner functions (the bundler wraps those in `__name()`, which does not exist in the page). `test.mjs` runs the injected copies.
- Every SQL statement binds its values with `?`. Everything printed into HTML goes through `esc()`. No inline event handlers: pages run under a nonce-based CSP, confirm prompts use `data-confirm`.
- Never run one greedy regex across a whole untrusted blob. Cut it into short pieces first.
- Secrets: `ADMIN_KEY` and `DISPLAY_KEY` via `npx wrangler secret put`. Local values live in `.dev.vars` (gitignored). Never write a real key, or a path derived from one, into any tracked file.
- Commits: `<type>: <description>`, on a feature branch with a PR, never straight onto `main`.

## Workflow (Claude Code team tips + ECC loop + Ponytail)
- **Ponytail ladder before code:** does it need to exist → already in this repo → stdlib → platform → installed dependency → one line → only then the minimum that works. Read the code the change touches first. Never cut validation, error handling, security or anything requested. Deliberate shortcuts get a `ponytail:` comment naming the ceiling and upgrade trigger.
- **Plan:** complex task → plan mode; `plan-reviewer` agent reviews the plan as a staff engineer; re-plan when something goes sideways.
- **Build:** research/reuse first (`search-first`); tests first for pure logic (RED → GREEN commits); fixtures + `/smoke` for model/network code; then `/code-review` from a fresh context, `verification-loop`, and the `verify-app` agent.
- **Commit:** `/ponytail-review` on the diff; "Grill me on these changes and don't commit until I pass your test"; "Prove to me this works" with real output; `/commit-phase`.
- **Phase close:** `/phase-close` (review, verification loop, `/ponytail-audit`, notes, prune this file). Independent phases run in git worktrees under `.claude/worktrees/`.
- **Publish:** `/security-scan` and `npx -y ecc-agentshield scan --path .` first.

## Mistakes and rules
Append one line after every correction ("Update your CLAUDE.md so you don't make that mistake again"). Prune at the end of each day.

- Never gate a deploy with `npm test | tail && deploy`. A pipe returns the last command's status, so a crashed test run deployed anyway. Capture `rc=$?` and test it.
- The live site holds real attendee data. Checks against it are read-only: GETs, plus POSTs that cannot match anything. No seeding, no real claims, no reset. A live script must read the counts first and abort if they are not zero.
- A security test needs a mutation check. Break the defence on purpose, watch the test fail, restore it, and confirm no `MUTANT` marker is left.
- A hand-built `Request` defaults to `redirect: 'follow'`. The gate's forward to the Durable Object must say `redirect: 'manual'`, or the object's 303s get chased inside the Worker and every admin POST turns into a 404.
- Answering a POST before its body is read, while that body streams into a Durable Object, throws after the response and can take the next request down. The gate buffers the body (with a byte cap) before forwarding.
- A strict CSP breaks pages silently. After touching headers or scripts, load every page in a real browser and look for `securitypolicyviolation` events.
- Apply the three-techniques harness at the start of a project, not right before the first commit.
- When the organizer gets a behaviour wrong in a calm quiz (Edit versus Delete on a claimed link), a volunteer will get it wrong at a busy desk. Put the consequence in the confirm dialog at the moment of the click, not only in the README.
