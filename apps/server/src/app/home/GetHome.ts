import type { Room } from '../../domain/entities/Room.js';
import type { User } from '../../domain/entities/User.js';
import type { Ports } from '../../domain/ports/index.js';
import type { Intent } from '../../domain/values/presenceIntent.js';
import type { RoomTemperature } from '../../domain/values/roomTemperature.js';
import { INTENT_TTL_SECONDS, isIntent } from '../../domain/values/presenceIntent.js';
import { ValidationError } from '../../domain/errors.js';

/**
 * USE CASE: what someone sees when they open the app.
 *
 * WHY THIS IS A DASHBOARD AND NOT A FEED
 * --------------------------------------
 * A feed's job is to keep you there. This screen's job is to get you into a
 * room and then be gone — so it is a short, finite list that ends, with no
 * infinite scroll, no counts to grow, and nothing to refresh for.
 *
 * It asks one question — what do you want tonight — and answers it. Someone who
 * opens the app knowing what they want should be in a room in two taps.
 *
 * WHY THE GREETING IS BY TIME OF DAY
 * ----------------------------------
 * The product is mostly used late, and "Good evening" at 2am is subtly wrong in
 * a way that matters here: it says the app has not noticed what kind of hour
 * this is for you. The small acknowledgement is most of what makes a screen
 * feel like a room rather than a page.
 */

export type Greeting = 'morning' | 'afternoon' | 'evening' | 'late';

export interface HomeRoom {
  readonly id: string;
  readonly slug: string;
  readonly title: string;
  readonly category: string;
  readonly temperature: RoomTemperature;
  /** People in it right now. The only number on the screen. */
  readonly listening: number;
  readonly speaking: number;
  /** One line about how it feels, or null when too few have said. */
  readonly pulse: string | null;
  /** True when this room matches what they said they wanted. */
  readonly matchesIntent: boolean;
}

export interface HomeView {
  readonly greeting: Greeting;
  readonly displayName: string;
  /** What they said they were here for, if they have said. */
  readonly intent: Intent | null;
  /** Rooms with someone in them, best match first. */
  readonly live: readonly HomeRoom[];
  /** Rooms nobody is in yet — shown only when there is little else. */
  readonly quiet: readonly HomeRoom[];
  /** Consecutive nights, for the one line about it on this screen. */
  readonly nights: number;
}

/** Enough to choose from; few enough that the screen ends. */
const LIVE_LIMIT = 6;
const QUIET_LIMIT = 3;

export class GetHome {
  constructor(private readonly ports: Ports) {}

  async execute(viewer: User): Promise<HomeView> {
    const now = this.ports.clock.now();

    const [availability, rooms] = await Promise.all([
      this.ports.availability.get(viewer.id),
      this.ports.rooms.list({ status: 'live', limit: 40, offset: 0 }),
    ]);

    // Occupancy comes from live presence, never from the durable membership
    // mirror — someone who left an hour ago still has a row there, and a home
    // screen advertising a room that is actually empty is the fastest way to
    // lose someone's trust in the whole list.
    const counted = await Promise.all(
      rooms.map(async (room) => this.describe(room, availability.intent)),
    );

    const live = counted
      .filter((room) => room.listening + room.speaking > 0)
      .sort(byRelevance)
      .slice(0, LIVE_LIMIT);

    const quiet = counted
      .filter((room) => room.listening + room.speaking === 0)
      .slice(0, QUIET_LIMIT);

    return {
      greeting: greetingFor(now, viewer.timeZone),
      displayName: viewer.displayName,
      intent: availability.intent,
      live,
      quiet,
      nights: viewer.streak.current,
    };
  }

  private async describe(room: Room, intent: Intent | null): Promise<HomeRoom> {
    const members = await this.ports.presence.getRoomMembers(room.id);

    const speaking = members.filter((m) => m.role === 'speaker' || m.role === 'host').length;

    return {
      id: room.id,
      slug: room.slug,
      title: room.title,
      category: room.category,
      temperature: room.temperature,
      listening: members.length - speaking,
      speaking,
      // The pulse is deliberately absent here rather than fetched: it needs a
      // per-room read and this screen shows six rooms. It appears once someone
      // is actually looking at a room, where one read is proportionate.
      pulse: null,
      matchesIntent: intent !== null && suitsIntent(room.temperature, members.length, intent),
    };
  }
}

/**
 * USE CASE: say what you are here for tonight.
 *
 * Deliberately trivial, and deliberately its own use case rather than a field
 * on a profile update: it expires, it shapes what someone is shown, and it is
 * the one thing on this screen that is about right now.
 */
export class SetIntent {
  constructor(private readonly ports: Ports) {}

  async execute(user: User, intent: string): Promise<void> {
    if (!isIntent(intent)) {
      throw new ValidationError('That is not something we can show you rooms for.');
    }

    await this.ports.availability.setIntent(user.id, intent, INTENT_TTL_SECONDS);
  }
}

/** Clear it, for someone who would rather not say. */
export class ClearIntent {
  constructor(private readonly ports: Ports) {}

  async execute(user: User): Promise<void> {
    await this.ports.availability.clearIntent(user.id);
  }
}

/**
 * Whether a room suits what someone said they wanted.
 *
 * A HAND-WRITTEN RULE, NOT A RECOMMENDATION ALGORITHM, and that is a product
 * decision rather than a shortcut. The spec puts recommendation engines out of
 * scope, and a learned one here would optimise for time-in-app — which for this
 * product is the wrong thing to be good at.
 *
 * What this does instead is take someone at their word: they said they wanted
 * to listen, so quiet rooms first. It is legible, it is arguable, and anyone
 * can read it and say whether it is right.
 */
function suitsIntent(temperature: RoomTemperature, occupancy: number, intent: Intent): boolean {
  switch (intent) {
    case 'listen':
      // Somewhere with enough people that nobody notices you not talking.
      return temperature === 'quiet' || occupancy >= 6;
    case 'talk':
      return temperature !== 'quiet' && occupancy > 0;
    case 'connect':
      // Small enough that a conversation includes everyone.
      return occupancy > 0 && occupancy <= 6;
    case 'think':
      return temperature === 'deep';
    case 'meet':
      return temperature !== 'quiet' && occupancy > 0;
  }
}

/**
 * Matching rooms first, then the busiest.
 *
 * NOT "most active" alone. Sorting purely by headcount makes one room win every
 * night and every other room die — the rich-get-richer dynamic that turns a
 * place with many rooms into a place with one.
 */
function byRelevance(a: HomeRoom, b: HomeRoom): number {
  if (a.matchesIntent !== b.matchesIntent) return a.matchesIntent ? -1 : 1;
  return b.listening + b.speaking - (a.listening + a.speaking);
}

/**
 * Which part of the day it is, where THEY are.
 *
 * Uses the same timezone the streak is counted in, so a person's day begins and
 * ends in one place. "Late" is its own greeting because this product is mostly
 * used then, and being met with "good evening" at 3am is a small failure to
 * notice something.
 */
function greetingFor(instant: Date, timeZone: string): Greeting {
  let hour: number;
  try {
    hour = Number(
      new Intl.DateTimeFormat('en-US', {
        timeZone,
        hour: '2-digit',
        hour12: false,
      }).format(instant),
    );
  } catch {
    hour = instant.getUTCHours();
  }

  // Guard against a runtime rendering midnight as 24.
  hour = hour % 24;

  if (hour >= 23 || hour < 5) return 'late';
  if (hour < 12) return 'morning';
  if (hour < 18) return 'afternoon';
  return 'evening';
}
