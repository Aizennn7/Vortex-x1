import { describe, expect, it } from 'vitest';
import { listAlerts, listHealth, raiseAlert } from '@vortex/db';
import { createHarness } from './helpers.js';
import { runMaintenance } from '../src/jobs/maintenance.js';

describe('in-app inbox health', () => {
  it('reports the database-backed inbox independently of Telegram and resolves legacy delivery alerts', async () => {
    const h = await createHarness({ env: { VORTEX_TELEGRAM_ENABLED: 'false' } });
    try {
      await raiseAlert(h.client, {
        severity: 'WARNING',
        code: 'telegram-delivery-failed',
        title: 'Legacy Telegram delivery failure',
        detail: 'This alert was created before the inbox migration.',
      });

      const summary = await runMaintenance(h.runtime, new Date('2026-10-24T00:00:00.000Z'));
      const health = await listHealth(h.client);
      const inbox = health.find((component) => component.component === 'telegram');

      expect(inbox?.status).toBe('CONNECTED');
      expect(inbox?.detail).toMatch(/in-app VORTEX inbox is database-backed/i);
      expect(inbox?.metadata).toMatchObject({
        channel: 'in-app',
        externalDeliveryEnabled: false,
      });
      expect(summary.alertsResolved).toContain('telegram-delivery-failed');

      const openAlerts = await listAlerts(h.client, false, 50);
      expect(openAlerts.some((alert) => alert.code === 'telegram-delivery-failed')).toBe(false);
    } finally {
      await h.close();
    }
  });
});
