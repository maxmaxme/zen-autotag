import { JevError, MAX_OPTIONS, type Classifier } from './classify/jev.ts';
import { MailAuthError, type Mailbox } from './mail/gmail.ts';
import { addDays, findMatch, withCategory } from './match.ts';
import { GMAIL_QUERIES, localDay, parseReceipt } from './receipts/parse.ts';
import { storeKey } from './receipts/stores.ts';
import type { ReceiptRow, Store } from './storage/types.ts';
import { ZenMoneyError } from './zenmoney/client.ts';
import { tagLabels, type ZenMirror } from './zenmoney/mirror.ts';
import type { ZmTransaction } from './zenmoney/types.ts';
import type { Notifier } from './notify/telegram.ts';
import type { Logger } from './logger.ts';

/** Re-read a few days of mail on every run; Gmail's `after:` is day-granular. */
const MAIL_OVERLAP_DAYS = 3;

const MAIL_CURSOR_KV = 'mail_cursor';
/** Receipts emailed before this moment (the first run) need a human OK; later ones apply themselves. */
export const AUTO_SINCE_KV = 'auto_since';
export const LAST_RUN_KV = 'last_run';
const LAST_OK_KV = 'last_run_ok';

export interface RunnerDeps {
  mailbox: Mailbox;
  mirror: Pick<ZenMirror, 'sync' | 'tags'>;
  store: Store;
  notifier: Notifier;
  log: Logger;
  now: () => Date;
  lookbackDays: number;
  /**
   * How long a receipt waits for its charge to show up in ZenMoney. Must
   * outlast the gap between the user's bank syncs in ZenMoney.
   */
  expireAfterDays: number;
  /** Optional: picks one of the candidate categories from the line items. */
  classifier: Classifier | null;
  /** Below this the classifier's pick waits for a human instead of applying. */
  minConfidence: number;
}

export interface RunResult {
  at: number;
  ok: boolean;
  newReceipts: number;
  matched: number;
  applied: number;
  error: string | null;
}

/** The category a receipt gets: the store's fixed one (the user's call) beats a per-receipt decision. */
export function resolveTag(r: Pick<ReceiptRow, 'storeKey' | 'tagId'>, store: Pick<Store, 'getStore'>): string | null {
  return store.getStore(r.storeKey)?.tagId ?? r.tagId;
}

/** The comment written on an otherwise empty ZenMoney transaction. */
export function receiptComment(r: Pick<ReceiptRow, 'source' | 'store'>): string {
  return r.source === 'glovo' ? `Glovo: ${r.store}` : r.store;
}

export class Runner {
  private readonly deps: RunnerDeps;
  private running: Promise<RunResult> | null = null;

  constructor(deps: RunnerDeps) {
    this.deps = deps;
  }

  isRunning(): boolean {
    return this.running !== null;
  }

  lastResult(): RunResult | null {
    const raw = this.deps.store.getKv(LAST_RUN_KV);
    return raw ? (JSON.parse(raw) as RunResult) : null;
  }

  /** One full pass. Concurrent callers share the in-flight run. */
  run(): Promise<RunResult> {
    if (!this.running) {
      this.running = this.doRun().finally(() => {
        this.running = null;
      });
    }
    return this.running;
  }

  /**
   * Apply receipts waiting in review — the human said yes, possibly picking
   * a different category than proposed (`tagId`).
   */
  async approve(picks: readonly { messageId: string; tagId: string | null }[]): Promise<number> {
    const { store } = this.deps;
    const chosen: ReceiptRow[] = [];
    for (const p of picks) {
      const r = store.getReceipt(p.messageId);
      if (r?.status !== 'review') {
        continue;
      }
      const proposed = resolveTag(r, store);
      if (p.tagId && p.tagId !== proposed) {
        store.setTag(r.messageId, p.tagId, 'user', null);
      }
      // For approved rows `tagId` carries the final category.
      chosen.push({ ...r, tagId: p.tagId ?? proposed });
    }
    await this.deps.mirror.sync();
    return this.apply(chosen, true);
  }

