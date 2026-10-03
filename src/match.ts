import type { ZmTxRow } from './storage/types.ts';
import type { ZmTransaction } from './zenmoney/types.ts';

/** Card statements lag the receipt by a day or two; a day earlier covers timezone edges. */
export const DAYS_BEFORE = 1;
export const DAYS_AFTER = 5;

export function addDays(isoDay: string, days: number): string {
  const d = new Date(`${isoDay}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function dayDistance(a: string, b: string): number {
  return Math.abs(Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86_400_000;
}

export type MatchResult = { zmTxId: string } | { ambiguous: string[] } | null;

/**
 * The receipt's expense in ZenMoney: same amount to the cent, money out,
 * within the date window, not already claimed by another receipt. The
 * closest date wins; a tie is reported rather than guessed.
 */
export function findMatch(
  receipt: { totalCents: number; date: string },
  candidates: readonly ZmTxRow[],
  claimed: ReadonlySet<string>,
): MatchResult {
  const from = addDays(receipt.date, -DAYS_BEFORE);
  const to = addDays(receipt.date, DAYS_AFTER);
  const hits = candidates
    .filter(
      (t) =>
        t.outcomeCents === receipt.totalCents &&
        t.incomeCents === 0 &&
        t.date >= from &&
        t.date <= to &&
        !claimed.has(t.id),
    )
    .map((t) => ({ id: t.id, distance: dayDistance(t.date, receipt.date) }))
    .sort((a, b) => a.distance - b.distance);

  const [best, second] = hits;
  if (!best) {
    return null;
  }
  if (second && second.distance === best.distance) {
    return { ambiguous: hits.filter((h) => h.distance === best.distance).map((h) => h.id) };
  }
  return { zmTxId: best.id };
}

/**
 * The transaction with its category set. Returns null when it already has
 * exactly that category. An empty comment gets the store name so the
 * ZenMoney list says where the money went; a comment the user wrote stays.
 */
export function withCategory(
  t: ZmTransaction,
  tagId: string,
  comment: string,
  nowSec: number,
): ZmTransaction | null {
  const sameTag = t.tag?.length === 1 && t.tag[0] === tagId;
  if (sameTag) {
    return null;
  }
  return {
    ...t,
    tag: [tagId],
    comment: t.comment?.trim() ? t.comment : comment,
    changed: nowSec,
  };
}
