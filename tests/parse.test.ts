import { describe, expect, it } from 'vitest';
import { decodeEntities, localDay, parseEuroAmount, parseReceipt } from '../src/receipts/parse.ts';
import { storeKey } from '../src/receipts/stores.ts';
import { glovoEmail, paypalEmail } from './helpers.ts';

describe('parseEuroAmount', () => {
  it.each([
    ['40,48', 4048],
    ['7.99', 799],
    ['1.234,50', 123450],
    ['1,234.50', 123450],
    ['12', 1200],
    ['12,5', 1250],
    ['31,13 €', 3113],
  ])('%s → %i', (raw, cents) => {
    expect(parseEuroAmount(raw)).toBe(cents);
  });

  it('rejects garbage', () => {
    expect(parseEuroAmount('No cost')).toBeNull();
  });
});

describe('localDay', () => {
  it('uses the Madrid calendar day', () => {
    // 23:30 UTC in summer is already the next day in Madrid.
    expect(localDay(new Date('2026-07-01T23:30:00Z'))).toBe('2026-07-02');
    expect(localDay(new Date('2026-07-01T12:00:00Z'))).toBe('2026-07-01');
  });
});

describe('decodeEntities', () => {
  it('handles named and numeric entities', () => {
    expect(decodeEntities('McDonald&#39;s &amp; Co&#x2122;')).toBe("McDonald's & Co™");
  });
});

describe('Glovo order email', () => {
  it('reads store, final total, items and local date', () => {
    const r = parseReceipt(
      glovoEmail({
        store: 'Shop A',
        items: [
          { qty: 1, name: 'Item one 3 kg', price: '33,49' },
          { qty: 2, name: 'Item two', price: '6,99' },
        ],
        total: '40,48',
        date: new Date('2026-09-06T18:10:57Z'),
        vatLines: true,
      }),
    );
    expect(r).toEqual({
      source: 'glovo',
      store: 'Shop A',
      totalCents: 4048,
      currency: 'EUR',
      date: '2026-09-06',
      reference: '100000000001',
      items: ['1x Item one 3 kg', '2x Item two'],
    });
  });

  it('ignores other Glovo mail', () => {
    const msg = glovoEmail({ store: 'X', items: [], total: '1,00', date: new Date() });
    expect(parseReceipt({ ...msg, subject: 'Your weekly offers' })).toBeNull();
  });
});

describe('PayPal Glovo Prime email', () => {
  it('reads the subscription charge', () => {
    const r = parseReceipt(paypalEmail({ amount: '7.99', item: 'GLOVO PRIME', date: new Date('2026-10-03T00:06:07Z') }));
    expect(r).toMatchObject({
      source: 'paypal-glovo-prime',
      store: 'Glovo Prime',
      totalCents: 799,
      date: '2026-10-03',
      reference: '1AB23456CD789012E',
    });
  });

  it('ignores PayPal receipts for ordinary orders (the Glovo email covers those)', () => {
    expect(parseReceipt(paypalEmail({ amount: '31.13', item: 'Glovo order', date: new Date() }))).toBeNull();
  });
});

describe('storeKey', () => {
  it('keys stores case-, accent- and ®-insensitively', () => {
    expect(storeKey('Café Ñandú')).toBe(storeKey('cafe nandu'));
    expect(storeKey('Brand®  Name')).toBe('brand name');
  });
});
