import type { PublicProfile } from '../../domain/entities/User.js';
import type { Relationship } from '../../domain/entities/Relationship.js';
import type { User } from '../../domain/entities/User.js';
import type { Ports } from '../../domain/ports/index.js';
import type { UserId } from '../../domain/values/ids.js';
import { toPublicProfile } from '../../domain/entities/User.js';
import { ladderView, type LadderView } from '../../domain/rules/trustLadder.js';

/**
 * USE CASE: everyone this person is connected to, and how far.
 *
 * WHAT THIS SCREEN IS FOR
 * -----------------------
 * It is the answer to "who did I meet?", which in a drop-in voice product is a
 * genuinely hard question — you spoke to someone for twenty minutes and never
 * learned anything you could search for. So this list is the only durable
 * record of a connection, and it has to carry enough to recognise a person by.
 *
 * INCOMING REQUESTS ARE SEPARATED FROM OPEN THREADS, deliberately. They demand
 * a decision; mixing them into the same list either buries them or nags. And a
 * request the USER sent is not shown as pending at all — see below.
 *
 * WHY OUTGOING REQUESTS ARE NOT LISTED
 * ------------------------------------
 * A pending request you sent tells you something you are not entitled to know:
 * that the other person has not answered. Surfacing it invites a second ask, or
 * a "why haven't you replied", which is precisely the pressure the request/
 * accept design exists to prevent. It stays invisible until they accept.
 *
 * THE LADDER VIEW IS FOR RENDERING, NOT FOR AUTHORIZATION
 * -------------------------------------------------------
 * `canSendDm` / `canCall` here decide which buttons exist. Every one of those
 * actions re-checks the same rule server-side when invoked, because a client
 * can send whatever it likes regardless of what we rendered.
 */
export interface Connection {
  readonly user: PublicProfile;
  readonly state: Relationship['state'];
  readonly since: string;
  readonly can: LadderView;
}

export interface ConnectionsView {
  /** Threads that are open (including one currently in a call). */
  readonly connections: readonly Connection[];
  /** People waiting on an answer FROM this user. */
  readonly incomingRequests: readonly Connection[];
}

/** Enough for the screen; the ladder means nobody accumulates thousands. */
const MAX_CONNECTIONS = 200;

export class ListConnections {
  constructor(private readonly ports: Ports) {}

  async execute(viewer: User): Promise<ConnectionsView> {
    const relationships = await this.ports.relationships.listForUser(
      viewer.id,
      ['dm_requested', 'dm_open', 'call_open'],
      MAX_CONNECTIONS,
    );

    if (relationships.length === 0) {
      return { connections: [], incomingRequests: [] };
    }

    // One batch load rather than a query per row. The repository skips ids it
    // cannot find, so a deleted account simply drops out of the list instead of
    // producing an entry with no name.
    const otherIds = relationships.map((rel) => this.otherParty(viewer.id, rel));
    const others = await this.ports.users.findManyByIds(otherIds);
    const byId = new Map(others.map((user) => [user.id, user]));

    const connections: Connection[] = [];
    const incomingRequests: Connection[] = [];

    for (const relationship of relationships) {
      const other = byId.get(this.otherParty(viewer.id, relationship));
      if (other === undefined) continue;

      const entry: Connection = {
        user: toPublicProfile(other),
        state: relationship.state,
        since: relationship.updatedAt.toISOString(),
        can: ladderView({
          actor: viewer,
          target: other,
          relationship,
          // Irrelevant once a relationship exists: `canRequestDm` is already
          // false for every state in this list, so no room lookup is needed.
          haveSharedRoomSession: false,
        }),
      };

      if (relationship.state === 'dm_requested') {
        // Only the person who was ASKED sees a pending request.
        if (relationship.requestedBy !== null && relationship.requestedBy !== viewer.id) {
          incomingRequests.push(entry);
        }
        continue;
      }

      connections.push(entry);
    }

    return { connections, incomingRequests };
  }

  /**
   * Rows are stored with `userA` as the lexicographically smaller id, so which
   * column holds "the other person" depends on where the viewer sorted.
   */
  private otherParty(viewerId: UserId, relationship: Relationship): UserId {
    return relationship.userA === viewerId ? relationship.userB : relationship.userA;
  }
}
