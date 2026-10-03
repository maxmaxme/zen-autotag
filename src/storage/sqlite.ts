import { DatabaseSync } from 'node:sqlite';
import { MIGRATIONS } from './migrations.ts';
import type { Candidate, ReceiptRow, ReceiptStatus, Store, StoreRow, TagSource, ZmTxRow } from './types.ts';

interface DbReceipt {
  message_id: string;
  source: ReceiptRow['source'];
  store: string;
  store_key: string;
  items: string;
  total_cents: number;
  currency: string;
  date: string;
  reference: string | null;
  received_at: number;
  status: ReceiptStatus;
  zm_tx_id: string | null;
  tag_id: string | null;
  tag_source: TagSource | null;
  tag_confidence: number | null;
  applied_tag: string | null;
  previous_tags: string | null;
  applied_at: number | null;
  note: string | null;
}

interface DbZmTx {
  id: string;
  date: string;
  outcome_cents: number;
  income_cents: number;
  payee: string | null;
  raw: string;
}

function toReceipt(r: DbReceipt): ReceiptRow {
  return {
    messageId: r.message_id,
    source: r.source,
    store: r.store,
    storeKey: r.store_key,
    items: JSON.parse(r.items) as string[],
    totalCents: r.total_cents,
    currency: r.currency,
    date: r.date,
    reference: r.reference,
    receivedAt: r.received_at,
    status: r.status,
    zmTxId: r.zm_tx_id,
    tagId: r.tag_id,
    tagSource: r.tag_source,
    tagConfidence: r.tag_confidence,
    appliedTag: r.applied_tag,
    previousTags: r.previous_tags ? (JSON.parse(r.previous_tags) as string[]) : null,
    appliedAt: r.applied_at,
    note: r.note,
  };
}

function toZmTx(r: DbZmTx): ZmTxRow {
  return {
    id: r.id,
    date: r.date,
    outcomeCents: r.outcome_cents,
    incomeCents: r.income_cents,
    payee: r.payee,
    raw: r.raw,
  };
}

