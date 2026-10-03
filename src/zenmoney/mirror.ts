import type { Store, ZmTxRow } from '../storage/types.ts';
import type { ZenMoneyApi, ZmTag, ZmTransaction } from './types.ts';

const SERVER_TS_KV = 'zm_server_timestamp';
const TAGS_KV = 'zm_tags';

export function toCents(amount: number): number {
  return Math.round(amount * 100);
}

/**
 * Keeps a local copy of the ZenMoney transactions a receipt could match,
 * using ZenMoney's own incremental sync: every call sends the last
 * `serverTimestamp` and gets back only what changed since. The first call
 * (timestamp 0) downloads everything once; only matching payees are kept.
 *
 * Every write also goes through `sync`, so the timestamp never skips past
 * changes we haven't seen.
 */
export class ZenMirror {
  private readonly api: ZenMoneyApi;
  private readonly store: Store;
  private readonly payeePattern: RegExp;

  constructor(opts: { api: ZenMoneyApi; store: Store; payeePattern: RegExp }) {
    this.api = opts.api;
    this.store = opts.store;
    this.payeePattern = opts.payeePattern;
  }

  relevant(t: ZmTransaction): boolean {
    return !t.deleted && this.payeePattern.test(`${t.payee ?? ''} ${t.originalPayee ?? ''}`);
  }

  async sync(outgoing: ZmTransaction[] = []): Promise<void> {
    const serverTimestamp = Number(this.store.getKv(SERVER_TS_KV) ?? 0);
    const res = await this.api.diff({
      serverTimestamp,
      // Categories are small; fetch them whole every time so renames show up.
      forceFetch: ['tag'],
      ...(outgoing.length ? { transaction: outgoing } : {}),
    });

    const keep: ZmTxRow[] = [];
    const drop: string[] = [];
    for (const t of res.transaction ?? []) {
      if (this.relevant(t)) {
        keep.push({
          id: t.id,
          date: t.date,
          outcomeCents: toCents(t.outcome),
          incomeCents: toCents(t.income),
          payee: t.payee ?? t.originalPayee,
          raw: JSON.stringify(t),
        });
      } else {
        drop.push(t.id);
      }
    }
    for (const d of res.deletion ?? []) {
      if (d.object === 'transaction') {
        drop.push(d.id);
      }
    }
    this.store.upsertZmTx(keep);
    this.store.deleteZmTx(drop);
    if (res.tag) {
      this.store.setKv(TAGS_KV, JSON.stringify(res.tag.map((t) => ({ id: t.id, title: t.title, parent: t.parent }))));
    }
    this.store.setKv(SERVER_TS_KV, String(res.serverTimestamp));
  }

  tags(): ZmTag[] {
    const raw = this.store.getKv(TAGS_KV);
    return raw ? (JSON.parse(raw) as ZmTag[]) : [];
  }
}

/** "Parent → Child" labels, sorted, for pickers and messages. */
export function tagLabels(tags: readonly ZmTag[]): { id: string; label: string }[] {
  const byId = new Map(tags.map((t) => [t.id, t]));
  return tags
    .map((t) => ({
      id: t.id,
      label: t.parent && byId.has(t.parent) ? `${byId.get(t.parent)?.title} → ${t.title}` : t.title,
    }))
    .sort((a, b) => a.label.localeCompare(b.label));
}
