import type { Candidate, ReceiptRow, StoreRow } from '../storage/types.ts';
import type { RunResult } from '../runner.ts';

export interface ReviewRow extends ReceiptRow {
  currentTags: string | null;
  /** The category that would be applied (store's fixed one or the classifier's pick). */
  proposedTagId: string | null;
}

export interface PageModel {
  flash: { kind: 'ok' | 'err'; text: string } | null;
  running: boolean;
  last: RunResult | null;
  hasClassifier: boolean;
  tags: { id: string; label: string }[];
  candidates: Candidate[];
  stores: StoreRow[];
  review: ReviewRow[];
  recent: ReceiptRow[];
}

export function escapeHtml(s: string): string {
  return s
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

const e = escapeHtml;

function euros(cents: number): string {
  return `${(cents / 100).toFixed(2)} €`;
}

function fmtTime(ms: number): string {
  return new Date(ms).toLocaleString('en-GB', { dateStyle: 'short', timeStyle: 'short' });
}

const STATUS_LABEL: Record<ReceiptRow['status'], string> = {
  unmatched: 'waiting for the charge in ZenMoney',
  matched: 'matched',
  review: 'needs review',
  applied: 'categorised',
  unchanged: 'already right',
  dismissed: 'dismissed',
  expired: 'no charge found',
};

function tagOptions(tags: PageModel['tags'], selected: string | null, empty: string): string {
  return (
    `<option value="">${e(empty)}</option>` +
    tags.map((t) => `<option value="${e(t.id)}" ${t.id === selected ? 'selected' : ''}>${e(t.label)}</option>`).join('')
  );
}

function statusSection(m: PageModel): string {
  const l = m.last;
  const line = l
    ? `Last run ${fmtTime(l.at)} · ${l.ok ? `ok — new receipts ${l.newReceipts}, matched ${l.matched}, categorised ${l.applied}` : `<span class="bad">failed: ${e(l.error ?? '')}</span>`}`
    : 'Not run yet.';
  return `<p class="small">${line}</p>
    <form method="post" action="/run"><button ${m.running ? 'disabled' : ''}>${m.running ? 'Running…' : 'Run now'}</button></form>`;
}

function candidatesSection(m: PageModel): string {
  if (m.tags.length === 0) {
    return '<p class="muted">Categories load after the first run.</p>';
  }
  const hints = new Map(m.candidates.map((c) => [c.tagId, c.hint]));
  const row = (t: PageModel['tags'][number], i: number) => `<tr>
      <td><label class="row nowrap"><input type="checkbox" name="on_${i}" ${hints.has(t.id) ? 'checked' : ''}>
        <input type="hidden" name="tag_${i}" value="${e(t.id)}"><span>${e(t.label)}</span></label></td>
      <td><input name="hint_${i}" value="${e(hints.get(t.id) ?? '')}" placeholder="hint for the classifier, e.g. what kind of shop"></td>
    </tr>`;
  const chosen = m.tags.filter((t) => hints.has(t.id));
  const rest = m.tags.filter((t) => !hints.has(t.id));
  return `<p class="small muted">${
    m.hasClassifier
      ? 'The classifier picks one of the ticked categories for each order. The hint tells it what belongs there — write it for a stranger (names like emoji mean nothing to it).'
      : 'No classifier configured (TYPESAFE_TOKEN) — use fixed categories per store below; other orders wait in review.'
  }</p>
    <form method="post" action="/candidates" class="stack">
      <table>${chosen.map((t, i) => row(t, i)).join('')}</table>
      <details ${chosen.length === 0 ? 'open' : ''}><summary class="small">All categories (${rest.length} more)</summary>
        <table>${rest.map((t, i) => row(t, chosen.length + i)).join('')}</table></details>
      <button>Save categories</button>
    </form>`;
}

function reviewSection(m: PageModel): string {
  if (m.review.length === 0) {
    return '<p class="muted">Nothing waiting.</p>';
  }
  const rows = m.review
    .map((r, i) => {
      const how =
        r.tagSource === 'jev' && r.tagConfidence !== null
          ? `classifier ${Math.round(r.tagConfidence * 100)}%`
          : r.tagSource === 'store'
            ? 'store rule'
            : r.tagSource === 'user'
              ? 'you'
              : 'undecided';
      return `<tr>
        <td><input type="checkbox" name="pick" value="${i}" ${r.proposedTagId ? 'checked' : ''}>
          <input type="hidden" name="id_${i}" value="${e(r.messageId)}"></td>
        <td class="nowrap">${e(r.date)}<div class="small muted">${euros(r.totalCents)}</div></td>
        <td>${e(r.store)}<div class="small muted">${e(r.items.slice(0, 3).join('; '))}</div>
          ${r.note ? `<div class="small bad">${e(r.note)}</div>` : ''}</td>
        <td><div class="small muted">now: ${e(r.currentTags ?? '—')}</div>
          <select name="tag_${i}">${tagOptions(m.tags, r.proposedTagId, '— choose —')}</select>
          <div class="small muted">${e(how)}</div></td>
      </tr>`;
    })
    .join('');
  return `<p class="small muted">Nothing changes in ZenMoney until you apply. Adjust the category in a row before applying if it's wrong.</p>
    <form method="post" action="/review" class="stack">
      <table>${rows}</table>
      <div class="row"><button name="action" value="apply">Apply selected</button>
      <button name="action" value="dismiss" class="secondary">Dismiss selected</button></div>
    </form>`;
}

function storesSection(m: PageModel): string {
  if (m.stores.length === 0) {
    return '<p class="muted">No stores seen yet.</p>';
  }
  const rows = m.stores
    .map(
      (s, i) => `<tr><td>${e(s.name)}</td>
        <td><input type="hidden" name="key_${i}" value="${e(s.storeKey)}">
          <select name="tag_${i}">${tagOptions(m.tags, s.tagId, 'auto (classifier)')}</select></td></tr>`,
    )
    .join('');
  return `<p class="small muted">Pin a store to one category when it always means the same thing.</p>
    <form method="post" action="/stores" class="stack"><table>${rows}</table><button>Save stores</button></form>`;
}

function recentSection(m: PageModel): string {
  if (m.recent.length === 0) {
    return '<p class="muted">No receipts yet.</p>';
  }
  const label = new Map(m.tags.map((t) => [t.id, t.label]));
  const rows = m.recent
    .map(
      (r) => `<tr><td class="nowrap muted">${e(r.date)}</td><td>${e(r.store)}</td><td class="num">${euros(r.totalCents)}</td>
        <td><span class="status-${r.status}">${e(STATUS_LABEL[r.status])}</span>${
          r.appliedTag ? `<div class="small muted">${e(label.get(r.appliedTag) ?? r.appliedTag)}</div>` : ''
        }${r.note && r.status !== 'review' ? `<div class="small muted">${e(r.note)}</div>` : ''}</td></tr>`,
    )
    .join('');
  return `<table>${rows}</table>`;
}

export function renderPage(m: PageModel): string {
  const flash = m.flash ? `<div class="flash ${m.flash.kind}">${e(m.flash.text)}</div>` : '';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>zen-receipts</title>
<style>
  :root { --bg:#f6f7f9; --fg:#16181d; --card:#fff; --muted:#6b7280; --line:#e5e7eb; --bad:#c0262d; --good:#13804b; --accent:#2b59c3; }
  @media (prefers-color-scheme: dark) {
    :root { --bg:#14161a; --fg:#e6e6e6; --card:#1e2127; --muted:#8b93a1; --line:#2c313a; --bad:#ff6b6b; --good:#4cc38a; --accent:#7aa2ff; }
  }
  * { box-sizing: border-box; }
  body { margin:0; padding:16px; font:15px/1.45 system-ui,sans-serif; background:var(--bg); color:var(--fg); }
  main { max-width:820px; margin:0 auto; }
  h1 { font-size:1.2rem; margin:0 0 12px; }
  h2 { font-size:1rem; margin:24px 0 8px; color:var(--muted); font-weight:600; }
  .muted { color:var(--muted); } .bad { color:var(--bad); } .small { font-size:.85rem; } .nowrap { white-space:nowrap; }
  .flash { padding:10px 12px; border-radius:8px; margin-bottom:12px; background:var(--card); border:1px solid var(--line); }
  .flash.err { border-color:var(--bad); color:var(--bad); } .flash.ok { border-color:var(--good); }
  .row { display:flex; gap:8px; align-items:center; flex-wrap:wrap; }
  .stack { display:flex; flex-direction:column; gap:8px; }
  button { font:inherit; padding:8px 14px; border-radius:8px; border:1px solid var(--line); background:var(--accent); color:#fff; cursor:pointer; align-self:flex-start; }
  button.secondary { background:var(--card); color:var(--fg); }
  button[disabled] { opacity:.6; cursor:default; }
  select, input:not([type=checkbox]) { font:inherit; padding:6px 8px; border-radius:8px; border:1px solid var(--line); background:var(--card); color:var(--fg); width:100%; min-width:0; }
  table { width:100%; border-collapse:collapse; background:var(--card); border-radius:10px; overflow:hidden; }
  td { padding:8px 10px; border-bottom:1px solid var(--line); vertical-align:top; overflow-wrap:anywhere; }
  td.num { text-align:right; white-space:nowrap; font-variant-numeric:tabular-nums; }
  summary { cursor:pointer; padding:6px 0; }
  .status-applied, .status-unchanged { color:var(--good); } .status-expired { color:var(--bad); } .status-review { color:var(--accent); }
</style>
</head>
<body><main>
<h1>zen-receipts</h1>
${flash}
<h2>Status</h2>
${statusSection(m)}
<h2>Review</h2>
${reviewSection(m)}
<h2>Categories the classifier may pick</h2>
${candidatesSection(m)}
<h2>Stores</h2>
${storesSection(m)}
<h2>Recent receipts</h2>
${recentSection(m)}
</main></body>
</html>`;
}
