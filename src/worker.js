import { DurableObject } from 'cloudflare:workers';
import qrcode from 'qrcode-generator';

const EVENT = 'Fable 5.1 Build Day · Bhopal';
const MAX_TRIES = 5; // wrong emails one scanned code will take before it dies. A brake per code, not a rate limit: scan() has that
const PATH_LEN = 20; // hex characters in the secret admin and display paths, 80 bits
// One answer for "not approved" and "already claimed", so a refusal tells a guesser nothing about who is on the list.
const REFUSED = 'That email can\'t be used to claim. Check the spelling and use the one you registered with, or talk to an organizer.';

// Two layers. This stateless Worker is the only thing the internet can reach. Whatever needs no data (wrong paths,
// wrong methods, oversized bodies, cross-site posts) it answers by itself, so junk never reaches the Durable Object
// behind it, which is single-threaded and holds all the state. Every decision about a claim is made back there.
// ponytail: one object for the whole event, fine for hundreds of scans a minute. Shard per desk if that ever isn't enough.
// ponytail: no per-IP rate limit on purpose. At a venue everyone shares one Wi-Fi address, so a limit would let one
// flooder lock out the whole room. What a flood really threatens is the free plan's 100k requests a day: go Paid for the event.
export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.protocol === 'http:' && !['localhost', '127.0.0.1'].includes(url.hostname)) {
      return Response.redirect(`https://${url.host}${url.pathname}${url.search}`, 301);
    }
    if (req.method !== 'GET' && req.method !== 'POST') return plain('Method not allowed', 405, { Allow: 'GET, POST' });
    const post = req.method === 'POST';
    if (url.pathname === '/' && !post) return page('Welcome', '<p>Scan the QR code at the check-in desk to claim your credits.</p>');

    // The admin panel and the display link live under unguessable paths derived from their keys. Every other path,
    // /admin and /login included, gets the same 404, so there is no login page to find, let alone attack.
    const [, seg, ...rest] = url.pathname.split('/');
    const sub = rest.length ? `/${rest.join('/')}` : '';
    let role = '';
    // ADMIN_PATH is an optional, memorable second address for the admin panel, kept as a secret so it never lands in a
    // public repo. It is checked before the claim-code pattern, because an eight-letter word looks exactly like a code.
    // It is only as private as it is hard to guess, so with one set, the login and its lockout carry the weight.
    const custom = /^[\w-]{4,64}$/.test(env.ADMIN_PATH ?? '') && env.ADMIN_PATH !== 'screen' ? env.ADMIN_PATH : '';
    if (custom && env.ADMIN_KEY && seg.length === custom.length && (await same(seg, custom))) role = 'admin';
    else if (/^[a-z2-7]{8}$/.test(seg) && !sub) role = 'public';
    else if (seg === 'screen') {
      // The QR display has no password. The desk laptop proves itself with a cookie it got from the private display
      // link, so a volunteer types nothing and the address bar, which attendees will photograph along with the QR,
      // only ever says /screen. Without the cookie this is one more 404.
      const cookie = req.headers.get('Cookie')?.match(/(?:^|;\s*)__Host-screen=([0-9a-f]{64})(?:;|$)/)?.[1];
      if (cookie && env.DISPLAY_KEY && (await same(cookie, await screenCookie(env.DISPLAY_KEY)))) role = 'display';
    } else if (seg.length === PATH_LEN) {
      if (env.ADMIN_KEY && (await same(seg, await secretPath('admin', env.ADMIN_KEY)))) role = 'admin';
      else if (!sub && !post && env.DISPLAY_KEY && (await same(seg, await secretPath('display', env.DISPLAY_KEY)))) {
        // The private display link: signs this browser in and moves on, so the secret never sits on screen.
        // Lax, not Strict, or a link tapped from chat or mail would arrive at /screen without its new cookie.
        return new Response(null, { status: 303, headers: { ...NO_STORE, Location: `${url.origin}/screen`,
          'Set-Cookie': `__Host-screen=${await screenCookie(env.DISPLAY_KEY)}; Path=/; Max-Age=1209600; HttpOnly; Secure; SameSite=Lax` } });
      }
    }
    if (!role) return notFound();

    // Reaching the admin area is not being logged in. The object checks the ID and password on every admin request,
    // because the organizer's own login is stored there. What the gate still owns is the cross-site check: the browser
    // attaches Basic auth to cross-site form posts too, so a hostile page could otherwise reset the pool.
    if (role === 'admin' && post && req.headers.get('Origin') !== url.origin) return plain('Bad origin', 403);

    // A claim posts one email address. Only the admin ever sends anything long.
    const body = post ? await readCapped(req.body, role === 'admin' ? 2_000_000 : 10_000) : undefined;
    if (body === null) return plain('Too large', 413);

    // A fresh request with a fresh header set: nothing the client sent can pose as X-Role.
    const inner = new URL(url);
    if (role !== 'public') inner.pathname = `/_${role}${sub}`;
    return env.GATE.get(env.GATE.idFromName('main')).fetch(new Request(inner, {
      method: req.method,
      body,
      redirect: 'manual', // hand the object's 303s back to the browser instead of chasing them in here
      headers: {
        'X-Role': role,
        'X-Base': `/${seg}`,
        'X-Ip': req.headers.get('CF-Connecting-IP') ?? '',
        Cookie: req.headers.get('Cookie') ?? '',
        Authorization: role === 'admin' ? req.headers.get('Authorization') ?? '' : '', // the login only ever travels to the admin area
      },
    }));
  },
};

