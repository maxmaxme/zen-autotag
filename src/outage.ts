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
 * Two log lines per outage instead of one per failed poll: when it turns out
 * to be one (the second failure in a row, with the first reason) and when it
 * ends (how long, how many failures, the last reason). A single failed call
 * that the next one gets past is a blip, not an outage — no lines at all.
 */
export function outageLog(name: string, log: (msg: string) => void, now: () => number = Date.now) {
  let since: number | null = null;
  let failures = 0;
  let first = '';
  let last = '';
  return {
    failed(err: unknown): void {
      failures++;
      last = explain(err);
      if (since === null) {
        since = now();
        first = last;
      } else if (failures === 2) {
        log(`${name}: unreachable — ${first}`);
      }
    },
    /** `at`: when the call that succeeded was made — a long poll returns long after it got through. */
    ok(at: number = now()): void {
      if (since !== null && failures > 1) {
        log(`${name}: back after ${duration(at - since)} (${failures} failed, last: ${last})`);
      }
      since = null;
      failures = 0;
    },
  };
}

/** Codes for the network letting us down (Node sockets, DNS, imapflow timeouts) — not the service saying no. */
const NETWORK_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EPIPE',
  'ETIMEOUT',
  'CONNECT_TIMEOUT',
  'GREETING_TIMEOUT',
  'UPGRADE_TIMEOUT',
]);

/** Trouble that passes on its own: fetch couldn't get through, a request timed out, a socket dropped. */
export function isNetworkError(err: unknown): boolean {
  if (err instanceof TypeError && err.message === 'fetch failed') {
    return true; // how undici reports anything below HTTP; the cause says what
  }
  if (err instanceof DOMException && err.name === 'TimeoutError') {
    return true; // AbortSignal.timeout
  }
  return v.is(CodeSchema, err) && NETWORK_CODES.has(err.code);
}
