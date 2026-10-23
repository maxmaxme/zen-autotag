import { describe, expect, it } from 'vitest';
import { explain, isNetworkError, outageLog } from '../src/outage.ts';

describe('explain', () => {
  it("adds what fetch's bare message hides", () => {
    expect(
      explain(new TypeError('fetch failed', { cause: Object.assign(new Error('read'), { code: 'ECONNRESET' }) })),
    ).toBe('fetch failed (ECONNRESET)');
    expect(explain(new Error('outer', { cause: new Error('inner reason') }))).toBe('outer (inner reason)');
    expect(explain(new Error('Telegram getUpdates: Bad Gateway'))).toBe('Telegram getUpdates: Bad Gateway');
  });
});

describe('outageLog', () => {
  it('logs an outage once when it starts and once when it ends, not every failed poll', () => {
    const lines: string[] = [];
    let t = 0;
    const outage = outageLog(
      'telegram',
      (m) => lines.push(m),
      () => t,
    );

    outage.ok(); // all fine: nothing to say
    outage.failed(new Error('Bad Gateway'));
    t = 10_000;
    outage.failed(new Error('timeout'));
    t = 130_000;
    outage.failed(new TypeError('fetch failed', { cause: { code: 'ETIMEDOUT' } }));
    t = 190_000; // the poll that got through was made at 140 s and returned 50 s later
    outage.ok(140_000);
    outage.ok();

    expect(lines).toEqual([
      'telegram: unreachable — Bad Gateway',
      'telegram: back after 2 min (3 failed, last: fetch failed (ETIMEDOUT))',
    ]);
  });

  it('says nothing about a single failed call the next one gets past', () => {
    const lines: string[] = [];
    const outage = outageLog('telegram', (m) => lines.push(m));

    outage.failed(new TypeError('fetch failed', { cause: { code: 'ECONNRESET' } }));
    outage.ok();
    outage.failed(new Error('Bad Gateway'));
    outage.ok();

    expect(lines).toEqual([]);
  });
});

describe('isNetworkError', () => {
  it('tells the network failing from a service saying no', () => {
    expect(isNetworkError(new TypeError('fetch failed', { cause: { code: 'UND_ERR_CONNECT_TIMEOUT' } }))).toBe(true);
    expect(isNetworkError(new DOMException('The operation was aborted due to timeout', 'TimeoutError'))).toBe(true);
    expect(
      isNetworkError(Object.assign(new Error('getaddrinfo EAI_AGAIN imap.gmail.com'), { code: 'EAI_AGAIN' })),
    ).toBe(true);

    expect(isNetworkError(new Error('ZenMoney 401: Unauthorized'))).toBe(false);
    expect(isNetworkError(new TypeError("Cannot read properties of undefined (reading 'id')"))).toBe(false);
    expect(isNetworkError(Object.assign(new Error('no such folder'), { code: 'NotFound' }))).toBe(false);
  });
});
