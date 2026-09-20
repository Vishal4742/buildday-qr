// Start `npm run dev` in another terminal first, then `npm test`.
// Relies on .dev.vars: ADMIN_KEY=dev, DISPLAY_KEY=devdisplay, ROTATE_SECONDS=2, TTL_SECONDS=6, MAX_CLAIMS_PER_MINUTE=6.
// Takes about 10 seconds.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const BASE = process.env.BASE || 'http://localhost:8787';
// Worked out here on its own, the same way urls.mjs documents it, so the test also proves that recipe is right.
const secretPath = (label, key) => createHash('sha256').update(`${label}-path:${key}`).digest('hex').slice(0, 20);
const ADMIN = `/${secretPath('admin', 'dev')}`;
const KEY_PATH = `/${secretPath('display', 'devdisplay')}`;
const basic = (key) => 'Basic ' + btoa('x:' + key);
const admin = { Authorization: basic('dev'), Origin: BASE };

// The display link has two halves: one derived from DISPLAY_KEY, and a token the organizer can replace from the panel.
// The panel is where the current link is shown, so that is where the test reads it, whatever an earlier run left behind.
const panelLink = (html) => new URL(html.match(/id="dlink" readonly value="([^"]+)"/)[1]).pathname;
const DISPLAY_LINK = panelLink(await (await fetch(BASE + ADMIN, { headers: admin })).text());
assert.ok(DISPLAY_LINK.startsWith(KEY_PATH), 'the first half of the display link still comes from DISPLAY_KEY');

// The display has no password. Opening the private link signs the browser in with a cookie and moves it to /screen,
// so the secret never sits in the address bar of a laptop that faces the room.
const signIn = await fetch(BASE + DISPLAY_LINK, { redirect: 'manual' });
assert.equal(signIn.status, 303);
assert.equal(signIn.headers.get('Location'), BASE + '/screen');
assert.equal(signIn.headers.get('WWW-Authenticate'), null, 'no password prompt on the display');
assert.match(signIn.headers.getSetCookie()[0], /^__Host-screen=[0-9a-f]{64}(\.[a-z2-7]{16})?; Path=\/; Max-Age=\d+; HttpOnly; Secure; SameSite=Lax$/);
let screen = { Cookie: signIn.headers.getSetCookie()[0].split(';')[0] };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const current = async () => (await fetch(BASE + '/screen/current', { headers: screen })).json();
const post = (path, body, headers = {}) => fetch(BASE + path, { method: 'POST', body, headers, redirect: 'manual' });
const claim = (token, email, cookie) => post('/' + token, new URLSearchParams({ email }), cookie ? { Cookie: cookie } : {});
const status = async (path, headers = {}) => (await fetch(BASE + path, { headers, redirect: 'manual' })).status;
const adminHtml = async (query = '') => (await fetch(BASE + ADMIN + query, { headers: admin })).text();

// Claiming starts closed. Open it for the run; the switch itself is tested further down.
assert.equal((await post(ADMIN + '/open', new URLSearchParams({ open: '1' }), admin)).status, 303);

// ===== Attack surface =====

// Nothing to find. Every guessable path is the same 404 with no login prompt, even for someone holding the real
// admin key and forging the headers the two layers use between themselves.
for (const p of ['/admin', '/admin/export.csv', '/display', '/api/current', '/login', '/.env', '/wp-admin', '/_admin', '/_admin/reset', '/_display/current', '/screen', '/screen/current', DISPLAY_LINK + '/current', ADMIN + 'x', '/' + 'a'.repeat(20)]) {
  const r = await fetch(BASE + p, { headers: { ...admin, 'X-Role': 'admin', 'X-Base': ADMIN } });
  assert.equal(r.status, 404, p);
  assert.equal(r.headers.get('WWW-Authenticate'), null, p);
}
assert.equal((await post('/_admin/reset', null, { ...admin, 'X-Role': 'admin', 'X-Base': ADMIN })).status, 404);

