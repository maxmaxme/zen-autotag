import * as v from 'valibot';

const CodeSchema = v.object({ code: v.string() });

/** An error's message plus what's underneath: fetch's bare "fetch failed" hides the real cause (ECONNRESET…). */
export function explain(err: unknown): string {
  if (!(err instanceof Error)) {
    return String(err);
  }
  let detail: string | null = null;
  if (v.is(CodeSchema, err.cause)) {
    detail = err.cause.code;
  } else if (err.cause instanceof Error) {
    detail = err.cause.message;
  }
  return detail && !err.message.includes(detail) ? `${err.message} (${detail})` : err.message;
}

function duration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 90) {
    return `${s} s`;
  }
  const min = Math.round(s / 60);
  return min < 90 ? `${min} min` : `${Math.floor(min / 60)} h ${min % 60} min`;
}

/**
 * Two log lines per outage instead of one per failed poll: when it starts
 * (with the first reason) and when it ends (how long, how many failures,
 * the last reason).
 */
export function outageLog(name: string, log: (msg: string) => void, now: () => number = Date.now) {
  let since: number | null = null;
  let failures = 0;
  let last = '';
  return {
    failed(err: unknown): void {
      failures++;
      last = explain(err);
      if (since === null) {
        since = now();
        log(`${name}: unreachable — ${last}`);
      }
    },
    ok(): void {
      if (since !== null) {
        log(`${name}: back after ${duration(now() - since)} (${failures} failed, last: ${last})`);
        since = null;
        failures = 0;
      }
    },
  };
}
