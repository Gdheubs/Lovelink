import type { Surprise, SurpriseTheme } from '../../domain/entities/Surprise.js';
import type { User } from '../../domain/entities/User.js';
import type { Ports } from '../../domain/ports/index.js';
import {
  formatCode,
  isSurpriseTheme,
  normalizeCode,
  normalizeSurpriseMessage,
  normalizeTasks,
  SURPRISE_TTL_DAYS,
} from '../../domain/entities/Surprise.js';
import { canAct, DENIAL_MESSAGES } from '../../domain/rules/trustLadder.js';
import { LIMITS } from '../../domain/ports/RateLimiter.js';
import { TRUST_DELTAS } from '../../domain/values/trust.js';
import { asSurpriseId } from '../../domain/values/ids.js';
import {
  AuthorizationError,
  ConflictError,
  RateLimitError,
  ValidationError,
} from '../../domain/errors.js';

/**
 * USE CASE: create a surprise.
 *
 * WHY A CODE RATHER THAN AN ADDRESSEE
 * -----------------------------------
 * This is the icebreaker, and the whole point is that you can hand it to
 * someone you have just met WITHOUT either of you exposing contact details.
 * You met in a room; you have no way to reach them and should not need one.
 * A code you can read aloud is the entire mechanism.
 *
 * That is also why it is the lowest rung of the trust ladder — it requires no
 * relationship at all, and it is how one is started.
 *
 * THE CODE HAS TO SURVIVE BEING READ ALOUD AND TYPED BY HAND
 * ----------------------------------------------------------
 * Which pulls in two directions. Short enough to say over voice; long enough
 * that guessing is hopeless. The resolution:
 *
 *   - characters come from an UNAMBIGUOUS alphabet (no O/0, I/1/l, no U), so
 *     it cannot be misheard or mistyped into someone else's surprise;
 *   - they come from a CSPRNG, not `Math.random()` — the original LoveLink
 *     page used one of ten words plus four digits, a keyspace of 90,000 that a
 *     script could exhaust in minutes;
 *   - redemption is rate limited, which is the control that actually makes a
 *     short code safe;
 *   - and codes EXPIRE, so the guessable surface does not grow without bound.
 *
 * A collision is caught by the unique index and retried, because two people
 * creating a surprise in the same millisecond should not see an error.
 */
export interface CreateSurpriseInput {
  readonly theme: string;
  readonly message: string;
  /** Optional "sweet tasks" the sender leaves for the recipient. */
  readonly tasks?: readonly string[];
}

export interface CreateSurpriseResult {
  readonly surprise: Surprise;
  /** The shareable form, e.g. `LOVE-7K2M`. */
  readonly displayCode: string;
}

/** Enough attempts to make a genuine collision vanishingly unlikely. */
const MAX_CODE_ATTEMPTS = 5;

/** Characters after the theme word. 30^6 with a CSPRNG behind it. */
const CODE_LENGTH = 6;

export class CreateSurprise {
  constructor(private readonly ports: Ports) {}

  async execute(sender: User, input: CreateSurpriseInput): Promise<CreateSurpriseResult> {
    const standing = canAct(sender);
    if (!standing.allowed) {
      // A restricted account cannot send unsolicited messages to strangers,
      // which is exactly what a surprise is.
      throw new AuthorizationError(
        DENIAL_MESSAGES[standing.reason ?? 'trust_restricted'],
        'TRUST_LADDER_VIOLATION',
      );
    }

    // Bulk code generation is the abuse here — a script minting thousands of
    // codes to hand out indiscriminately.
    const limit = await this.ports.rateLimiter.check(
      `surprise:create:${sender.id}`,
      LIMITS.surpriseCreate.limit,
      LIMITS.surpriseCreate.windowSec,
    );
    if (!limit.allowed) {
      this.ports.metrics.increment('ratelimit.blocked');
      throw new RateLimitError('You have created a lot of surprises recently. Try again later.');
    }

    if (!isSurpriseTheme(input.theme)) {
      throw new ValidationError('Choose what this surprise is about.');
    }
    const theme: SurpriseTheme = input.theme;

    const message = normalizeSurpriseMessage(input.message);
    const tasks = normalizeTasks(input.tasks ?? []);

    const now = this.ports.clock.now();
    const expiresAt = new Date(now.getTime() + SURPRISE_TTL_DAYS * 24 * 60 * 60 * 1000);

    const surprise = await this.createWithUniqueCode({
      senderId: sender.id,
      theme,
      message,
      tasks,
      createdAt: now,
      expiresAt,
    });

    await this.ports.users
      .appendTrustEvent({
        userId: sender.id,
        delta: TRUST_DELTAS.surprise_sent,
        reason: 'surprise_sent',
        context: surprise.id,
        createdAt: now,
      })
      .catch(() => undefined);

    this.ports.metrics.increment('surprise.created');
    this.ports.logger.info({ surpriseId: surprise.id, senderId: sender.id, theme }, 'surprise created');

    return { surprise, displayCode: formatCode(surprise.code) };
  }

  /**
   * Mint a code, retrying on collision.
   *
   * The unique index is the real guarantee; this loop only makes the common
   * case produce a code without an error. A caller who exhausts the attempts is
   * either extraordinarily unlucky or the keyspace is misconfigured, and both
   * deserve to be visible rather than retried forever.
   */
  private async createWithUniqueCode(input: {
    senderId: User['id'];
    theme: SurpriseTheme;
    message: string;
    tasks: ReturnType<typeof normalizeTasks>;
    createdAt: Date;
    expiresAt: Date;
  }): Promise<Surprise> {
    for (let attempt = 0; attempt < MAX_CODE_ATTEMPTS; attempt += 1) {
      // The theme word makes the code speakable and gives a hint of what is
      // coming, which is half the fun of handing one over.
      const word = THEME_WORDS[input.theme];
      const code = normalizeCode(`${word}${this.ports.ids.randomCode(CODE_LENGTH)}`);

      try {
        return await this.ports.surprises.create({
          id: asSurpriseId(this.ports.ids.uuid()),
          code,
          senderId: input.senderId,
          theme: input.theme,
          message: input.message,
          tasks: input.tasks,
          createdAt: input.createdAt,
          expiresAt: input.expiresAt,
        });
      } catch (error) {
        // Only a code collision is retryable; anything else is a real failure.
        const isCollision = error instanceof ConflictError;
        if (!isCollision || attempt === MAX_CODE_ATTEMPTS - 1) throw error;

        this.ports.logger.debug({ attempt }, 'surprise code collision; retrying');
      }
    }

    throw new ConflictError('Could not create a surprise right now. Please try again.');
  }
}

/**
 * The word each theme's code starts with.
 *
 * Chosen to be short, unambiguous when spoken, and drawn from the same
 * restricted alphabet as the random part — so the whole code can be read out
 * without spelling anything.
 */
const THEME_WORDS: Readonly<Record<SurpriseTheme, string>> = Object.freeze({
  love: 'LOVE',
  sorry: 'SRRY',
  miss: 'MISS',
  thinking_of_you: 'HEYA',
  congrats: 'YAYY',
});