// The admin panel still wants its key, and a signed-in screen is not an admin.
assert.equal(await status(ADMIN), 401);
assert.equal(await status(ADMIN, { Authorization: basic('wrong') }), 401);
assert.equal(await status(ADMIN, screen), 401, 'the screen cookie must not open the admin panel');
assert.equal(await status(ADMIN + '/export.csv', screen), 401);
// /screen only exists for a browser holding the right cookie. A wrong one is one more 404.
assert.equal(await status('/screen', screen), 200);
assert.equal(await status('/screen', { Cookie: `__Host-screen=${'0'.repeat(64)}` }), 404);
assert.equal(await status('/screen/current', { Cookie: `__Host-screen=${'0'.repeat(64)}` }), 404);
assert.equal((await post(DISPLAY_LINK, null)).status, 404, 'the sign-in link is GET only');
// The desk laptop reaches the QR and nothing else.
assert.equal(await status('/screen/export.csv', screen), 404);
assert.equal((await post('/screen/reset', null, { ...screen, Origin: BASE })).status, 404);
assert.deepEqual(Object.keys(await current()).sort(), ['approved', 'claimed', 'img', 'open', 'remaining', 'token', 'v'], 'the display feed carries no emails or links');

// A cross-site POST is refused even with the right key, with or without a body.
assert.equal((await post(ADMIN + '/reset', null, { ...admin, Origin: 'https://evil.example' })).status, 403);
assert.equal((await post(ADMIN + '/emails', new URLSearchParams({ emails: 'evil@example.com' }), { ...admin, Origin: 'https://evil.example' })).status, 403);

// Only GET and POST exist, and bodies are capped by what actually arrives.
for (const method of ['PUT', 'DELETE', 'PATCH', 'OPTIONS', 'HEAD']) assert.equal((await fetch(BASE + '/', { method })).status, 405, method);
assert.equal((await post('/aaaaaaaa', 'email=' + 'a'.repeat(20_000))).status, 413);
assert.equal((await post(ADMIN, 'links=' + 'a'.repeat(2_100_000), admin)).status, 413);

// Browser-side backstops on every page: a fresh nonce per response, no framing, no sniffing.
const home = await fetch(BASE + '/');
const csp = home.headers.get('Content-Security-Policy');
assert.match(csp, /default-src 'none'; script-src 'nonce-[0-9a-f]{32}'; style-src 'nonce-[0-9a-f]{32}'; img-src data:;/);
assert.match(csp, /frame-ancestors 'none'/);
assert.notEqual(csp, (await fetch(BASE + '/')).headers.get('Content-Security-Policy'), 'nonce must change on every response');
assert.equal(home.headers.get('X-Frame-Options'), 'DENY');
assert.equal(home.headers.get('X-Content-Type-Options'), 'nosniff');
assert.equal(home.headers.get('Cache-Control'), 'no-store');
assert.equal(home.headers.get('Cross-Origin-Opener-Policy'), 'same-origin');
assert.equal(home.headers.get('Cross-Origin-Resource-Policy'), 'same-origin');
assert.match(home.headers.get('Permissions-Policy'), /camera=\(\)/);

// ===== The claim flow =====

// Setup must succeed too: a silently failed reset leaves old data behind and every later number is wrong.
const setup = async (path, body) => assert.equal((await post(ADMIN + path, body, admin)).status, 303, `${path} failed`);
await setup('/reset', null);
await setup('', new URLSearchParams({ links: 'https://example.com/credit-1\nCODE-2\nhttp://', uses: '1' }));
// A messy paste: display names, CSV quotes, mixed case, junk. Only the three addresses should survive.
await setup('/emails', new URLSearchParams({ emails: 'Asha <Asha@Example.com>, ravi@example.com;\n"Zoya","zoya@example.com"\nnot-an-email' }));

const { token: t1, img, remaining, approved } = await current();
assert.match(t1, /^[a-z2-7]{8}$/);
assert.match(img, /^data:image\/gif;base64,/, 'the QR travels as an image, which dark-mode tools leave alone');
assert.equal(remaining, 2, 'the junk "http://" line must be skipped');
assert.equal(approved, 3);

// Opening a code shows the email form and doesn't burn it, but the screen moves on so the next person gets their own.
const get = await fetch(`${BASE}/${t1}`);
assert.equal(get.status, 200);
assert.match(await get.text(), /name="email"/);
assert.notEqual((await current()).token, t1);

// Not on the list: refused, and the code survives for a typo retry.
const stranger = await claim(t1, 'stranger@example.com');
assert.equal(stranger.status, 403);
assert.equal((await claim(t1, '')).status, 403);

