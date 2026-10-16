#!/usr/bin/env node
/**
 * Privileged administration CLI for free-tier deployments.
 *
 * Replaces the need for an always-on HTTP `/admin/*` relay server when
 * managing provider keys, verifying Telegram delivery, or inspecting operational
 * status. Runs server-side only (local terminal or GitHub Actions workflow)
 * using `DATABASE_URL` and `VORTEX_SECRET_KEY`.
 *
 * Usage:
 *   npm run admin -- status
 *   npm run admin -- key:list
 *   npm run admin -- key:add <label> [apiKey]   (or reads TWELVEDATA_API_KEY from env)
 *   npm run admin -- key:verify <id-or-label>
 *   npm run admin -- telegram:test
 */

import { assertNoSecrets, maskKey, redact, secretValues } from '@vortex/core';
import {
  encryptSecret,
  insertKey,
  keyFingerprint,
  lastSuccessfulJob,
  listAlerts,
  listHealth,
  listKeys,
  listQuality,
  publicKeyView,
  recordAudit,
  updateKey,
  workerStatus,
} from '@vortex/db';
import { TwelveDataProvider } from '@vortex/provider';
import { WorkerRuntime } from '../runtime.js';

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0] ?? 'status';

  const runtime = await WorkerRuntime.create({
    manual: true,
    config: { role: 'worker' },
  });

  if (!runtime.db.connected) {
    process.stderr.write(`Database unavailable: ${runtime.db.detail}\n`);
    process.exitCode = 1;
    await runtime.close();
    return;
  }

  const db = runtime.db.client;
  const secrets = secretValues(runtime.config);

  const printSafe = (payload: unknown) => {
    const safe = redact(payload, secrets);
    assertNoSecrets(safe, secrets);
    process.stdout.write(`${JSON.stringify(safe, null, 2)}\n`);
  };

  try {
    switch (command) {
      case 'status': {
        const [workers, lastJob, health, quality, alerts, budget] = await Promise.all([
          workerStatus(db),
          lastSuccessfulJob(db),
          listHealth(db),
          listQuality(db),
          listAlerts(db, false, 20),
          runtime.keyPool.usageSnapshots(),
        ]);
        printSafe({
          workers,
          lastSuccessfulJob: lastJob,
          health,
          marketData: quality,
          providerBudget: budget.summary,
          alerts,
        });
        break;
      }

      case 'key:list': {
        const keys = await listKeys(db);
        const { snapshots } = await runtime.keyPool.usageSnapshots();
        printSafe({
          keys: keys.map((k) => ({
            ...publicKeyView(k),
            usage: snapshots.find((s) => s.keyId === k.id) ?? null,
          })),
        });
        break;
      }

      case 'key:add': {
        const label = (args[1] ?? 'twelvedata-primary').trim();
        const apiKey = (args[2] ?? process.env.TWELVEDATA_API_KEY ?? '').trim();
        if (apiKey.length < 16) {
          throw new Error('Provide an API key (>= 16 chars) as argument or via TWELVEDATA_API_KEY environment variable.');
        }
        if (!runtime.config.secretKey) {
          throw new Error('VORTEX_SECRET_KEY is required to encrypt provider keys at rest.');
        }
        const ciphertext = encryptSecret(apiKey, runtime.config.secretKey);
        const fp = keyFingerprint(apiKey);
        const masked = maskKey(apiKey);
        const existing = (await listKeys(db)).find((k) => k.label === label);
        const stored = existing
          ? await updateKey(db, existing.id, {
              ciphertext,
              maskedKey: masked,
              fingerprint: fp,
              enabled: true,
              status: 'ACTIVE',
              minuteLimit: runtime.config.providerRpmPerKey,
              dayLimit: runtime.config.providerRpdPerKey,
            })
          : await insertKey(db, {
              label,
              maskedKey: masked,
              ciphertext,
              fingerprint: fp,
              minuteLimit: runtime.config.providerRpmPerKey,
              dayLimit: runtime.config.providerRpdPerKey,
              headroomPercent: runtime.config.providerHeadroomPercent,
            });
        await recordAudit(db, {
          actor: 'cli:admin',
          action: existing ? 'provider_key.rotate' : 'provider_key.create',
          target: label,
          detail: { maskedKey: masked },
        });
        printSafe({ ok: true, action: existing ? 'updated' : 'inserted', key: stored ? publicKeyView(stored) : null });
        break;
      }

      case 'key:verify': {
        const target = (args[1] ?? 'twelvedata-primary').trim();
        const keys = await listKeys(db);
        const key = keys.find((k) => k.id === target || k.label === target);
        if (!key) {
          throw new Error(`No stored provider key matching id or label "${target}".`);
        }
        await runtime.keyPool.loadKeys(true);
        const plaintext = await runtime.keyPool.keyMaterial(key.id);
        if (!plaintext) {
          throw new Error(`Stored key "${key.label}" could not be decrypted with current VORTEX_SECRET_KEY.`);
        }
        const provider = new TwelveDataProvider({
          baseUrl: runtime.config.providerBaseUrl,
          timeoutMs: runtime.config.providerTimeoutMs,
          maxAttempts: 1,
        });
        const result = await provider.verifyKey(plaintext);
        const rejected = result.status === 401 || result.status === 403;
        await updateKey(db, key.id, {
          lastVerifiedAt: new Date().toISOString(),
          status: result.ok ? 'ACTIVE' : rejected ? 'INVALID' : undefined,
          lastError: result.ok ? null : result.detail,
          providerUsageCredits: result.creditsUsed ?? null,
        });
        printSafe({
          key: key.label,
          maskedKey: key.maskedKey,
          ok: result.ok,
          status: result.status,
          outcome: result.ok ? 'ACCEPTED' : rejected ? 'REJECTED' : 'UNVERIFIED',
          detail: result.detail,
        });
        break;
      }

      case 'telegram:test': {
        const verification = await runtime.telegram.verify();
        if (!verification.ok) {
          printSafe(verification);
          process.exitCode = 1;
          break;
        }
        const channels = await runtime.telegram.resolveChannels();
        const results: unknown[] = [];
        for (const ch of channels) {
          const sent = await runtime.telegram.sendMessage(
            ch.chatId,
            '🛰️ *VORTEX SI* connectivity check (CLI) — no signal is implied.',
          );
          results.push({ channel: ch.label, ok: sent.ok, messageId: sent.messageId ?? null, error: sent.description ?? null });
        }
        await recordAudit(db, { actor: 'cli:admin', action: 'telegram.test', detail: { results } });
        printSafe({ ...verification, results });
        break;
      }

      default:
        throw new Error(`Unknown admin command "${command}". Supported: status, key:list, key:add, key:verify, telegram:test`);
    }
  } finally {
    await runtime.close();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`admin cli failed: ${(error as Error).message}\n`);
  process.exitCode = 1;
});
