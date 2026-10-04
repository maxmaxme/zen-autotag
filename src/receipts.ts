import { parse, type HTMLElement } from 'node-html-parser';
import type { Email } from './gmail.ts';

/** What a receipt adds to a charge: where it was bought and what. */
export interface Receipt {
  store: string;
  items: string[];
  totalCents: number;
  /** Local (Madrid) calendar day — the same day the card charge carries. */
  day: string;
}

/**
 * A merchant whose card charges all look alike and whose emailed receipts
 * tell them apart. Add Amazon etc. as another entry.
 */
export interface Merchant {
  name: string;
  /** Which ZenMoney payees are this merchant's charges. */
  payee: RegExp;
  /** Told to the classifier along with the receipt. */
  context: string;
  /** Gmail searches that find its receipts. Gmail matches whole words. */
  gmailQueries: string[];
  /** How many days a charge may be from its receipt (Amazon charges at dispatch). */
  maxDaysApart: number;
  parse(email: Email): Receipt | null;
}

export function localDay(d: Date, timeZone = 'Europe/Madrid'): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}

/** "40,48", "7.99", "1.234,50", "1,234.50" → cents. */
function euroCents(raw: string): number | null {
  const s = raw.replaceAll(/[\s  €]|EUR/g, '');
  const m = /^(\d{1,3}(?:[.,]\d{3})*|\d+)(?:[.,](\d{1,2}))?$/.exec(s);
  if (!m) {
    return null;
  }
  return Number((m[1] ?? '0').replaceAll(/[.,]/g, '')) * 100 + Number((m[2] ?? '').padEnd(2, '0'));
}

// Receipts are read as HTML documents, not with regexes over markup: the
// parser is linear on any input (anyone can email a look-alike receipt) and
// the rules below name what they look for — a cell, its neighbour, a class.

/** The element's text, entities decoded, whitespace collapsed. */
function textOf(el: HTMLElement | null | undefined): string {
  return (el?.text ?? '').replaceAll(/\s+/g, ' ').trim();
}

/** The value next to a label cell: `<td>Total</td><td>40,48 €</td>` → "40,48 €". */
function cellAfter(root: HTMLElement, label: string): string | null {
  const cell = root.querySelectorAll('td').find((td) => textOf(td) === label);
  return cell?.nextElementSibling ? textOf(cell.nextElementSibling) : null;
}

/** Glovo "Details of your order" — sent after delivery, so the total is final. */
function parseGlovoOrder(email: Email): Receipt | null {
  if (!/@glovoapp\.com/i.test(email.from) || !/details of your order/i.test(email.subject)) {
    return null;
  }
  const root = parse(email.html);
  const store = textOf(root.querySelector('td.header__subtitle strong'));
  // The bold grand total ("Total taxable base …" is a different cell).
  const total = cellAfter(root, 'Total');
  const totalCents = total ? euroCents(total) : null;
  if (!store || totalCents === null) {
    return null;
  }
  const items = root.querySelectorAll('td.product').flatMap((product) => {
    // The name is the first cell inside; an item the shop didn't have is struck
    // through there ("Not available — you weren't charged") and isn't in the total.
    const name = product.querySelector('td');
    const qty = /^(\d+)x$/.exec(textOf(product.previousElementSibling))?.[1];
    return name && qty && !name.classList.contains('strikethrough') && textOf(name) ? [`${qty}x ${textOf(name)}`] : [];
  });
  return { store, items, totalCents, day: localDay(email.date) };
}

/** PayPal's receipt for the Glovo Prime membership (Glovo itself sends none). */
function parseGlovoPrime(email: Email): Receipt | null {
  if (!/paypal\./i.test(email.from) || !/glovo/i.test(email.subject) || !/GLOVO PRIME/i.test(email.html)) {
    return null;
  }
  // Subject: "GLOVOAPP23 SL: €7.99 EUR"
  const amount = /:\s*(?:€|EUR)?\s*([\d.,]+)/.exec(email.subject.replaceAll(/[  ]/g, ' '))?.[1];
  const totalCents = amount ? euroCents(amount) : null;
  if (totalCents === null) {
    return null;
  }
  return {
    store: 'Glovo Prime',
    items: ['1x Glovo Prime membership (monthly)'],
    totalCents,
    day: localDay(email.date),
  };
}

