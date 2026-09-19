# Phase 2 — a front door for a custom domain by CNAME

## What was built
- `pages/wrangler.toml` and `pages/site/_worker.js`: a classic Cloudflare Pages project, `buildday-qr`, that re-exports the Worker's gate (`export { default } from '../../src/worker.js'`) and binds `GATE` to the Durable Object owned by the `buildday` Worker through `script_name`. Nothing is copied, and both entrances share one set of data.
- `npm run deploy` now deploys the Worker first and then the Pages project, so the gate can't go stale on one side.
- README: the domain section now leads with the CNAME route and keeps the nameserver move as the thorough alternative.

## Why
The organizer's domain already serves mail and several sites from another DNS provider. Workers custom domains need the whole zone on Cloudflare. Classic Pages accepts a subdomain from any DNS provider with one CNAME record, and a Pages Function can bind to a Durable Object in another Worker. Both points were checked against Cloudflare's documentation before building.

## What was verified (real output)
- Read-only comparison of the two entrances, run after the Pages deploy:
  - Pages data: the live approved, remaining and claimed counts, and sign-in lands on `/screen` of the Pages host
  - Worker data: the identical three counts, so it is the same Durable Object
  - Pages guessable paths `/admin /login /screen`: `404 404 404`
  - Pages admin path with no key, a wrong key, the right key: `401 401 200`
  - Pages `PUT /` and a 20 KB claim body: `405 413`
  - Pages CSP present, `X-Frame-Options: DENY`, `nosniff`
- `npm test` against the local Worker: exit 0. The gate code did not change in this phase.

## What went wrong
- `npx wrangler pages project create buildday-qr --production-branch main`, run from the repo root, did not create a Pages project. wrangler 4.135 delegates that command to Workers and deployed this directory as a new public Worker named `buildday-qr`, with its own empty Durable Object and no keys. Every private path on it answered 404 and it could not see the real data. It was deleted within minutes with `wrangler delete --name buildday-qr --force`, and the real Worker's version and data were checked afterwards and were untouched.
- The classic project was then created with `--force`, from an empty directory, after the organizer chose this route knowing it is Cloudflare's older platform.

## Decisions
- Classic Pages, by the organizer's choice, as the route for this event. Revisit after it.
- Keys live in two places now (Worker secrets and Pages secrets). Documented in README and CLAUDE.md.
- Old Pages deployments stay reachable at their hash URLs. Delete them after any deploy that fixes the gate.

## Open issues
- The custom domain itself is two manual steps for the organizer: add it under the Pages project's Custom domains, then add the CNAME at the DNS provider. In that order.
- No Cloudflare firewall rule on this route.
- The `workers.dev` and `pages.dev` addresses both stay reachable. They run the same gate, so this costs nothing in security, but QR codes point wherever the display was opened from. Open the display on the custom domain.

## What the next phase needs
- The custom domain active, then new private URLs from `urls.mjs`, then a dry run on the desk laptop through the new address.
