import type { IdentifierKind } from '../../domain/entities/User.js';
import type { Logger } from '../../domain/ports/Logger.js';
import type { DeliveryResult, NotificationSender } from '../../domain/ports/NotificationSender.js';

export interface SentNotification {
  readonly identifier: string;
  readonly kind: IdentifierKind;
  readonly type: 'login_code' | 'surprise_notice';
  readonly body: string;
}

/**
 * ADAPTER (memory): logs notifications instead of sending them.
 *
 * WHY: this is what makes `npm run dev:memory` able to complete a real signup
 * with no Twilio account, no SMTP server and no money. The login code appears
 * in the terminal, the developer types it into the UI, and the whole auth flow
 * is exercised end to end.
 *
 * THE ONE DANGEROUS THING here is printing a login code, so it is guarded:
 * `echoCodes` defaults to false and the composition root only enables it
 * outside production (config rejects `AUTH_ECHO_CODE` in production entirely).
 * When disabled, the log records that a code was sent and to whom, never what
 * it was.
 */
export class MemoryNotificationSender implements NotificationSender {
  /** Everything "sent", for test assertions. */
  readonly sent: SentNotification[] = [];

  constructor(
    private readonly logger: Logger,
    private readonly echoCodes = false,
  ) {}

  async sendLoginCode(
    identifier: string,
    kind: IdentifierKind,
    code: string,
  ): Promise<DeliveryResult> {
    this.sent.push({ identifier, kind, type: 'login_code', body: code });

    if (this.echoCodes) {
      this.logger.info(
        { identifier, kind, code },
        'DEV ONLY: login code issued (AUTH_ECHO_CODE is on)',
      );
    } else {
      this.logger.info({ identifier: maskIdentifier(identifier), kind }, 'login code issued');
    }

    return { delivered: true, providerRef: `memory-${this.sent.length}`, failureReason: null };
  }

  async sendSurpriseNotice(
    identifier: string,
    kind: IdentifierKind,
    fromDisplayName: string,
  ): Promise<DeliveryResult> {
    this.sent.push({ identifier, kind, type: 'surprise_notice', body: fromDisplayName });
    this.logger.info({ identifier: maskIdentifier(identifier), kind }, 'surprise notice queued');
    return { delivered: true, providerRef: `memory-${this.sent.length}`, failureReason: null };
  }

  /** The most recent login code sent to an identifier. Test/dev helper. */
  lastCodeFor(identifier: string): string | undefined {
    for (let i = this.sent.length - 1; i >= 0; i -= 1) {
      const entry = this.sent[i]!;
      if (entry.identifier === identifier && entry.type === 'login_code') return entry.body;
    }
    return undefined;
  }

  clear(): void {
    this.sent.length = 0;
  }
}

/**
 * Show enough of an identifier to support a user, not enough to contact them.
 * Applied to every log line so that a log export is not a contact list.
 */
export function maskIdentifier(identifier: string): string {
  const atIndex = identifier.indexOf('@');
  if (atIndex > 0) {
    const name = identifier.slice(0, atIndex);
    const domain = identifier.slice(atIndex);
    return `${name.slice(0, 2)}***${domain}`;
  }
  return identifier.length <= 4 ? '***' : `***${identifier.slice(-4)}`;
}
