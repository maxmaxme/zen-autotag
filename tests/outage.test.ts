import { describe, expect, it } from 'vitest';
import { explain, outageLog } from '../src/outage.ts';

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
    outage.ok();
    outage.ok();

    expect(lines).toEqual([
      'telegram: unreachable — Bad Gateway',
      'telegram: back after 2 min (3 failed, last: fetch failed (ETIMEDOUT))',
    ]);
  });
});
