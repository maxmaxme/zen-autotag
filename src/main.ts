import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import * as v from 'valibot';
import { GmailAuthError } from './gmail.ts';
import { JevError } from './jev.ts';
import { localDay } from './receipts.ts';
import { scan, type Deps } from './scan.ts';
import { handleTap } from './taps.ts';
import { Telegram } from './telegram.ts';
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
  const value = process.env[name];
  if (value) {
    return value;
  }
  if (fallback !== undefined) {
    return fallback;
  }
  console.error(`missing env var ${name}`);
  process.exit(1);
}

/** config.json (on the Pi, never in git): the start date and optional category hints. */
const ConfigSchema = v.object({
  startDate: v.optional(v.pipe(v.string(), v.isoDate())),
  hints: v.optional(v.record(v.string(), v.string()), {}),
});

function loadConfig(path: string): { startDate: string; hints: Record<string, string> } {
  const parsed = v.safeParse(ConfigSchema, existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {});
  if (!parsed.success) {
    console.error(`${path}: ${v.summarize(parsed.issues)}`);
    process.exit(1);
  }
  const config = parsed.output;
  if (!config.startDate) {
    // First start: only transactions from today on are ever touched.
    config.startDate = localDay(new Date());
    writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`);
    log(`wrote ${path} with startDate ${config.startDate}`);
  }
  return { startDate: config.startDate, hints: config.hints };
}

const server = v.safeParse(ServerSchema, env('ZENMONEY_SERVER', 'ru'));
if (!server.success) {
  console.error(`ZENMONEY_SERVER must be one of ${ServerSchema.options.join(', ')}`);
  process.exit(1);
}
const config = loadConfig(env('CONFIG_PATH', './data/config.json'));
const telegram = new Telegram(env('ZEN_TELEGRAM_BOT_TOKEN'));
const gmailUser = process.env.GMAIL_USER;
const gmailPassword = process.env.GMAIL_APP_PASSWORD;
const deps: Deps = {
  zenmoney: new ZenMoney(env('ZENMONEY_TOKEN'), server.output),
  telegram,
  chatId: env('TELEGRAM_CHAT_ID'),
  jevToken: env('TYPESAFE_TOKEN'),
  gmail: gmailUser && gmailPassword ? { user: gmailUser, appPassword: gmailPassword } : null,
  startDate: config.startDate,
  hints: config.hints,
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
for (;;) {
  if (Date.now() - lastScan >= scanEveryMs) {
    lastScan = Date.now();
    try {
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
    await alert(err);
    await new Promise((r) => setTimeout(r, 10_000));
  }
}
