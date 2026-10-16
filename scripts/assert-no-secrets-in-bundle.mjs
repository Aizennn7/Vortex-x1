/**
 * Bundle guard.
 *
 * The dashboard is a static site: anything inside the built JavaScript is
 * public. This script greps the production bundle for the shapes of the secrets
 * this project uses (provider keys, bot tokens, bearer tokens, Postgres URLs,
 * Supabase service keys) and fails the build if one shows up. It also fails on
 * accidental `localhost` API bases, which would break the deployed site.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'apps', 'web', 'dist');

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

let bundle;
try {
  bundle = walk(dist);
} catch {
  console.error(`no build output at ${dist} — run \`npm run build -w @vortex/web\` first`);
  process.exit(1);
}

const textFiles = bundle.filter((f) => /\.(js|mjs|css|html|json|map)$/.test(f));
if (textFiles.length === 0) {
  console.error(`no bundle files found in ${dist}`);
  process.exit(1);
}

function isPublicSupabaseAnonJwt(token) {
  const parts = token.split('.');
  if (parts.length !== 3 || !parts[1]) return false;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    return payload && typeof payload === 'object' && payload.role === 'anon';
  } catch {
    return false;
  }
}

const patterns = [
  { name: '12-data provider key', re: /\b[0-9a-f]{32}\b/ },
  { name: 'Telegram bot token', re: /\b\d{8,12}:[A-Za-z0-9_-]{30,40}\b/ },
  { name: 'Postgres connection string', re: /postgres(?:ql)?:\/\/[^\s"'`]+/i },
  { name: 'Supabase service key', re: /\b(service_role|sb_secret_[A-Za-z0-9_-]+)\b/ },
  { name: 'JWT-shaped token', re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g },
  { name: 'hard-coded admin bearer token', re: /Bearer\s+[A-Za-z0-9._~+/=-]{16,}/ },
  { name: 'environment dumps', re: /\bprocess\.env\.[A-Z_]+\b/ },
];

const failures = [];
for (const file of textFiles) {
  const content = readFileSync(file, 'utf8');
  for (const { name, re } of patterns) {
    if (name === 'JWT-shaped token') {
      const matches = content.match(re) ?? [];
      for (const jwt of matches) {
        if (!isPublicSupabaseAnonJwt(jwt)) {
          failures.push(`${file.replace(root + '/', '')}: ${name} → ${jwt.slice(0, 60)}`);
        }
      }
      continue;
    }
    const match = content.match(re);
    if (!match) continue;
    // `vite/client` injects a harmless `import.meta.env` guard; only real
    // environment reads inside our own code count.
    if (name === 'environment dumps' && /vite|import\.meta/.test(match[0])) continue;
    failures.push(`${file.replace(root + '/', '')}: ${name} → ${match[0].slice(0, 60)}`);
  }
}

// A deployed SPA must never hard-code a loopback address as its API base.
for (const file of textFiles.filter((f) => /\.(js|html)$/.test(f))) {
  const content = readFileSync(file, 'utf8');
  if (/https?:\/\/(localhost|127\.0\.0\.1):\d+/.test(content)) {
    failures.push(`${file.replace(root + '/', '')}: loopback API base baked into the bundle`);
  }
}

console.log(`scanned ${textFiles.length} bundle file(s)`);
if (failures.length > 0) {
  console.error('bundle guard failed:');
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log('bundle guard passed: no secrets, no loopback bases');
