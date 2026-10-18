/**
 * Keyed async mutex.
 *
 * Used to serialise critical sections that must not interleave inside one
 * process (quota reservations, singleton jobs). Cross-process safety is still
 * provided by the database row locks — this is the in-process half of the
 * guarantee, and it is what makes the behaviour testable on engines that only
 * expose a single connection.
 */

export class KeyedMutex {
  private readonly tails = new Map<string, Promise<unknown>>();

  async run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    // Chain onto the previous holder; swallow its rejection so one failure
    // cannot poison the queue.
    const current = previous.then(fn, fn);
    // The map must hold the *tail* (the rejection-swallowing promise), and
    // the cleanup must compare against that same object — otherwise the
    // entry is never removed and one settled promise is retained per key
    // forever.
    const tail = current.catch(() => undefined);
    this.tails.set(key, tail);
    try {
      return await current;
    } finally {
      queueMicrotask(() => {
        // Only clear when nothing has queued behind us in the meantime.
        if (this.tails.get(key) === tail) this.tails.delete(key);
      });
    }
  }

  get size(): number {
    return this.tails.size;
  }
}

/** Simple promise-based sleep used for backoff in tests and jobs. */
export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
