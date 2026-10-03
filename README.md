# zen-receipts

Sets the right [ZenMoney](https://zenmoney.app) category on card charges
that the bank statement can't tell apart, using the receipts that land in
your mailbox.

The motivating case: every Glovo order shows up on the card as the same
`Paypal *glovo`, whatever was actually ordered. Glovo emails a receipt for
each delivered order, with the store and the line items. zen-receipts reads
those emails, decides which of *your* ZenMoney categories the order belongs
to, finds the matching charge in ZenMoney and categorises it.

```
Gmail (IMAP)  ──►  receipt: store, items, total, day
                        │  category: pinned for the store, or picked by the classifier
                        │            among the categories you allowed (with your hints)
ZenMoney diff ──►  charge with the same amount, near that day, payee ~ /glovo/
                        │
                        └─► set category (+ "Glovo: <store>" comment) on that charge
```

Self-hosted, one small container with a web UI. No auth of its own — put it
behind your reverse proxy. No categories, stores or spending habits are
baked into the code: they live in your deployment's database.

## What it does, precisely

- **Receipts it understands:** Glovo "Details of your order" (sent after
  delivery, so the total is final) and PayPal's receipt for Glovo Prime.
  Parsers live in `src/receipts/parse.ts`; adding a merchant means adding a
  parser and a Gmail query.
- **Category:** a category you pinned to the store wins. Otherwise
  [TypeSafe Jev](https://docs.typesafe.ai) (optional) picks one of the
  categories you ticked in the UI, judging the store and the line items
  against each category's name and the hint you wrote for it. A pick below
  `JEV_MIN_CONFIDENCE`, or no way to decide at all, waits in **Review**.
- **Matching:** same amount to the cent, money out, payee matching
  `ZM_PAYEE_PATTERN`, from one day before to five days after the receipt
  (by the charge's own date, so it doesn't matter when you sync your bank in
  ZenMoney); the closest date wins, a tie is left alone. A receipt waits up
  to `RECEIPT_EXPIRE_DAYS` for its charge to appear. A charge is claimed by
  at most one receipt.
- **Writes:** each charge is touched **once**. If you change the category
  afterwards, it stays changed. A comment you wrote is kept; an empty one
  becomes "Glovo: &lt;store&gt;".
- **History:** receipts from before the first run go to **Review** —
  current vs proposed category, editable per row — and only change ZenMoney
  when you apply them. Later ones apply automatically.
- **ZenMoney sync** uses its incremental `diff` protocol: one full download
  on the first run, then only changes, every `RUN_INTERVAL_MINUTES`.

## Setup

1. **ZenMoney token** — ZenMoney doesn't issue API keys; sign in at
   [zerro.app](https://zerro.app) and copy `localStorage.zm_token`
   (`localStorage.zm_server` says `ru` or `app`).
2. **Gmail app password** — turn on 2-Step Verification, then create one at
   <https://myaccount.google.com/apppasswords>.
3. **TypeSafe token** (optional) for Jev.
4. Run:

   ```bash
   docker run -d --name zen-receipts -p 8080:8080 \
     --env-file .env -v "$(pwd)/data:/app/data" \
     ghcr.io/maxmaxme/zen-receipts:latest
   ```

5. Open the UI: tick the categories the classifier may use and write a
   hint for each (what kind of shop or purchase belongs there), pin stores
   that always mean one thing, then go through **Review** and apply what
   looks right.

See [`.env.example`](.env.example) for every setting.

## Development

```bash
npm install
npm run typecheck
npm test
cp .env.example .env   # fill in, ZEN_RECEIPTS_DATA_DIR=./data
node src/index.ts
```

Node 24 runs the TypeScript directly — no build step.
