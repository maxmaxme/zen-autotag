import { describe, expect, it } from 'vitest';
import { choiceKeyboard } from '../src/scan.ts';
import { handleTap, type TapDeps } from '../src/taps.ts';
import { decode, encode, type Keyboard, type Tap } from '../src/telegram.ts';
import type { Snapshot, Tag, Transaction } from '../src/zenmoney.ts';

const ID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const tags: Tag[] = [
  { id: ID(1), title: 'Food', parent: null, showOutcome: true },
  { id: ID(2), title: 'Gifts', parent: null, showOutcome: true },
  { id: ID(3), title: 'Salary', parent: null, showIncome: true, showOutcome: false },
];
const txId = ID(500);
const transaction: Transaction = {
  id: txId,
  changed: 1,
  created: 1,
  deleted: false,
  viewed: true,
  date: '2026-10-01',
  income: 0,
  outcome: 9.6,
  incomeAccount: ID(9),
  outcomeAccount: ID(9),
  tag: [ID(1)],
  payee: 'Shop',
  originalPayee: 'Shop',
  comment: null,
  merchant: ID(77),
};
const TEXT = 'Shop · −9.60 € · Card · 1 Oct\nCategory: Food · 40%';

function setup(known: Transaction[] = [transaction]) {
  const saved: Transaction[] = [];
  const edits: { html: string; keyboard: Keyboard | null }[] = [];
  const answers: (string | undefined)[] = [];
  const deps: TapDeps = {
    zenmoney: {
      since: async (): Promise<Snapshot> => ({ transactions: known, tags, accounts: [], instruments: [] }),
      save: async (t: Transaction[]) => void saved.push(...t),
    },
    telegram: {
      edit: async (_tap: Tap, html: string, keyboard: Keyboard | null) => void edits.push({ html, keyboard }),
      answer: async (_tap: Tap, text?: string) => void answers.push(text),
    },
    chatId: '42',
    hints: {},
    dryRun: false,
  };
  const keyboard = choiceKeyboard(txId, [{ id: ID(2), label: 'Gifts', probability: 0.35 }]);
  const tap = (data: string, kb: Keyboard = keyboard, chatId = 42): Tap => ({
    id: 'q',
    chatId,
    messageId: 7,
    text: TEXT,
    keyboard: kb,
    data,
  });
  return { deps, saved, edits, answers, tap, keyboard };
}

const labels = (kb: Keyboard | null | undefined) => (kb ?? []).map((r) => r.map((b) => b.text).join(' | '));

describe('button taps', () => {
  it('OK settles the message: buttons gone, nothing written', async () => {
    const s = setup();
    await handleTap(s.deps, s.tap(encode({ kind: 'ok', tx: txId })));
    expect(s.saved).toEqual([]);
    expect(s.edits[0]).toEqual({ html: 'Shop · −9.60 € · Card · 1 Oct\nCategory: Food · 40% ✓', keyboard: null });
  });

  it('picking a category writes it (keeping every other field and viewed) and settles the message', async () => {
    const s = setup();
    await handleTap(s.deps, s.tap(encode({ kind: 'set', tx: txId, tag: ID(2) })));
    expect(s.saved).toEqual([{ ...transaction, tag: [ID(2)], changed: expect.any(Number) }]);
    expect(s.edits[0]?.html).toBe('Shop · −9.60 € · Card · 1 Oct\nCategory: <b>Gifts</b> ✏️');
    expect(s.edits[0]?.keyboard).toBeNull();
  });

  it('Other shows every matching category under the original buttons, and Back restores them', async () => {
    const s = setup();
    await handleTap(s.deps, s.tap(encode({ kind: 'other', tx: txId })));
    const expanded = s.edits[0]!.keyboard!;
    expect(labels(expanded)).toEqual(['✓ OK', 'Gifts · 35%', '« Back', 'Food', 'Gifts']); // no income category for an expense

    const back = expanded.flat().find((b) => decode(b.data)?.kind === 'back')!;
    await handleTap(s.deps, s.tap(back.data, expanded));
    expect(labels(s.edits[1]!.keyboard)).toEqual(labels(s.keyboard));
  });

  it('Other on money in lists spending categories too — a refund goes there', async () => {
    const s = setup([{ ...transaction, outcome: 0, income: 9.6 }]);
    await handleTap(s.deps, s.tap(encode({ kind: 'other', tx: txId })));
    expect(labels(s.edits[0]!.keyboard).slice(3)).toEqual(['Food', 'Gifts', 'Salary']);
  });

  it('ignores taps from any other chat', async () => {
    const s = setup();
    await handleTap(s.deps, s.tap(encode({ kind: 'set', tx: txId, tag: ID(2) }), undefined, 999));
    expect(s.saved).toEqual([]);
    expect(s.edits).toEqual([]);
  });

  it('says so when the transaction is too old to find', async () => {
    const s = setup([]);
    await handleTap(s.deps, s.tap(encode({ kind: 'set', tx: txId, tag: ID(2) })));
    expect(s.saved).toEqual([]);
    expect(s.answers[0]).toMatch(/too old/i);
  });

  it('dry run edits the message but writes nothing', async () => {
    const s = setup();
    s.deps.dryRun = true;
    await handleTap(s.deps, s.tap(encode({ kind: 'set', tx: txId, tag: ID(2) })));
    expect(s.saved).toEqual([]);
    expect(s.edits).toHaveLength(1);
  });

  it('every button fits Telegram’s 64-byte callback limit', () => {
    for (const data of [
      encode({ kind: 'set', tx: txId, tag: ID(2) }),
      encode({ kind: 'other', tx: txId }),
      encode({ kind: 'back', tx: txId }),
      encode({ kind: 'ok', tx: txId }),
    ]) {
      expect(Buffer.byteLength(data)).toBeLessThanOrEqual(64);
    }
  });
});
