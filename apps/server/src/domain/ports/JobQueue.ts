/**
 * PORT: JobQueue — work that must not happen inside a request.
 *
 * WHY THIS EXISTS BEFORE THERE IS A WORKER
 * ----------------------------------------
 * Video processing is the reason: transcoding with FFmpeg takes minutes, needs
 * CPU the API does not have, and fails often enough that it must be retryable.
 * None of that can live in a request handler, and the shape of the boundary is
 * worth fixing before the first job rather than after the third.
 *
 * WHAT A JOB IS, AND WHAT IT IS NOT
 * ---------------------------------
 * A job is a DURABLE INSTRUCTION, not a function call. Two consequences that
 * every implementation and every handler must respect:
 *
 *   1. THE PAYLOAD IS DATA, NOT REFERENCES. It is serialised, stored, and read
 *      back by a different process — possibly on a different machine, possibly
 *      after a deploy that changed the code. It carries ids and primitives, and
 *      the handler re-reads whatever it needs.
 *
 *   2. HANDLERS MUST BE IDEMPOTENT. Delivery is at-least-once, always. A worker
 *      that dies after finishing the work but before acknowledging it will see
 *      the same job again, and no queue can prevent that — the only question is
 *      whether the handler notices. "Transcode this video" run twice should
 *      produce one video, not two.
 *
 * WHY NOT JUST USE THE EVENT BUS
 * ------------------------------
 * `EventBus` is fire-and-forget pub/sub: a subscriber that is down misses the
 * message, which is correct for "tell every process this user was banned" and
 * catastrophic for "transcode the video this person just uploaded". A queue
 * persists, retries, and eventually gives up somewhere visible.
 */

export type JobName = 'video.transcode' | 'video.thumbnail' | 'media.cleanup';

export interface JobOptions {
  /**
   * How many times to retry before the job is considered failed.
   *
   * Finite on purpose. A job that retries forever is how a poison message takes
   * a worker pool down: it never succeeds, never leaves the queue, and consumes
   * a slot every time round.
   */
  readonly maxAttempts?: number;
  /** Delay before the first attempt, in seconds. */
  readonly delaySeconds?: number;
  /**
   * Collapses duplicates: enqueuing the same key twice yields one job.
   *
   * The natural key is the thing being worked on — `video:<id>` — so a user who
   * taps retry three times does not queue three transcodes.
   */
  readonly dedupeKey?: string;
}

export interface Job<T = unknown> {
  readonly id: string;
  readonly name: JobName;
  readonly payload: T;
  readonly attempt: number;
  readonly enqueuedAt: Date;
}

export type JobHandler<T = unknown> = (job: Job<T>) => Promise<void>;

export interface JobQueue {
  /**
   * Hand work to a worker.
   *
   * Resolves once the job is DURABLE, not once it is done. A caller that needs
   * to know the outcome is asking for the wrong thing from a queue.
   */
  enqueue<T>(name: JobName, payload: T, options?: JobOptions): Promise<string>;

  /**
   * Process jobs of one kind. Returns a function that stops consuming.
   *
   * The API process never calls this. Workers do — which is the entire point of
   * the split, and why the port has both halves rather than being two ports.
   */
  consume<T>(name: JobName, handler: JobHandler<T>): Promise<() => Promise<void>>;

  /** Whether a queue is configured. False in a deployment with no workers. */
  isAvailable(): boolean;
}
