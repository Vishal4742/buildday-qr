# Phase 3 — the organizer's own admin ID and password

## What was built
- The admin login moved from the gate into the Durable Object. `login()` accepts the `ADMIN_KEY` as the password with any ID (checked first, touches no storage), or the ID and password the organizer sets in the panel (PBKDF2-SHA256, 100,000 rounds, 16-byte salt, in a new `kv` table). Five wrong passwords lock that second way for five minutes. The key is never locked.
- The gate no longer checks the password. It still owns the Origin check and the body cap, and forwards `Authorization` only for the admin area. `X-Role: admin` now means "reached the admin area", not "logged in".
- Panel: an "Admin login" form (ID, password, password again) and a search box over the attendee table.
- The panel address no longer moves when the login changes, because it is still derived from `ADMIN_KEY`.

## Why this shape
A session-and-login-page redesign was planned and sent to the plan reviewer. The organizer then asked for no tests because of time. A large untested rewrite of authentication before an event was the wrong trade, so the plan was cut to the smallest change that gives a changeable ID and password. Keeping HTTP Basic means the existing request flow, and the master-key path in particular, behaves exactly as before.

## What was verified
- NOT run, on the organizer's instruction: `npm test`, mutation checks, the browser pass, the pre-commit quiz.
- Run: `wrangler deploy --dry-run` (builds), and after the deploy a read-only check of the live site: home 200, admin 401 without a login, 401 with a wrong password, 200 with the admin key, the new form and search box present, 443 attendee rows, `/admin` and `/login` 404, stored counts unchanged, display still serving a QR.
- Run: the `slowHash` code on Node's WebCrypto (executes in about 50 ms, salted, deterministic) and the ID and password rules against sample values.
- NOT exercised anywhere: saving a login, logging in with it, and the lockout, end to end. If any of it fails, the admin key still opens the panel.

## Open issues
- `test.mjs` does not cover `setLogin`, the custom login or the lockout yet. Add: save rules (short, mismatch, equals ID, bad ID), login with the new pair, the old pair failing after a change, five failures then 429 while the admin key still works, `Delete everything` leaving the login alone. Then the usual mutation checks.
- The organizer's chosen password is weaker than the 100-bit key by nature. The secret path in front of it is what keeps guessing out of reach.

## What the next phase needs
- Those tests, run, before any further change to `login()`.

## Added later in the same phase
- `ADMIN_PATH`, an optional secret that gives the panel a memorable second address. Matched before the claim-code pattern, because an eight-letter lowercase word has the shape of a code.
- Three labelled ways to add attendees (one address, a pasted list, an Excel or CSV file), all posting to the same route, with a count of new against already listed.
- A Start / Stop switch for claiming, stored in `kv` and closed by default. While closed, `current()` makes no codes, `scan()` refuses with 403, and stopping clears the codes already handed out. Someone who already claimed still gets their credit back.
- Display page: says in words why there is no QR (closed, signed out, no links, no connection), has a `<noscript>` line, and declares `color-scheme: dark` so phone browsers do not repaint the white QR box dark.
- `npm test` was run once for the switch, because it changes `scan()` and `current()`: exit 0, including the new switch checks. That run also showed the login move had not broken the existing suite.
