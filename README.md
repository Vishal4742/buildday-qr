# Build Day QR gate

A check-in screen shows a QR code. Scanning it opens a short link that asks for the email you registered with. If that email is on the approved list and hasn't claimed yet, you get one credit link or code from the pool. The code on screen changes as soon as someone opens it, and every 20 seconds anyway.

So a claim needs two things: a live code from the desk, and an approved email that's still unused. A forwarded link or a photo of the screen is worthless to anyone who isn't on your list, and the total number of claims can never pass the size of that list.

One Cloudflare Worker, one Durable Object, no database to set up.

## Deploy

```
npm install
npx wrangler login
npx wrangler deploy
npx wrangler secret put ADMIN_KEY
npx wrangler secret put DISPLAY_KEY
node urls.mjs https://buildday.<you>.workers.dev <ADMIN_KEY> <DISPLAY_KEY>
```

Use two different long random keys. `ADMIN_KEY` is the password to the admin panel and stays with you. `DISPLAY_KEY` is never typed anywhere. It only produces the private display link. Until a key is set, its area doesn't exist for anyone.

There is no `/admin`. The panel and the display link are private addresses worked out from the keys, and `urls.mjs` prints them. Bookmark both. If you change a key, its address changes too, so run `urls.mjs` again.

The display has no password. Opening the display link signs that browser in for two weeks and moves it to `/screen`. So the link is the secret: send it to the check-in desk and nobody else. If it ever leaks, set a new `DISPLAY_KEY`. The old link dies and every signed-in screen is signed out.

## Getting in, and changing a key

Open your admin address, the one `urls.mjs` printed. The browser shows a login box. The first time, type anything as the username and your `ADMIN_KEY` as the password. There is no login page to find anywhere else, and that is on purpose.

Then scroll to "Admin login" at the bottom of the panel and set your own ID and password. From then on you log in with those. Three things to know:

- The address of the panel does not change when you change your ID or password.
- The `ADMIN_KEY` keeps working as the password, with any ID. That is how you get back in if you forget yours, so nobody can lock you out.
- Five wrong passwords lock the ID and password for five minutes. The `ADMIN_KEY` is never locked. Your password is stored as a salted PBKDF2 hash, never as text.

You only need the command line for the keys themselves, for example after a leak. Run one command from the repo folder, in your own terminal:

```
node rotate.mjs admin https://claim.yourdomain.com       # new admin password
node rotate.mjs display https://claim.yourdomain.com     # new display link
```

It makes a strong random key, or takes your own as a third argument if it is at least 16 characters. Add `--dry-run` to see the plan first. The new key is printed once and kept nowhere, so save it.

Two things surprise people. The admin address changes together with the password, because the address is worked out from the key. Your old bookmark will say "Not found", which is expected, and the command prints the new address to bookmark. And nothing else changes: links, emails and claims stay exactly as they were.

Don't change a key with `wrangler secret put` by hand once the Pages front door exists. Pages keeps its own copy, only picks a new value up on its next deploy, and every older Pages deployment stays reachable at its own address with the old key still working. `rotate.mjs` sets both copies, redeploys, and deletes the older deployments.

## Your own domain

Worth doing for two reasons. Attendees see your name instead of `workers.dev` when their camera reads the code, and developers notice that. And some Indian mobile networks have blocked `workers.dev` addresses in the past.

There are two ways to get there. Pick by how busy your domain already is.

### The quick way: one CNAME record, wherever your DNS lives

Use this if your domain already runs mail or other sites and you don't want to touch any of that. Your DNS stays at Spaceship, GoDaddy, Hostinger or wherever it is.

Cloudflare Workers only accept domains that Cloudflare manages. Cloudflare Pages accepts a subdomain from any DNS provider. So the repo ships a second front door in `pages/`. It is the same gate code and it talks to the same Durable Object, so both entrances share one set of data.

1. Create the Pages project once: `npx wrangler pages project create buildday-qr --production-branch main --force`. Run it from an empty folder, not from this repo. Without `--force`, current wrangler versions turn this command into "deploy the current folder as a new Worker", which is not what you want. The flag is only needed this one time.
2. Give it the same two keys: `npx wrangler pages secret put ADMIN_KEY --project-name buildday-qr`, and the same for `DISPLAY_KEY`.
3. `npm run deploy` now updates both entrances, the Worker first because it owns the data.
4. In the Cloudflare dashboard open Workers & Pages, `buildday-qr`, Custom domains, "Set up a custom domain". Type the address you want, for example `claim.yourdomain.com`. Do this before the next step. Cloudflare says a CNAME added first will not resolve.
5. At your DNS provider add a CNAME record. Host: `claim`. Value: `buildday-qr.pages.dev`. If you added this record before step 4, nothing is lost. It just won't resolve until step 4 is done.
6. Wait for the dashboard to show the domain as active, usually a few minutes. Then run `node urls.mjs https://claim.yourdomain.com <ADMIN_KEY> <DISPLAY_KEY>` for your new admin address and display link. Only the front part changes.

