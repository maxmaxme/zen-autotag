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

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  euro: '€',
  reg: '®',
  copy: '©',
  trade: '™',
  iexcl: '¡',
  iquest: '¿',
  ordm: 'º',
  ordf: 'ª',
  szlig: 'ß',
  aelig: 'æ',
  oslash: 'ø',
};
/** &eacute; &ntilde; &Uuml; … — a letter plus a combining mark, composed. */
const ACCENTS: Record<string, string> = {
  acute: '\u0301',
  grave: '\u0300',
  tilde: '\u0303',
  uml: '\u0308',
  circ: '\u0302',
  cedil: '\u0327',
  ring: '\u030a',
};

function text(html: string): string {
  return html
    .replaceAll(/<[^>]+>/g, ' ') // a tag separates words: "</p><p>" must not glue paragraphs
    .replaceAll(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
    .replaceAll(/&#x([0-9a-f]+);/gi, (_, n: string) => String.fromCodePoint(Number.parseInt(n, 16)))
    .replaceAll(/&([a-z])(acute|grave|tilde|uml|circ|cedil|ring);/gi, (_, l: string, mark: string) =>
      `${l}${ACCENTS[mark.toLowerCase()]}`.normalize('NFC'),
    )
    .replaceAll(/&([a-z]+);/gi, (all, name: string) => ENTITIES[name] ?? ENTITIES[name.toLowerCase()] ?? all)
    .replaceAll(/\s+/g, ' ')
    .trim();
}

/** Glovo "Details of your order" — sent after delivery, so the total is final. */
function parseGlovoOrder(email: Email): Receipt | null {
  if (!/@glovoapp\.com/i.test(email.from) || !/details of your order/i.test(email.subject)) {
    return null;
  }
  const store = /receipt from\s*<strong>([\s\S]*?)<\/strong>/i.exec(email.html)?.[1];
  // The bold grand total: `<td>Total</td><td>40,48 €</td>` ("Total taxable base" doesn't match `>Total<`).
  const total = />\s*Total\s*<\/td>\s*<td[^>]*>\s*([\d.,\s ]+)\s*(?:€|&euro;)/i.exec(email.html)?.[1];
  const totalCents = total ? euroCents(total) : null;
  if (!store || totalCents === null) {
    return null;
  }
  const items = [
    ...email.html.matchAll(/<strong>(\d+)x<\/strong><\/td>\s*<td class="product">[\s\S]*?<td>([\s\S]*?)<\/td>/g),
  ]
    .map((m) => `${m[1]}x ${text(m[2] ?? '')}`)
    .filter((s) => s.length > 3);
  return { store: text(store), items, totalCents, day: localDay(email.date) };
}

/** PayPal's receipt for the Glovo Prime membership (Glovo itself sends none). */
function parseGlovoPrime(email: Email): Receipt | null {
  if (!/paypal\./i.test(email.from) || !/glovo/i.test(email.subject) || !/GLOVO PRIME/i.test(email.html)) {
    return null;
  }
  // Subject: "GLOVOAPP23 SL: €7.99 EUR"
  const amount = /:\s*(?:€|EUR)?\s*([\d.,]+)/.exec(email.subject.replaceAll(/[  ]/g, ' '))?.[1];
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

/** Amazon "Ordered:" / "Dispatched:" emails: linked item titles, then "Quantity: N"; then the total. */
function parseAmazonOrder(email: Email): Receipt | null {
  if (!/@amazon\./i.test(email.from) || !/^(ordered|dispatched|shipped)\b/i.test(email.subject)) {
    return null;
  }
  const total = />\s*Total\s*<\/td>\s*<td[^>]*>(?:<[^>]+>|\s)*€\s*([\d.,]+)/i.exec(email.html)?.[1];
  const totalCents = total ? euroCents(total) : null;
  if (totalCents === null) {
    return null;
  }
  const items = [...email.html.matchAll(/<a [^>]*>([^<]{3,})<\/a>(?:(?!<a )[\s\S]){0,4000}?Quantity:\s*(\d+)/g)].map(
    (m) => `${m[2]}x ${text(m[1] ?? '')}`,
  );
  return { store: 'Amazon', items, totalCents, day: localDay(email.date) };
}

/** Amazon refund notice: "Item: …" and the amount credited back. */
function parseAmazonRefund(email: Email): Receipt | null {
  if (!/@amazon\./i.test(email.from) || !/^refund\b/i.test(email.subject)) {
    return null;
  }
  const body = text(email.html);
  const items = [...body.matchAll(/Item:\s*(.+?)(?=\s+(?:Item:|Your refund|Quantity))/g)].map(
    (m) => `1x ${m[1]?.trim()}`,
  );
  const amount = /credited as follows:.*?:\s*([\d.,]+)\s*€/i.exec(body)?.[1];
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
