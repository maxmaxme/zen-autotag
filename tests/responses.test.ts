import { afterEach, describe, expect, it, vi } from 'vitest';
import { classify, JevError } from '../src/jev.ts';
import { Telegram } from '../src/telegram.ts';
import { ZenMoney, ZenMoneyError } from '../src/zenmoney.ts';
import { requestBody } from './helpers.ts';

// What comes back from the three APIs is checked, not trusted.

const ID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

/** Stubs fetch with the given JSON bodies in order; returns the request bodies sent. */
function respond(...bodies: unknown[]) {
  const sent: Record<string, unknown>[] = [];
  vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
    sent.push(JSON.parse(requestBody(init)));
    return new Response(JSON.stringify(bodies.shift()), { status: 200 });
  });
  return sent;
}

afterEach(() => vi.unstubAllGlobals());

const transaction = {
  id: ID(1),
  changed: 1,
  created: 1,
  deleted: false,
  viewed: false,
  date: '2026-10-01',
  income: 0,
  outcome: 5,
  incomeAccount: ID(9),
  outcomeAccount: ID(9),
  tag: null,
  comment: null,
  qrCode: 'kept', // a field the service doesn't know about
};

describe('ZenMoney', () => {
  it('keeps fields it does not know (they are written back) and reads a missing payee as none', async () => {
    respond({ transaction: [transaction], tag: [{ id: ID(2), title: 'Food' }] });
    const s = await new ZenMoney('t', 'ru').since(0);
    expect(s.transactions[0]).toMatchObject({ qrCode: 'kept', payee: null, originalPayee: null });
    expect(s.tags[0]).toMatchObject({ title: 'Food', parent: null });
  });

  it('a malformed transaction fails the whole fetch rather than being half-read', async () => {
    respond({ transaction: [{ ...transaction, outcome: '5' }] });
    await expect(new ZenMoney('t', 'ru').since(0)).rejects.toThrow(ZenMoneyError);
  });

  it('an error object sent with HTTP 200 is still an error', async () => {
    respond({ error: { code: 'Unauthorized', message: 'token expired' } });
    await expect(new ZenMoney('t', 'ru').since(0)).rejects.toThrow('token expired');
  });
});

describe('Jev', () => {
  const options = [
    { id: ID(1), name: 'Food' },
    { id: ID(2), name: 'Gifts' },
  ];
  const answer = (category: object) => ({ answers: { category } });

  it('maps the answer back to category ids, most likely first', async () => {
    respond(answer({ choice: 'Gifts', confidence: 0.7, probabilities: { Food: 0.2, Gifts: 0.8 } }));
    expect(await classify('t', {}, options)).toEqual({
      id: ID(2),
      confidence: 0.7,
      ranked: [
        { id: ID(2), probability: 0.8 },
        { id: ID(1), probability: 0.2 },
      ],
    });
  });

  it('an answer without a confidence, or naming no offered category, is an error — never a guess', async () => {
    respond(answer({ choice: 'Food' }), answer({ choice: 'Travel', confidence: 0.9 }));
    await expect(classify('t', {}, options)).rejects.toThrow(JevError);
    await expect(classify('t', {}, options)).rejects.toThrow(JevError);
  });
});

describe('Telegram', () => {
  it('passes on how long Telegram asks to wait when rate-limited', async () => {
    respond({
      ok: false,
      error_code: 429,
      description: 'Too Many Requests: retry after 5',
      parameters: { retry_after: 5 },
    });
    await expect(new Telegram('t').taps(1)).rejects.toMatchObject({ name: 'TelegramError', retryAfter: 5 });
  });

  it('skips an update it cannot read and moves past it, so polling never gets stuck', async () => {
    const message = { message_id: 7, chat: { id: 42 }, text: 'hi' };
    const sent = respond(
      {
        ok: true,
        result: [
          { update_id: 10, callback_query: { id: 'a', message } }, // no data
          { update_id: 11, callback_query: { id: 'b', data: 'k|x', message } },
        ],
      },
      { ok: true, result: [] },
    );
    const telegram = new Telegram('t');
    const taps = await telegram.taps(1);
    expect(taps).toEqual([{ id: 'b', chatId: 42, messageId: 7, text: 'hi', keyboard: [], data: 'k|x' }]);
    await telegram.taps(1);
    expect(sent[1]).toMatchObject({ offset: 12 });
  });
});
