// Deploys the Pages front door, then deletes its older builds. Every Pages build keeps answering at its own hash URL
// with the gate code and the keys it was deployed with, so an old build is a second, stale door into the site.
// `npm run deploy` runs this after the Worker, and rotate.mjs runs it after changing a key.
//   node deploy-pages.mjs [--dry-run]
//
// Only older builds of the production branch are deleted, each one named first. The build just deployed carries the
// site's addresses and is never touched. A build from any other branch may carry a preview alias, so it is left for a
// person to look at. --force is needed: without it wrangler asks "Are you sure?", takes "no" when nobody can answer,
// and still exits 0. That is also why the list is read again afterwards: a delete that did not happen must not pass.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const PROJECT = 'buildday-qr'; // the Pages project named in pages/wrangler.toml
const dry = process.argv.includes('--dry-run');
const sh = (command, options = {}) => spawnSync(command, { shell: true, encoding: 'utf8', ...options });
const list = () => {
  const out = sh(`npx wrangler pages deployment list --project-name ${PROJECT} --json`).stdout;
  return JSON.parse(out.slice(out.indexOf('[')));
};

let fresh = '';
if (dry) {
  console.log('[dry run] would deploy Pages, keep that new build, and delete these:');
} else {
  const deployed = sh('npx wrangler pages deploy --branch main --commit-dirty=true', { cwd: fileURLToPath(new URL('./pages/', import.meta.url)) });
  process.stdout.write(deployed.stdout);
  process.stderr.write(deployed.stderr);
  if (deployed.status !== 0) process.exit(deployed.status || 1);
  fresh = deployed.stdout.match(/https:\/\/([0-9a-f]{8})\./)?.[1];
  if (!fresh) {
    console.error('Deployed, but could not tell which build is the new one, so nothing was deleted. Look at the list yourself.');
    process.exit(1);
  }
}

// The new build has to be in Cloudflare's own list before anything is deleted: judged from a list that is behind, the
// build still serving the site would look like an old one. The list gets a few seconds to catch up.
let listed = list();
for (let tries = 1; !dry && tries < 6 && !listed.some((d) => d.Id.startsWith(fresh)); tries++) {
  await new Promise((r) => setTimeout(r, 3000));
  listed = list();
}
if (!dry && !listed.some((d) => d.Id.startsWith(fresh))) {
  console.error(`The new build ${fresh} is not in Cloudflare's list yet, so nothing was deleted. Run \`npm run deploy:pages\` again in a minute.`);
  process.exit(1);
}
const others = listed.filter((d) => dry || !d.Id.startsWith(fresh));
const old = others.filter((d) => d.Environment === 'Production' && d.Branch === 'main');
for (const d of others.filter((d) => !old.includes(d))) console.log(`left alone, look at it yourself: ${d.Deployment} (${d.Environment}, branch ${d.Branch})`);
for (const d of old) {
  console.log(`${dry ? 'would delete' : 'deleting'} older Pages build ${d.Deployment} (from ${d.Source}, ${d.Status})`);
  if (!dry) sh(`npx wrangler pages deployment delete ${d.Id} --project-name ${PROJECT} --force`);
}
if (!old.length) console.log('no older Pages builds to delete');
if (!dry) {
  const left = list();
  const stuck = left.filter((d) => old.some((o) => o.Id === d.Id));
  if (stuck.length || !left.some((d) => d.Id.startsWith(fresh))) {
    console.error(`Not done. Still there: ${stuck.map((d) => d.Deployment).join(', ') || 'none'}. New build present: ${left.some((d) => d.Id.startsWith(fresh))}.`);
    process.exit(1);
  }
  console.log(`checked: ${left.length} Pages build left, the new one`);
}
