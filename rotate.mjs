// Changes a key everywhere it lives, in one go. `wrangler secret put` alone is not enough once the Pages front door
// exists: Pages keeps its own copy, only picks a new value up on its next deploy, and every OLD Pages deployment stays
// reachable at its own address with the OLD key still working. So: both copies, redeploy, delete the old deployments.
//
//   node rotate.mjs admin   https://claim.yourdomain.com          makes a new random key for you (recommended)
//   node rotate.mjs display https://claim.yourdomain.com
//   node rotate.mjs admin   https://claim.yourdomain.com MyOwnLongPassphrase2026
//   add --dry-run to see the plan without changing anything
//
// Run it in your own terminal from the repo folder. The new key is printed once and stored nowhere else.
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';

const PROJECT = 'buildday-qr'; // the Pages project named in pages/wrangler.toml
const dry = process.argv.includes('--dry-run');
const [which, site, own] = process.argv.slice(2).filter((a) => a !== '--dry-run');
const NAME = { admin: 'ADMIN_KEY', display: 'DISPLAY_KEY' }[which];

if (!NAME || !/^https:\/\/[^/]+\/?$/.test(site ?? '')) {
  console.error('usage: node rotate.mjs <admin|display> <https://your-site> [your-own-key] [--dry-run]');
  process.exit(1);
}
// The key is the only thing between an attendee and the panel, and the panel's address is derived from it too.
// Printable ASCII only: the browser's login box and the Worker disagree about anything else.
if (own !== undefined && !/^[\x21-\x7e]{16,}$/.test(own)) {
  console.error('Your own key needs at least 16 characters, no spaces, plain ASCII. Leave it out and a strong one is made for you.');
  process.exit(1);
}
const key = own ?? [...randomBytes(20)].map((b) => 'abcdefghijklmnopqrstuvwxyz234567'[b & 31]).join('').match(/.{5}/g).join('-');

function run(label, command, options = {}) {
  console.log(`${dry ? '[dry run] ' : ''}${label}`);
  if (dry) return '';
  const result = spawnSync(command, { shell: true, encoding: 'utf8', ...options });
  if (result.status !== 0) {
    console.error(result.stdout, result.stderr);
    console.error(`\nStopped at: ${label}\nNothing after this step ran. Fix the error above and run the same command again.`);
    process.exit(1);
  }
  return result.stdout;
}

// Printed before anything changes: from step 1 on the key is live on the Worker, so no failed step may lose it.
const address = `${site.replace(/\/$/, '')}/${createHash('sha256').update(`${which}-path:${key}`).digest('hex').slice(0, 20)}`;
if (!dry) {
  console.log('');
  if (which === 'admin') {
    console.log(`New admin password (save it now): ${key}`);
    console.log(`New admin panel address (BOOKMARK THIS ONE): ${address}`);
  } else {
    console.log(`New display link: ${address}`);
  }
  console.log('It takes effect from step 1 on. If a later step fails, fix the error and run the same command again:');
  console.log('that makes a fresh key and sets it everywhere.');
  console.log('');
}

// The key travels on stdin, never on a command line, so it stays out of the process list.
run(`1/3  set ${NAME} on the Worker (takes effect at once)`, `npx wrangler secret put ${NAME}`, { input: key });
run(`2/3  set ${NAME} on the Pages project`, `npx wrangler pages secret put ${NAME} --project-name ${PROJECT}`, { input: key });
// A new Pages build picks the key up; the older builds, which still answer to the old key, are deleted and checked.
console.log(`${dry ? '[dry run] ' : ''}3/3  redeploy Pages so it picks the new key up, and delete its older builds`);
const pages = spawnSync(`node deploy-pages.mjs${dry ? ' --dry-run' : ''}`, { shell: true, encoding: 'utf8' });
console.log(pages.stdout.trim().replace(/^/gm, '     '));
if (pages.status !== 0) {
  console.error(pages.stderr);
  console.error('\nStopped at step 3. The new key above is live on the Worker and set for Pages. Fix the error and run the same command again.');
  process.exit(1);
}

if (dry) {
  console.log('\nNothing was changed. Run it again without --dry-run to do it.');
} else if (which === 'admin') {
  console.log('\nThe admin address moved because it is worked out from the key. Your old bookmark now says "Not found".');
  console.log('That is expected. Your links, emails and claims are exactly as they were.');
  console.log('Log in at the new address with any username and the new password.');
} else {
  console.log('\nOpen the new display link on the desk laptop. Every screen that was signed in has been signed out.');
}