  dismiss(messageIds: readonly string[]): void {
    for (const id of messageIds) {
      const r = this.deps.store.getReceipt(id);
      if (r && (r.status === 'review' || r.status === 'matched' || r.status === 'unmatched')) {
        this.deps.store.setStatus(id, 'dismissed');
      }
    }
  }

  private async doRun(): Promise<RunResult> {
    const { store, log } = this.deps;
    const now = this.deps.now();
    if (!store.getKv(AUTO_SINCE_KV)) {
      store.setKv(AUTO_SINCE_KV, String(now.getTime()));
    }

    const result: RunResult = { at: now.getTime(), ok: true, newReceipts: 0, matched: 0, applied: 0, error: null };
    let hint: string | null = null;
    try {
      result.newReceipts = await this.readMail(now);
      await this.deps.mirror.sync();
      // Match before expiring, so a backfilled receipt gets one real attempt.
      result.matched = this.match();
      this.expire(now);
      await this.classifyPending();
      result.applied = await this.apply(store.receiptsByStatus('matched'), false);
    } catch (err) {
      result.ok = false;
      result.error = err instanceof Error ? err.message : String(err);
      if (err instanceof MailAuthError) {
        hint = 'Create a new Gmail app password and update GMAIL_APP_PASSWORD.';
      } else if (err instanceof JevError) {
        hint = 'TypeSafe rejected the request — check TYPESAFE_TOKEN.';
      } else if (err instanceof ZenMoneyError && err.isAuth) {
        hint = 'Take a fresh ZenMoney token from zerro.app (localStorage.zm_token) and update ZENMONEY_TOKEN.';
      }
      log.error({ err }, 'run failed');
    }

    store.setKv(LAST_RUN_KV, JSON.stringify(result));
    log.info(
      { newReceipts: result.newReceipts, matched: result.matched, applied: result.applied, ok: result.ok },
      'run finished',
    );
    await this.notifyTransition(result, hint);
    return result;
  }

  private async readMail(now: Date): Promise<number> {
    const { store, mailbox } = this.deps;
    const cursor = store.getKv(MAIL_CURSOR_KV);
    const since = cursor
      ? new Date(Date.parse(cursor) - MAIL_OVERLAP_DAYS * 86_400_000)
      : new Date(now.getTime() - this.deps.lookbackDays * 86_400_000);

    const messages = await mailbox.fetch(GMAIL_QUERIES, since, (id) => store.isMailSeen(id));
    let added = 0;
    for (const msg of messages) {
      const parsed = parseReceipt(msg);
      if (parsed) {
        store.addReceipt(msg.messageId, parsed, storeKey(parsed.store), msg.date.getTime());
        added++;
      } else {
        this.deps.log.warn({ subject: msg.subject, from: msg.from }, 'email matched a query but no parser');
      }
      store.markMailSeen(msg.messageId, parsed !== null, now.getTime());
    }
    store.setKv(MAIL_CURSOR_KV, now.toISOString());
    return added;
  }

  private expire(now: Date): void {
    const cutoff = addDays(localDay(now), -this.deps.expireAfterDays);
    for (const r of this.deps.store.receiptsByStatus('unmatched')) {
      if (r.date < cutoff) {
        this.deps.store.setStatus(r.messageId, 'expired', 'no ZenMoney transaction with this amount and date');
      }
    }
  }

  private isBackfill(r: ReceiptRow): boolean {
    return r.receivedAt < Number(this.deps.store.getKv(AUTO_SINCE_KV));
  }

  private match(): number {
    const { store } = this.deps;
    const claimed = store.claimedZmTxIds();
    let matched = 0;
    // Oldest first, so an earlier receipt claims the earlier of two equal charges.
    for (const r of store.receiptsByStatus('unmatched')) {
      const candidates = store.zmTxBetween(addDays(r.date, -7), addDays(r.date, 7));
      const m = findMatch(r, candidates, claimed);
      if (m && 'zmTxId' in m) {
        store.setMatch(r.messageId, m.zmTxId, this.isBackfill(r) ? 'review' : 'matched');
        claimed.add(m.zmTxId);
        matched++;
      } else if (m) {
        store.setStatus(r.messageId, 'unmatched', `${m.ambiguous.length} equal charges — can't tell which`);
      }
    }
    return matched;
  }