Three things to know. Every key now lives in two places, so change keys with `node rotate.mjs` and not by hand (see "Getting in, and changing a key"). Pages keeps every old deployment reachable at its own `<hash>.buildday-qr.pages.dev` address. After a deploy that fixes something in the gate, delete the older ones with `npx wrangler pages deployment list --project-name buildday-qr` and `npx wrangler pages deployment delete <id> --project-name buildday-qr`, or stale gate code stays reachable. And this route gives you no Cloudflare firewall rule, because that needs the whole domain on Cloudflare. Classic Pages is also the older of Cloudflare's two platforms, so treat this as the route for the event and look at the next one afterwards.

### The thorough way: move the domain's nameservers to Cloudflare

This puts Cloudflare's firewall in front and lets you turn the `workers.dev` address off. It also touches the DNS for everything else on the domain, so don't start it right before an event. It's free and you keep the domain where it is.

1. In the Cloudflare dashboard choose "Add a domain", type your domain, and pick the Free plan.
2. Cloudflare copies your existing DNS records. Stop and check them if the domain already runs a website or email. Every record on your registrar's DNS page should be in Cloudflare's list, the MX records for mail above all. Add any that are missing. Skipping this is how people break their email.
3. Cloudflare shows you two nameservers. At the place you bought the domain, replace the current nameservers with those two. On GoDaddy: Domain, DNS, Nameservers, Change, "I'll use my own nameservers". On Hostinger: Domains, your domain, DNS / Nameservers, Change nameservers.
4. Wait for Cloudflare's email saying the domain is active. Often under an hour, sometimes a day.
5. In `wrangler.toml`, uncomment the `routes` line and put your address in, for example `claim.yourdomain.com`. Run `npx wrangler deploy`. Cloudflare creates the DNS record and the certificate by itself.
6. Open the new address and check it, on Jio and Airtel data too. Then uncomment `workers_dev = false`, deploy again, and the domain is the only way in. Run `node urls.mjs https://claim.yourdomain.com <ADMIN_KEY> <DISPLAY_KEY>` for your new admin address and display link. Only the front part changes.

Do step 6 only after the new address works. Turning `workers.dev` off first would take the site down until the domain is ready.

### A firewall rule, if you stay on the free plan

With the domain in place you get one free rate limiting rule. In the Cloudflare dashboard open your domain, then Security, WAF, Rate limiting rules, Create rule:

- When incoming requests match: URI Path does not equal `/screen/current`
- Same IP address, more than 100 requests in 10 seconds
- Then block for 10 seconds

A person claiming makes three or four requests. A `curl` loop makes hundreds. The desk display is left out of the rule on purpose so a flood from the venue Wi-Fi can never freeze your QR. Blocked requests never reach the Worker, so they don't eat the free plan's daily allowance either. The catch: everyone on the venue Wi-Fi shares one address, so while someone floods from it, other people on that Wi-Fi are blocked too and need mobile data. On the Paid plan you can skip this rule, because a flood then costs you cents and hurts nobody.

## On event day

1. Open your admin address on your own laptop or phone. The browser asks for a login: any username, and `ADMIN_KEY` as the password.
2. Paste your credit links or codes, one per line, and save. If every line is unique, leave "how many people" at 1. If you only got one shared link, paste it once and enter your attendee count.
3. Load your approved emails. Pick your Excel sheet or CSV export with "Choose File", check the addresses that show up in the box, and press "Save emails". Pasting works too, in any shape: one per line, names mixed in. Only the addresses are kept. Until at least one email is loaded, nobody can claim.
4. On the check-in laptop, open your display link. No password. The QR comes up and the address bar says `/screen`. Press F11 for full screen and turn it toward attendees. Refreshing is safe. Never type `ADMIN_KEY` on that machine.
5. People scan, type their registered email, tap "Claim my credits", and land on their link.

Do a dry run first: add your own email, claim with your phone, then press "Clear claims only". That forgets the test claim and keeps your links and emails. Never press it mid-event.

Put this on the desk, not the projector. Each code admits one claim, so a hall of 100 people scanning one screen would mostly see "no longer valid".