/** Amazon "Ordered:" / "Dispatched:" emails: each item is a linked title, then "Quantity: N"; then the total. */
function parseAmazonOrder(email: Email): Receipt | null {
  if (!/@amazon\./i.test(email.from) || !/^(ordered|dispatched|shipped)\b/i.test(email.subject)) {
    return null;
  }
  const root = parse(email.html);
  const total = cellAfter(root, 'Total');
  const totalCents = total ? euroCents(total) : null;
  if (totalCents === null) {
    return null;
  }
  const items: string[] = [];
  let title: string | null = null; // the last link seen: an item's title if a quantity follows
  for (const el of root.querySelectorAll('a, span')) {
    const quantity = /^Quantity: (\d+)$/.exec(textOf(el))?.[1];
    if (el.tagName === 'A') {
      title = textOf(el).length >= 3 ? textOf(el) : null;
    } else if (quantity && title) {
      items.push(`${quantity}x ${title}`);
      title = null;
    }
  }
  return { store: 'Amazon', items, totalCents, day: localDay(email.date) };
}

/** Amazon refund notice: "Item: …" lines and the amount credited back. */
function parseAmazonRefund(email: Email): Receipt | null {
  if (!/@amazon\./i.test(email.from) || !/^refund\b/i.test(email.subject)) {
    return null;
  }
  const lines = parse(email.html)
    .structuredText.split('\n')
    .map((l) => l.replaceAll(/\s+/g, ' ').trim());
  const items = lines.flatMap((l) => (l.startsWith('Item: ') ? [`1x ${l.slice('Item: '.length)}`] : []));
  // "Your refund is being credited as follows:" then "Visa Credit Card […]: 7,99 €".
  const from = lines.findIndex((l) => /credited as follows/i.test(l));
  const credited = from === -1 ? undefined : lines.slice(from).find((l) => /: ?[\d.,]+ ?€$/.test(l));
  const amount = credited ? /([\d.,]+) ?€$/.exec(credited)?.[1] : undefined;
  const totalCents = amount ? euroCents(amount) : null;
  return totalCents === null ? null : { store: 'Amazon (refund)', items, totalCents, day: localDay(email.date) };
}

export const MERCHANTS: Merchant[] = [
  {
    name: 'Glovo',
    payee: /glovo/i,
    context: 'Glovo — food, grocery and convenience delivery app',
    gmailQueries: ['from:no-reply@glovoapp.com subject:"Details of your order"', 'from:paypal "GLOVO PRIME"'],
    maxDaysApart: 1,
    parse: (email) => parseGlovoOrder(email) ?? parseGlovoPrime(email),
  },
  {
    name: 'Amazon',
    // Not "Amazon Prime*…" — the membership has no order email; its history decides.
    payee: /^(?!amazon prime)(?:www\.)?(?:amazon|amzn)/i,
    context: 'Amazon.es — online marketplace that sells almost anything',
    gmailQueries: [
      'from:auto-confirm@amazon.es',
      'from:confirmar-envio@amazon.es',
      'from:payments-messages@amazon.es subject:refund',
    ],
    maxDaysApart: 3,
    parse: (email) => parseAmazonOrder(email) ?? parseAmazonRefund(email),
  },
];

function daysApart(a: string, b: string): number {
  return Math.abs(Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86_400_000;
}

/**
 * The receipt behind a charge: same amount to the cent, the closest day
 * within `maxDays`. Copies of one order (Amazon's "Ordered" and
 * "Dispatched") count once. A tie between different orders → none; the
 * classifier then works from the payee history alone.
 */
export function receiptFor(
  charge: { cents: number; day: string },
  receipts: readonly Receipt[],
  maxDays = 1,
): Receipt | null {
  const seen = new Set<string>();
  const near = receipts
    .filter((r) => r.totalCents === charge.cents && daysApart(r.day, charge.day) <= maxDays)
    .filter((r) => {
      const key = `${r.store}|${r.items.toSorted().join(';')}`; // the dispatch email may list items in another order
      return !seen.has(key) && seen.add(key) !== undefined;
    })
    .toSorted((a, b) => daysApart(a.day, charge.day) - daysApart(b.day, charge.day));
  const [best, next] = near;
  if (!best || (next && daysApart(next.day, charge.day) === daysApart(best.day, charge.day))) {
    return null;
  }
  return best;
}
