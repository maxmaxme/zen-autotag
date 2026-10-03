import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { JevError, type Classifier, type ClassifyOption, type ClassifyResult } from '../src/classify/jev.ts';
import type { Mailbox } from '../src/mail/gmail.ts';
import type { EmailMessage } from '../src/receipts/types.ts';
import { AUTO_SINCE_KV, Runner } from '../src/runner.ts';
import { openStore } from '../src/storage/sqlite.ts';
import type { Store } from '../src/storage/types.ts';
import { ZenMirror } from '../src/zenmoney/mirror.ts';
import type { ZenMoneyApi, ZmDiff, ZmTransaction } from '../src/zenmoney/types.ts';
import type { Notifier } from '../src/notify/telegram.ts';
import { glovoEmail, paypalEmail, silentLog } from './helpers.ts';

const DAY = 86_400_000;
const T0 = new Date('2026-10-04T10:00:00Z');

class FakeMailbox implements Mailbox {
  messages: EmailMessage[] = [];
  async fetch(_q: readonly string[], _since: Date, isSeen: (id: string) => boolean): Promise<EmailMessage[]> {
    return this.messages.filter((m) => !isSeen(m.messageId));
  }
}

function zmTx(id: string, date: string, outcome: number, extra: Partial<ZmTransaction> = {}): ZmTransaction {
  return {
    id,
    changed: 1,
    deleted: false,
    date,
    income: 0,
    outcome,
    tag: ['tag-old'],
    payee: 'Paypal *glovo',
    originalPayee: 'Paypal *glovo',
    comment: null,
    user: 7,
    ...extra,
  };
}

/** A tiny in-memory ZenMoney that honours serverTimestamp like the real one. */
class FakeZen implements ZenMoneyApi {
  tx = new Map<string, { t: ZmTransaction; stamp: number }>();
  clock = 100;
  writes: ZmTransaction[] = [];

  put(t: ZmTransaction) {
    this.tx.set(t.id, { t, stamp: ++this.clock });
  }

  async diff(body: ZmDiff): Promise<ZmDiff> {
    for (const t of body.transaction ?? []) {
      this.writes.push(t);
      this.put(t);
    }
    return {
      serverTimestamp: this.clock,
      tag: [
        { id: 'tag-a', title: 'Category A', parent: null },
        { id: 'tag-b', title: 'Category B', parent: null },
        { id: 'tag-c', title: 'Child C', parent: 'tag-b' },
        { id: 'tag-old', title: 'Old', parent: null },
      ],
      transaction: [...this.tx.values()].filter((x) => x.stamp > body.serverTimestamp).map((x) => x.t),
    };
  }
}

class FakeClassifier implements Classifier {
  answers = new Map<string, ClassifyResult | Error>();
  calls: { store: string; options: readonly ClassifyOption[] }[] = [];
  async classify(input: { store: string }, options: readonly ClassifyOption[]): Promise<ClassifyResult> {
    this.calls.push({ store: input.store, options });
    const a = this.answers.get(input.store) ?? { id: 'tag-a', confidence: 0.95 };
    if (a instanceof Error) {
      throw a;
    }
    return a;
  }
}

class RecordingNotifier implements Notifier {
  events: string[] = [];
  async failed(error: string, hint: string | null) {
    this.events.push(`failed:${hint ?? error}`);
  }
  async recovered() {
    this.events.push('recovered');
  }
}

let store: Store;
let mail: FakeMailbox;
let zen: FakeZen;
let classifier: FakeClassifier;
let notifier: RecordingNotifier;
let now: Date;
let runner: Runner;

function makeRunner(withClassifier = true) {
  return new Runner({
    mailbox: mail,
    mirror: new ZenMirror({ api: zen, store, payeePattern: /glovo/i }),
    store,
    notifier,
    log: silentLog,
    now: () => now,
    lookbackDays: 90,
    expireAfterDays: 45,
    classifier: withClassifier ? classifier : null,
    minConfidence: 0.6,
  });
}

beforeEach(() => {
  store = openStore(':memory:');
  mail = new FakeMailbox();
  zen = new FakeZen();
  classifier = new FakeClassifier();
  notifier = new RecordingNotifier();
  now = T0;
  runner = makeRunner();
  store.setCandidates([
    { tagId: 'tag-a', hint: 'what A is for' },
    { tagId: 'tag-c', hint: '' },
  ]);
});
afterEach(() => store.close());

