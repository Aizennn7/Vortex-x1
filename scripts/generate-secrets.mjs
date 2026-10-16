#!/usr/bin/env node
/**
 * Mint the deployment secrets for VORTEX SI.
 *
 *   node scripts/generate-secrets.mjs
 *
 * VORTEX_SECRET_KEY encrypts provider keys at rest (AES-256-GCM).
 * VORTEX_ADMIN_TOKEN is the bearer token for privileged /admin/* routes.
 *
 * The values are printed to stdout and nothing is written to disk, so they
 * never reach git. Paste them into GitHub Repository Secrets
 * (Settings -> Secrets and variables -> Actions) or `.env` locally.
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
    'Add these values in GitHub -> Settings -> Secrets and variables -> Actions -> Repository secrets.',
    'Nothing was written to disk. Do not commit them.',
    '',
  ].join('\n'),
);
