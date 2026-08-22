import type { Surprise, SurpriseMood, SurpriseTask, SurpriseTheme } from '../../domain/entities/Surprise.js';
import type {
  CreateSurpriseInput,
  SurpriseRepository,
} from '../../domain/ports/SurpriseRepository.js';
import type { SurpriseId, UserId } from '../../domain/values/ids.js';
import { asSurpriseId, asUserId } from '../../domain/values/ids.js';
import { ConflictError, NotFoundError, ValidationError } from '../../domain/errors.js';
import { isPgError, PG_ERROR, type Database } from './db.js';

/**
 * ADAPTER: surprises over Postgres.
 *
 * THE ONE THING THIS FILE EXISTS TO GET RIGHT
 * -------------------------------------------
 * `redeem` is a compare-and-set, and the entire mechanic depends on it. The
 * obvious implementation — SELECT the row, check `opened_at IS NULL`, then
 * UPDATE — is wrong, and wrong in a way that only shows up under load: two
 * requests read the same unopened row, both see null, both write, and two
 * people are told a surprise was meant for them.
 *
 * So the check and the write are ONE statement:
 *
 *     UPDATE ... WHERE code = $1 AND opened_at IS NULL AND expires_at > $4
 *     RETURNING ...
 *
 * Postgres takes a row lock for the duration; the loser's WHERE no longer
 * matches and it returns zero rows, which the port defines as `null`. There is
 * no window between the check and the act because there is no separate check.
 *
 * WHY EXPIRY IS JUDGED AGAINST THE CALLER'S CLOCK, NOT now()
 * ----------------------------------------------------------
 * `expires_at > $4` uses the `openedAt` the caller passed rather than the
 * database's `now()`. Two reasons: it keeps the decision on the Clock port
 * (which tests can control), and it means the row records a time consistent
 * with the one that authorised writing it. A row whose `opened_at` sits after
 * its own `expires_at` would be a real contradiction, and this makes that
 * unrepresentable.
 *
 * WHY TASKS ARE JSONB AND NOT A TABLE
 * -----------------------------------
 * Tasks are never queried across surprises, never joined, never counted; they
 * are read exactly when their surprise is read, and there are at most five.
 * A child table would buy nothing and cost a join on every read. The tradeoff
 * accepted in return: `setTaskDone` addresses by array index, so the stored
 * order is load-bearing and this adapter must never reorder it.
 */

interface SurpriseRow {
  id: string;
  code: string;
  sender_id: string;
  recipient_id: string | null;
  theme: string;
  message: string;
  tasks: unknown;
  mood_selected: string | null;
  opened_at: Date | null;
  created_at: Date;
  expires_at: Date;
}

const COLUMNS = `
  id, code, sender_id, recipient_id, theme, message, tasks,
  mood_selected, opened_at, created_at, expires_at
`;

/**
 * JSONB comes back as already-parsed JS, but it is `unknown` as far as the type
 * system is concerned and it came from a column any migration could have
 * touched. Narrow it rather than casting: a malformed row should degrade to an
 * empty task list, not throw while someone is opening a gift.
 */
function toTasks(raw: unknown): readonly SurpriseTask[] {
  if (!Array.isArray(raw)) return [];
  const tasks: SurpriseTask[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) continue;
    const { text, done } = entry as { text?: unknown; done?: unknown };
    if (typeof text !== 'string') continue;
    tasks.push({ text, done: done === true });
  }
  return tasks;
}

function toSurprise(row: SurpriseRow): Surprise {
  return {
    id: asSurpriseId(row.id),
    code: row.code,
    senderId: asUserId(row.sender_id),
    recipientId: row.recipient_id === null ? null : asUserId(row.recipient_id),
    // The CHECK constraint on the column is what makes these casts honest:
    // the database refuses any value outside the union.
    theme: row.theme as SurpriseTheme,
    message: row.message,
    tasks: toTasks(row.tasks),
    moodSelected: row.mood_selected === null ? null : (row.mood_selected as SurpriseMood),
    openedAt: row.opened_at,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
  };
}

export class PostgresSurpriseRepository implements SurpriseRepository {
  constructor(private readonly db: Database) {}

