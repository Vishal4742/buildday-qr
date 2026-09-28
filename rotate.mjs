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

// Only older builds of the production branch are deleted, each named first. The newest build carries the site's
// addresses and is never touched. A build from any other branch may carry a preview alias, so it is left for a person
// to look at. --force is needed: without it wrangler asks "Are you sure?", takes "no" when nobody can answer, and
// still exits 0. That is also why the list is read again afterwards: a delete that did not happen must not pass.
console.log(`${dry ? '[dry run] ' : ''}4/4  delete older Pages deployments, which still answer to the old key`);
const fresh = dry ? '' : deployed.match(/https:\/\/([0-9a-f]{8})\./)?.[1];
if (!dry && !fresh) {
  console.error('Could not tell which deployment is the new one, so nothing was deleted.');
  console.error(`Delete the old ones yourself, after looking at them: npx wrangler pages deployment list --project-name ${PROJECT}`);
  process.exit(1);
}
const list = () => {
  const out = spawnSync(`npx wrangler pages deployment list --project-name ${PROJECT} --json`, { shell: true, encoding: 'utf8' }).stdout;
  return JSON.parse(out.slice(out.indexOf('[')));
};
const others = list().filter((d) => dry || !d.Id.startsWith(fresh));
const old = others.filter((d) => d.Environment === 'Production' && d.Branch === 'main');
for (const d of others.filter((d) => !old.includes(d))) console.log(`     left alone, look at it yourself: ${d.Deployment} (${d.Environment}, branch ${d.Branch})`);
for (const d of old) {
  console.log(`     ${dry ? 'would delete' : 'deleting'} ${d.Deployment} (production build of main from ${d.Source}, ${d.Status})`);
  if (!dry) spawnSync(`npx wrangler pages deployment delete ${d.Id} --project-name ${PROJECT} --force`, { shell: true, encoding: 'utf8' });
}
if (!old.length) console.log('     none to delete');
if (!dry) {
  const left = list();
  const stuck = left.filter((d) => old.some((o) => o.Id === d.Id));
  if (stuck.length || !left.some((d) => d.Id.startsWith(fresh))) {
    console.error(`\nNot done. Still there: ${stuck.map((d) => d.Deployment).join(', ') || 'none'}. New build present: ${left.some((d) => d.Id.startsWith(fresh))}.`);
    console.error('The new key above is already live. Look at the list before deleting anything by hand.');
    process.exit(1);
  }
  console.log(`     checked: ${left.length} deployment left, the new one`);
}
if (dry) console.log('\nNothing was changed. Run it again without --dry-run to do it.');
