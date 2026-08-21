import type { Surprise, SurpriseMood } from '../../domain/entities/Surprise.js';
import { isExpired } from '../../domain/entities/Surprise.js';
import type {
  CreateSurpriseInput,
  SurpriseRepository,
} from '../../domain/ports/SurpriseRepository.js';
import type { SurpriseId, UserId } from '../../domain/values/ids.js';
import { ConflictError, NotFoundError, ValidationError } from '../../domain/errors.js';

/**
 * ADAPTER (memory): SurpriseRepository.
 *
 * THE POINT OF INTEREST is `redeem`, which the port defines as an atomic
 * compare-and-set. JavaScript's single-threaded execution gives that for free
 * here as long as the check and the write happen with no `await` between them —
 * so they do, and this comment exists to stop someone helpfully inserting one.
 */
export class MemorySurpriseRepository implements SurpriseRepository {
  private readonly byId = new Map<string, Surprise>();
  private readonly byCode = new Map<string, string>();

  constructor(private readonly nowFn: () => Date) {}

  async create(input: CreateSurpriseInput): Promise<Surprise> {
    if (this.byCode.has(input.code)) {
      throw new ConflictError('That code is already in use.');
    }
    const surprise: Surprise = Object.freeze({
      id: input.id,
      code: input.code,
      senderId: input.senderId,
      recipientId: null,
      theme: input.theme,
      message: input.message,
      tasks: input.tasks,
      moodSelected: null,
      openedAt: null,
      createdAt: input.createdAt,
      expiresAt: input.expiresAt,
    });
    this.byId.set(surprise.id, surprise);
    this.byCode.set(surprise.code, surprise.id);
    return surprise;
  }

  async findById(id: SurpriseId): Promise<Surprise | null> {
    return this.byId.get(id) ?? null;
  }

  async findByCode(code: string): Promise<Surprise | null> {
    const id = this.byCode.get(code);
    return id === undefined ? null : (this.byId.get(id) ?? null);
  }

  async redeem(
    code: string,
    recipientId: UserId,
    mood: SurpriseMood,
    openedAt: Date,
  ): Promise<Surprise | null> {
    // --- atomic section: no await from here to the write ---
    const id = this.byCode.get(code);
    if (id === undefined) return null;

    const existing = this.byId.get(id);
    if (existing === undefined) return null;
    if (existing.openedAt !== null) return null; // someone already claimed it
    if (isExpired(existing, this.nowFn())) return null;

    const claimed: Surprise = Object.freeze({
      ...existing,
      recipientId,
      moodSelected: mood,
      openedAt,
    });
    this.byId.set(id, claimed);
    // --- end atomic section ---
    return claimed;
  }

  async setTaskDone(id: SurpriseId, taskIndex: number, done: boolean): Promise<Surprise> {
    const existing = this.byId.get(id);
    if (existing === undefined) throw new NotFoundError('Surprise');
    if (taskIndex < 0 || taskIndex >= existing.tasks.length) {
      throw new ValidationError('That task does not exist.');
    }
    const tasks = existing.tasks.map((task, i) => (i === taskIndex ? { ...task, done } : task));
    const updated: Surprise = Object.freeze({ ...existing, tasks });
    this.byId.set(id, updated);
    return updated;
  }

  async listSentBy(senderId: UserId, limit: number): Promise<readonly Surprise[]> {
    return this.sortedByNewest((s) => s.senderId === senderId).slice(0, limit);
  }

  async listReceivedBy(recipientId: UserId, limit: number): Promise<readonly Surprise[]> {
    return this.sortedByNewest((s) => s.recipientId === recipientId).slice(0, limit);
  }

  private sortedByNewest(predicate: (s: Surprise) => boolean): Surprise[] {
    return [...this.byId.values()]
      .filter(predicate)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  }

  /** Test helper. Not part of the port. */
  clear(): void {
    this.byId.clear();
    this.byCode.clear();
  }
}
