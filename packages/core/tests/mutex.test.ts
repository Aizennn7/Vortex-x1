/**
 * KeyedMutex contract.
 *
 * The mutex serialises critical sections per key inside one process
 * (the database row locks are the cross-process half). These tests
 * pin the two guarantees that matter: strict ordering per key, and
 * cleanup of the internal tail map once nothing is queued — a
 * regression there retained one settled promise per key forever.
 */

import { describe, expect, it } from 'vitest';
import { KeyedMutex, delay } from '../src/mutex.js';

describe('KeyedMutex', () => {
  it('serialises concurrent runs under the same key', async () => {
    const mutex = new KeyedMutex();
    const order: number[] = [];
    const [a, b] = await Promise.all([
      mutex.run('k', async () => {
        await delay(10);
        order.push(1);
        return 'a';
      }),
      mutex.run('k', async () => {
        order.push(2);
        return 'b';
      }),
    ]);
    expect(order).toEqual([1, 2]);
    expect([a, b].sort()).toEqual(['a', 'b']);
  });

  it('does not block a different key', async () => {
    const mutex = new KeyedMutex();
    const slow = mutex.run('a', async () => {
      await delay(50);
      return 'slow';
    });
    const fast = await mutex.run('b', async () => 'fast');
    expect(fast).toBe('fast');
    expect(await slow).toBe('slow');
  });

  it('releases the key once the last queued run settles', async () => {
    const mutex = new KeyedMutex();
    await mutex.run('k', async () => 'first');
    await mutex.run('k', async () => 'second');
    // The cleanup is scheduled on the microtask queue; a macrotask
    // tick guarantees it has run.
    await delay(0);
    expect(mutex.size).toBe(0);
  });

  it('keeps later runs queued when an earlier run rejects', async () => {
    const mutex = new KeyedMutex();
    const failing = mutex.run('k', async () => {
      throw new Error('boom');
    });
    const after = mutex.run('k', async () => 'still-works');
    await expect(failing).rejects.toThrow('boom');
    expect(await after).toBe('still-works');
    await delay(0);
    expect(mutex.size).toBe(0);
  });
});
