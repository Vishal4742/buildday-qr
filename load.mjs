// Load test: a crowd of PEOPLE (200 by default) claims at one desk display. Start `npm run dev` first, or pass BASE,
// ADMIN_KEY, DISPLAY_KEY and THROWAWAY=<its host> for a throwaway deployment. It fills the target with test data and
// empties it again, so anywhere but this machine it runs only on a copy named that way, and only while it is empty.
// Empty alone is not enough: the live site is empty between two events. Never point it at the live site.
// Prints latency and status counts per kind of request, and fails if any rule broke under load.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

const BASE = process.env.BASE || 'http://localhost:8787';
const ADMIN_KEY = process.env.ADMIN_KEY || 'dev';
const DISPLAY_KEY = process.env.DISPLAY_KEY || 'devdisplay';
const PEOPLE = Number(process.env.PEOPLE) || 200;
const BRAKE = 30; // claims per minute, the value wrangler.toml ships with
const secretPath = (label, key) => createHash('sha256').update(`${label}-path:${key}`).digest('hex').slice(0, 20);
const ADMIN = `/${secretPath('admin', ADMIN_KEY)}`;
const admin = { Authorization: 'Basic ' + btoa('x:' + ADMIN_KEY), Origin: BASE };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// A well-formed code nobody was given, so it travels all the way to the object like a real one.
const madeUpCode = () => Array.from({ length: 8 }, () => 'abcdefghijklmnopqrstuvwxyz234567'[Math.floor(Math.random() * 32)]).join('');

// Every request goes through here, so the report covers all of them.
const log = [];
async function call(kind, path, init = {}) {
  const started = performance.now();
  const res = await fetch(BASE + path, { redirect: 'manual', ...init });
  const body = await res.text();
  log.push({ kind, ms: performance.now() - started, status: res.status });
  return { res, body };
}
const setup = async (path, fields = {}) => assert.equal((await call('admin', ADMIN + path, { method: 'POST', body: new URLSearchParams(fields), headers: admin })).res.status, 303, `${path} failed`);
const counts = async () => (await call('admin', ADMIN, { headers: admin })).body
  .match(/<b>(\d+)<\/b> of <b>(\d+)<\/b> approved attendees claimed\. Credits left: <b>(\d+)<\/b>/)?.slice(1).map(Number);

