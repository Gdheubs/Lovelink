import type { User, UserStatus } from '../../domain/entities/User.js';
import type { TrustEvent } from '../../domain/entities/TrustEvent.js';
import type { CreateUserInput, UserRepository } from '../../domain/ports/UserRepository.js';
import type { UserId } from '../../domain/values/ids.js';
import { projectTrustScore } from '../../domain/values/trust.js';
import { ConflictError, NotFoundError } from '../../domain/errors.js';

/**
 * ADAPTER (memory): UserRepository backed by two Maps.
 *
 * WHY IT MIRRORS THE REAL CONSTRAINTS
 * -----------------------------------
 * A fake that is more permissive than the real database is worse than no fake:
 * tests pass, production throws. So this implementation enforces the same
 * things the Postgres schema does — the unique index on `identifier`, and the
 * rule that `trust_score` is a projection of the ledger rather than a field
 * anyone may set.
 *
 * Entities are frozen on the way out. Without that, a caller mutating a
 * returned object would silently edit the "database", which is a class of bug
 * that cannot happen against a real one and would therefore never be found
 * until deploy.
 */
export class MemoryUserRepository implements UserRepository {
  private readonly byId = new Map<string, User>();
  private readonly byIdentifier = new Map<string, string>();
  private readonly ledger = new Map<string, TrustEvent[]>();

  async create(input: CreateUserInput): Promise<User> {
    if (this.byIdentifier.has(input.identifier)) {
      // Mirrors the unique index on users.identifier.
      throw new ConflictError('An account already exists for that contact.');
    }
    const user: User = Object.freeze({
      id: input.id,
      identifier: input.identifier,
      identifierKind: input.identifierKind,
      displayName: input.displayName,
      avatarSeed: input.avatarSeed,
      dob: input.dob,
      trustScore: 0,
      status: 'active' as UserStatus,
      createdAt: input.createdAt,
    });
    this.byId.set(user.id, user);
    this.byIdentifier.set(user.identifier, user.id);
    this.ledger.set(user.id, []);
    return user;
  }

  async findById(id: UserId): Promise<User | null> {
    return this.byId.get(id) ?? null;
  }

  async findByIdentifier(identifier: string): Promise<User | null> {
    const id = this.byIdentifier.get(identifier);
    return id === undefined ? null : (this.byId.get(id) ?? null);
  }

  async findManyByIds(ids: readonly UserId[]): Promise<readonly User[]> {
    const out: User[] = [];
    for (const id of ids) {
      const user = this.byId.get(id);
      if (user !== undefined) out.push(user);
    }
    return out;
  }

  async updateProfile(
    id: UserId,
    changes: { displayName?: string; avatarSeed?: string },
  ): Promise<User> {
    const existing = this.byId.get(id);
    if (existing === undefined) throw new NotFoundError('User');
    const updated: User = Object.freeze({
      ...existing,
      displayName: changes.displayName ?? existing.displayName,
      avatarSeed: changes.avatarSeed ?? existing.avatarSeed,
    });
    this.byId.set(id, updated);
    return updated;
  }

  async updateStatus(id: UserId, status: UserStatus): Promise<void> {
    const existing = this.byId.get(id);
    if (existing === undefined) throw new NotFoundError('User');
    this.byId.set(id, Object.freeze({ ...existing, status }));
  }

  /**
   * Append to the ledger and refresh the cached score in one synchronous step.
   * The Postgres adapter achieves the same atomicity with a transaction; here
   * it comes free, which is exactly the invariant the port describes.
   */
  async appendTrustEvent(event: TrustEvent): Promise<number> {
    const existing = this.byId.get(event.userId);
    if (existing === undefined) throw new NotFoundError('User');

    const events = this.ledger.get(event.userId) ?? [];
    events.push(event);
    this.ledger.set(event.userId, events);

    const trustScore = projectTrustScore(events.map((e) => e.delta));
    this.byId.set(event.userId, Object.freeze({ ...existing, trustScore }));
    return trustScore;
  }

  async listTrustEvents(userId: UserId, limit: number): Promise<readonly TrustEvent[]> {
    const events = this.ledger.get(userId) ?? [];
    return [...events]
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .slice(0, limit);
  }

  /** Test helper. Not part of the port. */
  clear(): void {
    this.byId.clear();
    this.byIdentifier.clear();
    this.ledger.clear();
  }
}
