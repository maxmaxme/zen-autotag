# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

A small long-running Node/TS service that categorises new ZenMoney
transactions: payee habit, else TypeSafe Jev (with merchant receipts from
Gmail for look-alike charges — Glovo, Amazon), marks them viewed, and asks
in Telegram (inline buttons) only when unsure. Personal use; see README.md
for the behaviour.

CI publishes `ghcr.io/maxmaxme/zen-autotag:latest` (+ `:sha-<short>`,
arm64) on every push to `main`. Deployment is someone else's job.

## Commands

```bash
npm install
npm run typecheck                 # tsc --noEmit
npm test                          # vitest run
DRY_RUN=1 node src/main.ts        # reads .env next to package.json
```

## Critical conventions

**Keep it small and sequential.** One loop in `main.ts`: scan every
SCAN_MINUTES, Telegram long polling in between. No timers, no HTTP server,
no queue, no database. A tap and a scan never run at the same time. Resist
adding state: ZenMoney's `viewed` flag is the "done" marker, Telegram
messages carry their own state (UUIDs packed as 22-char base64url in
`callback_data`, ≤64 bytes; the "Other" list keeps the original buttons
above « Back), `config.json` holds only startDate + hints.

**Functions stay under Sonar's cognitive complexity of 15** — split into
named steps (see `scan.ts`: newTransactions → loadContext → gather → choose
→ decide → notice) rather than growing one function.

**This repo is public and must not reveal what its user spends on.** No
categories, hints, shops or real receipts in code, docs, tests or commit
messages. Tests use neutral made-up data; `tests/fixtures.ts` reproduces
the receipt templates' structure with fake content. Real data only under
`data/` and `.env` (gitignored).

**Writing to ZenMoney replaces the whole object** — always start from the
transaction just fetched, change only `tag`, `viewed`, an empty `comment`
and `changed`. Never touch: transfers (incomeAccount ≠ outcomeAccount),
viewed transactions, anything before `startDate`, a non-empty comment.

**Never guess on failure.** A Jev 5xx skips that transaction (retried next
pass, nothing marked); 401/403 fails the pass (Telegram alert). An email
that doesn't parse is logged; the charge falls back to history-only.

**Tests check behaviour that can go wrong** (wrong total picked from a
receipt, a field lost on write, a tie matched at random, a tap from another
chat) — not formatting trivia.

**APIs:** ZenMoney `POST /v8/diff/` (any past `serverTimestamp` works as a
sliding window) — <https://github.com/zenmoney/ZenPlugins/wiki/ZenMoney-API>.
TypeSafe Choice question — <https://docs.typesafe.ai/api>. Gmail over IMAP
with an app password, "All Mail" found by the `\All` flag (name is
localised), Gmail search syntax via `X-GM-RAW` (matches whole words).

## Adding a merchant

Append to `MERCHANTS` in `src/receipts.ts`: payee regex, context for Jev,
Gmail queries, `maxDaysApart` (charge vs email day), and parsers returning
`{ store, items, totalCents, day }`. Add a fixture that mirrors the real
template's structure and a test for the total, the items and a near-miss.