export class Gate extends DurableObject {
  tokens = new Map(); // token -> { at, seen, tries }. Memory only: if the object restarts, people just scan again.
  recent = []; // when the last minute's successful claims happened
  okLogin = ''; // the last Authorization header that checked out, so the slow password hash runs once and not per click
  cur = '';
  svg = '';

  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.rotateMs = (Number(env.ROTATE_SECONDS) || 20) * 1000;
    this.ttlMs = (Number(env.TTL_SECONDS) || 120) * 1000;
    this.maxPerMinute = Number(env.MAX_CLAIMS_PER_MINUTE) || 30;
    this.sql.exec('CREATE TABLE IF NOT EXISTS links (id INTEGER PRIMARY KEY, val TEXT UNIQUE NOT NULL, uses INTEGER NOT NULL DEFAULT 1)');
    this.sql.exec('CREATE TABLE IF NOT EXISTS emails (email TEXT PRIMARY KEY)');
    this.sql.exec('CREATE TABLE IF NOT EXISTS claims (cid TEXT PRIMARY KEY, link_id INTEGER NOT NULL, at INTEGER NOT NULL, email TEXT)');
    this.sql.exec('CREATE UNIQUE INDEX IF NOT EXISTS claims_email ON claims (email)');
    this.sql.exec('CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)'); // the organizer's own login and its lockout
  }

  kv(key) {
    return this.sql.exec('SELECT value FROM kv WHERE key = ?', key).toArray()[0]?.value ?? '';
  }

  kvSet(key, value) {
    this.sql.exec('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, String(value));
  }

  // Returns true, or the response to send instead. Two ways in. The ADMIN_KEY always works as the password, with any
  // ID: it is how the first login happens and how a forgotten password is recovered, and because it is checked first
  // and needs nothing from storage, nothing that goes wrong further down can lock the organizer out. The second way is
  // the ID and password the organizer set in the panel. That one is a human's password, so five wrong tries lock it
  // for five minutes. The key is 100 random bits and needs no such brake.
  async login(req) {
    const header = req.headers.get('Authorization') ?? '';
    const ask = (status, text) => plain(text, status, { 'WWW-Authenticate': 'Basic realm="admin", charset="UTF-8"' });
    const encoded = header.match(/^Basic (.+)$/)?.[1];
    if (!encoded) return ask(401, 'Login required');
    if (this.okLogin && (await same(header, this.okLogin))) return true;

    let id = '', password = '';
    try {
      const text = atob(encoded);
      const colon = text.indexOf(':');
      id = colon < 0 ? '' : text.slice(0, colon);
      password = text.slice(colon + 1);
    } catch {
      return ask(401, 'Login required');
    }
    if (this.env.ADMIN_KEY && (await same(password, this.env.ADMIN_KEY))) {
      this.okLogin = header; // and deliberately nothing else: this branch must not depend on storage
      return true;
    }

    const hash = this.kv('admin_hash');
    if (hash && Date.now() < Number(this.kv('login_locked_until'))) {
      return ask(429, 'Too many wrong passwords. Wait five minutes, or log in with the admin key as the password.');
    }
    // Both comparisons always run, so a wrong ID and a wrong password take the same time.
    const idOk = hash ? await same(id, this.kv('admin_id')) : false;
    const passwordOk = hash ? await same(await slowHash(password, this.kv('admin_salt')), hash) : false;
    if (idOk && passwordOk) {
      this.okLogin = header;
      this.kvSet('login_failures', 0);
      return true;
    }
    // Someone who knows the secret path but not the login is worth noticing. Shows up in `npx wrangler tail`.
    console.warn(`wrong admin login from ${req.headers.get('X-Ip')}`);
    const failures = Number(this.kv('login_failures')) + 1;
    this.kvSet('login_failures', failures >= 5 ? 0 : failures);
    if (failures >= 5) this.kvSet('login_locked_until', Date.now() + 5 * 60_000);
    return ask(401, 'Login required');
  }

  async setLogin(form) {
    const id = String(form.get('id') ?? '').trim();
    const password = String(form.get('password') ?? '');
    // Plain ASCII only: the browser's login box and atob() disagree about anything else. No colon in the ID,
    // because "id:password" is how the browser sends the pair.
    if (!/^[\x21-\x39\x3b-\x7e]{3,40}$/.test(id)) return '?note=badid#account';
    if (!/^[\x20-\x7e]{10,200}$/.test(password) || password === id) return '?note=badpw#account';
    if (password !== String(form.get('again') ?? '')) return '?note=mismatch#account';
    const salt = hex(crypto.getRandomValues(new Uint8Array(16)));
    const hash = await slowHash(password, salt);
    this.kvSet('admin_id', id);
    this.kvSet('admin_salt', salt);
    this.kvSet('admin_hash', hash);
    this.kvSet('login_failures', 0);
    this.kvSet('login_locked_until', 0);
    this.okLogin = '';
    return '?note=login#account';
  }

  async fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname;
    const post = req.method === 'POST';
    // A Durable Object has no public address. Only the Worker above can call this, and it builds these headers
    // itself, so X-Role can be trusted to say which area was reached. Every SQL statement below binds its values with ?.
    const role = req.headers.get('X-Role');
    const base = req.headers.get('X-Base');
    // Read the body up front so that scan() never has to await.
    const form = new URLSearchParams(post ? await req.text() : '');

    if (role === 'public') {
      const token = path.match(/^\/([a-z2-7]{8})$/)?.[1];
      if (token) return this.scan(req, token, String(form.get('email') ?? '').trim().toLowerCase().slice(0, 254));
    }

    if (role === 'display') {
      if (path === '/_display/current') return this.current(url);
      if (path === '/_display') return page('Scan to claim', (nonce) => displayPage(nonce, base), { admin: true });
    }

    if (role === 'admin') {
      // X-Role: admin only says the request reached the admin area. Being logged in is decided here, every time.
      const allowed = await this.login(req);
      if (allowed !== true) return allowed;
      const back = (query = '') => Response.redirect(`${url.origin}${base}${query}`, 303);
      if (path === '/_admin/export.csv') return this.exportCsv();
      if (post && path === '/_admin/login') return back(await this.setLogin(form));
      if (post && path === '/_admin') return back(this.addLinks(form));
      if (post && path === '/_admin/link') return back(this.editLink(form));
      if (post && path === '/_admin/emails') return back(this.addEmails(form));
      if (post && path === '/_admin/email-remove') {
        // Someone who already claimed stays on the list: their credit is out the door and the record should say so.
        this.sql.exec('DELETE FROM emails WHERE email = ? AND email NOT IN (SELECT email FROM claims WHERE email IS NOT NULL)', String(form.get('email') ?? ''));
        return back('?note=removed#people');
      }
      if (post && path === '/_admin/clear-claims') {
        this.sql.exec('DELETE FROM claims');
        this.recent = [];
        return back();
      }
      if (post && path === '/_admin/reset') {
        this.recent = [];
        this.sql.exec('DELETE FROM claims');
        this.sql.exec('DELETE FROM links');
        this.sql.exec('DELETE FROM emails');
        return back();
      }
      if (path === '/_admin') return this.adminPage(url, base);
    }
    return notFound();
  }

  // No awaits in here on purpose: that is what makes check-assign-burn atomic.
  scan(req, token, email) {
    const cid = req.headers.get('Cookie')?.match(/(?:^|;\s*)__Host-cid=([0-9a-f-]{36})(?:;|$)/)?.[1] || crypto.randomUUID();
    const mine = this.sql.exec('SELECT l.val FROM claims c JOIN links l ON l.id = c.link_id WHERE c.cid = ?', cid).toArray()[0];
    if (mine) return deliver(mine.val, cid); // this phone already claimed: same link again, never a second one

    const t = this.tokens.get(token);
    const dead = () => page('Code expired', '<h2>That code is no longer valid</h2><p>It was already used or it timed out. Scan the new one on the screen.</p>', { status: 410 });
    if (!t || Date.now() - t.at >= this.ttlMs) return dead();
    // Someone has this code open, so the screen moves on and the next person in line gets their own.
    // GET never burns the token itself: camera apps, chat link previews and URL scanners fetch links on their own.
    t.seen = true;
    if (req.method !== 'POST') return claimForm();

    // ponytail: typing an approved email is not proof of owning it. Someone at the desk could use a teammate's.
    // The victim then shows up as already claimed in the admin panel. Email a one-time code here if that ever really happens.
    const approved = this.sql.exec('SELECT 1 FROM emails WHERE email = ?', email).toArray().length;
    const used = this.sql.exec('SELECT 1 FROM claims WHERE email = ?', email).toArray().length;
    if (!approved || used) {
      if (++t.tries < MAX_TRIES) return claimForm(REFUSED, email);
      this.tokens.delete(token);
      return dead();
    }

    const link = this.sql.exec('SELECT id, val FROM links l WHERE (SELECT COUNT(*) FROM claims c WHERE c.link_id = l.id) < l.uses ORDER BY id LIMIT 1').toArray()[0];
    if (!link) return page('All claimed', '<h2>All credits have been claimed</h2><p>Please talk to an organizer.</p>', { status: 409 });

    // MAX_TRIES only brakes guessing on one code. Someone filming the screen, or holding the display link, can
    // collect fresh codes and work through a list of other people's emails, and every correct one is a stolen credit.
    // A desk hands out a credit every few seconds at best, so anything faster is a script: hold it to desk speed and
    // let the racing counter on the display give it away. Only successes count, so this can't be used to lock people out.
    const now = Date.now();
    this.recent = this.recent.filter((at) => now - at < 60_000);
    if (this.recent.length >= this.maxPerMinute) {
      console.warn('claim rate limit hit');
      return page('Busy', '<h2>Too many claims right now</h2><p>Wait a minute, then scan the code on the screen again.</p>', { status: 429 });
    }
    this.recent.push(now);
    this.tokens.delete(token); // one claim per code
    this.sql.exec('INSERT INTO claims (cid, link_id, at, email) VALUES (?, ?, ?, ?)', cid, link.id, Date.now(), email);
    console.log('claim', link.id);
    return deliver(link.val, cid);
  }

  current(url) {
    const now = Date.now();
    const t = this.tokens.get(this.cur);
    // New code when the last one was claimed, opened by someone, or on screen long enough for a photo of it to travel.
    if (!t || t.seen || now - t.at >= this.rotateMs) {
      for (const [k, v] of this.tokens) if (now - v.at >= this.ttlMs) this.tokens.delete(k);
      this.cur = newToken();
      this.tokens.set(this.cur, { at: now, seen: false, tries: 0 });
      const qr = qrcode(0, 'M');
      qr.addData(`${url.origin}/${this.cur}`);
      qr.make();
      this.svg = qr.createSvgTag({ cellSize: 1, margin: 4, scalable: true, title: 'QR code to claim credits' });
    }
    const svg = url.searchParams.get('have') === this.cur ? undefined : this.svg;
    return Response.json({ token: this.cur, svg, ...this.stats() }, { headers: NO_STORE });
  }

  stats() {
    return this.sql.exec(`SELECT (SELECT COUNT(*) FROM claims) AS claimed, (SELECT COUNT(*) FROM emails) AS approved,
      (SELECT COALESCE(SUM(MAX(uses - (SELECT COUNT(*) FROM claims c WHERE c.link_id = l.id), 0)), 0) FROM links l) AS remaining`).one();
  }

  addLinks(form) {
    const uses = clampUses(form.get('uses'));
    const lines = String(form.get('links') || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean).slice(0, 5000);
    let added = 0;
    for (const line of lines) {
      const val = cleanLink(line);
      if (!val) continue;
      this.sql.exec('INSERT INTO links (val, uses) VALUES (?, ?) ON CONFLICT(val) DO UPDATE SET uses = excluded.uses', val, uses);
      added++;
    }
    return `?added=${added}&skipped=${lines.length - added}`;
  }

  // Saving a new value also moves everyone who already got this link: their short link redirects to the new one.
  // Deleting a link releases its claims, so the people who held it can scan and claim again.
  editLink(form) {
    const id = parseInt(form.get('id'));
    if (!(id > 0)) return '';
    if (form.get('do') === 'delete') {
      this.sql.exec('DELETE FROM claims WHERE link_id = ?', id);
      this.sql.exec('DELETE FROM links WHERE id = ?', id);
      return '?note=deleted#links';
    }
    const val = cleanLink(String(form.get('val') ?? '').trim());
    if (!val) return `?edit=${id}&note=badlink#l${id}`;
    try {
      this.sql.exec('UPDATE links SET val = ?, uses = ? WHERE id = ?', val, clampUses(form.get('uses')), id);
    } catch {
      return `?edit=${id}&note=duplicate#l${id}`; // val is UNIQUE
    }
    return `?note=saved#l${id}`;
  }

  // Pulls addresses out of whatever gets pasted: one per line, a CSV export, "Name <email>", anything.
  addEmails(form) {
    const found = findEmails(String(form.get('emails') || ''));
    const count = () => this.sql.exec('SELECT COUNT(*) AS n FROM emails').one().n;
    const before = count();
    for (const email of found) this.sql.exec('INSERT OR IGNORE INTO emails (email) VALUES (?)', email);
    return `?emails=${found.length}&fresh=${count() - before}#people`;
  }

  people() {
    return this.sql.exec(`SELECT e.email, l.val, c.at FROM emails e LEFT JOIN claims c ON c.email = e.email
      LEFT JOIN links l ON l.id = c.link_id ORDER BY c.at IS NULL, c.at DESC, e.email`).toArray();
  }

  exportCsv() {
    // A cell that starts with = + - or @ runs as a formula when Excel opens the file, and these addresses
    // started life in a public sign-up form. A leading apostrophe makes Excel treat the cell as plain text.
    const cell = (v) => `"${String(v ?? '').replace(/^[=+\-@\t\r]/, "'$&").replace(/"/g, '""')}"`;
    const when = (ms) => new Date(ms).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });
    const rows = this.people().map((r) => [r.email, r.at ? 'claimed' : 'not yet', r.val, r.at ? when(r.at) : ''].map(cell).join(','));
    return new Response(['"email","status","credit","claimed at (IST)"', ...rows].join('\r\n'), {
      headers: { ...NO_STORE, 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="buildday-claims.csv"' },
    });
  }

  async adminPage(url, base) {
    const { claimed, approved, remaining } = this.stats();
    const links = this.sql.exec('SELECT l.id, l.val, l.uses, (SELECT COUNT(*) FROM claims c WHERE c.link_id = l.id) AS used FROM links l ORDER BY l.id').toArray();
    const display = this.env.DISPLAY_KEY ? `/${await secretPath('display', this.env.DISPLAY_KEY)}` : '';
    const n = (k) => parseInt(url.searchParams.get(k));
    // Only fixed strings and parsed numbers reach the page, never text from the query string. hasOwn, because a
    // plain lookup would happily return Object.prototype members for ?note=constructor.
    const notes = { saved: 'Link saved.', deleted: 'Link deleted.', removed: 'Email removed from the approved list.',
      login: 'New login saved. If the browser asks you to log in again, use the new ID and password.',
      badid: 'Not saved: the ID needs 3 to 40 letters, digits or symbols, with no spaces and no colon.',
      badpw: 'Not saved: the password needs at least 10 characters, plain letters, digits and symbols, and must differ from the ID.',
      mismatch: 'Not saved: the two passwords were not the same.',
      badlink: 'Not saved: that isn\'t a valid URL, or it is too long.',
      duplicate: 'Not saved: another line already has that exact link or code.' };
    const key = url.searchParams.get('note');
    const note = n('added') >= 0 ? `Saved ${n('added')} line(s)${n('skipped') > 0 ? `, skipped ${n('skipped')} that were too long or not valid URLs` : ''}.`
      : n('emails') === 0 ? 'Nothing added: no email address was found in what you sent.'
      : n('emails') > 0 ? `Added ${n('fresh') || 0} new attendee(s). ${n('emails') - (n('fresh') || 0)} were already on the list.`
      : Object.hasOwn(notes, key) ? notes[key] : '';
    const ist = (ms) => new Date(ms).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit' });
    const linkRow = (r) => r.id !== n('edit')
      ? `<tr id="l${r.id}"><td>${esc(r.val)}</td><td>${r.used} / ${r.uses}</td><td><a href="${base}?edit=${r.id}#l${r.id}">edit</a></td></tr>`
      : `<tr id="l${r.id}"><td colspan="3"><form method="post" action="${base}/link" class="rowform">
          <input type="hidden" name="id" value="${r.id}">
          <input name="val" value="${esc(r.val)}" required maxlength="2000" aria-label="Link or code">
          <input name="uses" type="number" min="1" max="100000" value="${r.uses}" aria-label="How many people can claim it">
          <button name="do" value="save">Save</button>
          <button name="do" value="delete" class="danger" formnovalidate data-confirm="${r.used
    ? `Delete this link? ${r.used} people already claimed it, and every one of them would have to come back to the desk and scan again. If the link is only wrong, press Cancel and fix it with Save instead: they then get the fixed link by themselves.`
    : 'Delete this link? Nobody has claimed it yet.'}">Delete</button>
          <a href="${base}#links">cancel</a>
        </form></td></tr>`;
    return page('Admin', (nonce) => `<div class="admin">
      <p><b>${claimed}</b> of <b>${approved}</b> approved attendees claimed. Credits left: <b>${remaining}</b>.
      ${display ? `<a href="${display}">Open the QR display</a> <span class="dim">(no password: that private link signs a browser in, so only give it to the desk)</span>` : '<b>Set DISPLAY_KEY to get a QR display.</b>'}</p>
      ${note && `<p class="note" role="status">${note}</p>`}

      <h2 id="links">Credit links</h2>
      <form method="post" action="${base}">
        <label for="newlinks">Add links or codes, one per line</label>
        <textarea id="newlinks" name="links" rows="5" required></textarea>
        <label for="uses">How many people can claim each line?</label>
        <input id="uses" name="uses" type="number" min="1" max="100000" value="1">
        <p class="dim">Leave it at 1 when every line is a unique link or code. If all you have is one shared link, paste it once and enter your attendee count.</p>
        <button>Add links</button>
      </form>
      <table><tr><th>Link or code</th><th>Claimed</th><th></th></tr>${links.map(linkRow).join('')}</table>
      <p class="dim">Editing a link also moves everyone who already got it: their short link sends them to the new value.</p>

      <h2 id="people">Approved attendees</h2>
      <p>Three ways to add people. Anyone you add can claim straight away.</p>

      <h3>1. Add one attendee</h3>
      <form method="post" action="${base}/emails" class="rowform">
        <input id="one" name="emails" type="email" required maxlength="254" placeholder="name@example.com" aria-label="One attendee's email" autocomplete="off" autocapitalize="none" spellcheck="false">
        <button>Add attendee</button>
      </form>

      <h3>2. Add many: paste a list</h3>
      <form method="post" action="${base}/emails">
        <label for="emails">Any shape works: one per line, a CSV export, names mixed in. Only the addresses are kept.</label>
        <textarea id="emails" name="emails" rows="6" required></textarea>
        <button>Save emails</button>
      </form>

      <h3>3. Add from an Excel or CSV file</h3>
      <label for="file">Choose a .xlsx or .csv file</label>
      <input type="file" id="file" accept=".xlsx,.csv,.txt">
      <p id="filenote" class="dim" role="status">The file is read here in your browser and never uploaded. The addresses found in it land in the box under option 2. Check them, then press "Save emails".</p>
      <p><a href="${base}/export.csv">Download the list with claim status</a> <span class="dim">(CSV, opens in Excel)</span></p>
      <label for="find">Find an attendee</label>
      <input id="find" type="search" placeholder="type any part of an email" autocomplete="off">
      <form method="post" action="${base}/email-remove">
      <table id="people-table"><tr><th>Attendee</th><th>Got</th><th>At</th><th></th></tr>
      ${this.people().map((r) => `<tr data-email="${esc(r.email)}"><td>${esc(r.email)}</td><td>${r.val ? esc(r.val) : '<span class="dim">not yet</span>'}</td><td>${r.at ? ist(r.at) : ''}</td>
        <td>${r.at ? '' : `<button class="link" name="email" value="${esc(r.email)}">remove</button>`}</td></tr>`).join('')}</table>
      </form>

      <h2 id="account">Admin login</h2>
      <p>${this.kv('admin_hash') ? `Your ID is <b>${esc(this.kv('admin_id'))}</b>.` : 'No ID and password set yet. You are in with the admin key.'}</p>
      <form method="post" action="${base}/login">
        <label for="aid">New admin ID</label>
        <input id="aid" name="id" required minlength="3" maxlength="40" autocomplete="username" autocapitalize="none" spellcheck="false">
        <label for="apw">New password, 10 characters or more</label>
        <input id="apw" name="password" type="password" required minlength="10" maxlength="200" autocomplete="new-password">
        <label for="apw2">The same password again</label>
        <input id="apw2" name="again" type="password" required minlength="10" maxlength="200" autocomplete="new-password">
        <p class="dim">The address of this page stays the same. Forgot the password one day? The long admin key always works as the password, with any ID. Five wrong passwords lock the ID and password for five minutes. The admin key is never locked.</p>
        <button>Save login</button>
      </form>

      <h2>Danger zone</h2>
      <form method="post" action="${base}/clear-claims" data-confirm="Forget who claimed what? Links and emails stay. Use this after your dry run, never mid-event.">
        <button class="danger">Clear claims only</button>
      </form>
      <form method="post" action="${base}/reset" data-confirm="Delete ALL links, ALL emails and ALL claim records?">
        <button class="danger">Delete everything</button>
      </form></div>${adminScript(nonce)}`, { admin: true });
  }
}

