import { describe, expect, it } from 'vitest';
import { MERCHANTS, receiptFor } from '../src/receipts.ts';
import { amazonOrderEmail, amazonRefundEmail, glovoOrderEmail, paypalReceiptEmail } from './fixtures.ts';

const glovo = MERCHANTS[0];

describe('Glovo order receipt', () => {
  it('takes the grand total — not item prices, struck-through prices, fees or VAT lines', () => {
    const r = glovo.parse(
      glovoOrderEmail({
        store: 'Shop A',
        date: new Date('2026-10-03T09:24:02Z'),
        total: '31,13',
        products: [
          { qty: 1, name: 'Item one 6 x 33 cl', price: '5,88' },
          { qty: 1, name: 'Item two 12u', price: '4,00', promo: '-20%', was: '5,00' },
        ],
      }),
    );
    expect(r?.totalCents).toBe(3113);
  });

  it('lists line items with quantities, decoding entities and ignoring options and promo rows', () => {
    const r = glovo.parse(
      glovoOrderEmail({
        store: 'Caf&eacute; &amp; Co&#174;',
        date: new Date('2026-09-10T16:51:04Z'),
        total: '23,10',
        products: [
          { qty: 1, name: 'Burger &quot;Big&quot;', price: '9,25' },
          { qty: 2, name: 'Nuggets', price: '13,85', options: 'Sauce A, Sauce B' },
          { qty: 1, name: 'Eggs 12u', price: '4,00', promo: '-20%', was: '5,00' },
        ],
      }),
    );
    expect(r?.store).toBe('Café & Co®');
    expect(r?.items).toEqual(['1x Burger "Big"', '2x Nuggets', '1x Eggs 12u']);
  });

  it('dates the receipt by the Madrid day, which is what the card charge carries', () => {
    const late = glovo.parse(
      glovoOrderEmail({ store: 'S', date: new Date('2026-07-01T22:30:00Z'), total: '10,00', products: [] }),
    );
    expect(late?.day).toBe('2026-07-02');
  });

  it('handles thousands separators in big orders', () => {
    const r = glovo.parse(
      glovoOrderEmail({ store: 'S', date: new Date('2026-07-01T10:00:00Z'), total: '1.234,50', products: [] }),
    );
    expect(r?.totalCents).toBe(123450);
  });

  it('rejects other Glovo mail rather than guessing', () => {
    const promo = {
      ...glovoOrderEmail({ store: 'S', date: new Date(), total: '1,00', products: [] }),
      subject: 'Your weekly offers',
    };
    expect(glovo.parse(promo)).toBeNull();
    const broken = {
      ...glovoOrderEmail({ store: 'S', date: new Date(), total: '1,00', products: [] }),
      html: '<p>new template</p>',
    };
    expect(glovo.parse(broken)).toBeNull();
  });
});

describe('Glovo Prime receipt (PayPal)', () => {
  it('reads the membership charge', () => {
    const r = glovo.parse(
      paypalReceiptEmail({ amount: '7.99', item: 'GLOVO PRIME', date: new Date('2026-10-03T00:06:07Z') }),
    );
    expect(r).toMatchObject({ store: 'Glovo Prime', totalCents: 799, day: '2026-10-03' });
  });

  it('ignores PayPal receipts for ordinary orders (the Glovo email covers those)', () => {
    expect(glovo.parse(paypalReceiptEmail({ amount: '31.13', item: 'Glovo order', date: new Date() }))).toBeNull();
  });
});

describe('receiptFor', () => {
  const r = (store: string, totalCents: number, day: string) => ({ store, items: [], totalCents, day });

  it('finds the receipt when the bank dates the charge a day later', () => {
    expect(
      receiptFor({ cents: 4048, day: '2026-09-07' }, [r('A', 4048, '2026-09-06'), r('B', 999, '2026-09-07')])?.store,
    ).toBe('A');
  });

  it('prefers the same day when the same amount appears on neighbouring days (e.g. a monthly membership)', () => {
    const list = [r('A', 799, '2026-10-02'), r('B', 799, '2026-10-03')];
    expect(receiptFor({ cents: 799, day: '2026-10-03' }, list)?.store).toBe('B');
  });

  it('gives up on two same-amount orders the same day instead of picking one at random', () => {
    expect(
      receiptFor({ cents: 799, day: '2026-10-03' }, [r('A', 799, '2026-10-03'), r('B', 799, '2026-10-03')]),
    ).toBeNull();
  });

  it('does not stretch to a receipt two days away or a cent off', () => {
    expect(
      receiptFor({ cents: 799, day: '2026-10-03' }, [r('A', 799, '2026-10-01'), r('B', 798, '2026-10-03')]),
    ).toBeNull();
  });
});

describe('Amazon receipts', () => {
  const amazon = MERCHANTS.find((m) => m.name === 'Amazon')!;

  it('reads the order total and item titles from the order email', () => {
    const r = amazon.parse(
      amazonOrderEmail({
        kind: 'Ordered',
        date: new Date('2026-09-23T07:25:00Z'),
        total: '57.98',
        items: [
          ['Item A replacement blades...', 1, '29.99'],
          ['Item B &amp; case...', 2, '13.99'],
        ],
      }),
    );
    expect(r).toEqual({
      store: 'Amazon',
      items: ['1x Item A replacement blades...', '2x Item B & case...'],
      totalCents: 5798,
      day: '2026-09-23',
    });
  });

  it('reads a refund as the item and the amount credited back', () => {
    const r = amazon.parse(
      amazonRefundEmail({ date: new Date('2026-08-15T15:20:00Z'), item: 'Item C party set', amount: '7,99' }),
    );
    expect(r).toMatchObject({ store: 'Amazon (refund)', items: ['1x Item C party set'], totalCents: 799 });
  });

  it('takes card charges of the shop but not the Prime membership (no order email exists for it)', () => {
    for (const p of ['www.amazon', 'Www.amazon* Nw4k66f04', 'AMZN Mktp ES', 'Amazon.es']) {
      expect(amazon.payee.test(p)).toBe(true);
    }
    expect(amazon.payee.test('Amazon Prime*na57e5v64')).toBe(false);
  });

  it('matches a charge made at dispatch, counting the "Ordered" and "Dispatched" copies of one order once', () => {
    const order = {
      kind: 'Ordered' as const,
      total: '57.98',
      items: [
        ['Item A', 1, '29.99'],
        ['Item B', 1, '27.99'],
      ] as [string, number, string][],
    };
    const receipts = [
      amazon.parse(amazonOrderEmail({ ...order, date: new Date('2026-09-24T07:00:00Z') }))!,
      amazon.parse(
        amazonOrderEmail({
          ...order,
          items: order.items.toReversed(),
          kind: 'Dispatched',
          date: new Date('2026-09-26T05:00:00Z'),
        }),
      )!,
    ];
    // Both copies are a day from the charge: still one order, not a tie.
    expect(receiptFor({ cents: 5798, day: '2026-09-25' }, receipts, amazon.maxDaysApart)?.items).toEqual([
      '1x Item A',
      '1x Item B',
    ]);
  });
});
