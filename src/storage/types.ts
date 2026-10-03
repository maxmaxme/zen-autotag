import type { ParsedReceipt } from '../receipts/types.ts';

export type ReceiptStatus =
  /** No ZenMoney transaction found yet. */
  | 'unmatched'
  /** Matched; applies by itself once a category is decided. */
  | 'matched'
  /** Waits for a human: from before the first run, or the classifier wasn't sure. */
  | 'review'
  | 'applied'
  /** Matched and already had that category. */
  | 'unchanged'
  | 'dismissed'
  /** Never matched within the window. */
  | 'expired';

/** Who decided a receipt's category. */
export type TagSource = 'store' | 'jev' | 'user';

export interface ReceiptRow extends ParsedReceipt {
  messageId: string;
  storeKey: string;
  receivedAt: number;
  status: ReceiptStatus;
  zmTxId: string | null;
  tagId: string | null;
  tagSource: TagSource | null;
  tagConfidence: number | null;
  appliedTag: string | null;
  previousTags: string[] | null;
  appliedAt: number | null;
  note: string | null;
}

export interface StoreRow {
  storeKey: string;
  name: string;
  /** Fixed category for this store, or null to let the classifier decide. */
  tagId: string | null;
}

export interface Candidate {
  tagId: string;
  hint: string;
}

export interface ZmTxRow {
  id: string;
  date: string;
  outcomeCents: number;
  incomeCents: number;
  payee: string | null;
  raw: string;
}

export interface Store {
  isMailSeen(messageId: string): boolean;
  markMailSeen(messageId: string, parsed: boolean, now: number): void;

  /** Inserts the receipt (ignored if the email was stored before) and registers its store. */
  addReceipt(messageId: string, r: ParsedReceipt, storeKey: string, receivedAt: number): void;
  receiptsByStatus(...statuses: ReceiptStatus[]): ReceiptRow[];
  recentReceipts(limit: number): ReceiptRow[];
  getReceipt(messageId: string): ReceiptRow | null;
  setMatch(messageId: string, zmTxId: string, status: ReceiptStatus): void;
  setStatus(messageId: string, status: ReceiptStatus, note?: string | null): void;
  setTag(messageId: string, tagId: string | null, source: TagSource | null, confidence: number | null): void;
  markApplied(
    messageId: string,
    result: { status: 'applied' | 'unchanged'; tag: string; previousTags: string[] | null },
    now: number,
  ): void;
  claimedZmTxIds(): Set<string>;

  listStores(): StoreRow[];
  getStore(storeKey: string): StoreRow | null;
  setStoreTag(storeKey: string, tagId: string | null): void;

  candidates(): Candidate[];
  setCandidates(list: Candidate[]): void;

  upsertZmTx(rows: ZmTxRow[]): void;
  deleteZmTx(ids: string[]): void;
  getZmTx(id: string): ZmTxRow | null;
  zmTxBetween(from: string, to: string): ZmTxRow[];

  getKv(key: string): string | null;
  setKv(key: string, value: string): void;

  close(): void;
}
