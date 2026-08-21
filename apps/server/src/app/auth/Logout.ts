import type { Ports } from '../../domain/ports/index.js';
import type { UserId } from '../../domain/values/ids.js';

/**
 * USE CASE: end a session.
 *
 * WHY IT TAKES A SESSION ID AND NOT JUST A USER
 * ---------------------------------------------
 * Signing out on a phone must not sign out the laptop. Sessions are per-login
 * (see VerifyLoginCode), so revoking one leaves the others alone. `allDevices`
 * exists for the "I think someone has my account" case, which is a different
 * user intent and deserves a different button.
 *
 * WHY IT ALSO DISCONNECTS SOCKETS
 * -------------------------------
 * Revoking a token stops the NEXT connection; it does nothing about the one
 * already open, because sockets authenticate once at connect (architecture §3).
 * A user who signs out and watches their old tab keep receiving messages would
 * be right to consider that a bug.
 *
 * IDEMPOTENT: logging out twice, or logging out a session that has already
 * expired, succeeds quietly. There is no useful error to report and no caller
 * who could act on one.
 */
export interface LogoutInput {
  readonly userId: UserId;
  readonly sessionId: string;
  /** Revoke every session, not just this one. */
  readonly allDevices?: boolean;
}

export class Logout {
  constructor(private readonly ports: Ports) {}

  async execute(input: LogoutInput): Promise<void> {
    if (input.allDevices === true) {
      await this.ports.tokens.revokeAllSessions(input.userId);
      await this.ports.realtime.disconnectUser(input.userId, 'signed out');
      this.ports.logger.info({ userId: input.userId }, 'signed out of all devices');
      return;
    }

    await this.ports.tokens.revokeSession(input.sessionId);

    // NOTE: this disconnects every socket for the user, not only this session's.
    // The transport addresses connections per user, not per session — a
    // deliberate simplification, because the alternative (tracking which socket
    // belongs to which session) buys very little: the other devices simply
    // reconnect with their still-valid tokens, while this one cannot.
    await this.ports.realtime.disconnectUser(input.userId, 'signed out');

    this.ports.logger.info({ userId: input.userId, sessionId: input.sessionId }, 'signed out');
  }
}
