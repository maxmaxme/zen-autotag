import { afterEach, describe, expect, it, vi } from 'vitest';
import { habit, payeeHistory, payeeKey, scan, type Deps } from '../src/scan.ts';
import type { Keyboard } from '../src/telegram.ts';
import type { Snapshot, Tag, Transaction } from '../src/zenmoney.ts';

// Neutral, made-up data only (public repo).
const ID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const FOOD = ID(1);
const OUT = ID(2);
const GROCERIES = ID(3);
const EMOJI = ID(4);
const SALARY = ID(5);
const tags: Tag[] = [
  { id: FOOD, title: 'Food', parent: null, showOutcome: true },
  { id: OUT, title: 'Out', parent: FOOD, showOutcome: true },
  { id: GROCERIES, title: 'Groceries', parent: FOOD, showOutcome: true },
  { id: EMOJI, title: '🎈 ', parent: null, showOutcome: true }, // stray space, as real names sometimes have
  { id: SALARY, title: 'Salary', parent: null, showIncome: true, showOutcome: false },
];
const CARD = ID(100);
const SAVINGS = ID(101);

let seq = 1000;
function tx(over: Partial<Transaction> = {}): Transaction {
  return {
    id: ID(seq++),
    changed: 1,
    created: 1,
    deleted: false,
    viewed: false,
    date: '2026-10-01',
    income: 0,
    outcome: 5,
    incomeAccount: CARD,
    outcomeAccount: CARD,
    tag: null,
    payee: 'New Shop',
    originalPayee: 'New Shop',
    comment: null,
    ...over,
  };
}

type JevReply = { choice: string; confidence: number; probabilities?: Record<string, number> } | number;

/** Stubs fetch for Jev: answers in order (a number = that HTTP error status); records request bodies. */
function jev(...replies: JevReply[]) {
  const requests: { state: Record<string, unknown>; criteria: Record<string, string | null> }[] = [];
  vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    requests.push({ state: body.state, criteria: body.questions.category.criteria });
    const r = replies.shift() ?? { choice: 'Food', confidence: 1 };
    return typeof r === 'number'
      ? new Response('{"detail":"nope"}', { status: r })
      : Response.json({ answers: { category: { probabilities: { [r.choice]: r.confidence }, ...r } } });
  });
  return requests;
}

function setup(recent: Transaction[], history: Transaction[] = []) {
  const snapshot = (transactions: Transaction[]): Snapshot => ({
    transactions,
    tags,
    accounts: [
      { id: CARD, title: 'Card', instrument: 3 },
      { id: SAVINGS, title: 'Savings', instrument: 3 },
    ],
    instruments: [{ id: 3, shortTitle: 'EUR', symbol: '€' }],
  });
  const saved: Transaction[] = [];
  const sent: { html: string; keyboard: Keyboard | null }[] = [];
  const deps: Deps = {
    zenmoney: {
      since: async (sec: number) => snapshot(sec === 0 ? [...recent, ...history] : recent),
      save: async (t: Transaction[]) => void saved.push(...t),
    } as unknown as Deps['zenmoney'],
    telegram: {
      send: async (_chat: string, html: string, keyboard: Keyboard | null) => void sent.push({ html, keyboard }),
    } as unknown as Deps['telegram'],
    chatId: '1',
    jevToken: 't',
    gmail: null,
    startDate: '2026-09-01',
    hints: {
      '🎈': 'party supplies',
      Food: 'meals',
      'Food → Out': 'eating out',
      'Food → Groceries': 'shop food',
      Salary: 'pay',
    },
    minConfidence: 0.8,
    applyConfidence: 0.5,
    dryRun: false,
    log: () => {},
  };
  return { deps, saved, sent };
}

afterEach(() => vi.unstubAllGlobals());

