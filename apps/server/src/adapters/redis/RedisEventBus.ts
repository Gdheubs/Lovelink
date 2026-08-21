import type { BusChannel, BusEvent, BusHandler, EventBus } from '../../domain/ports/EventBus.js';
import type { Logger } from '../../domain/ports/Logger.js';
import { KEY, type RedisClient } from './client.js';

/**
 * ADAPTER: EventBus over Redis pub/sub.
 *
 * WHY TWO CONNECTIONS
 * -------------------
 * A Redis connection in SUBSCRIBE mode refuses ordinary commands, so publishing
 * and subscribing cannot share one. The constructor takes both explicitly
 * rather than creating them, so the composition root owns every connection's
 * lifecycle and shutdown is not a guessing game.
 *
 * DELIVERY GUARANTEES — READ THIS BEFORE RELYING ON IT
 * ----------------------------------------------------
 * Redis pub/sub is AT-MOST-ONCE and fire-and-forget. A subscriber that is
 * disconnected during a publish never receives that message; there is no
 * replay, no acknowledgement, and no ordering guarantee across channels.
 *
 * This is why the port says subscribers must be idempotent, and why ban
 * enforcement does not depend on the bus alone: account status is ALSO checked
 * at socket connect and at token refresh. The bus makes enforcement immediate;
 * the checks make it certain. Anything that must not be missed needs a
 * durable mechanism, not this.
 *
 * A HANDLER THAT THROWS is caught and logged. In production the publisher is
 * often a moderator issuing a ban — a subscriber's bug must not fail that.
 */
export class RedisEventBus implements EventBus {
  private readonly handlers = new Map<string, Set<BusHandler>>();
  private readonly log: Logger;
  private listening = false;

  constructor(
    private readonly publisher: RedisClient,
    private readonly subscriber: RedisClient,
    logger: Logger,
  ) {
    this.log = logger.child({ component: 'event-bus' });
  }

  async publish(channel: BusChannel, event: BusEvent): Promise<void> {
    try {
      await this.publisher.publish(KEY.busChannel(channel), JSON.stringify(event));
    } catch (error) {
      // A failed publish is logged, not thrown. See the guarantees note above:
      // callers already cannot assume delivery, so turning a transport failure
      // into an exception would only add a failure mode without adding safety.
      this.log.error(
        { channel, type: event.type, err: String(error) },
        'failed to publish bus event',
      );
    }
  }

  async subscribe(channel: BusChannel, handler: BusHandler): Promise<() => Promise<void>> {
    this.ensureListening();

    const redisChannel = KEY.busChannel(channel);
    let set = this.handlers.get(redisChannel);

    if (set === undefined) {
      set = new Set();
      this.handlers.set(redisChannel, set);
      await this.subscriber.subscribe(redisChannel);
    }
    set.add(handler);

    // Returning an unsubscribe function is not politeness: without it, a
    // hot-reloading dev process stacks handlers until every event fires a dozen
    // times, and tests leak listeners into each other.
    return async () => {
      const current = this.handlers.get(redisChannel);
      if (current === undefined) return;

      current.delete(handler);
      if (current.size === 0) {
        this.handlers.delete(redisChannel);
        await this.subscriber.unsubscribe(redisChannel);
      }
    };
  }

  /**
   * One message listener for the whole connection, dispatching by channel.
   *
   * Registering a listener per subscription would add an `on('message')` for
   * every subscribe call, and every one of them would fire for every message —
   * quadratic work and duplicate deliveries.
   */
  private ensureListening(): void {
    if (this.listening) return;
    this.listening = true;

    this.subscriber.on('message', (redisChannel: string, payload: string) => {
      const set = this.handlers.get(redisChannel);
      if (set === undefined || set.size === 0) return;

      let event: BusEvent;
      try {
        event = JSON.parse(payload) as BusEvent;
      } catch {
        // Something else is publishing on our namespace, or a version skew is
        // sending a shape we cannot read. Log and drop; do not crash.
        this.log.warn({ redisChannel }, 'dropped unparseable bus message');
        return;
      }

      for (const handler of [...set]) {
        // Each handler is isolated: one throwing must not stop the others from
        // seeing the event.
        void Promise.resolve()
          .then(() => handler(event))
          .catch((error: unknown) => {
            this.log.error(
              { redisChannel, type: event.type, err: String(error) },
              'bus handler threw',
            );
          });
      }
    });
  }

  async close(): Promise<void> {
    this.handlers.clear();
    // The connections themselves are closed by the composition root, which
    // owns them. Unsubscribing here stops delivery immediately without
    // reaching into a lifecycle this class does not manage.
    await this.subscriber.unsubscribe().catch(() => undefined);
  }
}
