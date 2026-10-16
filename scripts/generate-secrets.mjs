#!/usr/bin/env node
/**
 * Mint the two deployment secrets that must be identical on both services.
 *
 *   node scripts/generate-secrets.mjs
 *
 * VORTEX_SECRET_KEY encrypts provider keys at rest: a different value on the
 * relay and the worker means one of them cannot decrypt the keys the other
 * stored. VORTEX_ADMIN_TOKEN is the bearer token for /admin/*.
 *
 * The values are printed to stdout and nothing is written to disk, so they
 * never reach git. Paste them into the Render dashboard (both services) or add
 * them to `.env` locally — `.env` is git-ignored.
 */

import { randomBytes } from 'node:crypto';

const secretKey = randomBytes(32).toString('base64');
const adminToken = randomBytes(32).toString('hex');

process.stdout.write(
  [
    'VORTEX SI — deployment secrets (generated just now, shown once)',
    '',
    'VORTEX_SECRET_KEY = ' + secretKey,
    'VORTEX_ADMIN_TOKEN = ' + adminToken,
    '',
    'Set BOTH values, byte for byte, on vortex-si-relay AND vortex-si-worker.',
    'Nothing was written to disk. Do not commit them.',
    '',
  ].join('\n'),
);