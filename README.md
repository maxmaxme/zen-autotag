# zen-autotag

Categorises new [ZenMoney](https://zenmoney.app) transactions with an AI
classifier, so you don't have to — and asks you in Telegram only when it
isn't sure.

Every few minutes it looks at transactions your bank sync brought into
ZenMoney that you haven't viewed yet, and for each one:

1. **Payee habit.** If you've filed this payee the same way 3+ times (≥90%),
   that's the category. No AI call.
2. Otherwise **[TypeSafe Jev](https://docs.typesafe.ai)** picks one of your
   ZenMoney categories. It is shown the payee, amount, account, date, how you
   filed this payee before, optional hints for categories whose names don't
   explain themselves — and, for merchants whose charges all look alike, the
   **receipt from your mailbox** (Glovo, Amazon): store and line items.
3. The transaction gets the category and is **marked viewed**. Marking it
   viewed is also how the next pass knows it's done, so the service stores
   nothing about transactions.
4. When Jev wasn't sure, or another category is a real contender, you get a
   Telegram message — current category, `✓ OK`, the alternatives with their
   probabilities, and the full list. One tap fixes it in ZenMoney.

| Jev's confidence | What happens |
| --- | --- |
| ≥ `MIN_CONFIDENCE` (0.8) | applied silently |
| ≥ `APPLY_CONFIDENCE` (0.5) | applied, and you're asked |
| lower | category left as it was, and you're asked |

Transfers between your own accounts, transactions you've already viewed and
anything dated before the first start are never touched.

## Design

One process, one loop, nothing in parallel:

```
forever:
  every SCAN_MINUTES → scan()                # ZenMoney → receipts → Jev → ZenMoney → Telegram
  in between → Telegram long polling          # button taps; no public URL needed
```

No database. ZenMoney's `viewed` flag marks what's done, Telegram messages
carry their own state (ids packed into the buttons), and `config.json` holds
the start date and your category hints:

```json
{ "startDate": "2026-10-04", "hints": { "<category as shown, e.g. Parent → Child>": "plain words: what goes there" } }
```

Categories with no hint are named in one Telegram message (once per run).
Hints are read at start — restart after editing.

| File | Does |
| --- | --- |
| `src/main.ts` | env, config, the loop, error alerts to Telegram |
| `src/scan.ts` | one pass: new transactions → habit or Jev → save → messages |
| `src/taps.ts` | button presses: OK / pick / other / back |
| `src/receipts.ts` | merchants (Glovo, Amazon): Gmail queries, parsers, charge ↔ receipt matching |
| `src/gmail.ts` | IMAP search over "All Mail" |
| `src/jev.ts` | one Choice question to TypeSafe |
| `src/zenmoney.ts` | the `/v8/diff/` sync endpoint |
| `src/telegram.ts` | the few Bot API calls used, callback encoding |

## Setup

1. ZenMoney token: sign in at [zerro.app](https://zerro.app), copy
   `localStorage.zm_token` (and `zm_server`: `ru` or `app`).
2. TypeSafe token for Jev.
3. A new Telegram bot from @BotFather; send it `/start`.
4. Optional, for receipts: a Gmail app password.
5. Run (try `DRY_RUN=1` first — it decides and messages but writes nothing):

   ```bash
   docker run -d --name zen-autotag --env-file .env \
     -v "$(pwd)/data:/app/data" ghcr.io/maxmaxme/zen-autotag:latest
   ```

See [`.env.example`](.env.example).

## Development

```bash
npm install
npm run typecheck
npm test
node src/main.ts        # reads .env next to package.json
```

Node 24 runs the TypeScript directly — no build step.
