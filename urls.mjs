// Prints your private admin address and display link. They are derived from the keys, so they change when a key changes.
// The admin panel asks for ADMIN_KEY as its password. The display link asks for nothing: opening it signs that
// browser in and moves it to /screen. Treat the link itself as the secret, and change DISPLAY_KEY if it ever leaks.
//   node urls.mjs https://buildday.<you>.workers.dev <ADMIN_KEY> <DISPLAY_KEY>
import { createHash } from 'node:crypto';

const [site, adminKey, displayKey] = process.argv.slice(2);
if (!site || !adminKey || !displayKey) {
  console.error('usage: node urls.mjs <site url> <ADMIN_KEY> <DISPLAY_KEY>');
  process.exit(1);
}
const path = (label, key) => createHash('sha256').update(`${label}-path:${key}`).digest('hex').slice(0, 20);
console.log('admin panel (password = ADMIN_KEY):', `${site.replace(/\/$/, '')}/${path('admin', adminKey)}`);
console.log('display link (no password)        :', `${site.replace(/\/$/, '')}/${path('display', displayKey)}`);