// The one definition of "an email address in a pile of text", used by the server and injected into the admin page
// with toString() (so, like xlsxText below, it has to stay self-contained).
// It cuts the text into pieces first and only then looks at each short piece. One greedy pattern run across a whole
// paste does quadratic work on a long run without spaces: a single 150 KB cell planted in a public sign-up sheet
// froze the object, and with it every scan and claim, for 21 seconds. This way the work is linear whatever comes in.
function findEmails(text) {
  const found = [];
  for (const [piece] of text.toLowerCase().matchAll(/[^\s,;:<>()"']+/g)) {
    const email = piece.length <= 254 && piece.match(/^[^@]+@[^@]+\.[a-z]{2,}/)?.[0];
    if (email && found.push(email) >= 20000) break;
  }
  return found;
}

// An .xlsx file is a zip of XML, and all cell text sits in xl/sharedStrings.xml or inline in the sheets. Finding
// email addresses doesn't take a spreadsheet library: unzip those entries and drop the tags.
// It runs in the admin's browser, injected into the page with toString(), so the file itself never leaves their
// machine. That means it must stay self-contained: no helpers from this module, and no named inner functions
// (the bundler wraps those in a __name() call that doesn't exist in the page). test.mjs runs the injected copy.
// Sizes come from the zip's central directory because local headers are allowed to carry zeros.
async function xlsxText(buf) {
  const view = new DataView(buf);
  const bytes = new Uint8Array(buf);
  let end = buf.byteLength - 22;
  while (end >= 0 && view.getUint32(end, true) !== 0x06054b50) end--;
  if (end < 0) throw new Error('not a zip file');
  let at = view.getUint32(end + 16, true);
  let xml = '';
  for (let left = view.getUint16(end + 10, true); left > 0; left--) {
    const method = view.getUint16(at + 10, true);
    const size = view.getUint32(at + 20, true);
    const nameLen = view.getUint16(at + 28, true);
    const local = view.getUint32(at + 42, true);
    const name = new TextDecoder().decode(bytes.subarray(at + 46, at + 46 + nameLen));
    at += 46 + nameLen + view.getUint16(at + 30, true) + view.getUint16(at + 32, true);
    if (!/^xl\/(sharedStrings|worksheets\/[^/]+)\.xml$/.test(name)) continue;
    const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
    let stream = new Blob([bytes.subarray(start, start + size)]).stream();
    if (method === 8) stream = stream.pipeThrough(new DecompressionStream('deflate-raw'));
    xml += await new Response(stream).text();
  }
  // Cell and row ends become line breaks so neighbours never glue into one "address". Every other tag just goes,
  // which also rejoins an address that Excel split across formatting runs.
  return xml.replace(/<\/(si|c|row)>/g, '\n').replace(/<[^>]+>/g, '');
}

// The pages carry no inline event handlers, because the Content-Security-Policy only runs scripts that hold this
// response's nonce. Confirm prompts hang off a data-confirm attribute instead.
const adminScript = (nonce) => `<script nonce="${nonce}">
/*shared*/
${findEmails}
${xlsxText}
/*end*/
for (const el of document.querySelectorAll('[data-confirm]')) {
  el.addEventListener(el.tagName === 'FORM' ? 'submit' : 'click', (e) => { if (!confirm(el.dataset.confirm)) e.preventDefault(); });
}
document.getElementById('find').addEventListener('input', (e) => {
  const wanted = e.target.value.trim().toLowerCase();
  for (const row of document.querySelectorAll('#people-table tr[data-email]')) row.hidden = !row.dataset.email.includes(wanted);
});
document.getElementById('file').addEventListener('change', async (e) => {
  const file = e.target.files[0], note = document.getElementById('filenote');
  if (!file) return;
  let found = [];
  try {
    const buf = await file.arrayBuffer();
    const magic = buf.byteLength >= 4 ? new DataView(buf).getUint32(0) : 0;
    if (magic === 0xd0cf11e0) { // the old binary .xls: reading it as text finds addresses with garbage stuck to them
      note.textContent = 'That is the old .xls format. In Excel choose Save As, pick .xlsx or .csv, and load that instead.';
      return;
    }
    const text = magic === 0x504b0304 ? await xlsxText(buf) : new TextDecoder().decode(buf);
    found = [...new Set(findEmails(text))];
  } catch {}
  document.getElementById('emails').value = found.join('\\n');
  note.textContent = found.length ? 'Found ' + found.length + ' address(es). They are in the box under option 2. Check them, then press Save emails.'
    : 'No email addresses found in that file. Save it as .xlsx or .csv and try again.';
  if (found.length) document.getElementById('emails').scrollIntoView({ block: 'center' });
});
</script>`;

const displayPage = (nonce, base) => `
<style nonce="${nonce}">
  #qr { width: min(72vmin, 600px); aspect-ratio: 1; margin: 0 auto; padding: 8px; border-radius: 16px; background: #fff; color: #111; display: grid; place-items: center; font-size: 1.3rem; transition: opacity .2s }
  #qr svg { width: 100%; height: 100%; shape-rendering: crispEdges }
</style>
<h2>Scan to claim your credits</h2>
<div id="qr">Loading…</div>
<p id="stat" aria-live="polite"></p>
<p class="dim">One claim per registered email. The code changes every time someone scans it, so photos and screenshots of it are no use to anyone.</p>
<script nonce="${nonce}">
  const qr = document.getElementById('qr'), stat = document.getElementById('stat');
  let have = '';
  const stayAwake = () => navigator.wakeLock?.request('screen').catch(() => {});
  document.addEventListener('visibilitychange', stayAwake);
  stayAwake();
  // ponytail: polls once a second, about 3,600 requests per display-hour against the 100k/day free plan.
  // Close the tab when the desk is closed; switch to a WebSocket push if you ever need many displays.
  async function tick() {
    if (!document.hidden) try {
      // location.origin, not a relative URL: fetch() refuses relative URLs on a page opened as https://user:key@host/
      const d = await (await fetch(location.origin + '${base}/current?have=' + have, { cache: 'no-store' })).json();
      const blocked = !d.approved ? 'No approved emails loaded yet. Add them in the admin panel.'
        : !d.remaining ? (d.claimed ? 'All credits claimed' : 'No links loaded yet. Add them in the admin panel.') : '';
      if (blocked) { qr.textContent = blocked; have = ''; }
      else if (d.svg) { qr.innerHTML = d.svg; have = d.token; }
      qr.style.opacity = 1;
      stat.textContent = d.claimed + ' of ' + d.approved + ' attendees claimed · ' + d.remaining + ' credits left';
    } catch { qr.style.opacity = .15; stat.textContent = 'Connection lost, retrying…'; }
    setTimeout(tick, 1000);
  }
  tick();
</script>`;

const CSS = `
  * { box-sizing: border-box }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 24px; background: #0c0c10; color: #f2f2f3; font: 18px/1.5 system-ui, sans-serif; text-align: center }
  main { width: 100%; max-width: 760px }
  h1 { font-size: 1rem; font-weight: 600; opacity: .65; margin: 0 0 20px }
  h2 { font-size: 1.7rem; margin: 0 0 20px }
  a { color: #8fb4ff }
  .dim { opacity: .65; font-size: .95rem }
  .note { background: #1d2a1f; padding: 10px 14px; border-radius: 8px }
  .err { background: #3a1c1c; padding: 10px 14px; border-radius: 8px }
  .code { font: 600 1.6rem ui-monospace, monospace; background: #fff; color: #111; padding: 16px; border-radius: 12px; word-break: break-all; user-select: all }
  button { font: inherit; font-weight: 600; padding: 16px 28px; border: 0; border-radius: 12px; background: #3d6df2; color: #fff; cursor: pointer }
  button.danger { background: #b3261e; margin-top: 32px }
  label { display: block; margin: 16px 0 6px }
  textarea, input { width: 100%; font: 15px ui-monospace, monospace; padding: 10px; border-radius: 8px; border: 1px solid #444; background: #16161c; color: inherit }
  input[type=number] { max-width: 160px }
  input[type=email] { font: inherit; text-align: center; padding: 14px; margin-bottom: 16px } /* 16px+ so iOS doesn't zoom on focus */
  .admin { text-align: left }
  .admin form { margin-bottom: 8px }
  .admin h2 { font-size: 1.25rem; margin: 48px 0 4px; padding-top: 16px; border-top: 1px solid #2a2a33 }
  .admin h3 { font-size: 1rem; margin: 28px 0 8px }
  .rowform { display: flex; flex-wrap: wrap; gap: 8px; align-items: center }
  .rowform input[name=val] { flex: 1 1 320px }
  .rowform input[type=email] { flex: 1 1 240px; margin: 0; padding: 10px; text-align: left }
  .rowform button { padding: 8px 16px; margin: 0 }
  button.link { background: none; color: #8fb4ff; padding: 0; font-weight: 400; font-size: inherit; text-decoration: underline }
  input[type=file] { font: inherit; border-style: dashed }
  table { width: 100%; border-collapse: collapse; margin-top: 28px; font-size: .85rem }
  td, th { text-align: left; padding: 6px 8px; border-bottom: 1px solid #2a2a33; word-break: break-all }
  td:last-child, th:last-child { white-space: nowrap }`;

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const hex = (bytes) => [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');

const NO_STORE = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'X-Robots-Tag': 'noindex, nofollow' };
const plain = (text, status, headers = {}) => new Response(text, { status, headers: { ...NO_STORE, ...headers } });
const notFound = () => page('Not found', '<p>Nothing here. Scan the QR code at the check-in desk.</p>', { status: 404 });

// `body` is a string, or a function of the nonce for pages that carry a script or an extra style block.
// The policy is the backstop for esc(): even if some value slipped through unescaped, the browser would refuse to run
// it, because only tags holding this response's random nonce execute. No inline handlers, no outside resources,
// no framing. form-action is left off the public pages because a claim ends in a redirect to the credit's own site.
function page(title, body, { status = 200, headers = {}, admin = false } = {}) {
  const nonce = hex(crypto.getRandomValues(new Uint8Array(16)));
  const csp = `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'${admin ? "; form-action 'self'" : ''}`;
  return new Response(
    `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)} · ${esc(EVENT)}</title><style nonce="${nonce}">${CSS}</style><main><h1>${esc(EVENT)}</h1>${typeof body === 'function' ? body(nonce) : body}</main>`,
    {
      status,
      headers: {
        ...NO_STORE,
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Security-Policy': csp,
        'X-Frame-Options': 'DENY',
        'Strict-Transport-Security': 'max-age=31536000',
        // No other site gets a handle on these windows or may load these pages as a resource, and the pages
        // themselves have no business with a camera, a microphone or a location.
        'Cross-Origin-Opener-Policy': 'same-origin',
        'Cross-Origin-Resource-Policy': 'same-origin',
        'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
        // same-origin, not no-referrer: no-referrer turns the admin forms' Origin header into "null".
        // It also keeps the secret admin path out of every other site's logs.
        'Referrer-Policy': 'same-origin',
        ...headers,
      },
    },
  );
}

function claimForm(err = '', email = '') {
  return page('Claim', `<h2>You're in</h2>
    ${err && `<p class="err" role="alert">${esc(err)}</p>`}
    <form method="post">
      <label for="email">The email you registered with</label>
      <input id="email" name="email" type="email" value="${esc(email)}" required autofocus autocomplete="email" maxlength="254">
      <button>Claim my credits</button>
    </form>
    <p class="dim">One claim per registered email.</p>`, { status: err ? 403 : 200 });
}

// URLs get a redirect; anything else (a promo code) is shown on a page.
// __Host- pins the cookie to this exact host over HTTPS, so no sibling site can plant or overwrite it.
function deliver(val, cid) {
  const headers = { 'Set-Cookie': `__Host-cid=${cid}; Path=/; Max-Age=1209600; HttpOnly; Secure; SameSite=Lax` };
  if (/^https?:\/\//i.test(val)) return new Response(null, { status: 303, headers: { ...NO_STORE, ...headers, Location: val } });
  return page('Your code', (nonce) => `<h2>Your credit code</h2><p class="code" id="code">${esc(val)}</p>
    <p><button id="copy" type="button">Copy</button></p>
    <p class="dim">It works once and it's yours, so keep it to yourself. Lost this page? Open the same link again on this phone.</p>
    <script nonce="${nonce}">
      // Some in-app browsers refuse clipboard access. The code is select-all on tap, so point people at that instead.
      document.getElementById('copy').addEventListener('click', (e) => navigator.clipboard.writeText(document.getElementById('code').textContent)
        .then(() => { e.target.textContent = 'Copied'; }, () => { e.target.textContent = 'Press and hold the code to copy it'; }));
    </script>`, { headers });
}

const clampUses = (v) => Math.min(Math.max(parseInt(v) || 1, 1), 100000);

// URLs are normalised so they are always safe to put in a Location header. Returns null for junk.
function cleanLink(line) {
  if (line.length > 2000) return null;
  if (!/^https?:\/\//i.test(line)) return line;
  try { return new URL(line).href; } catch { return null; }
}

// 32-letter alphabet so `byte & 31` picks evenly. 32^8 is about 10^12 guesses for a code that lives two minutes.
const newToken = () => [...crypto.getRandomValues(new Uint8Array(8))].map((b) => 'abcdefghijklmnopqrstuvwxyz234567'[b & 31]).join('');

const sha256 = async (s) => new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)));
// Hashing first makes both sides 32 bytes, which timingSafeEqual needs, and then the comparison takes the same time
// whether the guess is wrong in the first byte or the last.
const same = async (a, b) => crypto.subtle.timingSafeEqual(await sha256(a), await sha256(b));
// urls.mjs prints these for you. Change a key and its path changes with it.
const secretPath = async (label, key) => hex(await sha256(`${label}-path:${key}`)).slice(0, PATH_LEN);
// What a signed-in display browser holds. Also derived from DISPLAY_KEY, so changing that key signs every screen out.
const screenCookie = async (key) => hex(await sha256(`display-cookie:${key}`));

// For the organizer's own password. It is a human's password, quite possibly one they use elsewhere, so it is stored
// as PBKDF2 with 100,000 rounds (the most Workers allow) and a random salt, never as a fast hash.
async function slowHash(password, saltHex) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const salt = Uint8Array.from(saltHex.match(/../g) ?? [], (pair) => parseInt(pair, 16));
  return hex(new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: 100_000 }, key, 256)));
}

// Counts what actually arrives: Content-Length can be missing, and it can lie. null means over the limit.
async function readCapped(stream, max) {
  if (!stream) return new ArrayBuffer(0);
  const reader = stream.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return new Blob(chunks).arrayBuffer();
    total += value.byteLength;
    if (total > max) {
      reader.cancel();
      return null;
    }
    chunks.push(value);
  }
}
