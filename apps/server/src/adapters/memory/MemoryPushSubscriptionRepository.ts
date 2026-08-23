import type { PushSubscription } from '../../domain/ports/PushSender.js';
import type {
  PushSubscriptionRepository,
  StoredPushSubscription,
} from '../../domain/ports/PushSubscriptionRepository.js';
import type { UserId } from '../../domain/values/ids.js';

/**
 * ADAPTER (memory): push subscriptions.
 *
 * Keyed on the endpoint, exactly as the table is — which is what makes the
 * shared-device behaviour identical: saving an existing endpoint under a new
 * user MOVES it rather than adding a second row, so the previous owner stops
 * being notified on a machine they signed out of.
 *
 * Getting that wrong here would make the fake more forgiving than Postgres, and
 * the bug would only appear in production on somebody's family laptop.
 */
export class MemoryPushSubscriptionRepository implements PushSubscriptionRepository {
  private readonly byEndpoint = new Map<string, StoredPushSubscription>();

  async save(input: PushSubscription & { userId: UserId; createdAt: Date }): Promise<void> {
    const existing = this.byEndpoint.get(input.endpoint);

    this.byEndpoint.set(input.endpoint, {
      endpoint: input.endpoint,
      userId: input.userId,
      p256dh: input.p256dh,
      auth: input.auth,
      // The original registration time survives a re-save, matching the
      // Postgres upsert which does not touch `created_at`.
      createdAt: existing?.createdAt ?? input.createdAt,
      lastSeenAt: existing?.lastSeenAt ?? null,
    });
  }

  async listForUser(userId: UserId): Promise<readonly StoredPushSubscription[]> {
    return [...this.byEndpoint.values()]
      .filter((entry) => entry.userId === userId)
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  }

  async remove(endpoint: string): Promise<void> {
    this.byEndpoint.delete(endpoint);
  }

  async removeMany(endpoints: readonly string[]): Promise<void> {
    for (const endpoint of endpoints) this.byEndpoint.delete(endpoint);
  }

  async touch(endpoint: string, at: Date): Promise<void> {
    const existing = this.byEndpoint.get(endpoint);
    if (existing === undefined) return;
    this.byEndpoint.set(endpoint, { ...existing, lastSeenAt: at });
  }

  /** Test helper. Not part of the port. */
  clear(): void {
    this.byEndpoint.clear();
  }
}