const local = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(BASE);
assert.ok(local || new URL(BASE).host === process.env.THROWAWAY, `${BASE} is not this machine. This test only runs on a throwaway copy you name: THROWAWAY=${new URL(BASE).host}`);
assert.deepEqual(await counts(), [0, 0, 0], `${BASE} is not empty (or the login failed). This test fills and empties the target, so it stops here.`);
const panel = (await call('admin', ADMIN, { headers: admin })).body;
const wasOpen = /Claiming is OPEN/.test(panel);
const signIn = await call('admin', new URL(panel.match(/id="dlink" readonly value="([^"]+)"/)[1]).pathname);
const screen = { Cookie: signIn.res.headers.getSetCookie()[0].split(';')[0] };

// Two links, like the real event: the first one fills up and the rest spill over to the second.
const firstCap = Math.ceil(PEOPLE * 0.75), secondCap = PEOPLE - firstCap + 10;
const emails = Array.from({ length: PEOPLE }, (_, i) => `load-${String(i + 1).padStart(3, '0')}@example.com`);
let polling = true, poller;
try {
  await setup('/reset'); // empty already; this also clears the in-memory claim brake
  await setup('', { links: 'https://example.com/load-credit-a', uses: String(firstCap) });
  await setup('', { links: 'https://example.com/load-credit-b', uses: String(secondCap) });
  await setup('/emails', { emails: emails.join('\n') });
  // Codes live ten minutes here so the first person in the queue still holds a live one when everyone claims.
  await setup('/settings', { rotate_seconds: '20', ttl_seconds: '600', max_claims_per_minute: String(BRAKE) });
  await setup('/open', { open: '1' });

  // The display keeps polling once a second the whole time, like the real one.
  poller = (async () => { while (polling) { await call('display', '/screen/current', { headers: screen }); await sleep(1000); } })();

  // The desk: people scan one after another, and every scan moves the screen on to a fresh code.
  let started = performance.now();
  const codes = [];
  for (let i = 0; i < PEOPLE; i++) {
    const { token } = JSON.parse((await call('scan', '/screen/current', { headers: screen })).body);
    assert.equal((await call('scan', '/' + token)).res.status, 200, 'a scanned code opens the email form');
    codes.push(token);
  }
  assert.equal(new Set(codes).size, PEOPLE, 'every scan got its own code');
  console.log(`${PEOPLE} scans, one after another: ${((performance.now() - started) / 1000).toFixed(1)} s`);

  // Everyone presses "Claim" at the same moment, while someone floods made-up codes with real emails. The brake lets
  // BRAKE through in a minute and refuses the rest without using up their code. Made-up codes claim nothing.
  const claim = (i) => call('claim', '/' + codes[i], { method: 'POST', body: new URLSearchParams({ email: emails[i] }) });
  const junk = (i) => call('junk', '/' + madeUpCode(), { method: 'POST', body: new URLSearchParams({ email: emails[i] }) });
  started = performance.now();
  const [first, junkAnswers] = await Promise.all([Promise.all(emails.map((_, i) => claim(i))), Promise.all(emails.map((_, i) => junk(i)))]);
  console.log(`${PEOPLE} claims and ${PEOPLE} junk posts at once: ${((performance.now() - started) / 1000).toFixed(1)} s`);
  const waiting = emails.map((_, i) => i).filter((i) => first[i].res.status === 429);
  assert.equal(first.filter(({ res }) => res.status === 303).length, Math.min(BRAKE, PEOPLE), 'the brake lets exactly its number through');
  assert.equal(waiting.length, Math.max(PEOPLE - BRAKE, 0), 'everyone else is told to wait, nothing else');
  assert.ok(junkAnswers.every(({ res }) => res.status === 410), 'a made-up code claims nothing');

  // The organizer raises the brake from the panel, and everyone who was told to wait presses again with the same code.
  await setup('/settings', { rotate_seconds: '20', ttl_seconds: '600', max_claims_per_minute: '10000' });
  started = performance.now();
  const second = await Promise.all(waiting.map((i) => claim(i)));
  console.log(`${waiting.length} second presses at once: ${((performance.now() - started) / 1000).toFixed(1)} s`);
  assert.ok(second.every(({ res }) => res.status === 303), 'with the brake raised, everyone who waited gets through');
  const links = [...first, ...second].filter(({ res }) => res.status === 303).map(({ res }) => res.headers.get('Location'));
  assert.ok(links.every((l) => /^https:\/\/example\.com\/load-credit-[ab]$/.test(l)), 'every claim lands on a credit link');

  // The record has to add up: everyone claimed exactly once, and no link went past its limit.
  const csv = (await call('admin', ADMIN + '/export.csv', { headers: admin })).body.trim().split('\r\n').slice(1).map((line) => line.split('","'));
  assert.equal(csv.length, PEOPLE);
  assert.ok(csv.every((row) => row[1] === 'claimed'), 'everyone is recorded as claimed');
  assert.equal(csv.filter((row) => row[2].endsWith('credit-a')).length, firstCap, 'the first link filled exactly');
  assert.equal(csv.filter((row) => row[2].endsWith('credit-b')).length, PEOPLE - firstCap, 'the rest went to the second');
  assert.deepEqual(await counts(), [PEOPLE, PEOPLE, secondCap - (PEOPLE - firstCap)]);
} finally {
  polling = false;
  await poller;
  // Leave the target as found: empty, settings back to their starting values, the switch where it was.
  await setup('/reset');
  await setup('/settings', { rotate_seconds: '', ttl_seconds: '', max_claims_per_minute: '' });
  await setup('/open', { open: wasOpen ? '1' : '0' });
}

const pick = (sorted, p) => Math.round(sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]);
for (const kind of ['scan', 'claim', 'junk', 'display', 'admin']) {
  const rows = log.filter((r) => r.kind === kind);
  const ms = rows.map((r) => r.ms).sort((a, b) => a - b);
  const statuses = Object.entries(Object.groupBy(rows, (r) => r.status)).map(([s, list]) => `${s}x${list.length}`).join(' ');
  console.log(`${kind.padEnd(8)}${String(rows.length).padStart(5)} requests   p50 ${pick(ms, 0.5)} ms   p95 ${pick(ms, 0.95)} ms   max ${pick(ms, 1)} ms   ${statuses}`);
}
assert.ok(!log.some((r) => r.status >= 500), 'no server errors');
assert.ok(log.filter((r) => r.kind === 'display').every((r) => r.status === 200), 'the display never failed');
assert.deepEqual(await counts(), [0, 0, 0], 'left empty');
console.log(`ok: ${PEOPLE} people claimed exactly once each, no link over its limit, no errors`);
