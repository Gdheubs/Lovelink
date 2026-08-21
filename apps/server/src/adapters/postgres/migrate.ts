import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from 'pg';
import { loadConfig } from '../../config.js';

/**
 * A deliberately tiny migration runner.
 *
 * WHY NOT A MIGRATION LIBRARY
 * ---------------------------
 * Migration tools bring their own opinions about how schema is described, and
 * the ones that generate SQL for you produce diffs nobody reviewed. The schema
 * IS the product's most durable artifact; it deserves hand-written SQL with
 * comments explaining every index. What is left over — "run these files in
 * order, once each, and remember which ran" — is about eighty lines, and those
 * eighty lines are auditable in a way a dependency is not.
 *
 * GUARANTEES
 *  - Files run in filename order, exactly once, tracked in `schema_migrations`.
 *  - Each file runs INSIDE A TRANSACTION with its bookkeeping row, so a failure
 *    halfway through leaves nothing applied and nothing recorded.
 *  - A CHECKSUM is stored. Editing a migration that has already run is caught
 *    and refused, because the "it works on my machine" version of that bug is
 *    two environments with silently different schemas.
 *  - An advisory lock serializes concurrent runners, so two app instances
 *    booting together cannot both apply 0003.
 *
 * USAGE
 *   npm run migrate           -- apply everything pending
 *   npm run migrate:status    -- show what has run and what is pending
 */

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '../../../migrations');

/** Any 64-bit constant; it only has to be the same in every process. */
const ADVISORY_LOCK_KEY = 8_142_390_017_442_119n;

interface MigrationFile {
  readonly name: string;
  readonly sql: string;
  readonly checksum: string;
}

function loadMigrationFiles(): readonly MigrationFile[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort() // zero-padded numeric prefixes make lexical order the intended order
    .map((name) => {
      const sql = readFileSync(join(MIGRATIONS_DIR, name), 'utf8');
      return {
        name,
        sql,
        checksum: createHash('sha256').update(sql).digest('hex').slice(0, 16),
      };
    });
}

async function ensureBookkeepingTable(client: Client): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name       TEXT PRIMARY KEY,
      checksum   TEXT        NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await client.query(`
    COMMENT ON TABLE schema_migrations IS
      'Which migration files have been applied, and a checksum of each so an '
      'edited-after-the-fact migration is detected rather than silently ignored.';
  `);
}

interface AppliedRow {
  name: string;
  checksum: string;
  applied_at: Date;
}

async function readApplied(client: Client): Promise<Map<string, AppliedRow>> {
  const { rows } = await client.query<AppliedRow>(
    'SELECT name, checksum, applied_at FROM schema_migrations ORDER BY name',
  );
  return new Map(rows.map((r) => [r.name, r]));
}

/**
 * Refuse to run if a previously-applied file has changed on disk.
 * Silently ignoring the edit is the dangerous option: the developer believes
 * their change is live, and it is not.
 */
function assertNoDrift(files: readonly MigrationFile[], applied: Map<string, AppliedRow>): void {
  const drifted = files.filter((f) => {
    const row = applied.get(f.name);
    return row !== undefined && row.checksum !== f.checksum;
  });

  if (drifted.length > 0) {
    throw new Error(
      [
        'Migration drift detected. These files changed after they were applied:',
        ...drifted.map((f) => `  - ${f.name}`),
        '',
        'An applied migration is immutable. Write a NEW migration that alters',
        'the schema instead of editing history.',
      ].join('\n'),
    );
  }
}

async function up(client: Client): Promise<void> {
  await ensureBookkeepingTable(client);

  const files = loadMigrationFiles();
  const applied = await readApplied(client);
  assertNoDrift(files, applied);

  const pending = files.filter((f) => !applied.has(f.name));

  if (pending.length === 0) {
    process.stdout.write('Schema is up to date. Nothing to apply.\n');
    return;
  }

  for (const file of pending) {
    process.stdout.write(`Applying ${file.name} ... `);
    try {
      // The migration and its bookkeeping row commit together or not at all.
      await client.query('BEGIN');
      await client.query(file.sql);
      await client.query('INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)', [
        file.name,
        file.checksum,
      ]);
      await client.query('COMMIT');
      process.stdout.write('ok\n');
    } catch (error) {
      await client.query('ROLLBACK');
      process.stdout.write('FAILED\n');
      throw error;
    }
  }
  process.stdout.write(`Applied ${pending.length} migration(s).\n`);
}

async function status(client: Client): Promise<void> {
  await ensureBookkeepingTable(client);
  const files = loadMigrationFiles();
  const applied = await readApplied(client);

  process.stdout.write('\n  status    migration\n  ------    ---------\n');
  for (const file of files) {
    const row = applied.get(file.name);
    if (row === undefined) {
      process.stdout.write(`  PENDING   ${file.name}\n`);
    } else if (row.checksum !== file.checksum) {
      process.stdout.write(`  DRIFTED   ${file.name}  (file edited after apply)\n`);
    } else {
      process.stdout.write(`  applied   ${file.name}  ${row.applied_at.toISOString()}\n`);
    }
  }
  process.stdout.write('\n');
}

async function main(): Promise<void> {
  const command = process.argv[2] ?? 'up';
  const config = loadConfig();
  const client = new Client({ connectionString: config.DATABASE_URL });

  await client.connect();
  try {
    // Serializes concurrent runners: two app instances booting at once cannot
    // both try to apply the same migration.
    await client.query('SELECT pg_advisory_lock($1)', [ADVISORY_LOCK_KEY.toString()]);

    switch (command) {
      case 'up':
        await up(client);
        break;
      case 'status':
        await status(client);
        break;
      default:
        throw new Error(`Unknown command "${command}". Use "up" or "status".`);
    }
  } finally {
    await client
      .query('SELECT pg_advisory_unlock($1)', [ADVISORY_LOCK_KEY.toString()])
      .catch(() => {});
    await client.end();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`\n${error instanceof Error ? error.message : String(error)}\n\n`);
  process.exitCode = 1;
});
