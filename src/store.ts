import { existsSync, mkdirSync, readFileSync, renameSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import * as v from 'valibot';

// zen-autotag's own data: the day it started and what each category means.
// Everything about transactions stays in ZenMoney (`viewed` is the "done" marker).

/** Append-only; the index is PRAGMA user_version. */
const MIGRATIONS = [
  `CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
   CREATE TABLE hints (
     category TEXT PRIMARY KEY, -- as shown in ZenMoney: "Parent → Child"
     hint TEXT NOT NULL         -- plain words the classifier reads
   );`,
];

const START_DATE = 'start_date';

const HintRowsSchema = v.array(v.object({ category: v.string(), hint: v.string() }));
const ValueRowSchema = v.object({ value: v.pipe(v.string(), v.isoDate()) });
const VersionRowSchema = v.object({ user_version: v.number() });

/** The file this data lived in before the database. */
const LegacyConfigSchema = v.object({
  startDate: v.optional(v.pipe(v.string(), v.isoDate())),
  hints: v.optional(v.record(v.string(), v.string()), {}),
});

export interface Store {
  /** Transactions dated before this are never touched; null until the first start. */
  startDate(): string | null;
  setStartDate(day: string): void;
  /** Category → hint. Read on every scan, so an edit applies without a restart. */
  hints(): Record<string, string>;
  setHint(category: string, hint: string): void;
  close(): void;
}

function migrate(db: DatabaseSync): void {
  const { user_version: from } = v.parse(VersionRowSchema, db.prepare('PRAGMA user_version').get());
  for (const [version, sql] of MIGRATIONS.entries()) {
    if (version < from) {
      continue;
    }
    db.exec('BEGIN');
    try {
      db.exec(sql);
      db.exec(`PRAGMA user_version = ${version + 1}`);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }
}

export function openStore(path: string): Store {
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  // WAL + a busy timeout: the hints table may be edited by hand (sqlite-web) while the service reads it.
  db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
  migrate(db);
  return {
    startDate() {
      const row: unknown = db.prepare('SELECT value FROM kv WHERE key = ?').get(START_DATE);
      return row === undefined ? null : v.parse(ValueRowSchema, row).value;
    },
    setStartDate(day) {
      db.prepare(
        'INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value',
      ).run(START_DATE, day);
    },
    hints() {
      const rows = v.parse(HintRowsSchema, db.prepare('SELECT category, hint FROM hints ORDER BY category').all());
      return Object.fromEntries(rows.map((r) => [r.category, r.hint]));
    },
    setHint(category, hint) {
      db.prepare(
        'INSERT INTO hints (category, hint) VALUES (?, ?) ON CONFLICT (category) DO UPDATE SET hint = excluded.hint',
      ).run(category, hint);
    },
    close() {
      db.close();
    },
  };
}

/**
 * Moves a config.json from before the database into a fresh store, once.
 * The file is renamed to `*.imported` so it is never read again. A store that
 * already has data is left alone. Returns whether anything was imported.
 */
export function importLegacyConfig(store: Store, path: string): boolean {
  if (!existsSync(path) || store.startDate() !== null) {
    return false;
  }
  const parsed = v.safeParse(LegacyConfigSchema, JSON.parse(readFileSync(path, 'utf8')));
  if (!parsed.success) {
    throw new Error(`${path}: ${v.summarize(parsed.issues)}`);
  }
  for (const [category, hint] of Object.entries(parsed.output.hints)) {
    store.setHint(category, hint);
  }
  if (parsed.output.startDate) {
    store.setStartDate(parsed.output.startDate);
  }
  renameSync(path, `${path}.imported`);
  return true;
}
