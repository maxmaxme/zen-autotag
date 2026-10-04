// ZenMoney API: one sync endpoint, `POST /v8/diff/`.
// Reference: https://github.com/zenmoney/ZenPlugins/wiki/ZenMoney-API
// Timestamps are Unix seconds; amounts are plain decimals, always >= 0.

import * as v from 'valibot';
import { parseJson } from './json.ts';

export const ServerSchema = v.picklist(['ru', 'app']);
export type Server = v.InferOutput<typeof ServerSchema>;
const SERVERS: Record<Server, string> = { ru: 'https://api.zenmoney.ru', app: 'https://api.zenmoney.app' };

const nullableString = v.nullish(v.string(), null);

const TagSchema = v.object({
  id: v.string(),
  title: v.string(),
  parent: nullableString,
  showIncome: v.optional(v.boolean()),
  showOutcome: v.optional(v.boolean()),
});
export type Tag = v.InferOutput<typeof TagSchema>;

const AccountSchema = v.object({
  id: v.string(),
  title: v.string(),
  instrument: v.nullish(v.number(), null),
});
export type Account = v.InferOutput<typeof AccountSchema>;

const InstrumentSchema = v.object({
  id: v.number(),
  shortTitle: v.string(),
  symbol: v.string(),
});
export type Instrument = v.InferOutput<typeof InstrumentSchema>;

/** Written back whole (ZenMoney replaces the object), so unknown fields are kept, not stripped. */
const TransactionSchema = v.looseObject({
  id: v.string(),
  changed: v.number(),
  created: v.number(),
  deleted: v.boolean(),
  viewed: v.boolean(),
  date: v.string(),
  income: v.number(),
  outcome: v.number(),
  incomeAccount: v.string(),
  outcomeAccount: v.string(),
  tag: v.nullish(v.array(v.string()), null),
  payee: nullableString,
  originalPayee: nullableString,
  comment: nullableString,
});
export type Transaction = v.InferOutput<typeof TransactionSchema>;

// Errors come back as { error: { code, message } } (or a plain string), sometimes with HTTP 200.
const DiffSchema = v.object({
  error: v.optional(v.union([v.string(), v.object({ code: v.optional(v.string()), message: v.optional(v.string()) })])),
  transaction: v.optional(v.array(TransactionSchema), []),
  tag: v.optional(v.array(TagSchema), []),
  account: v.optional(v.array(AccountSchema), []),
  instrument: v.optional(v.array(InstrumentSchema), []),
});
type Diff = v.InferOutput<typeof DiffSchema>;

export interface Snapshot {
  transactions: Transaction[];
  tags: Tag[];
  accounts: Account[];
  instruments: Instrument[];
}

export class ZenMoneyError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'ZenMoneyError';
    this.status = status;
  }
}

export class ZenMoney {
  private readonly token: string;
  private readonly url: string;

  constructor(token: string, server: Server) {
    this.token = token;
    this.url = `${SERVERS[server]}/v8/diff/`;
  }

  /**
   * Everything changed since `sinceSec` (0 = the whole account) plus the full
   * category and account lists. ZenMoney accepts any past timestamp, so a
   * sliding window needs no stored cursor.
   */
  async since(sinceSec: number): Promise<Snapshot> {
    const res = await this.diff({ serverTimestamp: sinceSec, forceFetch: ['tag', 'account', 'instrument'] });
    return {
      transactions: res.transaction.filter((t) => !t.deleted),
      tags: res.tag,
      accounts: res.account,
      instruments: res.instrument,
    };
  }

  /** Saves transactions (whole objects, with a fresh `changed`). */
  async save(transactions: Transaction[]): Promise<void> {
    if (transactions.length > 0) {
      await this.diff({ serverTimestamp: Math.floor(Date.now() / 1000), transaction: transactions });
    }
  }

  private async diff(body: Record<string, unknown>): Promise<Diff> {
    const res = await fetch(this.url, {
      method: 'POST',
      headers: { authorization: `Bearer ${this.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ ...body, currentClientTimestamp: Math.floor(Date.now() / 1000) }),
    });
    const text = await res.text();
    const parsed = v.safeParse(DiffSchema, parseJson(text));
    const err = parsed.success ? parsed.output.error : undefined;
    if (!res.ok || err) {
      const msg = typeof err === 'object' ? `${err.code ?? ''} ${err.message ?? ''}`.trim() : (err ?? text.slice(0, 200));
      throw new ZenMoneyError(res.status, `ZenMoney ${res.status}: ${msg}`);
    }
    if (!parsed.success) {
      throw new ZenMoneyError(res.status, `ZenMoney: unexpected response — ${v.summarize(parsed.issues)}`);
    }
    return parsed.output;
  }
}


/** "Parent → Child", the way the user sees categories (stray spaces in titles dropped). */
export function tagLabel(tag: Tag, tags: readonly Tag[]): string {
  const parent = tag.parent ? tags.find((t) => t.id === tag.parent) : undefined;
  return parent ? `${parent.title.trim()} → ${tag.title.trim()}` : tag.title.trim();
}

/** A transfer between two of the user's own accounts — not spending, never touched. */
export function isTransfer(t: Transaction): boolean {
  return t.incomeAccount !== t.outcomeAccount;
}