## The admin panel

Three parts on one page.

Credit links. Add more at any time. Each row has an "edit" link where you can change the link or code, change how many people may claim it, or delete it. Two things to know. Editing a link also moves everyone who already got it, so if a sponsor replaces a broken link you fix it once and those people just reopen their short link. Deleting a link releases its claims, so whoever held it can scan and claim again.

Approved attendees. The file picker takes `.xlsx` and `.csv`. It looks through every sheet and every column, so you don't need to clean the file up first. The file is read inside your browser and is never uploaded. Only the addresses you see in the box get sent when you press save. Loading a second file adds to the list, and addresses already on it are skipped. The old `.xls` format isn't supported: use Save As in Excel and pick `.xlsx`. Each person who hasn't claimed yet has a "remove" link, for when you approved someone by mistake. People who have claimed stay on the list so the record stays honest.

"Download the list with claim status" gives you a CSV that opens in Excel: every approved email, whether they claimed, what they got, and when. Handy for your sponsor report after the event.

Danger zone. "Clear claims only" is for after your dry run. "Delete everything" is for after the event.

### At the desk

A credit link turns out to be broken: edit it in the admin panel. Everyone holding it gets the new value the next time they open their short link.

Someone can't claim: the form gives one answer whether the email isn't approved or has already claimed, on purpose, so a refusal tells a guesser nothing. Look the person up in the admin panel. If they registered under another address, they use that one, or you add the one they want.

A walk-in you want to let in: add their email in the admin panel and they can claim right away.

Someone lost their page: opening any old short link on the same phone brings their credit back. On a different phone they'll be refused, and you can read their link out from the table in the admin panel.

Someone is refused but the panel shows their email as claimed, and they swear it wasn't them: a person at the desk used their email. The table shows when. Approve a second address for the victim and let them claim with that. Anything works, `name+1@gmail.com` for example, since no mail is ever sent.

## Security

Your attendees are developers, so assume every one of them opens dev tools and tries `/admin`. Here is what they'll find.

Nothing to look at in the browser. The claim page is a plain HTML form. Whether a code is live, whether an email is approved, who gets which credit: all of it is decided on the server. No keys, no logic and no other attendee's data ever reach a phone.

No admin page to find. `/admin`, `/login`, `/api` and every other guess return the same 404 with no login prompt. The real addresses are 80 random-looking bits derived from your keys. Behind them sits the key itself, 100 bits, compared in constant time. Guessing is not a plan, and wrong keys are logged: run `npx wrangler tail` during the event and you'll see `wrong admin key from <ip>` if someone found the address and is trying.

The desk laptop is not an admin. It holds a display cookie, which opens the QR and a live counter, and nothing else. Someone who opens a new tab on it while your volunteer looks away finds no admin panel, because that machine never had the admin key. This is the most realistic attack at a desk, which is why the two are separate.

The display has no password, by choice, so think about what its link is worth. The address bar on the desk only ever shows `/screen`, which is a 404 for every browser without the cookie, so a photo of the screen gives nothing away. The cookie is HttpOnly, so page scripts can't read it. If the private link itself leaks, the holder can watch live codes from anywhere. That removes the "you have to be at the desk" rule for them, and nothing more: a code still needs an approved, unused email, and claims still can't pass the size of your list. Setting a new `DISPLAY_KEY` ends it.

Two layers. The Worker facing the internet holds no data. It turns away wrong paths, wrong methods (only GET and POST exist), oversized bodies (counted as they arrive, 10 KB for a claim) and failed logins by itself. The Durable Object with your links and emails has no public address at all. It can only be called by that Worker, which builds the internal request from scratch, so a forged `X-Role: admin` header from outside goes nowhere.

Injection. Every SQL statement binds its values, so an email like `' OR '1'='1` is just a wrong email. Everything printed into a page is escaped. Behind that sits a Content-Security-Policy with a fresh random nonce per response, so even a missed escape could not run a script. There are no inline event handlers and no third-party scripts or CDNs. Pages can't be framed. A hostile website can't make your logged-in browser post to the admin panel, because the Origin is checked. The CSV export defuses cells that Excel would run as formulas. The claim cookie is `__Host-` prefixed, HttpOnly and Secure.

Imports can't freeze it. Your approved list probably started as a public sign-up form, so treat it as hostile. Addresses are found by cutting the text into short pieces first, which keeps the work linear. An earlier version used one greedy pattern, and an outside review showed that a single 150 KB cell with no spaces froze every scan and claim for 21 seconds. The same input now takes a millisecond, and a test holds it there.

