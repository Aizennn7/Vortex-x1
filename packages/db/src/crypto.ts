/**
 * Envelope encryption for provider keys (AES-256-GCM).
 *
 * Stored format:  v1:<ivBase64>:<authTagBase64>:<cipherBase64>
 * The master key comes from VORTEX_SECRET_KEY (base64 or hex, 32 bytes) and
 * never leaves the server process.
 */

import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from 'node:crypto';

const VERSION = 'v1';

export class SecretKeyError extends Error {}

export function parseMasterKey(raw: string): Buffer {
  const trimmed = raw.trim();
  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) return Buffer.from(trimmed, 'hex');
  try {
    const b64 = Buffer.from(trimmed, 'base64');
    if (b64.length === 32) return b64;
  } catch {
    /* fall through */
  }
  throw new SecretKeyError(
    'VORTEX_SECRET_KEY must be 32 bytes encoded as base64 or 64 hex characters. Generate one with: openssl rand -base64 32',
  );
}

export function encryptSecret(plaintext: string, masterKey: Buffer | string): string {
  const key = typeof masterKey === 'string' ? parseMasterKey(masterKey) : masterKey;
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv.toString('base64'), tag.toString('base64'), ciphertext.toString('base64')].join(':');
}

export function decryptSecret(envelope: string, masterKey: Buffer | string): string {
  const key = typeof masterKey === 'string' ? parseMasterKey(masterKey) : masterKey;
  const parts = envelope.split(':');
  if (parts.length !== 4 || parts[0] !== VERSION) {
    throw new SecretKeyError('Unrecognised ciphertext envelope; cannot decrypt provider key.');
  }
  const [, ivB64, tagB64, dataB64] = parts;
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivB64 as string, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64 as string, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(dataB64 as string, 'base64')), decipher.final()]).toString('utf8');
}

/** Non-reversible fingerprint used to detect duplicate keys without storing them. */
export function keyFingerprint(plaintext: string): string {
  return createHash('sha256').update(plaintext).digest('hex').slice(0, 16);
}

/** Constant-time comparison for admin tokens. */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}
