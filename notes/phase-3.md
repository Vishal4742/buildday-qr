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
- Nothing left that needs a laptop on event day. The display credential now has two halves: the one derived from `DISPLAY_KEY`, still checked in the gate so junk never reaches the object, and a `display_token` in `kv` that the panel replaces with one button. A new token kills the old link and signs every screen out. With no token set, the plain link and plain cookie keep matching, so nothing changed for a desk that was already running. The three tuning numbers moved into `kv` with `wrangler.toml` as the starting values, saved as a whole or not at all. The panel shows the wrong-login counter, which used to need `wrangler tail`.
- `npm test` for that change: exit 0 twice, once from the no-token state the live site was in, and once starting from an already replaced link.
- Still laptop-only, on purpose: `ADMIN_KEY`. It is the way back in when everything stored has gone wrong, so it must not depend on anything stored.
- The QR stopped being an SVG and became an image (a GIF data URL from `createDataURL(8, 32)`, shown in an `<img>` with `image-rendering: pixelated`, CSP `img-src data:`). The organizer reported several times that the QR was not visible while every check here, in a clean headless browser, showed it. An SVG's black and white are only colours, and dark-mode extensions, forced dark themes and Windows high contrast repaint colours. They leave images alone. Verified: `npm test` exit 0, the image decoded with jsQR to the exact claim URL both locally and from the live feed, and the live page in a real browser showed a 565 px image with zero CSP violations.
- Lesson: "it renders in my clean browser" says nothing about the organizer's browser. When a user keeps reporting something invisible that tests can see, suspect their rendering environment and remove the dependency on it.
- What "QR not visible" turned out to be. A screenshot of the organizer's own Chrome, taken with permission, showed the QR rendering. They had about thirty tabs open, several of them older tabs of this site, and the site had been deployed many times in an hour. A tab opened before a deploy keeps running the old page code, and after the QR changed from SVG to an image an old tab could not draw the new codes. The feed now carries the deployed version (`[version_metadata]`), and the display reloads itself when it changes. The display also sizes the QR from the window's height, so the whole code fits without scrolling at every size tried, from a 780x360 phone held sideways to 1080p.
- A mistake on the way: the first screenshot looked as if the QR was cut off at the bottom. `CopyFromScreen` from a process that is not DPI-aware crops a scaled display to its top-left part. The layout was not the cause. Check the tool before believing the picture.
- The real cause of most "QR not visible" reports: the organizer kept opening the home page, `claim.withclaude.in`, which by design never showed the QR. Being told four times to use the display link did not change what they expected their own site to do. The home page now IS the QR display for a screen that has signed in through the display link (same two-part cookie as `/screen`, same checks), and stays a line of text for everyone else, including a forged or signed-out cookie. Lesson: when a user keeps going to the same place expecting the same thing, change the place, not the user.
