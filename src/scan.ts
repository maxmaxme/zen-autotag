import { findMail } from './gmail.ts';
import { classify, JevError, type Choice, type Option } from './jev.ts';
import { MERCHANTS, receiptFor, type Merchant, type Receipt } from './receipts.ts';
import { encode, escapeHtml, type Keyboard, type Telegram } from './telegram.ts';
import { isTransfer, tagLabel, type Tag, type Transaction, type ZenMoney } from './zenmoney.ts';

const DAY = 86_400_000;
/** New charges are looked for among transactions changed this recently. */
const WINDOW_DAYS = 14;
/** Payee history the classifier sees. */
const HISTORY_DAYS = 365;
/** A payee filed this many times… */
const HABIT_MIN_TIMES = 3;
/** …in one category at least this share of the time just gets that category — no AI, no message. */
const HABIT_SHARE = 0.9;

export interface Deps {
  zenmoney: ZenMoney;
  telegram: Telegram;
  chatId: string;
  jevToken: string;
  gmail: { user: string; appPassword: string } | null;
  /** Transactions dated before this are never touched. */
  startDate: string;
  /** Category label → plain-words hint for the classifier. */
  hints: Record<string, string>;
  /** At or above: applied silently. Below: you get a Telegram message to check it. */
  minConfidence: number;
  /** Below this the pick isn't applied at all — the category stays, you're asked. */
  applyConfidence: number;
  dryRun: boolean;
  log: (msg: string) => void;
}

/** Who the money went to or came from. Some bank lines carry no payee, only a description ("To Sam K", "Card fee"). */
export function counterparty(t: Pick<Transaction, 'payee' | 'originalPayee'> & { comment?: string | null }): string {
  return t.originalPayee || t.payee || t.comment || '';
}

/**
 * Same payee across statements → stable key: "Glovo 05aug Msh5tfdp",
 * "Www.amazon* Nw4k66f04", "Fee for: BALANCE-5805848335" (any token with a
 * long number in it is a reference, not a name).
 */
