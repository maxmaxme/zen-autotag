/** A receipt as parsed out of one email. */
export interface ParsedReceipt {
  /** Which parser recognised it. */
  source: 'glovo' | 'paypal-glovo-prime';
  store: string;
  totalCents: number;
  currency: string;
  /** Local (Europe/Madrid) calendar day of the purchase. */
  date: string;
  /** Merchant-side reference (Glovo ID, PayPal transaction id), for humans. */
  reference: string | null;
  /** Line items as printed ("2x Item name"); input for classification. */
  items: string[];
}

export interface EmailMessage {
  messageId: string;
  from: string;
  subject: string;
  date: Date;
  html: string;
}
