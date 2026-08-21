import type { Ports } from '../../domain/ports/index.js';

/**
 * Cross-process ban enforcement.
 *
 * WHY THIS EXISTS AT ALL
 * ----------------------
 * `BanUser` already severs the banned user's sockets — but only the ones on
 * the process that handled the ban. The moment the API and the realtime server
 * are separate processes (architecture §3, ADR 0005), the moderator's HTTP
 * request lands on one machine while the abusive user's websocket is held by
 * another. A direct function call cannot reach it; a message can.
 *
 * So this subscriber runs on every process that holds sockets, and turns a
 * `user.banned` fact into a local disconnect.
 *
 * IT IS BEST-EFFORT, AND THAT IS ACCOUNTED FOR
 * --------------------------------------------
 * Redis pub/sub is at-most-once: a subscriber that is momentarily disconnected
 * never receives the message, and there is no replay. That would be alarming
 * if this were the only enforcement, so it is not:
 *
 *   - socket connect checks account status  — catches the reconnect
 *   - token refresh checks account status   — catches the long-lived credential
 *   - every socket event re-reads the user  — catches the still-open session
 *
 * This subscriber makes enforcement IMMEDIATE. Those three make it CERTAIN.
 * The worst case if this message is lost is that a banned user stays connected
 * until their next action, which is typically milliseconds.
 *
 * IDEMPOTENT: disconnecting an already-disconnected user is a no-op, so a
 * duplicate delivery is harmless.
 */
export interface ModerationSubscriberDeps {
  readonly ports: Ports;
}

export async function startModerationSubscriber(
  deps: ModerationSubscriberDeps,
): Promise<() => Promise<void>> {
  const { ports } = deps;
  const log = ports.logger.child({ component: 'moderation-subscriber' });

  const unsubscribe = await ports.bus.subscribe('moderation', async (event) => {
    if (event.type !== 'user.banned') return;

    try {
      // Sever every connection this user holds ON THIS PROCESS. The transport
      // emits `user:banned` first so the client can show a reason rather than
      // a mystery reconnect loop, then closes the socket.
      await ports.realtime.disconnectUser(event.userId, event.reason);

      log.warn(
        { userId: event.userId, permanent: event.permanent },
        'severed sockets for a banned user',
      );
    } catch (error) {
      // A subscriber that throws must not take down the publisher — which, in
      // production, is a moderator's ban request.
      log.error(
        { userId: event.userId, err: String(error) },
        'failed to sever sockets for a banned user',
      );
    }
  });

  return unsubscribe;
}
