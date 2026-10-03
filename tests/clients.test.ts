import { describe, expect, it } from 'vitest';
import { JevClassifier, JevError, TYPESAFE_URL } from '../src/classify/jev.ts';
import { ZenMoneyClient, ZenMoneyError } from '../src/zenmoney/client.ts';
import { loadConfig } from '../src/config.ts';

function fakeFetch(respond: () => Response) {
  const calls: { url: string; init: RequestInit }[] = [];
  const f = (async (url: string | URL, init: RequestInit) => {
    calls.push({ url: String(url), init });
    return respond();
  }) as typeof fetch;
  return { f, calls };
}

describe('JevClassifier', () => {
  const options = [
    { id: 'id-1', name: 'Category A', hint: 'hint A' },
    { id: 'id-2', name: 'Category B', hint: '' },
    { id: 'id-3', name: 'Category A', hint: 'same name, different id' },
  ];

  it('asks one Choice question over the given options and maps the answer back to an id', async () => {
    const { f, calls } = fakeFetch(() =>
      Response.json({
        model: 'jev-1.13.0',
        answers: { category: { type: 'choice', choice: 'Category A (2)', probabilities: {}, confidence: 0.93 } },
      }),
    );
    const res = await new JevClassifier({ token: 'tok', fetch: f }).classify({ store: 'Shop', items: ['1x Item'] }, options);
    expect(res).toEqual({ id: 'id-3', confidence: 0.93 });
    expect(calls[0]?.url).toBe(TYPESAFE_URL);
    expect((calls[0]?.init.headers as Record<string, string>).authorization).toBe('Bearer tok');
    const body = JSON.parse(String(calls[0]?.init.body));
    expect(body).toMatchObject({ model: 'jev-latest', state: { store: 'Shop', items: ['1x Item'] } });
    expect(body.questions.category.criteria).toEqual({
      'Category A': 'hint A',
      'Category B': null,
      'Category A (2)': 'same name, different id',
    });
  });

  it('turns HTTP errors and unknown answers into JevError', async () => {
    const unauthorized = fakeFetch(() => new Response('{"detail":"bad key"}', { status: 401 }));
    await expect(
      new JevClassifier({ token: 'x', fetch: unauthorized.f }).classify({ store: 's', items: [] }, options),
    ).rejects.toMatchObject({ status: 401 });
    const odd = fakeFetch(() => Response.json({ answers: { category: { choice: 'Nope', confidence: 1 } } }));
    await expect(
      new JevClassifier({ token: 'x', fetch: odd.f }).classify({ store: 's', items: [] }, options),
    ).rejects.toBeInstanceOf(JevError);
  });

  it('refuses an empty option list without calling the API', async () => {
    const { f, calls } = fakeFetch(() => Response.json({}));
    await expect(new JevClassifier({ token: 'x', fetch: f }).classify({ store: 's', items: [] }, [])).rejects.toBeInstanceOf(
      JevError,
    );
    expect(calls).toHaveLength(0);
  });
});

describe('ZenMoneyClient', () => {
  it('surfaces {error} bodies even with HTTP 200', async () => {
    const { f } = fakeFetch(() => Response.json({ error: { code: 'validationError', message: 'Wrong Value' } }));
    const err = await new ZenMoneyClient({ token: 't', server: 'ru', fetch: f }).diff({ serverTimestamp: 0 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ZenMoneyError);
    expect((err as Error).message).toContain('Wrong Value');
  });
});

describe('loadConfig', () => {
  const base = { ZENMONEY_TOKEN: 'z', GMAIL_USER: 'u@example.com', GMAIL_APP_PASSWORD: 'abcd efgh ijkl mnop' };

  it('applies defaults; Jev and Telegram are optional', () => {
    const c = loadConfig(base);
    expect(c).toMatchObject({ port: 8080, lookbackDays: 90, intervalMs: 10 * 60_000, expireAfterDays: 45, jev: null, telegram: null });
    expect(c.zenmoney).toEqual({ token: 'z', server: 'ru' });
    expect(c.payeePattern.test('Paypal *glovo')).toBe(true);
  });

  it('enables Jev with a token', () => {
    expect(loadConfig({ ...base, TYPESAFE_TOKEN: 'ts' }).jev).toEqual({ token: 'ts', minConfidence: 0.6 });
  });

  it('rejects bad values', () => {
    expect(() => loadConfig({ ...base, ZENMONEY_SERVER: 'com' })).toThrow(/ZENMONEY_SERVER/);
    expect(() => loadConfig({ ...base, JEV_MIN_CONFIDENCE: '2' })).toThrow(/JEV_MIN_CONFIDENCE/);
    expect(() => loadConfig({ ZENMONEY_TOKEN: 'z' })).toThrow(/GMAIL_USER/);
  });
});
