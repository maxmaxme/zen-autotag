import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import * as v from 'valibot';

export interface Email {
  from: string;
  subject: string;
  date: Date;
  html: string;
}

export class GmailAuthError extends Error {}

function gmailDay(d: Date): string {
  return `${d.getUTCFullYear()}/${d.getUTCMonth() + 1}/${d.getUTCDate()}`;
}

/**
 * Emails matching any of `queries` (Gmail search syntax) between two days,
 * over IMAP with an app password. Searches "All Mail" — found by its \All
 * flag because the folder name is localised — so archived mail counts too.
 */
export async function findMail(
  auth: { user: string; appPassword: string },
  queries: readonly string[],
  from: Date,
  to: Date,
): Promise<Email[]> {
  const client = new ImapFlow({
    host: 'imap.gmail.com',
    port: 993,
    secure: true,
    // Google shows app passwords in groups of four; the spaces aren't part of it.
    auth: { user: auth.user, pass: auth.appPassword.replaceAll(/\s+/g, '') },
    logger: false,
  });
  try {
    await client.connect();
  } catch (err) {
    if (v.is(v.object({ authenticationFailed: v.literal(true) }), err)) {
      throw new GmailAuthError('Gmail rejected the login — check GMAIL_USER / GMAIL_APP_PASSWORD');
    }
    throw err;
  }

  const emails: Email[] = [];
  try {
    const all = (await client.list()).find((b) => b.specialUse === '\\All');
    if (!all) {
      throw new Error('Gmail "All Mail" folder not visible over IMAP');
    }
    const lock = await client.getMailboxLock(all.path);
    try {
      const range = `after:${gmailDay(from)} before:${gmailDay(new Date(to.getTime() + 86_400_000))}`;
      const uids = new Set<number>();
      for (const q of queries) {
        for (const uid of (await client.search({ gmraw: `${q} ${range}` }, { uid: true })) || []) {
          uids.add(uid);
        }
      }
      for (const uid of uids) {
        const msg = await client.fetchOne(String(uid), { source: true }, { uid: true });
        if (msg && msg.source) {
          const mail = await simpleParser(msg.source);
          emails.push({
            from: mail.from?.text ?? '',
            subject: mail.subject ?? '',
            date: mail.date ?? new Date(0),
            html: typeof mail.html === 'string' ? mail.html : '',
          });
        }
      }
    } finally {
      lock.release();
    }
  } finally {
    await client.logout().catch(() => {});
  }
  return emails;
}
