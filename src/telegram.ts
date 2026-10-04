// Just the slice of the Telegram Bot API this service uses.
// Updates come by long polling, so the Pi needs no public URL.

import * as v from 'valibot';
import { parseJson } from './json.ts';

export interface Button {
  text: string;
  data: string;
}
export type Keyboard = Button[][];

export interface Tap {
  id: string;
  chatId: number;
  messageId: number;
  /** The message text and buttons as they are now, so they can be edited without stored state. */
  text: string;
  keyboard: Keyboard;
  data: string;
}

const ResponseSchema = v.object({
  ok: v.boolean(),
  result: v.optional(v.unknown()),
  description: v.optional(v.string()),
});

const KeyboardSchema = v.array(v.array(v.object({ text: v.string(), callback_data: v.optional(v.string(), '') })));

/** A button press on one of our messages; anything else in an update is ignored. */
const CallbackSchema = v.object({
  id: v.string(),
  data: v.string(),
  message: v.object({
    message_id: v.number(),
    chat: v.object({ id: v.number() }),
    text: v.optional(v.string(), ''),
    reply_markup: v.optional(v.object({ inline_keyboard: v.optional(KeyboardSchema, []) }), {}),
  }),
});

const UpdatesSchema = v.array(v.object({ update_id: v.number(), callback_query: v.optional(v.unknown()) }));

export class Telegram {
  private readonly base: string;
  private offset = 0;

  constructor(token: string) {
    this.base = `https://api.telegram.org/bot${token}`;
  }

  async send(chatId: string, html: string, keyboard: Keyboard | null, silent: boolean): Promise<void> {
    await this.call('sendMessage', {
      chat_id: chatId,
      text: html,
      parse_mode: 'HTML',
      disable_notification: silent,
      link_preview_options: { is_disabled: true },
      ...(keyboard ? { reply_markup: markup(keyboard) } : {}),
    });
  }

  async edit(tap: Tap, html: string, keyboard: Keyboard | null): Promise<void> {
    await this.call('editMessageText', {
      chat_id: tap.chatId,
      message_id: tap.messageId,
      text: html,
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
      reply_markup: markup(keyboard ?? []),
    });
  }

  async answer(tap: Tap, text?: string): Promise<void> {
    await this.call('answerCallbackQuery', { callback_query_id: tap.id, ...(text ? { text } : {}) });
  }

  /** Waits up to `timeoutSec` for button taps; everything else (and anything malformed) is dropped. */
  async taps(timeoutSec: number): Promise<Tap[]> {
    const updates = v.parse(
      UpdatesSchema,
      await this.call(
        'getUpdates',
        { offset: this.offset, timeout: timeoutSec, allowed_updates: ['callback_query'] },
        (timeoutSec + 10) * 1000,
      ),
    );
    const taps: Tap[] = [];
    for (const u of updates) {
      // Moving the offset first: an update we can't read is dropped, not retried forever.
      this.offset = u.update_id + 1;
      const q = v.safeParse(CallbackSchema, u.callback_query);
      if (q.success) {
        const { id, data, message } = q.output;
        taps.push({
          id,
          chatId: message.chat.id,
          messageId: message.message_id,
          text: message.text,
          keyboard: message.reply_markup.inline_keyboard.map((row) =>
            row.map((b) => ({ text: b.text, data: b.callback_data })),
          ),
          data,
        });
      }
    }
    return taps;
  }

  private async call(method: string, body: unknown, timeoutMs = 15_000): Promise<unknown> {
    const res = await fetch(`${this.base}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const parsed = v.safeParse(ResponseSchema, parseJson(await res.text()));
    if (!parsed.success || !parsed.output.ok) {
      throw new Error(`Telegram ${method}: ${(parsed.success && parsed.output.description) || res.status}`);
    }
    return parsed.output.result;
  }
}

function markup(keyboard: Keyboard) {
  return { inline_keyboard: keyboard.map((row) => row.map((b) => ({ text: b.text, callback_data: b.data }))) };
}

// callback_data is capped at 64 bytes, so UUIDs travel as 22-char base64url.
export function packId(uuid: string): string {
  return Buffer.from(uuid.replace(/-/g, ''), 'hex').toString('base64url');
}

export function unpackId(packed: string): string {
  const h = Buffer.from(packed, 'base64url').toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** k = ok (hide buttons), s = set category, o = show all categories, b = back from that list. */
export type Action =
  | { kind: 'ok'; tx: string }
  | { kind: 'set'; tx: string; tag: string }
  | { kind: 'other'; tx: string }
  | { kind: 'back'; tx: string };

const CODES = { ok: 'k', other: 'o', back: 'b' } as const;

export function encode(a: Action): string {
  return a.kind === 'set' ? `s|${packId(a.tx)}|${packId(a.tag)}` : `${CODES[a.kind]}|${packId(a.tx)}`;
}

export function decode(data: string): Action | null {
  const [kind, tx, tag] = data.split('|');
  if (!tx || tx.length !== 22) {
    return null;
  }
  if (kind === 'k') {
    return { kind: 'ok', tx: unpackId(tx) };
  }
  if (kind === 'o') {
    return { kind: 'other', tx: unpackId(tx) };
  }
  if (kind === 'b') {
    return { kind: 'back', tx: unpackId(tx) };
  }
  if (kind === 's' && tag?.length === 22) {
    return { kind: 'set', tx: unpackId(tx), tag: unpackId(tag) };
  }
  return null;
}

export function escapeHtml(s: string): string {
  return s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}
