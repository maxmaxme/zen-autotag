import type { EmailMessage, ParsedReceipt } from './types.ts';

const TZ = 'Europe/Madrid';

/** Calendar day in Madrid — card statements and ZenMoney dates are local days. */
export function localDay(d: Date, timeZone = TZ): string {
  // en-CA formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}

/** "40,48", "7.99", "1.234,50", "1,234.50" → cents. */
export function parseEuroAmount(raw: string): number | null {
  const s = raw.replace(/[\s  €]|EUR/g, '');
  const m = /^(\d{1,3}(?:[.,]\d{3})*|\d+)(?:[.,](\d{1,2}))?$/.exec(s);
  if (!m) {
    return null;
  }
  const int = (m[1] ?? '0').replace(/[.,]/g, '');
  const frac = (m[2] ?? '').padEnd(2, '0');
  return Number(int) * 100 + Number(frac);
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

export function decodeEntities(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n: string) => String.fromCodePoint(Number.parseInt(n, 16)))
    .replace(/&([a-z]+);/gi, (all, name: string) => ENTITIES[name.toLowerCase()] ?? all);
}

function clean(s: string): string {
  return decodeEntities(s.replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();
}

/**
 * Glovo "Details of your order" — sent once the order is delivered, so the
 * total is final (substitutions and weighed items already settled).
 */
export function parseGlovoOrder(msg: EmailMessage): ParsedReceipt | null {
  if (!/@glovoapp\.com/i.test(msg.from) || !/details of your order/i.test(msg.subject)) {
    return null;
  }
  const store =
    /receipt from\s*<strong>([\s\S]*?)<\/strong>/i.exec(msg.html)?.[1] ??
    /Deliver from<\/span>[\s\S]*?class="label"[^>]*>([\s\S]*?)<\/td>/i.exec(msg.html)?.[1];
  // The bold grand-total row: `<td …>Total</td><td …>40,48 €</td>`. "Total taxable base" lines don't match `>Total<`.
  const total = />\s*Total\s*<\/td>\s*<td[^>]*>\s*([\d.,\s ]+)\s*(?:€|&euro;)/i.exec(msg.html)?.[1];
  if (!store || !total) {
    return null;
  }
  const totalCents = parseEuroAmount(total);
  if (totalCents === null) {
    return null;
  }
  const items: string[] = [];
  const itemRe = /<strong>(\d+)x<\/strong><\/td>\s*<td class="product">[\s\S]*?<td>([\s\S]*?)<\/td>/g;
  for (const m of msg.html.matchAll(itemRe)) {
    const name = clean(m[2] ?? '');
    if (name) {
      items.push(`${m[1]}x ${name}`);
    }
  }
  return {
    source: 'glovo',
    store: clean(store),
    totalCents,
    currency: 'EUR',
    date: localDay(msg.date),
    reference: /Glovo ID:\s*(\d+)/i.exec(msg.html)?.[1] ?? null,
    items,
  };
}

/**
 * PayPal receipt for the Glovo Prime subscription. Glovo itself doesn't
 * email for it; PayPal's "You authorized €7.99 EUR to GLOVOAPP23 SL" does,
 * with the line item "GLOVO PRIME".
 */
export function parsePaypalGlovoPrime(msg: EmailMessage): ParsedReceipt | null {
  if (!/paypal\./i.test(msg.from) || !/glovo/i.test(msg.subject)) {
    return null;
  }
  const hasPrime = /aria-label="[^"]*prime[^"]*"|>\s*GLOVO PRIME\s*</i.test(msg.html);
  // Subject: "GLOVOAPP23 SL: €7.99 EUR"
  const amount = /:\s*(?:€|EUR)?\s*([\d.,]+)/.exec(msg.subject.replace(/[  ]/g, ' '))?.[1];
  if (!hasPrime || !amount) {
    return null;
  }
  const totalCents = parseEuroAmount(amount);
  if (totalCents === null) {
    return null;
  }
  return {
    source: 'paypal-glovo-prime',
    store: 'Glovo Prime',
    totalCents,
    currency: 'EUR',
    date: localDay(msg.date),
    reference: /Transaction ID:\s*([A-Z0-9]+)/i.exec(msg.html)?.[1] ?? null,
    items: ['1x Glovo Prime'],
  };
}

const PARSERS = [parseGlovoOrder, parsePaypalGlovoPrime];

export function parseReceipt(msg: EmailMessage): ParsedReceipt | null {
  for (const parse of PARSERS) {
    const r = parse(msg);
    if (r) {
      return r;
    }
  }
  return null;
}

/** Gmail search queries that find every email some parser understands. */
export const GMAIL_QUERIES = [
  'from:no-reply@glovoapp.com subject:"Details of your order"',
  // Gmail matches whole words, so "glovo" wouldn't hit "GLOVOAPP23 SL"; the line item is exact.
  'from:paypal "GLOVO PRIME"',
];
