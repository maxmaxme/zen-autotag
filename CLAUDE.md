# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Long-running Node/TS service that categorises ZenMoney transactions from
emailed receipts. Reads Gmail over IMAP, parses receipts (Glovo orders,
PayPal's Glovo Prime receipt), decides the category — the store's pinned
category, else TypeSafe Jev picking among user-chosen candidate categories
with user-written hints — finds the matching charge in a local mirror of
ZenMoney and sets it. Small `node:http` UI for candidates, store pins and
reviewing. Personal use.

CI publishes `ghcr.io/maxmaxme/zen-receipts:latest` (+ `:sha-<short>`,
arm64) on every push to `main`. Deployment is someone else's job.

## Commands

```bash
npm install
npm run typecheck                 # tsc --noEmit
npm test                          # vitest run
node src/index.ts                 # needs ZENMONEY_TOKEN, GMAIL_USER, GMAIL_APP_PASSWORD
```

`.env` next to `package.json` is auto-loaded (and gitignored).

## Critical conventions

**Node 24 native TypeScript stripping, no build step.** Relative imports
use `.ts`; no `enum` / `namespace` / parameter properties / decorators
(`erasableSyntaxOnly`). SQLite is `node:sqlite`; runtime deps are only
`pino`, `imapflow`, `mailparser` (all pure JS — the image is cross-built
for arm64).

**This repo is public, and must not reveal what its user spends on.** No
categories, category hints, store names or store→category rules in code,
docs, tests or commit messages — not even as "defaults". All of that lives
only in the deployed SQLite (`candidates`, `stores`), set in the UI. Tests
use neutral synthetic data (`Shop A`, `Category B`, `Item 1`) from
`tests/helpers.ts`; never paste real receipts.

**Never write to ZenMoney without a reason the user agreed to.** Receipts
emailed before the first run (`kv.auto_since`) go to `review` and change
nothing until approved in the UI. Each ZenMoney transaction is written at
most once (`receipts.zm_tx_id` is UNIQUE and a receipt leaves
`matched`/`review` after applying) — a later manual change must stick.
Writes replace the whole transaction object, so always start from the
freshly mirrored `raw` and change only `tag`, empty `comment`, `changed`.

**ZenMoney mirror** (`src/zenmoney/mirror.ts`): every diff call — reads
and writes — goes through `ZenMirror.sync` so `serverTimestamp` never
skips changes. Only transactions whose payee matches `ZM_PAYEE_PATTERN`
are kept. API reference: <https://github.com/zenmoney/ZenPlugins/wiki/ZenMoney-API>.

**Category precedence** (`runner.ts::resolveTag`): the store's pinned
category → the receipt's own decision (Jev pick, or the user's pick in
review). Jev chooses only among `candidates`; options are sent by readable
category name + hint and mapped back to ids. A pick below
`JEV_MIN_CONFIDENCE`, or no candidates/classifier, parks the receipt in
`review`. A Jev error leaves it undecided and retried; a 401/403 fails the
run (Telegram).

**Order in a run matters:** read mail → sync mirror → match → expire →
classify → apply. Matching before expiring gives backfilled receipts one
real attempt.

**Gmail search** uses Gmail's own syntax (`X-GM-RAW`) over "All Mail",
found by the `\All` special-use flag because its name is localised. Gmail
matches whole words — `glovo` doesn't hit `GLOVOAPP23`.

## Architecture

```
src/index.ts              # entry — config, wiring, interval timer
src/config.ts             # env → Config
src/runner.ts             # one pass: mail → mirror → match → expire → classify → apply; resolveTag
src/receipts/parse.ts     # email → ParsedReceipt (Glovo, PayPal Prime) + GMAIL_QUERIES
src/receipts/stores.ts    # storeKey normalisation
src/classify/jev.ts       # TypeSafe Jev Choice over the candidate categories → id + confidence
src/match.ts              # findMatch (amount/date window), withCategory
src/mail/gmail.ts         # IMAP fetch with app password
src/zenmoney/             # client (diff), mirror (incremental sync + tags), types
src/storage/              # node:sqlite store; migrations in PRAGMA user_version (append-only)
src/notify/telegram.ts    # failure / recovery transitions
src/web/                  # node:http routes + server-rendered HTML
tests/                    # vitest; synthetic emails, fake ZenMoney / mailbox / classifier
```
