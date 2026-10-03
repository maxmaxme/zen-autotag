import pino from 'pino';
import type { EmailMessage } from '../src/receipts/types.ts';
import type { Logger } from '../src/logger.ts';

export const silentLog = pino({ level: 'silent' }) as unknown as Logger;

// Synthetic emails that mirror the markup the parsers rely on — no real
// receipts (or anyone's address) in this public repo.

export function glovoEmail(opts: {
  store: string;
  items: { qty: number; name: string; price: string }[];
  total: string;
  date: Date;
  id?: string;
  vatLines?: boolean;
}): EmailMessage {
  const rows = opts.items
    .map(
      (i) => `<tr style="vertical-align: top">
          <td><strong>${i.qty}x</strong></td>
          <td class="product">
            <table role="presentation"><tr>
                <td>
                  ${i.name}
                </td>
            </tr></table>
          </td>
          <td align="right"><table><tr><td align="right">${i.price} €</td></tr></table></td>
        </tr>`,
    )
    .join('\n');
  const vat = opts.vatLines
    ? `<tr><td style="padding: 12px">Total taxable base 27.60 €, total VAT 3.37 €</td></tr>`
    : '';
  return {
    messageId: opts.id ?? `<${opts.store}-${opts.total}@test>`,
    from: '"Glovo" <no-reply@glovoapp.com>',
    subject: 'Details of your order',
    date: opts.date,
    html: `<html><body>
      <tr><td class="header__subtitle">Find below the receipt from <strong>${opts.store}</strong></td></tr>
      <table>${rows}</table>
      <tr style="font-size: 1.25em; font-weight: bold;">
        <td style="padding-right:0">Total</td>
        <td align="right" style="white-space:nowrap; vertical-align: top">${opts.total} €</td>
      </tr>
      ${vat}
      <span class="highlight">Glovo ID: 100000000001</span>
    </body></html>`,
  };
}

export function paypalEmail(opts: { amount: string; item: string; date: Date; id?: string }): EmailMessage {
  return {
    messageId: opts.id ?? `<pp-${opts.item}-${opts.amount}@test>`,
    from: '"service@paypal.es" <service@paypal.es>',
    subject: `GLOVOAPP23 SL: €${opts.amount} EUR`,
    date: opts.date,
    html: `<span aria-label="${opts.item}"><span>${opts.item}</span></span>
      <span>Transaction ID: 1AB23456CD789012E</span>`,
  };
}
