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
    this.tails.set(
      key,
      current.catch(() => undefined),
    );
    try {
      return await current;
    } finally {
      if (this.tails.get(key) === current || (await this.isTail(key, current))) {
        // Only clear when nothing else has queued behind us.
        queueMicrotask(() => {
          if (this.tails.get(key) === current) this.tails.delete(key);
        });
      }
    }
  }

  private async isTail(key: string, candidate: unknown): Promise<boolean> {
    return this.tails.get(key) === candidate;
  }

  get size(): number {
    return this.tails.size;
  }
}

/** Simple promise-based sleep used for backoff in tests and jobs. */
export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
