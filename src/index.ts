import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from './config.ts';
import { defaultEnvCandidates, loadEnvFiles } from './env.ts';
import { JevClassifier } from './classify/jev.ts';
import { GmailImap } from './mail/gmail.ts';
import { NullNotifier, TelegramNotifier } from './notify/telegram.ts';
import { Runner } from './runner.ts';
import { openStore } from './storage/sqlite.ts';
import { createApp } from './web/server.ts';
import { ZenMoneyClient } from './zenmoney/client.ts';
import { ZenMirror } from './zenmoney/mirror.ts';
import { createLogger } from './logger.ts';

const log = createLogger('index');

// Auto-load .env when running outside the container. In production the file
// is injected by docker-compose's `env_file`, so this is a no-op.
loadEnvFiles(defaultEnvCandidates(import.meta.url));

const FIRST_RUN_DELAY_MS = 10_000;

function main(): void {
  const config = loadConfig(process.env);
  mkdirSync(config.dataDir, { recursive: true });

  const store = openStore(join(config.dataDir, 'zen-receipts.sqlite'));
  const mirror = new ZenMirror({
    api: new ZenMoneyClient(config.zenmoney),
    store,
    payeePattern: config.payeePattern,
  });
  const runner = new Runner({
    mailbox: new GmailImap(config.gmail),
    mirror,
    store,
    notifier: config.telegram ? new TelegramNotifier(config.telegram) : new NullNotifier(),
    log: createLogger('runner'),
    now: () => new Date(),
    lookbackDays: config.lookbackDays,
    expireAfterDays: config.expireAfterDays,
    classifier: config.jev ? new JevClassifier({ token: config.jev.token }) : null,
    minConfidence: config.jev?.minConfidence ?? 1,
  });

  const server = createApp({ store, runner, mirror, hasClassifier: config.jev !== null, log: createLogger('web') });
  server.listen(config.port, () => log.info({ port: config.port }, 'listening'));

  const tick = () => {
    runner.run().catch((err: unknown) => log.error({ err }, 'run crashed'));
  };
  const first = setTimeout(tick, FIRST_RUN_DELAY_MS);
  const timer = setInterval(tick, config.intervalMs);

  const shutdown = (signal: string) => {
    log.info({ signal }, 'shutting down');
    clearTimeout(first);
    clearInterval(timer);
    server.close(() => {
      store.close();
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

try {
  main();
} catch (err) {
  log.error({ err }, 'fatal');
  process.exit(1);
}
