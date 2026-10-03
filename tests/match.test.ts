import { describe, expect, it } from 'vitest';
import { findMatch, withCategory } from '../src/match.ts';
import type { ZmTxRow } from '../src/storage/types.ts';
import type { ZmTransaction } from '../src/zenmoney/types.ts';

function tx(id: string, date: string, outcomeCents: number, incomeCents = 0): ZmTxRow {
  return { id, date, outcomeCents, incomeCents, payee: 'Paypal *glovo', raw: '{}' };
}

const receipt = { totalCents: 4048, date: '2026-09-06' };

describe('findMatch', () => {
  it('takes the same amount on the same or a nearby day', () => {
    expect(findMatch(receipt, [tx('a', '2026-09-08', 4048)], new Set())).toEqual({ zmTxId: 'a' });
  });

  it('prefers the closest date', () => {
    const r = findMatch(receipt, [tx('far', '2026-09-09', 4048), tx('near', '2026-09-06', 4048)], new Set());
    expect(r).toEqual({ zmTxId: 'near' });
  });

  it('reports a tie instead of guessing', () => {
    const r = findMatch(receipt, [tx('a', '2026-09-06', 4048), tx('b', '2026-09-06', 4048)], new Set());
    expect(r).toEqual({ ambiguous: ['a', 'b'] });
  });

  it('skips claimed transactions, other amounts, refunds and out-of-window dates', () => {
    const candidates = [
      tx('claimed', '2026-09-06', 4048),
      tx('cents-off', '2026-09-06', 4047),
      tx('refund', '2026-09-06', 0, 4048),
      tx('too-early', '2026-09-04', 4048),
      tx('too-late', '2026-09-12', 4048),
    ];
    expect(findMatch(receipt, candidates, new Set(['claimed']))).toBeNull();
  });
});

describe('withCategory', () => {
  const base: ZmTransaction = {
    id: 't',
    changed: 1,
    deleted: false,
    date: '2026-09-06',
    income: 0,
    outcome: 40.48,
    tag: ['old'],
    payee: 'Paypal *glovo',
    originalPayee: 'Paypal *glovo',
    comment: null,
    user: 1,
    incomeAccount: 'acc',
  };

  it('sets the category and fills an empty comment, keeping every other field', () => {
    expect(withCategory(base, 'tag-b', 'Glovo: Shop A', 99)).toEqual({
      ...base,
      tag: ['tag-b'],
      comment: 'Glovo: Shop A',
      changed: 99,
    });
  });

  it("keeps the user's own comment", () => {
    expect(withCategory({ ...base, comment: 'my own note' }, 'tag-b', 'Glovo: X', 99)?.comment).toBe('my own note');
  });

  it('is a no-op when the category is already right', () => {
    expect(withCategory({ ...base, tag: ['tag-b'] }, 'tag-b', 'Glovo: X', 99)).toBeNull();
  });
});
