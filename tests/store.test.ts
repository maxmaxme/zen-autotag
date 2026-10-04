import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { importLegacyConfig, openStore } from '../src/store.ts';

// Neutral, made-up data only (public repo).
const dir = () => mkdtempSync(join(tmpdir(), 'zen-autotag-'));

describe('store', () => {
  it('starts empty and keeps what was written across restarts', () => {
    const path = join(dir(), 'nested', 'db.sqlite'); // the data dir may not exist yet
    const first = openStore(path);
    expect(first.startDate()).toBeNull();
    expect(first.hints()).toEqual({});
    first.setStartDate('2026-10-04');
    first.setHint('Food → Out', 'restaurants');
    first.setHint('Food → Out', 'restaurants and cafes'); // an edit replaces, never duplicates
    first.close();

    const again = openStore(path);
    expect(again.startDate()).toBe('2026-10-04');
    expect(again.hints()).toEqual({ 'Food → Out': 'restaurants and cafes' });
  });
});

describe('importing the old config.json', () => {
  it('moves it in once and renames the file so it is never read again', () => {
    const d = dir();
    const config = join(d, 'config.json');
    writeFileSync(
      config,
      JSON.stringify({ startDate: '2026-09-01', hints: { '🎈': 'party supplies', Gifts: 'presents' } }),
    );
    const store = openStore(join(d, 'db.sqlite'));

    expect(importLegacyConfig(store, config)).toBe(true);
    expect(store.startDate()).toBe('2026-09-01');
    expect(store.hints()).toEqual({ '🎈': 'party supplies', Gifts: 'presents' });
    expect(existsSync(config)).toBe(false);
    expect(existsSync(`${config}.imported`)).toBe(true);
    expect(importLegacyConfig(store, config)).toBe(false);
  });

  it('leaves a store that already has data alone', () => {
    const d = dir();
    const config = join(d, 'config.json');
    writeFileSync(config, JSON.stringify({ startDate: '2020-01-01', hints: { Gifts: 'old' } }));
    const store = openStore(join(d, 'db.sqlite'));
    store.setStartDate('2026-10-04');
    store.setHint('Gifts', 'current');

    expect(importLegacyConfig(store, config)).toBe(false);
    expect(store.startDate()).toBe('2026-10-04');
    expect(store.hints()).toEqual({ Gifts: 'current' });
    expect(existsSync(config)).toBe(true);
  });

  it('refuses a malformed file instead of starting from a wrong date', () => {
    const d = dir();
    const config = join(d, 'config.json');
    writeFileSync(config, JSON.stringify({ startDate: '4 Oct', hints: {} }));
    const store = openStore(join(d, 'db.sqlite'));
    expect(() => importLegacyConfig(store, config)).toThrow(/startDate/);
    expect(store.startDate()).toBeNull();
    expect(existsSync(config)).toBe(true);
  });
});