describe('what scan touches', () => {
  it('leaves viewed transactions, transfers and anything before the start date alone', async () => {
    const { deps, saved } = setup([
      tx({ viewed: true }),
      tx({ incomeAccount: SAVINGS, income: 5 }), // own transfer
      tx({ date: '2026-08-31' }),
      tx({ payee: null, originalPayee: null }), // hand-entered, nothing to go on
    ]);
    const requests = jev();
    expect(await scan(deps, new Set())).toBe(0);
    expect(requests).toEqual([]);
    expect(saved).toEqual([]);
  });

  it('writes the whole transaction back — unknown fields survive — with category, viewed and a fresh changed', async () => {
    const t = tx({ merchant: ID(77), latitude: 40.4, incomeBankID: 'abc', qrCode: null });
    const { deps, saved } = setup([t]);
    jev({ choice: 'Food → Groceries', confidence: 0.95 });
    await scan(deps, new Set());
    expect(saved).toHaveLength(1);
    expect(saved[0]).toEqual({ ...t, tag: [GROCERIES], viewed: true, changed: expect.any(Number) });
    expect(saved[0]!.changed).toBeGreaterThan(t.changed);
  });

  it("never overwrites the user's comment", async () => {
    const t = tx({ comment: 'for the party' });
    const { deps, saved } = setup([t]);
    jev({ choice: '🎈', confidence: 0.9 });
    await scan(deps, new Set());
    expect(saved[0]?.comment).toBe('for the party');
  });

  it('offers income categories for money in, expense categories for money out', async () => {
    const { deps } = setup([tx({ outcome: 0, income: 2000, payee: 'Employer' })]);
    const requests = jev({ choice: 'Salary', confidence: 0.99 });
    await scan(deps, new Set());
    expect(Object.keys(requests[0]!.criteria)).toEqual(['Salary']);
    expect(requests[0]!.state).toMatchObject({ direction: 'money in', amount: 2000 });
  });

  it('money back from a payee you have paid is a refund: spending categories, flagged for Jev', async () => {
    const paid = tx({ viewed: true, payee: 'Shop', originalPayee: 'Shop', tag: [GROCERIES], date: '2026-08-01' });
    const { deps } = setup([tx({ outcome: 0, income: 3, payee: 'Shop', originalPayee: 'Shop' })], [paid]);
    const requests = jev({ choice: 'Food → Groceries', confidence: 0.9 });
    await scan(deps, new Set());
    expect(Object.keys(requests[0]!.criteria)).toContain('Food → Groceries');
    expect(Object.keys(requests[0]!.criteria)).not.toContain('Salary');
    expect(requests[0]!.state.looks_like).toMatch(/refund/);
  });

  it('gives Jev the readable category names, the user hints and the payee history', async () => {
    const past = [
      tx({ viewed: true, payee: 'Cafe', originalPayee: 'Cafe', tag: [OUT], date: '2026-08-01', outcome: 4 }),
    ];
    const { deps } = setup([tx({ payee: 'Cafe', originalPayee: 'Cafe' })], past);
    const requests = jev({ choice: 'Food → Out', confidence: 0.9 });
    await scan(deps, new Set());
    expect(requests[0]!.criteria).toMatchObject({ 'Food → Out': 'eating out', '🎈': 'party supplies' });
    expect(requests[0]!.state.how_i_filed_this_payee_before).toEqual([
      { category: 'Food → Out', times: 1, typical_amount: 4 },
    ]);
  });
});

describe('categories without a hint', () => {
  it('are named in one message, once', async () => {
    const { deps, sent } = setup([]);
    delete deps.hints.Salary;
    delete deps.hints['Food → Groceries'];
    await scan(deps, new Set());
    await scan(deps, new Set());
    expect(sent.map((m) => m.html)).toEqual(['No hint in config.json for: <b>Food → Groceries</b>, <b>Salary</b>']);
  });
});

describe('habits', () => {
  it('a payee filed the same way 3+ times gets that category with no AI call and no message', async () => {
    const past = [1, 2, 3].map(() =>
      tx({ viewed: true, payee: 'Cafe', originalPayee: 'Cafe', tag: [OUT], date: '2026-08-01' }),
    );
    const { deps, saved, sent } = setup([tx({ payee: 'Cafe', originalPayee: 'Cafe', tag: [GROCERIES] })], past);
    const requests = jev();
    await scan(deps, new Set());
    expect(requests).toEqual([]);
    expect(saved[0]).toMatchObject({ tag: [OUT], viewed: true });
    expect(sent).toEqual([]);
  });

  it('statement variants of one payee count as the same payee', () => {
    expect(payeeKey({ payee: null, originalPayee: 'Www.shop* Nw4k66f04' })).toBe(
      payeeKey({ payee: null, originalPayee: 'www.shop' }),
    );
    expect(payeeKey({ payee: null, originalPayee: 'Shop 05aug Msh5tfdp' })).toBe(
      payeeKey({ payee: null, originalPayee: 'Shop 21aug Mynbcrfc' }),
    );
  });

  it('a line with no payee is known by its bank description, minus reference numbers', () => {
    const fee = (ref: string) => payeeKey({ payee: null, originalPayee: null, comment: `Card fee for: REF-${ref}` });
    expect(fee('5805848335')).toBe(fee('5918815368'));
    expect(payeeKey({ payee: null, originalPayee: null, comment: 'To Sam K' })).not.toBe(
      payeeKey({ payee: null, originalPayee: null, comment: 'To Alex P' }),
    );
  });

  it('lines with no payee are not one big payee: each description has its own history', async () => {
    const toSam = (over: Partial<Transaction> = {}) =>
      tx({ payee: null, originalPayee: null, comment: 'To Sam K', ...over });
    const past = [
      ...[1, 2, 3].map(() => toSam({ viewed: true, tag: [OUT], date: '2026-08-01' })),
      ...[1, 2, 3, 4].map(() =>
        tx({ payee: null, originalPayee: null, comment: 'Card fee', viewed: true, tag: [EMOJI], date: '2026-08-01' }),
      ),
    ];
    const { deps, saved } = setup([toSam()], past);
    const requests = jev();
    await scan(deps, new Set());
    expect(requests).toEqual([]); // habit, no AI
    expect(saved[0]).toMatchObject({ tag: [OUT], viewed: true, comment: 'To Sam K' });
  });

  it('mixed history is not a habit', () => {
    const t = tx({ payee: 'Shop', originalPayee: 'Shop' });
    const past = [
      ...[1, 2, 3].map(() => tx({ payee: 'Shop', originalPayee: 'Shop', tag: [OUT], date: '2026-08-01' })),
      tx({ payee: 'Shop', originalPayee: 'Shop', tag: [GROCERIES], date: '2026-08-02' }),
    ];
    expect(habit(payeeHistory(t, past, tags))).toBeNull(); // 3 of 4 = 75%
  });
});

