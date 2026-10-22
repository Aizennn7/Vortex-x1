import { describe, expect, it } from 'vitest';
import { listAlerts, listHealth, raiseAlert } from '@vortex/db';
import { createHarness } from './helpers.js';
import { runMaintenance } from '../src/jobs/maintenance.js';

describe('VORTEX in-app inbox health', () => {
  it('reports the database-backed inbox instead of disabled Telegram and resolves stale Telegram alerts', async () => {
    const h = await createHarness({ env: { VORTEX_TELEGRAM_ENABLED: 'false' } });
    try {
      await raiseAlert(h.client, {
        severity: 'WARNING',
        code: 'telegram-delivery-failed',
        title: 'Legacy Telegram delivery failure',
        detail: 'Stale alert from the retired delivery path.',
      });

      const summary = await runMaintenance(h.runtime, new Date());
      const health = (await listHealth(h.client)).find((row) => row.component === 'telegram');

      expect(health?.status).toBe('CONNECTED');
      expect(health?.detail).toMatch(/In-app VORTEX inbox is database-backed/);
      expect(health?.detail).toMatch(/External Telegram delivery is disabled/);
      expect(health?.metadata).toMatchObject({
        channel: 'in-app',
        externalDeliveryEnabled: false,
      });
      expect(summary.alertsResolved).toContain('telegram-delivery-failed');
      expect((await listAlerts(h.client, false, 50)).some((alert) => alert.code === 'telegram-delivery-failed')).toBe(false);
    } finally {
      await h.close();
    }
  }, 120_000);
});
