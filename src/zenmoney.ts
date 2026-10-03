// ZenMoney API: one sync endpoint, `POST /v8/diff/`.
// Reference: https://github.com/zenmoney/ZenPlugins/wiki/ZenMoney-API
// Timestamps are Unix seconds; amounts are plain decimals, always >= 0.

export const SERVERS = { ru: 'https://api.zenmoney.ru', app: 'https://api.zenmoney.app' } as const;
export type Server = keyof typeof SERVERS;

export interface Tag {
  id: string;
  title: string;
  parent: string | null;
  showIncome?: boolean;
  showOutcome?: boolean;
}

export interface Account {
  id: string;
  title: string;
  instrument: number | null;
}

export interface Instrument {
  id: number;
  shortTitle: string;
  symbol: string;
}

/** Written back whole (ZenMoney replaces the object), so every field we got is kept. */
export interface Transaction {
  id: string;
  changed: number;
  created: number;
  deleted: boolean;
  viewed: boolean;
  date: string;
  income: number;
  outcome: number;
  incomeAccount: string;
  outcomeAccount: string;
  tag: string[] | null;
  payee: string | null;
  originalPayee: string | null;
  comment: string | null;
  [field: string]: unknown;
}

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
      transactions: ((res.transaction as Transaction[] | undefined) ?? []).filter((t) => !t.deleted),
      tags: (res.tag as Tag[] | undefined) ?? [],
      accounts: (res.account as Account[] | undefined) ?? [],
      instruments: (res.instrument as Instrument[] | undefined) ?? [],
    };
  }

  /** Saves transactions (whole objects, with a fresh `changed`). */
  async save(transactions: Transaction[]): Promise<void> {
    if (transactions.length > 0) {
      await this.diff({ serverTimestamp: Math.floor(Date.now() / 1000), transaction: transactions });
    }
  }

  private async diff(body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const res = await fetch(this.url, {
      method: 'POST',
      headers: { authorization: `Bearer ${this.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ ...body, currentClientTimestamp: Math.floor(Date.now() / 1000) }),
    });
    const text = await res.text();
    let json: Record<string, unknown> = {};
    try {
      json = JSON.parse(text) as Record<string, unknown>;
    } catch {
      // handled below
    }
    // Errors come back as { error: { code, message } }, sometimes with HTTP 200.
    const err = json.error as { code?: string; message?: string } | string | undefined;
    if (!res.ok || err) {
      const msg = typeof err === 'object' ? `${err.code ?? ''} ${err.message ?? ''}`.trim() : (err ?? text.slice(0, 200));
      throw new ZenMoneyError(res.status, `ZenMoney ${res.status}: ${msg}`);
    }
    return json;
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