  /**
   * Decide a category for every matched receipt that has none yet: the
   * store's fixed category if the user set one, else the classifier's pick
   * among the candidate categories. An unsure pick, or no way to decide,
   * parks the receipt in review. A classifier hiccup leaves it undecided
   * (retried next run); a rejected token fails the run.
   */
  private async classifyPending(): Promise<void> {
    const { store, classifier, log } = this.deps;
    const labels = new Map(tagLabels(this.deps.mirror.tags()).map((t) => [t.id, t.label]));
    const options = store
      .candidates()
      .filter((c) => labels.has(c.tagId))
      .slice(0, MAX_OPTIONS)
      .map((c) => ({ id: c.tagId, name: labels.get(c.tagId) as string, hint: c.hint }));

    for (const r of store.receiptsByStatus('matched', 'review')) {
      if (r.tagSource !== null) {
        continue;
      }
      const storeTag = store.getStore(r.storeKey)?.tagId;
      if (storeTag) {
        store.setTag(r.messageId, storeTag, 'store', null);
        continue;
      }
      if (!classifier || options.length === 0) {
        store.setStatus(r.messageId, 'review', 'pick a category (no candidate categories for the classifier yet)');
        continue;
      }
      try {
        const pick = await classifier.classify({ store: r.store, items: r.items }, options);
        store.setTag(r.messageId, pick.id, 'jev', pick.confidence);
        if (pick.confidence < this.deps.minConfidence) {
          store.setStatus(r.messageId, 'review', `classifier unsure (${Math.round(pick.confidence * 100)}%)`);
        } else if (r.status === 'review' && !this.isBackfill(r)) {
          // Parked only because nothing could decide before; now something did.
          store.setStatus(r.messageId, 'matched');
        }
      } catch (err) {
        if (err instanceof JevError && (err.status === 401 || err.status === 403)) {
          throw err;
        }
        log.warn({ err, store: r.store }, 'classification failed, will retry');
      }
    }
  }

  /** Sets the category on each receipt's transaction in one ZenMoney write. */
  private async apply(receipts: readonly ReceiptRow[], approved: boolean): Promise<number> {
    const { store } = this.deps;
    const nowMs = this.deps.now().getTime();
    const nowSec = Math.floor(nowMs / 1000);

    const outgoing: ZmTransaction[] = [];
    const done: { receipt: ReceiptRow; status: 'applied' | 'unchanged'; tag: string; previous: string[] | null }[] = [];
    for (const r of receipts) {
      const fresh = store.getReceipt(r.messageId) ?? r;
      const tag = approved ? r.tagId : resolveTag(fresh, store);
      if (!tag || (!approved && (fresh.tagSource === null || fresh.status !== 'matched'))) {
        continue; // undecided or parked for review
      }
      const tx = fresh.zmTxId ? store.getZmTx(fresh.zmTxId) : null;
      if (!tx) {
        // The transaction vanished (deleted or re-imported in ZenMoney) — look again next run.
        store.setStatus(fresh.messageId, 'unmatched', 'matched transaction disappeared');
        continue;
      }
      const current = JSON.parse(tx.raw) as ZmTransaction;
      const updated = withCategory(current, tag, receiptComment(fresh), nowSec);
      if (updated) {
        outgoing.push(updated);
      }
      done.push({ receipt: fresh, status: updated ? 'applied' : 'unchanged', tag, previous: current.tag });
    }

    if (outgoing.length > 0) {
      await this.deps.mirror.sync(outgoing);
    }
    for (const d of done) {
      store.markApplied(d.receipt.messageId, { status: d.status, tag: d.tag, previousTags: d.previous }, nowMs);
    }
    return outgoing.length;
  }

  private async notifyTransition(result: RunResult, hint: string | null): Promise<void> {
    const { store, notifier, log } = this.deps;
    const wasOk = store.getKv(LAST_OK_KV) !== '0';
    store.setKv(LAST_OK_KV, result.ok ? '1' : '0');
    try {
      if (wasOk && !result.ok) {
        await notifier.failed(result.error ?? '', hint);
      } else if (!wasOk && result.ok) {
        await notifier.recovered();
      }
    } catch (err) {
      log.error({ err }, 'notification failed');
    }
  }
}