// An approved email (any case, stray spaces) wins link 1. After that the code is dead, even for another approved person.
const won = await claim(t1, ' ASHA@example.com ');
assert.equal(won.status, 303);
assert.equal(won.headers.get('Location'), 'https://example.com/credit-1');
assert.match(won.headers.getSetCookie()[0], /^__Host-cid=[0-9a-f-]{36}; Path=\/; Max-Age=\d+; HttpOnly; Secure; SameSite=Lax$/);
const cookie = won.headers.getSetCookie()[0].split(';')[0];
assert.equal((await claim(t1, 'ravi@example.com')).status, 410);
assert.equal((await claim('aaaaaaaa', 'ravi@example.com')).status, 410);

// Same email from a different phone: refused. Same phone again: its own link back, never a second one.
const { token: t2 } = await current();
const taken = await claim(t2, 'asha@example.com');
assert.equal(taken.status, 403);
assert.equal((await claim(t2, '', cookie)).headers.get('Location'), 'https://example.com/credit-1');
assert.equal((await current()).remaining, 1);

// "Not approved" and "already claimed" read exactly the same, so the form can't be used to map out the list.
const alertText = async (res) => (await res.text()).match(/role="alert">([^<]+)</)[1];
assert.equal(await alertText(stranger), await alertText(taken));

// Hostile input comes back inert: escaped on the page, and just a wrong email to the database.
const xss = '"><script>alert(1)</script>@x.co';
const reflected = await (await claim(t2, xss)).text();
assert.ok(!reflected.includes('<script>alert'), 'a typed email must never come back as markup');
assert.ok(reflected.includes('&#60;script&#62;alert(1)'), 'it comes back escaped');
const { token: t2b } = await current();
assert.equal((await claim(t2b, "' OR '1'='1")).status, 403);
assert.equal((await claim(t2b, 'x@y.zz\r\nSet-Cookie: pwned=1')).status, 403);
assert.equal((await current()).claimed, 1, 'none of that claimed anything');

// Five wrong emails kill a code, so nobody can run a list of guesses against one scan.
const { token: t3 } = await current();
for (let i = 0; i < 4; i++) assert.equal((await claim(t3, `guess${i}@example.com`)).status, 403);
assert.equal((await claim(t3, 'guess4@example.com')).status, 410);
assert.equal((await claim(t3, 'ravi@example.com')).status, 410);

// Second person gets the next credit, this one a code shown on a page.
const { token: t4 } = await current();
const second = await claim(t4, 'ravi@example.com');
assert.equal(second.status, 200);
assert.match(await second.text(), /CODE-2/);

// Sold out: Zoya is approved but nothing is left.
const { token: t5, remaining: none } = await current();
assert.equal(none, 0);
assert.equal((await claim(t5, 'zoya@example.com')).status, 409);

// An untouched code dies on its own after TTL_SECONDS.
const { token: t6 } = await current();
await sleep(6500);
assert.equal((await claim(t6, 'zoya@example.com')).status, 410);

// "Clear claims only" (after a dry run) keeps links and emails.
await setup('/clear-claims', null);
const after = await current();
assert.deepEqual([after.claimed, after.approved, after.remaining], [0, 3, 2]);