describe('confidence', () => {
  it('sure: applies silently', async () => {
    const { deps, saved, sent } = setup([tx()]);
    jev({ choice: 'Food → Out', confidence: 0.85 });
    await scan(deps, new Set());
    expect(saved[0]?.tag).toEqual([OUT]);
    expect(sent).toEqual([]);
  });

  it('somewhat sure: applies and asks', async () => {
    const { deps, saved, sent } = setup([tx()]);
    jev({ choice: 'Food → Out', confidence: 0.6, probabilities: { 'Food → Out': 0.6, 'Food → Groceries': 0.3 } });
    await scan(deps, new Set());
    expect(saved[0]?.tag).toEqual([OUT]);
    expect(sent[0]?.html).toContain('Category: <b>Food → Out</b> · 60%');
    expect(sent[0]?.keyboard?.map((r) => r[0]?.text)).toEqual(['✓ OK', 'Food → Groceries · 30%', 'Other category…']);
  });

  it('unsure: keeps what ZenMoney had, but marks it viewed and asks', async () => {
    const { deps, saved, sent } = setup([tx({ tag: [EMOJI] })]);
    jev({ choice: 'Food → Out', confidence: 0.3, probabilities: { 'Food → Out': 0.4, '🎈': 0.1 } });
    await scan(deps, new Set());
    expect(saved[0]).toMatchObject({ tag: [EMOJI], viewed: true });
    expect(sent[0]?.html).toContain('Category: <b>🎈</b> · 10% (kept from ZenMoney)');
  });

  it('unsure with no real alternative: no message — nothing to decide', async () => {
    const { deps, sent } = setup([tx({ tag: [EMOJI] })]);
    jev({ choice: 'Food → Out', confidence: 0.1, probabilities: { 'Food → Out': 0.12, '🎈': 0.1 } });
    await scan(deps, new Set());
    expect(sent).toEqual([]);
  });
});

describe('failures', () => {
  it('a Jev hiccup skips only that transaction; the rest are saved and it is retried next pass', async () => {
    const a = tx({ payee: 'A', originalPayee: 'A' });
    const b = tx({ payee: 'B', originalPayee: 'B' });
    const { deps, saved } = setup([a, b]);
    jev(503, { choice: 'Food', confidence: 0.9 });
    const handled = new Set<string>();
    expect(await scan(deps, handled)).toBe(1);
    expect(saved.map((t) => t.id)).toEqual([b.id]);
    expect(handled.has(a.id)).toBe(false);
  });

  it('a rejected Jev token stops the pass and writes nothing', async () => {
    const { deps, saved } = setup([tx(), tx()]);
    jev(401);
    await expect(scan(deps, new Set())).rejects.toThrow(/401/);
    expect(saved).toEqual([]);
  });

  it('dry run writes nothing and does not ask again for the same transaction', async () => {
    const { deps, saved } = setup([tx()]);
    const requests = jev({ choice: 'Food', confidence: 0.9 }, { choice: 'Food', confidence: 0.9 });
    deps.dryRun = true;
    const handled = new Set<string>();
    await scan(deps, handled);
    await scan(deps, handled);
    expect(saved).toEqual([]);
    expect(requests).toHaveLength(1);
  });
});
