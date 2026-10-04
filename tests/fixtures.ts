import type { Email } from '../src/gmail.ts';

// Synthetic emails that reproduce the real templates' structure (nested
// tables, promo badges, struck-through prices, fee rows, VAT lines, delivery
// block) with made-up content — never real receipts in this public repo.

function product(qty: number, name: string, price: string, extra = '', unavailable = false): string {
  // An item the shop didn't have: name struck through, then a notice row.
  const nameCell = unavailable
    ? `<td class="strikethrough">
                  ${name}
                </td>
              </tr>
              <tr class="product__notice">
                <td><img class="light-mode" src="https://example.invalid/icon_product_removed-light.png" alt="notice_icon" width="14" height="14"></td>
                <td> Not available — you weren’t charged </td>`
    : `<td>
                  ${name}
                </td>`;
  return `<tr style="vertical-align: top">
          <td><strong>${qty}x</strong></td>
          <td class="product">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
              <tr>
                  ${nameCell}
              </tr>
${extra}
            </table>
          </td>
          <td align="right" style="white-space: nowrap">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                <tr>
                    <td align="right" style="white-space: nowrap">
                    ${price} €
                  </td>
                </tr>
            </table>
          </td>
        </tr>`;
}

export function glovoOrderEmail(opts: {
  store: string;
  date: Date;
  total: string;
  products: {
    qty: number;
    name: string;
    price: string;
    options?: string;
    promo?: string;
    was?: string;
    unavailable?: boolean;
  }[];
}): Email {
  const rows = opts.products
    .map((p) =>
      product(
        p.qty,
        p.name,
        p.price,
        [
          p.options ? `<tr><td style="color:#6E6E6E; font-size:0.875em; padding-top:3px">${p.options}</td></tr>` : '',
          p.promo ? `<tr><td><span class="product__promotion">${p.promo}</span></td></tr>` : '',
          p.was
            ? `<tr><td align="right" class="product__original-price" style="white-space: nowrap">${p.was} €</td></tr>`
            : '',
        ].join('\n'),
        p.unavailable,
      ),
    )
    .join('\n');
  return {
    from: '"Glovo" <no-reply@glovoapp.com>',
    subject: 'Details of your order',
    date: opts.date,
    html: `<!doctype html><html lang="en"><body class="main">
<table><tr><td class="header__title"><a class="no-color" rel="nofollow">Hey Test User, your order has been delivered, enjoy!</a></td></tr>
<tr><td class="header__subtitle">Find below the receipt from <strong>${opts.store}</strong></td></tr></table>
<table class="table__padded"><tr><td><strong>Products</strong></td>
  <td align="right"><span class="highlight">Bill ID: TEST0000001</span></td></tr></table>
<table class="table__padded" role="presentation">
${rows}
  <tr><td><img alt="cutlery"></td><td style="padding-left:0">No cutlery requested</td><td>&nbsp;</td></tr>
</table>
<table class="table__padded" role="presentation">
  <tr><td style="padding-right:0"><table><tr><td >Bag</td></tr><tr><td>Tax included</td></tr></table></td>
    <td align="right" style="white-space: nowrap; vertical-align:top" >0,16 €</td></tr>
  <tr><td style="padding-right:0"><table><tr><td >Prime Delivery</td></tr></table></td>
    <td align="right" style="white-space: nowrap; vertical-align:top" >No cost</td></tr>
</table>
<table class="table__padded" role="presentation">
  <tr style="font-size: 1.25em; font-weight: bold;">
    <td style="padding-right:0">Total</td>
    <td align="right" style="white-space:nowrap; vertical-align: top">${opts.total} €</td>
  </tr>
</table>
<table class="table__padded" role="presentation">
  <tr><td style="padding: 12px; font-size: 0.8em">VAT 10.0%: Taxable amount 14.15 € plus VAT (10%) 1.42 €</td></tr>
  <tr><td style="padding: 12px; font-size: 0.8em">Total taxable base 27.60 €, total VAT 3.37 €</td></tr>
</table>
<table><tr><td><strong>Delivery details</strong></td><td><span class="highlight">Glovo ID: 100000000000</span></td></tr>
  <tr><td class="label">${opts.store}</td></tr>
  <tr><td>Deliver to</td><td>Test Street, 1</td></tr>
  <tr><td>Courier Test</td></tr></table>
</body></html>`,
  };
}

export function paypalReceiptEmail(opts: { amount: string; item: string; date: Date }): Email {
  return {
    from: '"service@paypal.es" <service@paypal.es>',
    subject: `GLOVOAPP23 SL: €${opts.amount} EUR`,
    date: opts.date,
    html: `<p><span>You authorized €${opts.amount} EUR to GLOVOAPP23 SL</span></p>
<table id="cartDetails"><tr><td><span aria-label="${opts.item}"><span>${opts.item}</span></span><br />
<span>Qty: 1</span></td><td><span>${opts.amount} €</span></td></tr></table>
<span>Transaction ID: 0TEST000000000000</span>`,
  };
}

/** Amazon "Ordered:" / "Dispatched:" — item links, "Quantity: N", per-item aria-label prices, then the total. */
export function amazonOrderEmail(opts: {
  kind: 'Ordered' | 'Dispatched';
  date: Date;
  total: string;
  items: [string, number, string][];
}): Email {
  const items = opts.items
    .map(
      ([
        name,
        qty,
        price,
      ]) => `<tr><td align="left"><div><span class="rio-text rio-text-544"><a href="https://www.amazon.es/dp/TEST" target="_blank" >${name}</a></span></div></td></tr>
<tr><td align="left" class="rio-spacer"><div aria-hidden="true">&nbsp;</div></td></tr>
<tr><td align="left"><div><span class="rio-text rio-text-545">Sold by Amazon.es</span></div></td></tr>
<tr><td align="left"><div><span class="rio-text rio-text-548">Quantity: ${qty}</span></div></td></tr>
<tr><td align="left"><div><span class="rio-text rio-text-551"><mj-raw></mj-raw> <span role="region" aria-label="{amount=${price}, currencyCode={smallestAmount=0.01, code=EUR}, label=null}"><!--[if mso]><![endif]-->${price} EUR</span></span></div></td></tr>`,
    )
    .join('\n');
  return {
    from: `"Amazon.es" <${opts.kind === 'Ordered' ? 'auto-confirm' : 'confirmar-envio'}@amazon.es>`,
    subject: `${opts.kind}: ‘${opts.items[0]?.[0] ?? ''}’`,
    date: opts.date,
    html: `<table><tr><td><a href="https://www.amazon.es/gp/css/order-history" target="_blank">View or edit order</a></td></tr>
${items}
<tr><td>Total</td><td align="right" ><mj-raw></mj-raw><mj-raw> </mj-raw> €${opts.total}<mj-raw></mj-raw></td></tr></table>`,
  };
}

export function amazonRefundEmail(opts: { date: Date; item: string; amount: string }): Email {
  return {
    from: '"Amazon.es" <payments-messages@amazon.es>',
    subject: 'Refund on order 000-0000000-0000000',
    date: opts.date,
    html: `<p>This refund is for the following item(s):</p><p>Item: ${opts.item}</p><p>Quantity: 1</p>
<p>Item Tax Refund: 0,10 €</p><p>Your refund is being credited as follows:</p><p>Visa Credit Card [expiring on 1/2030]: ${opts.amount} €</p><p>These amounts will be returned to your payment method.</p>`,
  };
}
