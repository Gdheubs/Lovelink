import type { Room, RoomCategory } from '../../domain/entities/Room.js';
import type { User } from '../../domain/entities/User.js';
import type { Ports } from '../../domain/ports/index.js';
import {
  assertValidMaxSpeakers,
  DEFAULT_MAX_SPEAKERS,
  isRoomCategory,
  normalizeRoomTitle,
  slugify,
} from '../../domain/entities/Room.js';
import { canAct, DENIAL_MESSAGES } from '../../domain/rules/trustLadder.js';
import { asRoomId } from '../../domain/values/ids.js';
import { AuthorizationError, ConflictError, ValidationError } from '../../domain/errors.js';

/**
 * USE CASE: create a room.
 *
 * WHY SLUG COLLISION IS HANDLED HERE
 * ----------------------------------
 * `slugify` in the domain is pure and total — it does not know what already
 * exists. Uniqueness is a storage concern, so resolving a collision belongs in
 * the use case that owns the write. Two people creating "Late Night Talk" a
 * second apart is not an error worth showing anyone; they get
 * `late-night-talk` and `late-night-talk-2`.
 *
 * The retry loop is bounded and the fallback appends random characters rather
 * than looping forever, because an unbounded retry against a popular title is a
 * denial-of-service against ourselves.
 *
 * WHY THE CREATOR IS NOT AUTO-JOINED
 * ----------------------------------
 * Creating a room and being in it are different actions. A host who schedules a
 * room for later should not be marked present now, and `JoinRoom` is the single
 * place presence is established — duplicating that here would give us two code
 * paths that can disagree about what "joined" means.
 */
export interface CreateRoomInput {
  readonly title: string;
  readonly category: string;
  readonly maxSpeakers?: number;
  /** Cron expression for a recurring room. Phase 6 uses this; null for ad-hoc. */
  readonly scheduleCron?: string | null;
}

const MAX_SLUG_ATTEMPTS = 5;

export class CreateRoom {
  constructor(private readonly ports: Ports) {}

  async execute(host: User, input: CreateRoomInput): Promise<Room> {
    const standing = canAct(host);
    if (!standing.allowed) {
      // A restricted account may still listen and chat, but hosting puts
      // someone in charge of other people's safety.
      throw new AuthorizationError(
        DENIAL_MESSAGES[standing.reason ?? 'trust_restricted'],
        'TRUST_LADDER_VIOLATION',
      );
    }

    const title = normalizeRoomTitle(input.title);

    if (!isRoomCategory(input.category)) {
      throw new ValidationError('Choose a category for your room.');
    }

    const maxSpeakers = input.maxSpeakers ?? DEFAULT_MAX_SPEAKERS;
    assertValidMaxSpeakers(maxSpeakers);

    const scheduleCron = input.scheduleCron ?? null;
    const slug = await this.reserveSlug(title);

    const room = await this.ports.rooms.create({
      id: asRoomId(this.ports.ids.uuid()),
      slug,
      title,
      category: input.category as RoomCategory,
      hostUserId: host.id,
      isScheduled: scheduleCron !== null,
      scheduleCron,
      maxSpeakers,
      // A room is live the moment it exists unless it is scheduled for later.
      status: scheduleCron === null ? 'live' : 'scheduled',
      createdAt: this.ports.clock.now(),
    });

    this.ports.metrics.increment('room.created');
    this.ports.logger.info(
      { roomId: room.id, hostUserId: host.id, category: room.category },
      'room created',
    );

    return room;
  }

  /**
   * Find an unused slug.
   *
   * Note this is a check-then-write and therefore racy: two simultaneous
   * creations can both see `late-night-talk` as free. That race is CAUGHT, not
   * prevented — the unique index on `rooms.slug` is the real guarantee, and
   * `RoomRepository.create` translates the violation into a ConflictError. This
   * loop exists to make the common case produce a pretty slug, not to be the
   * safety mechanism.
   */
  private async reserveSlug(title: string): Promise<string> {
    const base = slugify(title);

    for (let attempt = 0; attempt < MAX_SLUG_ATTEMPTS; attempt += 1) {
      const candidate = attempt === 0 ? base : `${base}-${attempt + 1}`;
      if ((await this.ports.rooms.findBySlug(candidate)) === null) {
        return candidate;
      }
    }

    // A very popular title. Stop probing and take a random suffix, which is
    // effectively certain to be free in one go.
    const random = this.ports.ids.randomCode(5).toLowerCase();
    const candidate = `${base}-${random}`;

    if ((await this.ports.rooms.findBySlug(candidate)) !== null) {
      throw new ConflictError('Could not find a free address for that room title. Try another.');
    }
    return candidate;
  }
}