function order(storeName: string, total: string, at: Date, id = `<${storeName}-${total}>`) {
  return glovoEmail({ store: storeName, items: [{ qty: 1, name: 'Item 1', price: total }], total, date: at, id });
}

const later = (days: number) => new Date(T0.getTime() + days * DAY);

describe('first run (backfill)', () => {
  it('puts receipts from before the first run into review with a proposal and writes nothing', async () => {
    mail.messages = [order('Shop A', '40,48', later(-3))];
    zen.put(zmTx('z1', '2026-10-01', 40.48));
    classifier.answers.set('Shop A', { id: 'tag-c', confidence: 1 });

    const res = await runner.run();
    expect(res).toMatchObject({ ok: true, newReceipts: 1, matched: 1, applied: 0 });
    expect(store.receiptsByStatus('review')).toMatchObject([{ tagId: 'tag-c', tagSource: 'jev' }]);
    expect(zen.writes).toEqual([]);
  });

  it('offers the candidates by their readable names and hints', async () => {
    mail.messages = [order('Shop A', '40,48', later(-3))];
    zen.put(zmTx('z1', '2026-10-01', 40.48));
    await runner.run();
    expect(classifier.calls[0]?.options).toEqual([
      { id: 'tag-a', name: 'Category A', hint: 'what A is for' },
      { id: 'tag-c', name: 'Category B → Child C', hint: '' },
    ]);
  });

  it('applies approved rows, with the category the human picked', async () => {
    mail.messages = [order('Shop A', '40,48', later(-3)), order('Shop B', '12,00', later(-2))];
    zen.put(zmTx('z1', '2026-10-01', 40.48));
    zen.put(zmTx('z2', '2026-10-02', 12));
    await runner.run();

    const [a, b] = store.receiptsByStatus('review');
    expect(await runner.approve([
      { messageId: a!.messageId, tagId: null },
      { messageId: b!.messageId, tagId: 'tag-b' },
    ])).toBe(2);
    expect(zen.writes.map((w) => [w.id, w.tag, w.comment])).toEqual([
      ['z1', ['tag-a'], 'Glovo: Shop A'],
      ['z2', ['tag-b'], 'Glovo: Shop B'],
    ]);
    expect(store.getReceipt(b!.messageId)).toMatchObject({ status: 'applied', tagSource: 'user', previousTags: ['tag-old'] });
  });
});

