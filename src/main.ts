import { writeFileSync } from 'node:fs';
import * as v from 'valibot';
import { GmailAuthError } from './gmail.ts';
import { JevError } from './jev.ts';
import { localDay } from './receipts.ts';
import { scan, type Deps } from './scan.ts';
import { importLegacyConfig, openStore } from './store.ts';
import { handleTap, type TapDeps } from './taps.ts';
import { Telegram, TelegramError } from './telegram.ts';
import { ServerSchema, ZenMoney, ZenMoneyError } from './zenmoney.ts';

// One process, one loop, nothing in parallel:
//   every SCAN_MINUTES → scan(); in between → wait for button taps (long polling).

try {
  process.loadEnvFile(new URL('../.env', import.meta.url));
} catch {
  // No .env next to the code — fine in Docker, where env comes from compose.
}

const log = (msg: string) => console.log(`${new Date().toISOString()} ${msg}`);

function env(name: string, fallback?: string): string {
  const value = process.env[name] || fallback;
  if (value === undefined) {
    console.error(`missing env var ${name}`);
    process.exit(1);
  }
  return value;
}

const server = v.safeParse(ServerSchema, env('ZENMONEY_SERVER', 'ru'));
if (!server.success) {
  console.error(`ZENMONEY_SERVER must be one of ${ServerSchema.options.join(', ')}`);
  process.exit(1);
}
const store = openStore(env('DB_PATH', './data/zen-autotag.sqlite'));
const legacyConfig = env('CONFIG_PATH', './data/config.json');
if (importLegacyConfig(store, legacyConfig)) {
  log(`imported ${legacyConfig} into the database (renamed to *.imported)`);
}
let startDate = store.startDate();
if (!startDate) {
  // First start: only transactions from today on are ever touched.
  startDate = localDay(new Date());
  store.setStartDate(startDate);
  log(`first start: startDate ${startDate}`);
}
const telegram = new Telegram(env('ZEN_TELEGRAM_BOT_TOKEN'));
const gmailUser = process.env.GMAIL_USER;
const gmailPassword = process.env.GMAIL_APP_PASSWORD;
const deps: Deps & TapDeps = {
  zenmoney: new ZenMoney(env('ZENMONEY_TOKEN'), server.output),
  telegram,
  chatId: env('TELEGRAM_CHAT_ID'),
  jevToken: env('TYPESAFE_TOKEN'),
  gmail: gmailUser && gmailPassword ? { user: gmailUser, appPassword: gmailPassword } : null,
  startDate,
  hints: store.hints(),
  minConfidence: Number(env('MIN_CONFIDENCE', '0.8')),
  applyConfidence: Number(env('APPLY_CONFIDENCE', '0.5')),
  dryRun: ['1', 'true', 'yes'].includes(env('DRY_RUN', '').toLowerCase()),
  log,
};
const scanEveryMs = Number(env('SCAN_MINUTES', '5')) * 60_000;

/** Errors go to Telegram, each distinct one at most every 6 hours. */
const lastAlert = new Map<string, number>();
async function alert(err: unknown): Promise<void> {
  const msg = err instanceof Error ? err.message : String(err);
  log(`error: ${msg}`);
  let hint = '';
  if (err instanceof ZenMoneyError && (err.status === 401 || err.status === 403)) {
    hint = '\nTake a fresh token from zerro.app (localStorage.zm_token) → ZENMONEY_TOKEN.';
  } else if (err instanceof GmailAuthError) {
    hint = '\nCreate a new Gmail app password → GMAIL_APP_PASSWORD.';
  } else if (err instanceof JevError) {
    hint = '\nCheck TYPESAFE_TOKEN.';
  }
  const key = msg.slice(0, 80);
  if (Date.now() - (lastAlert.get(key) ?? 0) > 6 * 3_600_000) {
    lastAlert.set(key, Date.now());
    await telegram.send(deps.chatId, `⚠️ zen-autotag: ${msg}${hint}`, null, false).catch(() => {});
  }
}

process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));

log(`started — since ${deps.startDate}, scan every ${scanEveryMs / 60_000} min${deps.dryRun ? ', DRY RUN' : ''}`);
const handled = new Set<string>();
let lastScan = 0;
// Touched every turn of the loop; the Docker healthcheck reads its age.
const heartbeat = process.env.HEARTBEAT_FILE;
for (;;) {
  if (heartbeat) {
    writeFileSync(heartbeat, '');
  }
  if (Date.now() - lastScan >= scanEveryMs) {
    lastScan = Date.now();
    try {
      deps.hints = store.hints(); // an edit in the database applies on the next scan
      const n = await scan(deps, handled);
      if (n > 0) {
        log(`categorised ${n}`);
      }
    } catch (err) {
      await alert(err);
    }
  }
  try {
    const wait = Math.max(1, Math.min(50, Math.ceil((lastScan + scanEveryMs - Date.now()) / 1000)));
    for (const tap of await telegram.taps(wait)) {
      await handleTap(deps, tap).catch(alert);
    }
  } catch (err) {
    // Telegram itself failing (429, 5xx, a timed-out poll) has no channel to alert
    // through and passes on its own: log it and wait as long as Telegram asks.
    log(`telegram: ${err instanceof Error ? err.message : String(err)}`);
    const retryAfter = err instanceof TelegramError ? err.retryAfter : null;
    await new Promise((r) => setTimeout(r, (retryAfter ?? 10) * 1000));
  }
}