// ===== Admin panel: editing links =====
const linkIds = async () => [...(await adminHtml()).matchAll(/\?edit=(\d+)#/g)].map((m) => m[1]);
const [id1] = await linkIds();
const editLink = async (fields) => (await post(ADMIN + '/link', new URLSearchParams({ id: id1, uses: '1', ...fields }), admin)).headers.get('Location');
const asha = await claim((await current()).token, 'asha@example.com');
assert.equal(asha.headers.get('Location'), 'https://example.com/credit-1');
const ashaCookie = asha.headers.getSetCookie()[0].split(';')[0];

// Fixing a link moves the person who already holds it.
assert.match(await editLink({ do: 'save', val: 'https://example.com/credit-1b' }), /note=saved/);
assert.equal((await claim((await current()).token, '', ashaCookie)).headers.get('Location'), 'https://example.com/credit-1b');
// Junk and duplicates are refused and change nothing.
assert.match(await editLink({ do: 'save', val: 'http://' }), /note=badlink/);
assert.match(await editLink({ do: 'save', val: 'CODE-2' }), /note=duplicate/);
assert.match(await adminHtml(), /credit-1b/);
assert.equal((await post(ADMIN + '/link', new URLSearchParams({ id: id1, do: 'delete' }), { ...admin, Origin: 'https://evil.example' })).status, 403);

// A stored value full of markup shows up escaped in the panel, and the panel itself carries no inline handlers
// (the Content-Security-Policy would refuse to run them anyway). ?note= can't be talked into printing object internals.
await setup('', new URLSearchParams({ links: '<img src=x onerror=alert(1)>', uses: '1' }));
const panel = await adminHtml('?note=constructor');
assert.ok(!panel.includes('<img src=x'), 'a stored link must never come back as markup');
assert.ok(panel.includes('&#60;img src=x onerror=alert(1)&#62;'));
assert.ok(!/<[^>]+\son[a-z]+\s*=/i.test(panel), 'no inline event handlers');
assert.ok(!panel.includes('native code'));
const imgId = (await linkIds()).at(-1);
await setup('/link', new URLSearchParams({ id: imgId, do: 'delete' }));

// ===== Admin panel: the approved list =====
// Removing works for someone who hasn't claimed, and is refused for someone who has.
await setup('/email-remove', new URLSearchParams({ email: 'zoya@example.com' }));
await setup('/email-remove', new URLSearchParams({ email: 'asha@example.com' }));
assert.equal((await current()).approved, 2);

// Export opens in Excel, so an address shaped like a formula must come out defused.
await setup('/emails', new URLSearchParams({ emails: '=cmd@example.com' }));
const csv = await (await fetch(BASE + ADMIN + '/export.csv', { headers: admin })).text();
assert.match(csv, /^"email","status","credit","claimed at \(IST\)"\r\n/);
assert.match(csv, /"asha@example\.com","claimed","https:\/\/example\.com\/credit-1b","[^"]+"/);
assert.match(csv, /"ravi@example\.com","not yet","",""/);
assert.match(csv, /"'=cmd@example\.com"/);

// Deleting a link releases whoever held it, so they can claim again.
assert.match(await editLink({ do: 'delete' }), /note=deleted/);
assert.equal((await current()).claimed, 0);
const reclaimed = await claim((await current()).token, 'asha@example.com');
assert.match(await reclaimed.text(), /CODE-2/);

// ===== Excel import: run the exact script the admin page ships, against files written by real Excel and by openpyxl =====
const shared = (await adminHtml()).match(/\/\*shared\*\/([\s\S]*?)\/\*end\*\//)[1];
const { findEmails, xlsxText } = new Function(shared + '; return { findEmails, xlsxText };')();
for (const name of ['approved-excel.xlsx', 'approved-openpyxl.xlsx']) {
  const file = readFileSync(new URL('./fixtures/' + name, import.meta.url));
  const text = await xlsxText(file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength));
  const found = [...new Set(findEmails(text))].sort();
  assert.deepEqual(found, ['asha@example.com', 'ravi@example.com', 'walkin@example.org', 'zoya.khan+build@example.co.in'], name);
}
await assert.rejects(xlsxText(new TextEncoder().encode('just,a,csv@example.com').buffer), /not a zip/);
assert.deepEqual(findEmails('Asha <Asha@Example.com>. mailto:zoya@example.co.in; a@b@c.com, not-an-email, tail@example.com.'),
  ['asha@example.com', 'zoya@example.co.in', 'tail@example.com']);

// ===== One hostile cell must not freeze anything =====
// A long run without spaces, planted in a public sign-up sheet, used to make the email search do quadratic work:
// 150 KB froze every scan and claim for 21 seconds. Both copies of the search, server and admin page, must stay fast.
const hostile = 'a'.repeat(150_000) + ' real@example.com ' + 'b@'.repeat(50_000);
let started = performance.now();
assert.deepEqual(findEmails(hostile), ['real@example.com']);
assert.ok(performance.now() - started < 1000, `admin page copy took ${Math.round(performance.now() - started)} ms`);
await setup('/reset', null);
started = performance.now();
await setup('/emails', new URLSearchParams({ emails: hostile }));
assert.ok(performance.now() - started < 2000, `server import took ${Math.round(performance.now() - started)} ms`);
assert.equal((await current()).approved, 1);

// ===== The Start / Stop switch =====
// Closed means closed for everyone: no code is made, a code from before dies, and an approved email can't claim.
// Someone who already claimed still gets their own credit back.
await setup('/reset', null);
await setup('', new URLSearchParams({ links: 'SWITCH-CODE', uses: '5' }));
await setup('/emails', new URLSearchParams({ emails: 'early@example.com\nlate@example.com' }));
const early = await claim((await current()).token, 'early@example.com');
assert.equal(early.status, 200);
const earlyCookie = early.headers.getSetCookie()[0].split(';')[0];
const beforeStop = (await current()).token;
await setup('/open', new URLSearchParams({ open: '0' }));
const closed = await current();
assert.equal(closed.open, false);
assert.equal(closed.token, undefined, 'no code while closed');
assert.equal(closed.img, undefined, 'no QR while closed');
assert.equal((await claim(beforeStop, 'late@example.com')).status, 403, 'a code from before the stop must be dead');
assert.equal(await status('/' + beforeStop), 403);
assert.match(await (await claim(beforeStop, '', earlyCookie)).text(), /SWITCH-CODE/, 'an earlier claimant keeps their credit');
assert.match(await adminHtml(), /Claiming is CLOSED/);
assert.equal((await post(ADMIN + '/open', new URLSearchParams({ open: '1' }), { ...admin, Origin: 'https://evil.example' })).status, 403, 'a hostile site cannot open claiming');
await setup('/open', new URLSearchParams({ open: '1' }));
assert.match(await adminHtml(), /Claiming is OPEN/);
assert.equal((await claim((await current()).token, 'late@example.com')).status, 200, 'and it works again once reopened');

// ===== Nothing needs a laptop: settings and a new display link, both from the panel =====
await setup('/settings', new URLSearchParams({ rotate_seconds: '30', ttl_seconds: '200', max_claims_per_minute: '50' }));
assert.match(await adminHtml(), /name="ttl_seconds"[^>]*value="200"/);
// Refused as a whole: a code that would die before the screen moves on, and a number out of range.
const settingsNote = async (fields) => (await post(ADMIN + '/settings', new URLSearchParams(fields), admin)).headers.get('Location');
assert.match(await settingsNote({ rotate_seconds: '100', ttl_seconds: '50', max_claims_per_minute: '50' }), /badsettings/);
assert.match(await settingsNote({ rotate_seconds: '1', ttl_seconds: '200', max_claims_per_minute: '50' }), /badsettings/);
assert.match(await adminHtml(), /name="ttl_seconds"[^>]*value="200"/, 'a refused save changes nothing');
// Empty boxes go back to the starting values, here the ones in .dev.vars, which the rest of this file relies on.
await setup('/settings', new URLSearchParams({ rotate_seconds: '', ttl_seconds: '', max_claims_per_minute: '' }));
assert.match(await adminHtml(), /name="ttl_seconds"[^>]*value="6"/);

// A new display link kills the old link and signs every screen out, without touching DISPLAY_KEY.
const oldScreen = screen;
await setup('/display-link', null);
const newLink = panelLink(await adminHtml());
assert.notEqual(newLink, DISPLAY_LINK);
assert.match(newLink, new RegExp(`^${KEY_PATH}/[a-z2-7]{16}$`));
assert.equal(await status(DISPLAY_LINK), 404, 'the old link is dead');
assert.equal(await status('/screen', oldScreen), 404, 'every signed-in screen is signed out');
assert.equal(await status('/screen/current', oldScreen), 404);
assert.equal(await status(newLink.slice(0, -1) + (newLink.endsWith('a') ? 'b' : 'a')), 404, 'a near miss on the token is a 404');
const resigned = await fetch(BASE + newLink, { redirect: 'manual' });
assert.equal(resigned.status, 303);
screen = { Cookie: resigned.headers.getSetCookie()[0].split(';')[0] };
assert.match(screen.Cookie, /^__Host-screen=[0-9a-f]{64}\.[a-z2-7]{16}$/);
assert.equal(await status('/screen', screen), 200);
assert.equal((await post(ADMIN + '/display-link', null, { ...admin, Origin: 'https://evil.example' })).status, 403);

// ===== Bulk-claim brake =====
// A script with a list of other people's emails and a supply of fresh codes is held to desk speed.
// .dev.vars sets MAX_CLAIMS_PER_MINUTE=6. A refused claim must not go through or use anything up.
await setup('/reset', null);
await setup('', new URLSearchParams({ links: 'SHARED-CODE', uses: '20' }));
await setup('/emails', new URLSearchParams({ emails: Array.from({ length: 8 }, (_, i) => `p${i}@example.com`).join('\n') }));
for (let i = 0; i < 6; i++) assert.equal((await claim((await current()).token, `p${i}@example.com`)).status, 200, `claim ${i}`);
assert.equal((await claim((await current()).token, 'p6@example.com')).status, 429);
assert.equal((await current()).claimed, 6, 'the refused claim must not have gone through');

await setup('/reset', null);
assert.equal((await current()).approved, 0);
console.log('ok: all checks passed');