describe('steady state', () => {
  beforeEach(async () => {
    await runner.run(); // first run fixes the auto-apply cutoff at T0
    now = later(1);
  });

  it('auto-applies a confident pick for receipts after the first run', async () => {
    mail.messages = [order('Shop A', '23,10', later(0.5))];
    zen.put(zmTx('z2', '2026-10-04', 23.1));
    expect((await runner.run()).applied).toBe(1);
    expect(zen.writes[0]).toMatchObject({ id: 'z2', tag: ['tag-a'], user: 7 });
  });

  it('waits — weeks if need be — for the charge to reach ZenMoney', async () => {
    mail.messages = [order('Shop A', '23,10', later(0.5))];
    await runner.run();
    now = later(20);
    await runner.run();
    expect(store.receiptsByStatus('unmatched')).toHaveLength(1);

    zen.put(zmTx('z2', '2026-10-05', 23.1)); // the user finally synced their bank in ZenMoney
    expect((await runner.run()).applied).toBe(1);
  });

  it('parks an unsure pick in review instead of applying it', async () => {
    mail.messages = [order('Shop A', '23,10', later(0.5))];
    classifier.answers.set('Shop A', { id: 'tag-c', confidence: 0.4 });
    zen.put(zmTx('z2', '2026-10-04', 23.1));
    await runner.run();
    expect(zen.writes).toEqual([]);
    expect(store.receiptsByStatus('review')).toMatchObject([{ note: 'classifier unsure (40%)', tagId: 'tag-c' }]);
  });

  it("uses the store's pinned category without asking the classifier", async () => {
    mail.messages = [order('Shop P', '7.99', later(0.5))];
    store.addReceipt('<seed>', { source: 'glovo', store: 'Shop P', totalCents: 1, currency: 'EUR', date: '2026-01-01', reference: null, items: [] }, 'shop p', 0);
    store.setStoreTag('shop p', 'tag-b');
    zen.put(zmTx('z3', '2026-10-04', 7.99));
    await runner.run();
    expect(zen.writes[0]).toMatchObject({ tag: ['tag-b'] });
    expect(classifier.calls).toHaveLength(0);
  });

  it('classifies subscription receipts like any other (no categories in code)', async () => {
    mail.messages = [paypalEmail({ amount: '7.99', item: 'GLOVO PRIME', date: later(0.5) })];
    classifier.answers.set('Glovo Prime', { id: 'tag-c', confidence: 0.9 });
    zen.put(zmTx('z3', '2026-10-04', 7.99));
    await runner.run();
    expect(zen.writes[0]).toMatchObject({ tag: ['tag-c'], comment: 'Glovo Prime' });
  });

  it('marks it already right instead of rewriting', async () => {
    mail.messages = [order('Shop A', '23,10', later(0.5))];
    zen.put(zmTx('z2', '2026-10-04', 23.1, { tag: ['tag-a'] }));
    await runner.run();
    expect(zen.writes).toEqual([]);
    expect(store.receiptsByStatus('unchanged')).toHaveLength(1);
  });

  it('touches each transaction once — a later manual change sticks', async () => {
    mail.messages = [order('Shop A', '23,10', later(0.5))];
    zen.put(zmTx('z2', '2026-10-04', 23.1));
    await runner.run();
    zen.put(zmTx('z2', '2026-10-04', 23.1, { tag: ['tag-old'], changed: 999 }));
    await runner.run();
    expect(zen.writes).toHaveLength(1);
  });

  it('retries classification after a hiccup instead of guessing', async () => {
    mail.messages = [order('Shop A', '23,10', later(0.5))];
    classifier.answers.set('Shop A', new JevError(529, 'overloaded'));
    zen.put(zmTx('z2', '2026-10-04', 23.1));
    await runner.run();
    expect(zen.writes).toEqual([]);

    classifier.answers.delete('Shop A');
    await runner.run();
    expect(zen.writes).toHaveLength(1);
  });

  it('fails the run on a rejected classifier token and says so once', async () => {
    mail.messages = [order('Shop A', '23,10', later(0.5))];
    classifier.answers.set('Shop A', new JevError(401, 'bad token'));
    zen.put(zmTx('z2', '2026-10-04', 23.1));
    expect((await runner.run()).ok).toBe(false);
    await runner.run();
    classifier.answers.delete('Shop A');
    await runner.run();
    expect(notifier.events).toEqual(['failed:TypeSafe rejected the request — check TYPESAFE_TOKEN.', 'recovered']);
  });

  it('expires receipts that never find a charge', async () => {
    mail.messages = [order('Shop A', '23,10', later(0.5))];
    await runner.run();
    now = later(60);
    await runner.run();
    expect(store.receiptsByStatus('expired')).toHaveLength(1);
  });

  it('keeps the auto-apply cutoff from the very first run', () => {
    expect(store.getKv(AUTO_SINCE_KV)).toBe(String(T0.getTime()));
  });
});

describe('without candidates or classifier', () => {
  it('sends new receipts to review, then applies them once candidates exist', async () => {
    store.setCandidates([]);
    await runner.run();
    now = later(1);
    mail.messages = [order('Shop A', '23,10', later(0.5))];
    zen.put(zmTx('z2', '2026-10-04', 23.1));
    await runner.run();
    expect(store.receiptsByStatus('review')).toHaveLength(1);
    expect(zen.writes).toEqual([]);

    store.setCandidates([{ tagId: 'tag-a', hint: '' }]);
    await runner.run();
    expect(zen.writes[0]).toMatchObject({ tag: ['tag-a'] });
  });

  it('never calls a classifier that is not configured', async () => {
    runner = makeRunner(false);
    await runner.run();
    now = later(1);
    mail.messages = [order('Shop A', '23,10', later(0.5))];
    zen.put(zmTx('z2', '2026-10-04', 23.1));
    await runner.run();
    expect(store.receiptsByStatus('review')).toHaveLength(1);
    expect(classifier.calls).toHaveLength(0);
  });
});
