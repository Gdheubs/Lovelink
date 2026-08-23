import type { PushSubscription } from '../../domain/ports/PushSender.js';
import type {
  PushSubscriptionRepository,
  StoredPushSubscription,
} from '../../domain/ports/PushSubscriptionRepository.js';
import type { UserId } from '../../domain/values/ids.js';
import { asUserId } from '../../domain/values/ids.js';
import type { Database } from './db.js';

/**
 * ADAPTER: push subscriptions over Postgres.
 *
 * The interesting statement is `save`, and the interesting part of it is that
 * the upsert MOVES a device rather than duplicating it — see the note there.
 */

interface Row {
  endpoint: string;
  user_id: string;
  p256dh: string;
  auth: string;
  created_at: Date;
  last_seen_at: Date | null;
}

const COLUMNS = `endpoint, user_id, p256dh, auth, created_at, last_seen_at`;

function toEntity(row: Row): StoredPushSubscription {
  return {
    endpoint: row.endpoint,
    userId: asUserId(row.user_id),
    p256dh: row.p256dh,
    auth: row.auth,
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
  };
}

export class PostgresPushSubscriptionRepository implements PushSubscriptionRepository {
  constructor(private readonly db: Database) {}

  async save(input: PushSubscription & { userId: UserId; createdAt: Date }): Promise<void> {
    /*
     * ON CONFLICT (endpoint) DO UPDATE — the upsert that moves a device.
     *
     * A shared laptop returns the SAME endpoint after one person signs out and
     * another signs in. Updating `user_id` is what stops the first person's
     * notifications arriving on a screen that is no longer theirs; inserting a
     * second row would notify both, which is a privacy failure rather than a
     * duplicate-delivery bug.
     *
     * The keys are refreshed too: a browser may rotate them for an endpoint it
     * keeps, and stale keys mean every payload fails to decrypt — a failure the
     * push service reports as success, because from its side the delivery
     * worked.
     */
    await this.db.query(
      `INSERT INTO push_subscriptions (endpoint, user_id, p256dh, auth, created_at)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (endpoint) DO UPDATE
         SET user_id = EXCLUDED.user_id,
             p256dh  = EXCLUDED.p256dh,
             auth    = EXCLUDED.auth`,
      [input.endpoint, input.userId, input.p256dh, input.auth, input.createdAt],
    );
  }

  async listForUser(userId: UserId): Promise<readonly StoredPushSubscription[]> {
    const rows = await this.db.query<Row>(
      `SELECT ${COLUMNS} FROM push_subscriptions WHERE user_id = $1 ORDER BY created_at ASC`,
      [userId],
    );
    return rows.map(toEntity);
  }

  async remove(endpoint: string): Promise<void> {
    await this.db.query(`DELETE FROM push_subscriptions WHERE endpoint = $1`, [endpoint]);
  }

  async removeMany(endpoints: readonly string[]): Promise<void> {
    if (endpoints.length === 0) return;
    await this.db.query(`DELETE FROM push_subscriptions WHERE endpoint = ANY($1::text[])`, [
      endpoints,
    ]);
  }

  async touch(endpoint: string, at: Date): Promise<void> {
    await this.db.query(`UPDATE push_subscriptions SET last_seen_at = $2 WHERE endpoint = $1`, [
      endpoint,
      at,
    ]);
  }
}
