/**
 * Relay client behaviour.
 *
 * The dashboard must never invent data: when the relay is unreachable or
 * answers with an error envelope, the client reports a failure instead of
 * returning an empty object that a component could render as "all good".
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { relay, RELAY_BASE } from '../src/relay.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

describe('relay client', () => {
  it('defaults to same-origin requests (no baked-in host)', () => {
    expect(RELAY_BASE).toBe('');
  });

  it('unwraps the ok/data envelope', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ ok: true, data: { status: 'ok' } })));
    const result = await relay.health();
    expect(result.ok).toBe(true);
    expect(result.data).toEqual({ status: 'ok' });
    expect(result.error).toBeNull();
  });

  it('reports an error envelope instead of passing it on as data', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ ok: false, error: { code: 'not_ready', message: 'worker not ready' } }, 503)),
    );
    const result = await relay.summary();
    expect(result.ok).toBe(false);
    expect(result.status).toBe(503);
    expect(result.data).toBeNull();
    expect(result.error).toBe('worker not ready');
  });

  it('reports an unreachable relay as an error, never as empty data', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch');
      }),
    );
    const result = await relay.signals(10);
    expect(result.ok).toBe(false);
    expect(result.status).toBe(0);
    expect(result.data).toBeNull();
    expect(result.error).toContain('relay unreachable');
  });

  it('sends the requested limit and accepts only JSON', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ ok: true, data: { signals: [], count: 0 } }));
    vi.stubGlobal('fetch', fetchMock);
    await relay.signals(5);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/signals?limit=5');
    expect((init.headers as Record<string, string>).accept).toBe('application/json');
  });
});