  async create(input: CreateSurpriseInput): Promise<Surprise> {
    try {
      const row = await this.db.queryOne<SurpriseRow>(
        `INSERT INTO surprises (id, code, sender_id, theme, message, tasks, created_at, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8)
         RETURNING ${COLUMNS}`,
        [
          input.id,
          input.code,
          input.senderId,
          input.theme,
          input.message,
          JSON.stringify(input.tasks),
          input.createdAt,
          input.expiresAt,
        ],
      );
      // RETURNING on a successful INSERT always yields the row; this branch is
      // unreachable in practice and exists so the type is honest.
      if (row === null) throw new ConflictError('Could not create that surprise.');
      return toSurprise(row);
    } catch (error) {
      // The unique index on `code` is the real collision guarantee — the
      // retry loop in CreateSurprise depends on getting a ConflictError here
      // specifically, so translate it rather than letting a driver error leak
      // into the application ring.
      if (isPgError(error, PG_ERROR.UNIQUE_VIOLATION)) {
        throw new ConflictError('That code is already in use.');
      }
      throw error;
    }
  }

  async findById(id: SurpriseId): Promise<Surprise | null> {
    const row = await this.db.queryOne<SurpriseRow>(
      `SELECT ${COLUMNS} FROM surprises WHERE id = $1`,
      [id],
    );
    return row === null ? null : toSurprise(row);
  }

  async findByCode(code: string): Promise<Surprise | null> {
    // The port's contract says the caller normalizes. Matching exactly (rather
    // than UPPER(code) = UPPER($1)) is what keeps `surprises_code_key` usable
    // as an index instead of forcing a sequential scan.
    const row = await this.db.queryOne<SurpriseRow>(
      `SELECT ${COLUMNS} FROM surprises WHERE code = $1`,
      [code],
    );
    return row === null ? null : toSurprise(row);
  }

  async redeem(
    code: string,
    recipientId: UserId,
    mood: SurpriseMood,
    openedAt: Date,
  ): Promise<Surprise | null> {
    // ONE statement. See the note at the top of this file — splitting this into
    // a read and a write reintroduces the double-redemption race.
    const row = await this.db.queryOne<SurpriseRow>(
      `UPDATE surprises
          SET recipient_id = $2, mood_selected = $3, opened_at = $4
        WHERE code = $1
          AND opened_at IS NULL
          AND expires_at > $4
        RETURNING ${COLUMNS}`,
      [code, recipientId, mood, openedAt],
    );

    // Zero rows means one of: no such code, already opened, or expired. The
    // port deliberately collapses all three into null — the use case must not
    // be able to tell a guesser which one it was.
    return row === null ? null : toSurprise(row);
  }

  async setTaskDone(id: SurpriseId, taskIndex: number, done: boolean): Promise<Surprise> {
    if (!Number.isInteger(taskIndex) || taskIndex < 0) {
      throw new ValidationError('That task does not exist.');
    }

    // jsonb_set would silently no-op on an out-of-range index and hand back an
    // unchanged row, which the caller would read as success. Guarding on
    // jsonb_array_length makes the statement return zero rows instead, so the
    // two failure modes below stay distinguishable.
    const row = await this.db.queryOne<SurpriseRow>(
      `UPDATE surprises
          SET tasks = jsonb_set(tasks, ARRAY[$2::text, 'done'], to_jsonb($3::boolean), false)
        WHERE id = $1
          AND jsonb_array_length(tasks) > $2::int
        RETURNING ${COLUMNS}`,
      [id, taskIndex, done],
    );

    if (row === null) {
      // Distinguish "no such surprise" from "no such task" with one extra
      // read. It only runs on the failure path, and the two cases mean very
      // different things to the caller.
      const exists = await this.findById(id);
      if (exists === null) throw new NotFoundError('Surprise');
      throw new ValidationError('That task does not exist.');
    }

    return toSurprise(row);
  }

  async listSentBy(senderId: UserId, limit: number): Promise<readonly Surprise[]> {
    const rows = await this.db.query<SurpriseRow>(
      `SELECT ${COLUMNS} FROM surprises
        WHERE sender_id = $1
        ORDER BY created_at DESC, id DESC
        LIMIT $2`,
      [senderId, limit],
    );
    return rows.map(toSurprise);
  }

  async listReceivedBy(recipientId: UserId, limit: number): Promise<readonly Surprise[]> {
    // Only redeemed surprises have a recipient at all, so this needs no
    // `opened_at IS NOT NULL` clause — the redemption-atomic CHECK constraint
    // guarantees the two move together.
    const rows = await this.db.query<SurpriseRow>(
      `SELECT ${COLUMNS} FROM surprises
        WHERE recipient_id = $1
        ORDER BY opened_at DESC, id DESC
        LIMIT $2`,
      [recipientId, limit],
    );
    return rows.map(toSurprise);
  }
}