`npm test` attacks all of the above and fails if any of it stops holding.

### What is still on you

Go Paid for the event. This is the one real weak spot left, and code can't fix it. The free plan stops serving after 100,000 requests in a day, and one attendee with a `while true; curl` loop can burn that in minutes and take the desk down for everyone. Workers Paid is $5 for the month, has no daily cap, and a day-long flood costs you about a dollar. Turn it on in the Cloudflare dashboard under Workers, Plans. There is no per-IP rate limit here on purpose: everyone at a venue shares one Wi-Fi address, so a limit would let a single flooder lock out the whole room.

Keep `ADMIN_KEY` off shared screens, and log in to the admin panel on a device that stays in your pocket or bag.

Typing an email isn't proof of owning it. This is the biggest thing left, so here it is without sugar. The small version: someone at the desk who knows a teammate's registered email claims in their name. It shows in the panel, and the fix above costs you one spare credit. The big version: someone with a list of your attendees' emails and a supply of fresh codes could claim other people's credits by script. Fresh codes come from filming the desk screen, or from a leaked display link. The five-wrong-guesses limit doesn't stop this. It is per code, and every guess from a real list is correct.

Three things stand in the way. Codes appear one per second at most. Claims are capped at `MAX_CLAIMS_PER_MINUTE`, 30 by default, where a real desk manages about ten, and hitting the cap is logged. And every claim moves the counter on the display and lands in the panel with its time, so a run on the pool is visible while it is still small. If you see one, set a new `DISPLAY_KEY` and keep the attendee list out of public view. Closing this for good means emailing each person a one-time code before they can claim. That needs a mail service, costs every attendee half a minute at the desk, and depends on mail arriving over venue Wi-Fi. It is a trade, not a free win.

If your credit is one shared link, an approved person who claims it can still copy the final URL out of their address bar and pass it on. No code can fix that, because the link itself works for anyone. Send your approved list to whoever issued the credits and ask for unique codes per person, or for redemption to be limited to those emails.

Nothing on the web can detect a screenshot or a camera pointed at a screen. It doesn't matter here, because a code alone gets you nothing without an approved email.

Some Indian mobile networks have blocked `workers.dev` addresses in the past. Test your live URL on Jio and Airtel data before the event. If it fails, attach your own domain in the Cloudflare dashboard (Workers, your worker, Settings, Domains & Routes). Your own domain also lets you add Cloudflare's firewall rules in front.

## Privacy

The approved emails are personal data. They sit in your Cloudflare account, only the admin panel shows them, and nothing is sent anywhere else. Press "Delete everything" once the event is over.

## Tuning

`ROTATE_SECONDS`, `TTL_SECONDS` and `MAX_CLAIMS_PER_MINUTE` live in `wrangler.toml`. A code lives 120 seconds so people have time to type an email on a phone. If your desk keeps hitting "no longer valid", raise `TTL_SECONDS` and redeploy. If you run several desks off one display and honest people see "Too many claims right now", raise `MAX_CLAIMS_PER_MINUTE`. To rename the event, change `EVENT` at the top of `src/worker.js`.

The display polls once a second, roughly 3,600 requests per hour. Close the display tab when the desk is closed.

## Test

```
npm run dev     # terminal 1
npm test        # terminal 2, about 10 seconds
```

Attack surface: guessable paths all 404 even with the real key and forged internal headers, the display link signs in without a password prompt, `/screen` is a 404 without the right cookie, a signed-in screen reaches nothing but the QR and can't open the admin panel, cross-site POSTs are refused, other HTTP methods are refused, oversized bodies are cut off, and every page carries the security headers with a nonce that changes per response.

Claim flow: email extraction from a messy paste, unapproved emails refused, identical wording for "not approved" and "already claimed", script and SQL shaped input coming back inert, one claim per email, one credit per phone, single-use codes, the five-wrong-guesses limit, the screen moving on when a code is opened, sold out, expiry, and "Clear claims only" keeping links and emails.

Abuse: a 250 KB hostile import has to finish in under two seconds on the server and one in the admin page, and claims past `MAX_CLAIMS_PER_MINUTE` are refused without using anything up.

Admin panel: editing a link moves its holder, junk and duplicate edits are refused, deleting a link releases its claims, stored markup shows up escaped, no inline handlers, only unclaimed emails can be removed, and the CSV export defuses formula-shaped cells. The Excel reader is tested by pulling the script out of the served admin page and running it on the two files in `fixtures/`, one written by Excel and one by openpyxl.