export function payeeKey(t: Parameters<typeof counterparty>[0]): string {
  return counterparty(t)
    .toLowerCase()
    .replace(/[*#]\s*[a-z0-9]{6,}$/, '')
    .replace(/\s\d{2}[a-z]{3}\s+[a-z0-9]+$/, '')
    .replace(/\S*\d{5,}\S*/g, '')
    .replace(/\s+/g, ' ')
    .replace(/[\s,:;.-]+$/, '')
    .trim();
}

function cents(t: Transaction): number {
  return Math.round((t.outcome > 0 ? t.outcome : t.income) * 100);
}

/** How the user filed this payee before: category → times and typical amount. */
export function payeeHistory(t: Transaction, all: readonly Transaction[], tags: readonly Tag[]) {
  const key = payeeKey(t);
  const from = new Date(Date.parse(`${t.date}T00:00:00Z`) - HISTORY_DAYS * DAY).toISOString().slice(0, 10);
  const byTag = new Map<string, number[]>();
  for (const o of all) {
    const tag = o.tag?.[0];
    if (o.id !== t.id && tag && !isTransfer(o) && o.date >= from && o.date <= t.date && payeeKey(o) === key) {
      byTag.set(tag, [...(byTag.get(tag) ?? []), cents(o) / 100]);
    }
  }
  return [...byTag]
    .toSorted((a, b) => b[1].length - a[1].length)
    .slice(0, 6)
    .map(([tagId, amounts]) => {
      const sorted = amounts.toSorted((a, b) => a - b);
      const tag = tags.find((x) => x.id === tagId);
      return {
        tagId,
        category: tag ? tagLabel(tag, tags) : tagId,
        times: amounts.length,
        typical_amount: sorted[Math.floor(sorted.length / 2)],
      };
    });
}

/**
 * Money in from someone you've paid before is a refund (or paying you back),
 * not income — in ZenMoney it goes to a spending category, as a return.
 */
export function paidBefore(t: Transaction, all: readonly Transaction[]): boolean {
  const key = payeeKey(t);
  return all.some((o) => o.id !== t.id && o.outcome > 0 && !isTransfer(o) && o.date <= t.date && payeeKey(o) === key);
}

/** The category this payee always gets, if the history is that clear-cut. */
export function habit(history: ReturnType<typeof payeeHistory>): string | null {
  const total = history.reduce((n, h) => n + h.times, 0);
  const top = history[0];
  return top && top.times >= HABIT_MIN_TIMES && top.times / total >= HABIT_SHARE ? top.tagId : null;
}

export function categoryOptions(income: boolean, tags: readonly Tag[], hints: Record<string, string>): Option[] {
  // Category names can carry stray spaces ("Name "); hint keys shouldn't have to.
  const byName = new Map(Object.entries(hints).map(([k, v]) => [k.trim(), v]));
  return tags
    .filter((t) => (income ? t.showIncome === true : t.showOutcome !== false))
    .map((t) => {
      const name = tagLabel(t, tags);
      return { id: t.id, name, hint: byName.get(name) ?? '' };
    });
}

function weekday(day: string): string {
  return new Date(`${day}T12:00:00Z`).toLocaleDateString('en-GB', { weekday: 'long', timeZone: 'UTC' });
}

/** Every receipt of the merchants involved, across all the charges' days, in one mailbox visit. */
async function receiptsFor(deps: Deps, charges: readonly Transaction[]): Promise<Map<Merchant, Receipt[]>> {
  const out = new Map<Merchant, Receipt[]>();
  if (!deps.gmail) {
    return out;
  }
  for (const m of MERCHANTS) {
    const days = charges
      .filter((t) => m.payee.test(t.originalPayee || t.payee || ''))
      .map((t) => t.date)
      .toSorted();
    const first = days[0];
    const last = days.at(-1);
    if (!first || !last) {
      continue;
    }
    const emails = await findMail(
      deps.gmail,
      m.gmailQueries,
      new Date(Date.parse(`${first}T00:00:00Z`) - m.maxDaysApart * DAY),
      new Date(Date.parse(`${last}T00:00:00Z`) + m.maxDaysApart * DAY),
    );
    const parsed = emails.map((e) => m.parse(e)).filter((r): r is Receipt => r !== null);
    if (emails.length > 0 && parsed.length === 0) {
      deps.log(`${m.name}: ${emails.length} email(s) found but none parsed — has the template changed?`);
    }
    out.set(m, parsed);
  }
  return out;
}

/** "Www.amazon* N44ou7at4" → "amazon"; dots get a word joiner so Telegram doesn't turn names into links. */
export function displayPayee(raw: string): string {
  const name = raw
    .replace(/^www\./i, '')
    .replace(/[*#]\s*[A-Za-z0-9]{6,}$/, '')
    .replace(/\s\d{2}[a-z]{3}\s+[A-Za-z0-9]+$/i, '')
    .replace(/[*\s]+$/, '')
    .trim();
  return (name || raw).replace(/\./g, '.\u2060');
}

function shortDate(day: string): string {
  return new Date(`${day}T12:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
}

/** Message lines: the "Category:" line is what taps rewrite. */
export function messageHtml(p: {
  title: string;
  /** e.g. "−10.99 €" */
  money: string;
  account: string;
  day: string;
  via: string | null;
  items: string[];
  /** The category the transaction has now (after this pass). */
  category: string;
  /** Jev's probability for that category. */
  probability: number;
  /** True when Jev didn't set it — it's what ZenMoney had. */
  kept: boolean;
  dryRun: boolean;
}): string {
  const lines = [
    `<b>${escapeHtml(p.title)}</b> · ${escapeHtml(p.money)} · ${escapeHtml(p.account)} · ${shortDate(p.day)}`,
  ];
  const details = [p.via ? `via ${p.via}` : '', p.items.slice(0, 3).join('; ') + (p.items.length > 3 ? ' …' : '')]
    .filter(Boolean)
    .join(' · ');
  if (details) {
    lines.push(`<i>${escapeHtml(details)}</i>`);
  }
  lines.push(
    `Category: <b>${escapeHtml(p.category)}</b> · ${Math.round(p.probability * 100)}%${p.kept ? ' (kept from ZenMoney)' : ''}`,
  );
  if (p.dryRun) {
    lines.push('<i>dry run — nothing written</i>');
  }
  return lines.join('\n');
}

/** Alternatives offered: Jev's categories at or above this probability… */
export const MIN_SUGGESTION = 0.2;
/** …at most this many. */
const MAX_SUGGESTIONS = 4;

/** Other likely categories than the current one, most likely first. */
export function suggestions(pick: Choice, currentId: string | null, labels: Map<string, string>) {
  return pick.ranked
    .filter((r) => r.id !== currentId && r.probability >= MIN_SUGGESTION)
    .flatMap((r) => {
      const label = labels.get(r.id);
      return label ? [{ id: r.id, label, probability: r.probability }] : [];
    })
    .slice(0, MAX_SUGGESTIONS);
}

/** ✓ OK keeps what's there; one button per alternative (full "Parent → Child" names fit); then the full list. */
export function choiceKeyboard(
  txId: string,
  alternatives: { id: string; label: string; probability: number }[],
): Keyboard {
  return [
    [{ text: '✓ OK', data: encode({ kind: 'ok', tx: txId }) }],
    ...alternatives.map((a) => [
      { text: `${a.label} · ${Math.round(a.probability * 100)}%`, data: encode({ kind: 'set', tx: txId, tag: a.id }) },
    ]),
    [{ text: 'Other category…', data: encode({ kind: 'other', tx: txId }) }],
  ];
}

/** Everything one pass needs to know about the account, fetched once. */
interface Context {
  all: Transaction[];
  tags: Tag[];
  labels: Map<string, string>;
  accounts: Map<string, { title: string; symbol: string }>;
  receipts: Map<Merchant, Receipt[]>;
}

/** What gets decided for one transaction. */
interface Decision {
  update: Transaction;
  message: { html: string; keyboard: Keyboard } | null;
  note: string;
}

/** New, unviewed spending or income since the start date that we haven't handled yet. */
export function newTransactions(
  transactions: readonly Transaction[],
  startDate: string,
  handled: Set<string>,
): Transaction[] {
  return transactions.filter(
    (t) =>
      !t.viewed &&
      !isTransfer(t) &&
      t.date >= startDate &&
      (t.outcome > 0 || t.income > 0) &&
      Boolean(counterparty(t)) &&
      !handled.has(t.id),
  );
}

async function loadContext(deps: Deps, todo: readonly Transaction[]): Promise<Context> {
  const everything = await deps.zenmoney.since(0); // payee history
  const symbols = new Map(everything.instruments.map((i) => [i.id, i.symbol || i.shortTitle]));
  return {
    all: everything.transactions,
    tags: everything.tags,
    labels: new Map(everything.tags.map((t) => [t.id, tagLabel(t, everything.tags)])),
    accounts: new Map(
      everything.accounts.map((a) => [
        a.id,
        { title: a.title, symbol: (a.instrument !== null && symbols.get(a.instrument)) || '' },
      ]),
    ),
    receipts: await receiptsFor(deps, todo),
  };
}

/** The category for one transaction: a clear-cut payee habit, else Jev. Null = Jev failed, retry later. */
async function choose(
  deps: Deps,
  ctx: Context,
  t: Transaction,
  state: Record<string, unknown>,
  hasReceipt: boolean,
  options: Option[],
): Promise<{ pick: Choice; habitual: boolean } | null> {
  const history = payeeHistory(t, ctx.all, ctx.tags);
  const usual = hasReceipt ? null : habit(history);
  if (usual) {
    return { pick: { id: usual, confidence: 1, ranked: [] }, habitual: true };
  }
  try {
    const pick = await classify(
      deps.jevToken,
      { ...state, how_i_filed_this_payee_before: history.map(({ tagId: _, ...h }) => h) },
      options,
    );
    return { pick, habitual: false };
  } catch (err) {
    if (err instanceof JevError && (err.status === 401 || err.status === 403)) {
      throw err;
    }
    deps.log(
      `classify failed for ${String(state.payee)}, retrying next pass: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}

/** The facts about one transaction: its receipt (if any), account and what Jev is shown. */
interface Facts {
  income: boolean;
  /** Money in that is really money back: offered spending categories. */
  refund: boolean;
  merchant: Merchant | undefined;
  receipt: Receipt | null;
  account: { title: string; symbol: string } | undefined;
  state: { payee: string | null; amount: number; [key: string]: unknown };
}

function gather(ctx: Context, t: Transaction): Facts {
  const income = t.outcome === 0;
  const refund = income && paidBefore(t, ctx.all);
  const merchant = MERCHANTS.find((m) => m.payee.test(t.originalPayee || t.payee || ''));
  const receipts = merchant ? (ctx.receipts.get(merchant) ?? []) : [];
  const receipt = merchant ? receiptFor({ cents: cents(t), day: t.date }, receipts, merchant.maxDaysApart) : null;
  const account = ctx.accounts.get(income ? t.incomeAccount : t.outcomeAccount);
  const state = {
    payee: counterparty(t),
    direction: income ? 'money in' : 'money out',
    amount: cents(t) / 100,
    account: account?.title ?? '',
    date: `${t.date} (${weekday(t.date)})`,
    ...(t.comment ? { bank_description: t.comment } : {}),
    ...(refund ? { looks_like: 'a refund: money back from a payee I have paid before' } : {}),
    ...(merchant ? { purchased_via: merchant.context } : {}),
    ...(receipt ? { receipt: { store: receipt.store, items: receipt.items } } : {}),
  };
  return { income, refund, merchant, receipt, account, state };
}

function notice(
  deps: Deps,
  ctx: Context,
  t: Transaction,
  f: Facts,
  category: { id: string | null; probability: number; kept: boolean },
  alternatives: ReturnType<typeof suggestions>,
) {
  return {
    html: messageHtml({
      title: f.receipt ? f.receipt.store : displayPayee(String(f.state.payee)),
      money: `${f.income ? '+' : '−'}${f.state.amount.toFixed(2)} ${f.account?.symbol ?? ''}`.trim(),
      account: f.account?.title ?? '',
      day: t.date,
      via: f.merchant && f.receipt ? f.merchant.name : null,
      items: f.receipt?.items ?? [],
      category: category.id ? (ctx.labels.get(category.id) ?? category.id) : 'none',
      probability: category.probability,
      kept: category.kept,
      dryRun: deps.dryRun,
    }),
    keyboard: choiceKeyboard(t.id, alternatives),
  };
}

async function decide(deps: Deps, ctx: Context, t: Transaction): Promise<Decision | null> {
  const f = gather(ctx, t);
  const options = categoryOptions(f.income && !f.refund, ctx.tags, deps.hints);
  const chosen = await choose(deps, ctx, t, f.state, f.receipt !== null, options);
  if (!chosen) {
    return null;
  }
  const { pick, habitual } = chosen;
  const apply = pick.confidence >= deps.applyConfidence;
  const currentId = apply ? pick.id : (t.tag?.[0] ?? null);
  const update: Transaction = {
    ...t,
    tag: currentId ? [currentId] : t.tag,
    viewed: true,
    comment: t.comment || (f.merchant && f.receipt ? `${f.merchant.name} · ${f.receipt.store}` : null),
    changed: Math.floor(Date.now() / 1000),
  };

  // Ask only when there's something to decide: a change Jev isn't sure of,
  // a real alternative, or no category at all.
  const alternatives = suggestions(pick, currentId, ctx.labels);
  const unsureChange = apply && !habitual && pick.confidence < deps.minConfidence;
  const probability = pick.ranked.find((r) => r.id === currentId)?.probability ?? 0;
  const message =
    unsureChange || alternatives.length > 0 || currentId === null
      ? notice(deps, ctx, t, f, { id: currentId, probability, kept: !apply }, alternatives)
      : null;
  const how = habitual ? 'habit' : pick.confidence.toFixed(2);
  return {
    update,
    message,
    note: `${t.date} ${String(f.state.payee)} ${f.state.amount} → ${ctx.labels.get(pick.id)} (${how})${apply ? '' : ' — kept'}`,
  };
}

/** Categories already reported as missing a hint — once per run is enough. */
const reported = new Set<string>();

/** One line in Telegram when a category has no hint in config.json, so you remember to add one. */
async function reportUnhinted(deps: Deps, tags: readonly Tag[]): Promise<void> {
  const options = [...categoryOptions(false, tags, deps.hints), ...categoryOptions(true, tags, deps.hints)];
  const fresh = [...new Set(options.filter((o) => !o.hint && !reported.has(o.name)).map((o) => o.name))];
  if (fresh.length > 0) {
    await deps.telegram.send(
      deps.chatId,
      `No hint in config.json for: ${fresh.map((n) => `<b>${escapeHtml(n)}</b>`).join(', ')}`,
      null,
      false,
    );
    fresh.forEach((n) => reported.add(n));
  }
}

/**
 * One pass: every new (unviewed) transaction since `startDate` gets a
 * category and is marked viewed — which is also how the next pass knows
 * it's done. Unsure or debatable ones are announced in Telegram with
 * buttons. `handled` remembers ids in dry-run mode, where nothing is marked.
 */
export async function scan(deps: Deps, handled: Set<string>): Promise<number> {
  const recent = await deps.zenmoney.since(Math.floor((Date.now() - WINDOW_DAYS * DAY) / 1000));
  await reportUnhinted(deps, recent.tags);
  const todo = newTransactions(recent.transactions, deps.startDate, handled);
  if (todo.length === 0) {
    return 0;
  }
  const ctx = await loadContext(deps, todo);
  const decisions: Decision[] = [];
  for (const t of todo) {
    const d = await decide(deps, ctx, t);
    if (d) {
      decisions.push(d);
      handled.add(t.id);
      deps.log(d.note);
    }
  }
  if (!deps.dryRun) {
    await deps.zenmoney.save(decisions.map((d) => d.update));
  }
  for (const d of decisions) {
    if (d.message) {
      await deps.telegram.send(deps.chatId, d.message.html, d.message.keyboard, false);
    }
  }
  return decisions.length;
}
