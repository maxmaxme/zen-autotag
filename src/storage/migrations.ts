// Applied in order; `PRAGMA user_version` records how many have run.
// Append only — never edit a migration that has shipped.
export const MIGRATIONS: string[] = [
  `
  -- One row per receipt email we understood.
  CREATE TABLE receipts (
    message_id TEXT PRIMARY KEY,
    source TEXT NOT NULL,
    store TEXT NOT NULL,
    store_key TEXT NOT NULL,
    -- JSON array of line items, input for classification.
    items TEXT NOT NULL DEFAULT '[]',
    total_cents INTEGER NOT NULL,
    currency TEXT NOT NULL,
    date TEXT NOT NULL,
    reference TEXT,
    received_at INTEGER NOT NULL,
    -- unmatched | matched | review | applied | unchanged | dismissed | expired
    status TEXT NOT NULL DEFAULT 'unmatched',
    zm_tx_id TEXT UNIQUE,
    -- The ZenMoney category decided for this receipt, and by whom.
    tag_id TEXT,
    tag_source TEXT,          -- store | jev | user; NULL = not decided yet
    tag_confidence REAL,
    applied_tag TEXT,
    previous_tags TEXT,
    applied_at INTEGER,
    note TEXT
  );
  CREATE INDEX idx_receipts_status ON receipts(status);

  -- Stores seen in receipts. tag_id set = always this category (the user said so).
  CREATE TABLE stores (
    store_key TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    tag_id TEXT
  );

  -- ZenMoney categories the classifier may pick, with the user's hint for each.
  CREATE TABLE candidates (
    tag_id TEXT PRIMARY KEY,
    hint TEXT NOT NULL DEFAULT ''
  );

  -- Local mirror of the ZenMoney transactions that can match a receipt
  -- (payee matches the merchant pattern). raw = the full object, needed to write it back.
  CREATE TABLE zm_tx (
    id TEXT PRIMARY KEY,
    date TEXT NOT NULL,
    outcome_cents INTEGER NOT NULL,
    income_cents INTEGER NOT NULL,
    payee TEXT,
    raw TEXT NOT NULL
  );
  CREATE INDEX idx_zm_tx_date ON zm_tx(date);

  -- Every email id we've looked at, parsed or not, so it's fetched once.
  CREATE TABLE mail_seen (
    message_id TEXT PRIMARY KEY,
    parsed INTEGER NOT NULL,
    seen_at INTEGER NOT NULL
  );

  CREATE TABLE kv (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  `,
];
