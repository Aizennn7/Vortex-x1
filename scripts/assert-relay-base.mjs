#!/usr/bin/env node
/**
 * Relay-base guard.
 *
 *   node scripts/assert-relay-base.mjs https://<relay-host>
 *
 * The bundle guard proves the bundle holds no secrets; this one proves the
 * opposite half of the contract — that the published dashboard actually talks
 * to the relay it was built for. `VITE_RELAY_URL` is read at build time, and a
 * typo or an unset variable silently produces a dashboard that calls its own
 * origin and shows nothing. This fails the deploy instead.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'apps', 'web', 'dist');
const expected = (process.argv[2] ?? '').trim().replace(/\/+$/, '');

if (!expected) {
  console.error('usage: node scripts/assert-relay-base.mjs <relay-origin>');
  process.exit(1);
}
if (/^https?:\/\/(localhost|127\.0\.0\.1)/.test(expected)) {
  console.error(`refusing to build a published bundle against a loopback relay: ${expected}`);
  process.exit(1);
}

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

let files;
try {
  files = walk(dist);
} catch {
  console.error(`no build output at ${dist} — run \`npm run build:web\` first`);
  process.exit(1);
}

const text = files
  .filter((f) => /\.(js|mjs|css|html)$/.test(f))
  .map((f) => readFileSync(f, 'utf8'))
  .join('\n');

const needle = expected;
const host = (() => {
  try {
    return new URL(expected).host;
  } catch {
    return expected;
  }
})();

if (text.includes(needle)) {
  console.log(`relay base verified in bundle: ${needle}`);
  process.exit(0);
}

if (host !== needle && text.includes(host)) {
  console.log(`relay host verified in bundle: ${host} (base ${needle})`);
  process.exit(0);
}

console.error('relay base guard failed.');
console.error(`  expected the published bundle to call: ${needle}`);
console.error('  the bundle contains neither that origin nor its hostname.');
console.error('  Check that VITE_RELAY_URL is set in the environment that runs');
console.error('  `npm run build:web` (repository variable VITE_RELAY_URL).');
process.exit(1);