function migrate(db: DatabaseSync): void {
  const row = db.prepare('PRAGMA user_version').get() as { user_version: number };
  for (let v = row.user_version; v < MIGRATIONS.length; v++) {
    db.exec('BEGIN');
    try {
      db.exec(MIGRATIONS[v] as string);
      db.exec(`PRAGMA user_version = ${v + 1}`);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }
}

export function openStore(path: string): Store {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL');
  migrate(db);

  function inTransaction(fn: () => void): void {
    db.exec('BEGIN');
    try {
      fn();
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }

  return {
    isMailSeen(messageId) {
      return db.prepare('SELECT 1 FROM mail_seen WHERE message_id = ?').get(messageId) !== undefined;
    },

    markMailSeen(messageId, parsed, now) {
      db.prepare(
        'INSERT INTO mail_seen (message_id, parsed, seen_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING',
      ).run(messageId, parsed ? 1 : 0, now);
    },

    addReceipt(messageId, r, storeKey, receivedAt) {
      inTransaction(() => {
        db.prepare(
          `INSERT INTO receipts (message_id, source, store, store_key, items, total_cents, currency, date, reference, received_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT DO NOTHING`,
        ).run(
          messageId,
          r.source,
          r.store,
          storeKey,
          JSON.stringify(r.items),
          r.totalCents,
          r.currency,
          r.date,
          r.reference,
          receivedAt,
        );
        db.prepare('INSERT INTO stores (store_key, name) VALUES (?, ?) ON CONFLICT DO NOTHING').run(storeKey, r.store);
      });
    },

    receiptsByStatus(...statuses) {
      const rows = db
        .prepare(
          `SELECT * FROM receipts WHERE status IN (${statuses.map(() => '?').join(',')})
           ORDER BY date, received_at`,
        )
        .all(...statuses) as unknown as DbReceipt[];
      return rows.map(toReceipt);
    },

    recentReceipts(limit) {
      const rows = db
        .prepare('SELECT * FROM receipts ORDER BY date DESC, received_at DESC LIMIT ?')
        .all(limit) as unknown as DbReceipt[];
      return rows.map(toReceipt);
    },

    getReceipt(messageId) {
      const row = db.prepare('SELECT * FROM receipts WHERE message_id = ?').get(messageId) as
        | DbReceipt
        | undefined;
      return row ? toReceipt(row) : null;
    },

    setMatch(messageId, zmTxId, status) {
      db.prepare('UPDATE receipts SET zm_tx_id = ?, status = ?, note = NULL WHERE message_id = ?').run(
        zmTxId,
        status,
        messageId,
      );
    },

    setStatus(messageId, status, note = null) {
      db.prepare('UPDATE receipts SET status = ?, note = ? WHERE message_id = ?').run(status, note, messageId);
    },

    markApplied(messageId, result, now) {
      db.prepare(
        `UPDATE receipts SET status = ?, applied_tag = ?, previous_tags = ?, applied_at = ?, note = NULL
         WHERE message_id = ?`,
      ).run(
        result.status,
        result.tag,
        result.previousTags ? JSON.stringify(result.previousTags) : null,
        now,
        messageId,
      );
    },

    claimedZmTxIds() {
      const rows = db.prepare('SELECT zm_tx_id FROM receipts WHERE zm_tx_id IS NOT NULL').all() as unknown as {
        zm_tx_id: string;
      }[];
      return new Set(rows.map((r) => r.zm_tx_id));
    },

    setTag(messageId, tagId, source, confidence) {
      db.prepare('UPDATE receipts SET tag_id = ?, tag_source = ?, tag_confidence = ? WHERE message_id = ?').run(
        tagId,
        source,
        confidence,
        messageId,
      );
    },

    listStores() {
      const rows = db.prepare('SELECT * FROM stores ORDER BY name').all() as unknown as {
        store_key: string;
        name: string;
        tag_id: string | null;
      }[];
      return rows.map((r): StoreRow => ({ storeKey: r.store_key, name: r.name, tagId: r.tag_id }));
    },

    getStore(storeKey) {
      const r = db.prepare('SELECT * FROM stores WHERE store_key = ?').get(storeKey) as
        | { store_key: string; name: string; tag_id: string | null }
        | undefined;
      return r ? { storeKey: r.store_key, name: r.name, tagId: r.tag_id } : null;
    },

    setStoreTag(storeKey, tagId) {
      db.prepare('UPDATE stores SET tag_id = ? WHERE store_key = ?').run(tagId, storeKey);
    },

    candidates() {
      const rows = db.prepare('SELECT tag_id, hint FROM candidates').all() as unknown as {
        tag_id: string;
        hint: string;
      }[];
      return rows.map((r): Candidate => ({ tagId: r.tag_id, hint: r.hint }));
    },

    setCandidates(list) {
      inTransaction(() => {
        db.exec('DELETE FROM candidates');
        const stmt = db.prepare('INSERT INTO candidates (tag_id, hint) VALUES (?, ?)');
        for (const c of list) {
          stmt.run(c.tagId, c.hint);
        }
      });
    },

    upsertZmTx(rows) {
      inTransaction(() => {
        const stmt = db.prepare(
          `INSERT INTO zm_tx (id, date, outcome_cents, income_cents, payee, raw) VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT (id) DO UPDATE SET date = excluded.date, outcome_cents = excluded.outcome_cents,
             income_cents = excluded.income_cents, payee = excluded.payee, raw = excluded.raw`,
        );
        for (const r of rows) {
          stmt.run(r.id, r.date, r.outcomeCents, r.incomeCents, r.payee, r.raw);
        }
      });
    },

    deleteZmTx(ids) {
      inTransaction(() => {
        const stmt = db.prepare('DELETE FROM zm_tx WHERE id = ?');
        for (const id of ids) {
          stmt.run(id);
        }
      });
    },

    getZmTx(id) {
      const row = db.prepare('SELECT * FROM zm_tx WHERE id = ?').get(id) as DbZmTx | undefined;
      return row ? toZmTx(row) : null;
    },

    zmTxBetween(from, to) {
      const rows = db
        .prepare('SELECT * FROM zm_tx WHERE date >= ? AND date <= ? ORDER BY date')
        .all(from, to) as unknown as DbZmTx[];
      return rows.map(toZmTx);
    },

    getKv(key) {
      const row = db.prepare('SELECT value FROM kv WHERE key = ?').get(key) as { value: string } | undefined;
      return row?.value ?? null;
    },

    setKv(key, value) {
      db.prepare(
        'INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value',
      ).run(key, value);
    },

    close() {
      db.close();
    },
  };
}
