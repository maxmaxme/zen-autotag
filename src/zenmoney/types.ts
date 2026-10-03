// Subset of the ZenMoney API this service touches.
// Reference: https://github.com/zenmoney/ZenPlugins/wiki/ZenMoney-API
// Timestamps are Unix seconds; amounts are plain decimals, always >= 0.

export interface ZmTag {
  id: string;
  title: string;
  parent: string | null;
}

/**
 * Transactions are written back whole (ZenMoney replaces the object), so we
 * keep every field we got and only know the ones we read or change.
 */
export interface ZmTransaction {
  id: string;
  changed: number;
  deleted: boolean;
  date: string;
  income: number;
  outcome: number;
  tag: string[] | null;
  payee: string | null;
  originalPayee: string | null;
  comment: string | null;
  [field: string]: unknown;
}

export interface ZmDeletion {
  id: string;
  object: string;
  stamp: number;
  user: number;
}

export interface ZmDiff {
  serverTimestamp: number;
  currentClientTimestamp?: number;
  forceFetch?: string[];
  tag?: ZmTag[];
  transaction?: ZmTransaction[];
  deletion?: ZmDeletion[];
}

/** What the rest of the service needs from the client — small so tests can fake it. */
export interface ZenMoneyApi {
  diff(body: ZmDiff): Promise<ZmDiff>;
}
