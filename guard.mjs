// test.mjs and load.mjs delete everything they touch, so this decides where they may run at all: this machine, or a
// throwaway copy named on purpose over https (THROWAWAY=<its host>). The site's own addresses are refused even when
// named, because the live site is empty between two events and an empty site passes every other check. They are read
// from the config, so a renamed Worker or a new domain is covered without editing this file.
import { readFileSync } from 'node:fs';

const read = (file) => readFileSync(new URL(file, import.meta.url), 'utf8');
const worker = read('./wrangler.toml').match(/^name\s*=\s*"([^"]+)"/m)[1]; // the Worker: <name>.<account>.workers.dev
const pages = read('./pages/wrangler.toml').match(/^name\s*=\s*"([^"]+)"/m)[1]; // the Pages front door: <name>.pages.dev
const domains = [...read('./wrangler.toml').matchAll(/pattern\s*=\s*"([^"]+)"/g)].map((m) => m[1]); // commented out or not

export function throwawayOnly(base) {
  const url = new URL(base);
  if (url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname)) return;
  const host = url.hostname;
  if (host.split('.')[0] === worker || host === `${pages}.pages.dev` || host.endsWith(`.${pages}.pages.dev`) || domains.includes(host)) {
    throw new Error(`${base} is the live site. These scripts delete everything they touch, so they never run there, not even when it is empty.`);
  }
  // https as well, because every admin request carries the key in its Authorization header.
  if (url.protocol !== 'https:' || url.host !== process.env.THROWAWAY) {
    throw new Error(`${base} is not this machine. These scripts only run on a throwaway copy over https that you name: THROWAWAY=${url.host}`);
  }
}
