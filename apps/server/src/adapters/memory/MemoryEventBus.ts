import type { BusChannel, BusEvent, BusHandler, EventBus } from '../../domain/ports/EventBus.js';

/**
 * ADAPTER (memory): in-process EventBus.
 *
 * WHY IT DELIVERS ASYNCHRONOUSLY
 * ------------------------------
 * The obvious implementation calls handlers synchronously inside `publish`.
 * That would make the fake EASIER to test against than Redis pub/sub is in
 * production — and every test would then be asserting on a delivery guarantee
 * the real system does not provide. So handlers are invoked on the microtask
 * queue, and `flush()` exists for tests that need to wait for delivery
 * deliberately rather than by accident.
 *
 * Handler errors are caught and swallowed (with the error recorded for tests).
 * A subscriber that throws must not take down the publisher, which in
 * production is a user's ban request.
 */
export class MemoryEventBus implements EventBus {
  private readonly handlers = new Map<BusChannel, Set<BusHandler>>();
  private pending: Promise<unknown>[] = [];

  /** Everything published, for test assertions. */
  readonly published: { channel: BusChannel; event: BusEvent }[] = [];
  /** Errors thrown by subscribers, so a test can assert none happened. */
  readonly handlerErrors: unknown[] = [];

  async publish(channel: BusChannel, event: BusEvent): Promise<void> {
    this.published.push({ channel, event });

    const subscribers = this.handlers.get(channel);
    if (subscribers === undefined || subscribers.size === 0) return;

    for (const handler of [...subscribers]) {
      const task = Promise.resolve()
        .then(() => handler(event))
        .catch((error: unknown) => {
          this.handlerErrors.push(error);
        });
      this.pending.push(task);
    }
  }

  async subscribe(channel: BusChannel, handler: BusHandler): Promise<() => Promise<void>> {
    let set = this.handlers.get(channel);
    if (set === undefined) {
      set = new Set();
      this.handlers.set(channel, set);
    }
    set.add(handler);

    return async () => {
      set!.delete(handler);
    };
  }

  /** Await delivery of everything published so far. Test-only. */
  async flush(): Promise<void> {
    while (this.pending.length > 0) {
      const batch = this.pending;
      this.pending = [];
      await Promise.all(batch);
    }
  }

  async close(): Promise<void> {
    await this.flush();
    this.handlers.clear();
  }

  /** Test helper. Not part of the port. */
  clear(): void {
    this.published.length = 0;
    this.handlerErrors.length = 0;
  }
}
