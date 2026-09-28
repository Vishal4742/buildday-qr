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

// The key travels on stdin, never on a command line, so it stays out of the process list.
run(`1/4  set ${NAME} on the Worker (takes effect at once)`, `npx wrangler secret put ${NAME}`, { input: key });
run(`2/4  set ${NAME} on the Pages project`, `npx wrangler pages secret put ${NAME} --project-name ${PROJECT}`, { input: key });
const deployed = run('3/4  redeploy Pages so it picks the new key up', 'npx wrangler pages deploy --branch main --commit-dirty=true', { cwd: 'pages' });

// The new key is live from step 1 on, so it is printed before step 4 can fail. Printed last, a failed delete lost it.
const path = createHash('sha256').update(`${which}-path:${key}`).digest('hex').slice(0, 20);
if (which === 'admin' && !dry) {
  console.log('');
  console.log(`New admin password (shown once, save it now): ${key}`);
  console.log(`New admin panel address (BOOKMARK THIS ONE):  ${site.replace(/\/$/, '')}/${path}`);
  console.log('');
  console.log('The address moved because it is worked out from the key. Your old bookmark now says "Not found".');
  console.log('That is expected. Your links, emails and claims are exactly as they were.');
  console.log('Log in at the new address with any username and the new password.');
  console.log('');
} else if (!dry) {
  console.log('');
  console.log(`New display link: ${site.replace(/\/$/, '')}/${path}`);
  console.log('Open it again on the desk laptop. Every screen that was signed in has been signed out.');
  console.log('');
}

// Every deployment is named before it goes, and none is forced. Cloudflare refuses to delete one that still carries
// an alias, and that refusal is a reason to stop and look, not something to override.
console.log(`${dry ? '[dry run] ' : ''}4/4  delete older Pages deployments, which still answer to the old key`);
const fresh = dry ? '' : deployed.match(/https:\/\/([0-9a-f]{8})\./)?.[1];
if (!dry && !fresh) {
  console.error('Could not tell which deployment is the new one, so nothing was deleted.');
  console.error(`Delete the old ones yourself, after looking at them: npx wrangler pages deployment list --project-name ${PROJECT}`);
  process.exit(1);
}
const listed = spawnSync(`npx wrangler pages deployment list --project-name ${PROJECT} --json`, { shell: true, encoding: 'utf8' }).stdout;
const old = JSON.parse(listed.slice(listed.indexOf('['))).filter((d) => dry || !d.Id.startsWith(fresh));
for (const d of old) {
  console.log(`     ${dry ? 'would delete' : 'deleting'} ${d.Deployment} (${d.Environment}, built from ${d.Source}, ${d.Status})`);
  if (dry) continue;
  const done = spawnSync(`npx wrangler pages deployment delete ${d.Id} --project-name ${PROJECT}`, { shell: true, encoding: 'utf8' });
  if (done.status !== 0) {
    console.error(done.stdout, done.stderr);
    console.error(`\nCloudflare refused to delete ${d.Deployment}, and it was not forced. The new key above is already live.`);
    console.error('Find out why it was refused before deleting it by hand.');
    process.exit(1);
  }
}
if (!old.length) console.log('     none to delete');
if (dry) console.log('\nNothing was changed. Run it again without --dry-run to do it.');
