import type { Job, JobHandler, JobName, JobOptions, JobQueue } from '../../domain/ports/JobQueue.js';

/**
 * ADAPTER (memory): JobQueue.
 *
 * Runs handlers in-process, immediately, and records everything enqueued.
 *
 * IT MODELS DEDUPLICATION, because that is the property callers most easily get
 * wrong: a user tapping retry three times must produce one job, and a fake that
 * happily queued three would let that bug reach a real queue where it costs
 * three transcodes.
 *
 * It does NOT model retries or at-least-once delivery. A fake that redelivered
 * would make every test non-deterministic; the idempotence requirement is a
 * contract on handlers, stated in the port and enforced by reviewing them.
 */
export class MemoryJobQueue implements JobQueue {
  readonly enqueued: { name: JobName; payload: unknown; options: JobOptions }[] = [];

  private readonly handlers = new Map<JobName, JobHandler<never>>();
  private readonly dedupe = new Set<string>();
  private counter = 0;

  isAvailable(): boolean {
    return true;
  }

  async enqueue<T>(name: JobName, payload: T, options: JobOptions = {}): Promise<string> {
    if (options.dedupeKey !== undefined) {
      if (this.dedupe.has(options.dedupeKey)) return options.dedupeKey;
      this.dedupe.add(options.dedupeKey);
    }

    this.counter += 1;
    const id = `job-${this.counter}`;
    this.enqueued.push({ name, payload, options });

    const handler = this.handlers.get(name);
    if (handler !== undefined) {
      const job: Job<T> = { id, name, payload, attempt: 1, enqueuedAt: new Date() };
      // Awaited so a test can assert on the effect without a timer. A real
      // queue is asynchronous; a test that had to sleep would be flaky.
      await (handler as JobHandler<T>)(job);
    }

    return id;
  }

  async consume<T>(name: JobName, handler: JobHandler<T>): Promise<() => Promise<void>> {
    this.handlers.set(name, handler as JobHandler<never>);
    return async () => {
      this.handlers.delete(name);
    };
  }

  /** Test helper. Not part of the port. */
  clear(): void {
    this.enqueued.length = 0;
    this.dedupe.clear();
  }
}
