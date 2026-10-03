import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import type { EmailMessage } from '../receipts/types.ts';

export interface Mailbox {
  /** Messages matching any query, received on/after `since`, that `isSeen` doesn't already know. */
  fetch(queries: readonly string[], since: Date, isSeen: (messageId: string) => boolean): Promise<EmailMessage[]>;
}

export class MailAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MailAuthError';
  }
}

function gmailDate(d: Date): string {
  return `${d.getUTCFullYear()}/${d.getUTCMonth() + 1}/${d.getUTCDate()}`;
}

/**
 * Gmail over IMAP with an app password. Searches "All Mail" (its name is
 * localised, so it's found by the \All special-use flag) with Gmail's own
 * query syntax, so archived and labelled mail is included.
 */
export class GmailImap implements Mailbox {
  private readonly user: string;
  private readonly pass: string;

  constructor(opts: { user: string; appPassword: string }) {
    this.user = opts.user;
    // Google shows app passwords in groups of four; the spaces aren't part of it.
    this.pass = opts.appPassword.replace(/\s+/g, '');
  }

  async fetch(
    queries: readonly string[],
    since: Date,
    isSeen: (messageId: string) => boolean,
  ): Promise<EmailMessage[]> {
    const client = new ImapFlow({
      host: 'imap.gmail.com',
      port: 993,
      secure: true,
      auth: { user: this.user, pass: this.pass },
      logger: false,
    });
    try {
      await client.connect();
    } catch (err) {
      const e = err as { authenticationFailed?: boolean; message?: string };
      if (e.authenticationFailed) {
        throw new MailAuthError('Gmail rejected the login — check GMAIL_USER / GMAIL_APP_PASSWORD');
      }
      throw err;
    }

    const out: EmailMessage[] = [];
    try {
      const all = (await client.list()).find((b) => b.specialUse === '\\All');
      if (!all) {
        throw new Error('Gmail "All Mail" folder not found (is it hidden from IMAP in Gmail settings?)');
      }
      const lock = await client.getMailboxLock(all.path);
      try {
        const uids = new Set<number>();
        for (const q of queries) {
          const found = await client.search({ gmraw: `${q} after:${gmailDate(since)}` }, { uid: true });
          for (const uid of found || []) {
            uids.add(uid);
          }
        }
        if (uids.size === 0) {
          return out;
        }
        const fresh: { uid: number; messageId: string }[] = [];
        for await (const m of client.fetch([...uids].join(','), { envelope: true }, { uid: true })) {
          const messageId = m.envelope?.messageId ?? `uid:${m.uid}`;
          if (!isSeen(messageId)) {
            fresh.push({ uid: m.uid, messageId });
          }
        }
        for (const { uid, messageId } of fresh) {
          const m = await client.fetchOne(String(uid), { source: true }, { uid: true });
          if (!m || !m.source) {
            continue;
          }
          const mail = await simpleParser(m.source);
          out.push({
            messageId,
            from: mail.from?.text ?? '',
            subject: mail.subject ?? '',
            date: mail.date ?? new Date(),
            html: typeof mail.html === 'string' ? mail.html : '',
          });
        }
      } finally {
        lock.release();
      }
    } finally {
      await client.logout().catch(() => {});
    }
    return out;
  }
}
