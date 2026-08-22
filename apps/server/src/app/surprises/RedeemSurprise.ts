import type { Surprise, SurpriseMood } from '../../domain/entities/Surprise.js';
import type { User } from '../../domain/entities/User.js';
import type { Ports } from '../../domain/ports/index.js';
import type { SurpriseId } from '../../domain/values/ids.js';
import {
  formatCode,
  isSurpriseMood,
  isExpired,
  normalizeCode,
} from '../../domain/entities/Surprise.js';
import { revealMessage } from '../../domain/values/surpriseMessages.js';
import { toPublicProfile } from '../../domain/entities/User.js';
import { LIMITS } from '../../domain/ports/RateLimiter.js';
import { TRUST_DELTAS } from '../../domain/values/trust.js';
import {
  ConflictError,
  NotFoundError,
  RateLimitError,
  ValidationError,
} from '../../domain/errors.js';

/**
 * USE CASE: open a surprise.
 *
 * THE RATE LIMIT IS THE SECURITY CONTROL, NOT THE CODE LENGTH
 * -----------------------------------------------------------
 * A six-character code over a thirty-character alphabet is ~729 million
 * combinations, which sounds ample and is not, on its own, the thing keeping
 * surprises private — an unthrottled attacker works through a keyspace far
 * larger than that.
 *
 * What actually makes it safe is that redemption attempts are limited PER USER
 * AND PER IP, so guessing costs an attacker orders of magnitude more time than
 * it is worth. The short code exists because it has to be read aloud; the limit
 * is what buys that affordance.
 *
 * A WRONG CODE AND AN EXPIRED CODE LOOK THE SAME
 * ----------------------------------------------
 * Both return the same "we could not find that" message. Distinguishing them
 * would tell a guesser which codes had once existed, which is exactly the
 * signal that turns brute force from hopeless into merely slow.
 *
 * REDEMPTION IS A COMPARE-AND-SET
 * -------------------------------
 * `redeem` sets recipient, mood and `openedAt` atomically and only if unopened,
 * so two people racing on a shared code produce exactly one winner. The loser
 * is told it has already been opened, which is true and unhelpful to an
 * attacker.
 */
export interface RedeemSurpriseInput {
  readonly code: string;
  /**
   * How the RECIPIENT is feeling, chosen at the moment they open it.
   *
   * The sender picked the theme hours ago and cannot know this; the mood is
   * what lets one message meet the reader where they actually are.
   */
  readonly mood: string;
  readonly ip: string;
}

export interface RevealedSurprise {
  readonly id: SurpriseId;
  readonly displayCode: string;
  readonly theme: Surprise['theme'];
  readonly mood: SurpriseMood;
  /** The prepared message for this theme and mood. */
  readonly reveal: string;
  /** What the sender wrote themselves. */
  readonly personalMessage: string;
  readonly tasks: readonly { text: string; done: boolean }[];
  readonly from: ReturnType<typeof toPublicProfile>;
  readonly openedAt: string;
}

export class RedeemSurprise {
  constructor(private readonly ports: Ports) {}

  async execute(recipient: User, input: RedeemSurpriseInput): Promise<RevealedSurprise> {
    if (!isSurpriseMood(input.mood)) {
      throw new ValidationError('Tell us how you are feeling first.');
    }
    const mood: SurpriseMood = input.mood;

    // Consumed BEFORE the lookup, per user and per IP. This is the control
    // that makes a short, speakable code viable at all.
    await this.enforceLimit(`surprise:redeem:user:${recipient.id}`);
    await this.enforceLimit(`surprise:redeem:ip:${input.ip}`);

    // Normalised aggressively: "love 7k2m", "LOVE-7K2M" and "Love7k2m" are the
    // same code, because someone is reading it off a screen.
    const code = normalizeCode(input.code);
    if (code.length === 0) {
      throw new ValidationError('Enter the code you were given.');
    }

    const existing = await this.ports.surprises.findByCode(code);
    const now = this.ports.clock.now();

    // One message for "no such code" and for "expired". See the note above.
    if (existing === null || isExpired(existing, now)) {
      throw new NotFoundError('That surprise');
    }

    if (existing.senderId === recipient.id) {
      throw new ConflictError('That is the surprise you sent. Share the code with someone else.');
    }

    // Atomic claim. Returns null when someone else got there first, or when it
    // was already open.
    const claimed = await this.ports.surprises.redeem(code, recipient.id, mood, now);

    if (claimed === null) {
      throw new ConflictError(
        'That surprise has already been opened.',
        'ALREADY_REDEEMED',
      );
    }

    const sender = await this.ports.users.findById(claimed.senderId);
    if (sender === null) throw new NotFoundError('The sender');

    // Both parties gain a little standing: one for sending something, one for
    // the surprise having actually reached a person.
    await Promise.all([
      this.ports.users
        .appendTrustEvent({
          userId: recipient.id,
          delta: TRUST_DELTAS.surprise_redeemed,
          reason: 'surprise_redeemed',
          context: claimed.id,
          createdAt: now,
        })
        .catch(() => undefined),
      this.notifySender(sender, recipient, claimed),
    ]);

    this.ports.metrics.increment('surprise.redeemed');
    this.ports.logger.info(
      { surpriseId: claimed.id, senderId: sender.id, recipientId: recipient.id, mood },
      'surprise redeemed',
    );

    return {
      id: claimed.id,
      displayCode: formatCode(claimed.code),
      theme: claimed.theme,
      mood,
      reveal: revealMessage(claimed.theme, mood, sender.displayName),
      personalMessage: claimed.message,
      tasks: claimed.tasks.map((task) => ({ text: task.text, done: task.done })),
      from: toPublicProfile(sender),
      openedAt: now.toISOString(),
    };
  }

  /**
   * Tell the sender their surprise landed.
   *
   * Deliberately does NOT say how the recipient was feeling. The mood is a
   * private disclosure made to the app in order to choose a message, not a
   * message to the sender — "they opened your surprise and they are sad" is
   * information the recipient did not agree to share.
   */
  private async notifySender(
    sender: User,
    recipient: User,
    surprise: Surprise,
  ): Promise<void> {
    await this.ports.realtime.emitToUser(sender.id, 'surprise:received', {
      surpriseId: surprise.id,
      from: recipient.displayName,
    });
  }

  private async enforceLimit(key: string): Promise<void> {
    const result = await this.ports.rateLimiter.check(
      key,
      LIMITS.surpriseRedeem.limit,
      LIMITS.surpriseRedeem.windowSec,
    );
    if (!result.allowed) {
      this.ports.metrics.increment('ratelimit.blocked');
      throw new RateLimitError('Too many attempts. Check the code and try again in a while.');
    }
  }
}

/**
 * USE CASE: tick off one of the sender's "sweet tasks".
 *
 * Only the RECIPIENT may do this — they are the one the tasks were left for.
 * The sender watching a checklist they can edit themselves would be a strange
 * kind of pressure.
 */
export class ToggleSurpriseTask {
  constructor(private readonly ports: Ports) {}

  async execute(
    user: User,
    input: { surpriseId: SurpriseId; taskIndex: number; done: boolean },
  ): Promise<Surprise> {
    const surprise = await this.ports.surprises.findById(input.surpriseId);
    if (surprise === null) throw new NotFoundError('That surprise');

    if (surprise.recipientId !== user.id) {
      // Including the sender. Not found rather than forbidden: whether a
      // surprise exists is not something to confirm to someone who cannot see
      // it.
      throw new NotFoundError('That surprise');
    }

    return this.ports.surprises.setTaskDone(input.surpriseId, input.taskIndex, input.done);
  }
}
