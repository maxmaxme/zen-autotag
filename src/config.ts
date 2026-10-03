import { optionalEnv, requireEnv, type Env } from './env.ts';
import { ZENMONEY_SERVERS, type ZenMoneyServer } from './zenmoney/client.ts';

export interface Config {
  dataDir: string;
  port: number;
  zenmoney: { token: string; server: ZenMoneyServer };
  gmail: { user: string; appPassword: string };
  /** How far back the very first run reads mail. */
  lookbackDays: number;
  intervalMs: number;
  /** Days a receipt waits for its charge to reach ZenMoney (outlast your bank-sync gaps). */
  expireAfterDays: number;
  /** ZenMoney payees a receipt may match (case-insensitive regex). */
  payeePattern: RegExp;
  telegram: { token: string; chatId: string } | null;
  /** TypeSafe Jev for classifying orders by their items; null = store rules only. */
  jev: { token: string; minConfidence: number } | null;
}

function positive(env: Env, name: string, fallback: string): number {
  const n = Number(requireEnv(env, name, fallback));
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`${name} must be a positive number, got ${env[name]}`);
  }
  return n;
}

export function loadConfig(env: Env): Config {
  const server = requireEnv(env, 'ZENMONEY_SERVER', 'ru');
  if (!(server in ZENMONEY_SERVERS)) {
    throw new Error(`ZENMONEY_SERVER must be one of ${Object.keys(ZENMONEY_SERVERS).join(', ')}, got ${server}`);
  }
  const jevToken = optionalEnv(env, 'TYPESAFE_TOKEN');
  const minConfidence = Number(requireEnv(env, 'JEV_MIN_CONFIDENCE', '0.6'));
  if (!(minConfidence >= 0 && minConfidence <= 1)) {
    throw new Error(`JEV_MIN_CONFIDENCE must be between 0 and 1, got ${env.JEV_MIN_CONFIDENCE}`);
  }
  const token = optionalEnv(env, 'TELEGRAM_BOT_TOKEN');
  const chatId = optionalEnv(env, 'TELEGRAM_CHAT_ID');
  return {
    dataDir: requireEnv(env, 'ZEN_RECEIPTS_DATA_DIR', '/app/data'),
    port: positive(env, 'PORT', '8080'),
    zenmoney: { token: requireEnv(env, 'ZENMONEY_TOKEN'), server: server as ZenMoneyServer },
    gmail: { user: requireEnv(env, 'GMAIL_USER'), appPassword: requireEnv(env, 'GMAIL_APP_PASSWORD') },
    lookbackDays: positive(env, 'MAIL_LOOKBACK_DAYS', '90'),
    intervalMs: positive(env, 'RUN_INTERVAL_MINUTES', '10') * 60_000,
    expireAfterDays: positive(env, 'RECEIPT_EXPIRE_DAYS', '45'),
    payeePattern: new RegExp(requireEnv(env, 'ZM_PAYEE_PATTERN', 'glovo'), 'i'),
    telegram: token && chatId ? { token, chatId } : null,
    jev: jevToken ? { token: jevToken, minConfidence } : null,
  };
}
