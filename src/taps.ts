import { categoryOptions } from './scan.ts';
import { decode, encode, escapeHtml, type Keyboard, type Tap, type Telegram } from './telegram.ts';
import { tagLabel, type ZenMoney } from './zenmoney.ts';

const DAY = 86_400_000;
/** A button older than this can't find its transaction any more — change it in ZenMoney. */
const TAP_WINDOW_DAYS = 30;

export interface TapDeps {
  zenmoney: Pick<ZenMoney, 'since' | 'save'>;
  telegram: Pick<Telegram, 'edit' | 'answer'>;
  chatId: string;
  hints: Record<string, string>;
  dryRun: boolean;
}

/** Rewrites the "Category:" line once the question is settled. */
function settled(text: string, category: string): string {
  return text.replace(/^Category: .*$/m, category);
}

/** Handles one button press on a message sent by `scan`. No stored state: the message carries it all. */
export async function handleTap(deps: TapDeps, tap: Tap): Promise<void> {
  const action = decode(tap.data);
  if (String(tap.chatId) !== deps.chatId || !action) {
    await deps.telegram.answer(tap);
    return;
  }
  const text = escapeHtml(tap.text);

  // "Other" keeps the original buttons on top, then « Back, then every category;
  // "Back" cuts the list off again — the message itself is the state.
  const backAt = tap.keyboard.findIndex((row) => row.some((b) => decode(b.data)?.kind === 'back'));
  if (action.kind === 'back') {
    const original = backAt >= 0 ? tap.keyboard.slice(0, backAt) : tap.keyboard;
    await deps.telegram.edit(tap, text, [
      ...original,
      [{ text: 'Other category…', data: encode({ kind: 'other', tx: action.tx }) }],
    ]);
    await deps.telegram.answer(tap);
    return;
  }

  if (action.kind === 'ok') {
    await deps.telegram.edit(tap, text.replace(/^(Category: .*)$/m, '$1 ✓'), null);
    await deps.telegram.answer(tap);
    return;
  }

  const recent = await deps.zenmoney.since(Math.floor((Date.now() - TAP_WINDOW_DAYS * DAY) / 1000));
  const tx = recent.transactions.find((t) => t.id === action.tx);
  if (!tx) {
    await deps.telegram.answer(tap, 'Too old to change from here — edit it in ZenMoney.');
    return;
  }
  const { tags } = recent;

  if (action.kind === 'other') {
    // Money in can be a refund, which goes to a spending category — so it gets both lists.
    const both =
      tx.outcome === 0 ? [...categoryOptions(true, tags, deps.hints), ...categoryOptions(false, tags, deps.hints)] : [];
    const options = (both.length > 0 ? both : categoryOptions(false, tags, deps.hints))
      .filter((o, i, all) => all.findIndex((x) => x.id === o.id) === i)
      .toSorted((a, b) => a.name.localeCompare(b.name));
    const original = tap.keyboard.filter((row) => !row.some((b) => decode(b.data)?.kind === 'other'));
    const rows: Keyboard = [...original, [{ text: '« Back', data: encode({ kind: 'back', tx: tx.id }) }]];
    for (const o of options) {
      rows.push([{ text: o.name, data: encode({ kind: 'set', tx: tx.id, tag: o.id }) }]);
    }
    await deps.telegram.edit(tap, text, rows);
    await deps.telegram.answer(tap);
    return;
  }

  const tag = tags.find((t) => t.id === action.tag);
  if (!tag) {
    await deps.telegram.answer(tap, 'That category no longer exists.');
    return;
  }
  const label = tagLabel(tag, tags);
  if (!deps.dryRun) {
    await deps.zenmoney.save([{ ...tx, tag: [tag.id], changed: Math.floor(Date.now() / 1000) }]);
  }
  await deps.telegram.edit(tap, settled(text, `Category: <b>${escapeHtml(label)}</b> ✏️`), null);
  await deps.telegram.answer(tap, `→ ${label}`);
}
