# Phase 1 — the QR credit gate, hardened and live

## What was built
- `src/worker.js`: a stateless gate Worker in front of one Durable Object. Rotating single-claim QR codes, an approved-email check, one credit per email and per phone, a pool of links or codes that can be shared (`uses`) or unique.
- Admin panel at a secret path derived from `ADMIN_KEY`: add, edit and delete links, load the approved list from `.xlsx` / `.csv` in the browser, remove unclaimed emails, CSV export, "Clear claims only", "Delete everything".
- QR display with no password: a secret link derived from `DISPLAY_KEY` sets a `__Host-screen` cookie and moves to `/screen`.
- `test.mjs`: one end-to-end suite that attacks a running instance. `urls.mjs`: prints the private addresses. `fixtures/`: two real spreadsheets, one written by Excel and one by openpyxl.
- The three-techniques harness (`CLAUDE.md`, `.claude/`, `notes/`).

## What was verified (real output, not claims)
- `npm test` → `ok: all checks passed`, exit 0. Three runs back to back after the last change, and five runs from a deliberately dirty state earlier in the phase.
- Mutation checks. Each defence was broken on purpose, the suite failed, the defence was restored, and `grep -c MUTANT src/worker.js` gave 0:
  - one-time token burn removed → `200 !== 410`
  - email gate removed → `303 !== 403`
  - output escaping removed → "a typed email must never come back as markup"
  - Origin check removed → `303 !== 403`
  - any cookie accepted on `/screen` → `200 !== 404`
  - "can't remove someone who claimed" removed → failed on the approved count
  - CSV formula guard removed → failed on the `'=cmd@…` assertion
  - claim-rate brake removed → `200 !== 429`
- Email search timing, old pattern against the new function:
  - old, one repeated character: 10 KB 48 ms, 20 KB 178 ms, 40 KB 720 ms (quadratic). The 250 KB hostile input was still running after 3 minutes.
  - new: that same 250 KB input 1 ms, 2 MB of one character 3 ms, 2 MB of tiny `a@` pieces 35 ms, 20,000 real-looking addresses 13 ms.
- Real browser (headless Edge over the DevTools protocol): zero `securitypolicyviolation` events on the display, claim, code and admin pages. The QR draws. The file picker reads the Excel fixture ("Found 4 address(es)"), reads a CSV, and turns away the old `.xls` format. Cancelling the "Delete everything" prompt does not submit. The display link lands on `/screen` with no password prompt, the secret is not in the address bar, the cookie is not readable by page script, and a refresh keeps the QR up.
- Live site, read-only checks only: guessable paths all 404 with no login prompt, even with the real admin key plus forged `X-Role` headers. `/screen` is 404 without its cookie and with a forged one. A signed-in screen gets 404 on the export and 401 on the admin panel. The stored data was identical before and after every deploy.
- Independent adversarial review by a separate agent with a private local instance. It found no way to claim without an approved email, read the list, or reach the admin or display. Two findings, both acted on (see Decisions).
- `npm audit`: 0 vulnerabilities. Old version preview hosts: 404.
- `ecc-agentshield`: grade F, but the 92 "hardcoded Azure storage account key" criticals are exactly the 92 `sha512` integrity hashes in `package-lock.json`. The rest is about prompt wording and hook style in the harness templates. No real secret in any tracked file, confirmed by a separate grep for the real keys, the derived paths and the account id.

## Decisions
- Decisions live in the Durable Object because it is single-threaded. `scan()` has no `await`, so check, assign and burn can't interleave.
- The gate builds the inner request from scratch. That is the whole reason the object may trust `X-Role`.
- Secret paths are derived from the keys instead of being a third and fourth secret. Changing a key moves its path.
- No per-IP rate limit: a venue shares one Wi-Fi address, so one flooder would lock out the room. The free plan's daily request cap is the real flood risk, and the answer to that is the Paid plan, or a WAF rule once a domain is attached.
- Review finding 1, quadratic email regex: replaced with `findEmails`, which cuts the text into pieces first. It is shared with the admin page through `toString()` and covered by a timed test.
- Review finding 2, guess limit is per code: added `MAX_CLAIMS_PER_MINUTE` (successes only, so it can't be used to lock people out) and rewrote the README, which had overclaimed.
- The display has no password, at the organizer's request. The link is therefore the secret. The cookie hop keeps it out of the address bar of a screen that attendees photograph.
- Public repository. Nothing depends on hiding the code.

## Open issues
- Typing an approved email is not proof of owning it. Someone with the attendee list and a supply of fresh codes can claim other people's credits at up to the per-minute cap. The real fix is a one-time code by email, at the cost of about 30 seconds per attendee and a dependency on mail delivery over venue Wi-Fi.
- Custom domain not attached yet. The organizer's domain already serves mail and other sites, so its nameservers should only move after a record-by-record comparison against the current zone.
- The free plan stops serving after 100,000 requests in a day.
- `three-techniques/scripts/setup.ps1`: `CopyIfAbsent` calls `New-Item -Path (Split-Path $dst)`, which is an empty string for root-level files such as `CLAUDE.md`. It prints an error and still copies the file.

## What the next phase needs
- Domain active in the Cloudflare account, then `routes` in `wrangler.toml`, a check on Jio and Airtel data, then `workers_dev = false`, then new private URLs from `urls.mjs`.
- A decision on the one-time email code.
- A dry run on the real desk laptop: open the display link, claim with a phone, press "Clear claims only".
