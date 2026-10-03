import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { renderPage, type ReviewRow } from './html.ts';
import type { Candidate, Store } from '../storage/types.ts';
import { resolveTag, type Runner } from '../runner.ts';
import { tagLabels, type ZenMirror } from '../zenmoney/mirror.ts';
import type { ZmTransaction } from '../zenmoney/types.ts';
import type { Logger } from '../logger.ts';

const MAX_BODY_BYTES = 512 * 1024;

export interface ServerDeps {
  store: Store;
  runner: Pick<Runner, 'run' | 'approve' | 'dismiss' | 'isRunning' | 'lastResult'>;
  mirror: Pick<ZenMirror, 'tags'>;
  hasClassifier: boolean;
  log: Logger;
}

class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function readForm(req: IncomingMessage): Promise<URLSearchParams> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) {
      throw new HttpError(413, 'Request body too large');
    }
    chunks.push(chunk as Buffer);
  }
  return new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
}

function flashRedirect(res: ServerResponse, kind: 'ok' | 'err', text: string): void {
  res.writeHead(303, { location: `/?${kind}=${encodeURIComponent(text)}` });
  res.end();
}

export function createApp(deps: ServerDeps): Server {
  const { store, runner } = deps;

  function knownTags(): Set<string> {
    return new Set(deps.mirror.tags().map((t) => t.id));
  }

  function page(url: URL, res: ServerResponse): void {
    const tags = tagLabels(deps.mirror.tags());
    const label = new Map(tags.map((t) => [t.id, t.label]));
    const review: ReviewRow[] = store.receiptsByStatus('review').map((r) => {
      const tx = r.zmTxId ? store.getZmTx(r.zmTxId) : null;
      const current = tx ? (JSON.parse(tx.raw) as ZmTransaction).tag : null;
      return {
        ...r,
        currentTags: current?.length ? current.map((id) => label.get(id) ?? id).join(', ') : null,
        proposedTagId: resolveTag(r, store),
      };
    });
    const ok = url.searchParams.get('ok');
    const err = url.searchParams.get('err');
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(
      renderPage({
        flash: err ? { kind: 'err', text: err } : ok ? { kind: 'ok', text: ok } : null,
        running: runner.isRunning(),
        last: runner.lastResult(),
        hasClassifier: deps.hasClassifier,
        tags,
        candidates: store.candidates(),
        stores: store.listStores(),
        review,
        recent: store.recentReceipts(50),
      }),
    );
  }

  function kickRun(): void {
    runner.run().catch((err: unknown) => deps.log.error({ err }, 'run crashed'));
  }

  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const method = req.method ?? 'GET';
    const path = url.pathname;

    if (method === 'GET' && path === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
      return;
    }
    if (method === 'GET' && path === '/') {
      page(url, res);
      return;
    }
    if (method === 'GET' && path === '/api/receipts') {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ receipts: store.recentReceipts(500) }, null, 2));
      return;
    }
    if (method === 'POST' && path === '/run') {
      kickRun();
      flashRedirect(res, 'ok', 'Run started — refresh in a few seconds.');
      return;
    }
    if (method === 'POST' && path === '/candidates') {
      const form = await readForm(req);
      const known = knownTags();
      const list: Candidate[] = [];
      for (let i = 0; form.has(`tag_${i}`); i++) {
        const tagId = form.get(`tag_${i}`) ?? '';
        if (form.get(`on_${i}`) && known.has(tagId)) {
          list.push({ tagId, hint: (form.get(`hint_${i}`) ?? '').trim().slice(0, 500) });
        }
      }
      store.setCandidates(list);
      kickRun(); // receipts waiting for candidates can be classified now
      flashRedirect(res, 'ok', `Saved ${list.length} categories.`);
      return;
    }
    if (method === 'POST' && path === '/stores') {
      const form = await readForm(req);
      const known = knownTags();
      for (let i = 0; form.has(`key_${i}`); i++) {
        const key = form.get(`key_${i}`) ?? '';
        const tag = form.get(`tag_${i}`) || null;
        const before = store.getStore(key);
        if (before && (tag === null || known.has(tag)) && before.tagId !== tag) {
          store.setStoreTag(key, tag);
        }
      }
      kickRun();
      flashRedirect(res, 'ok', 'Stores saved.');
      return;
    }
    if (method === 'POST' && path === '/review') {
      const form = await readForm(req);
      const known = knownTags();
      const picks = form.getAll('pick').map((i) => {
        const tag = form.get(`tag_${i}`) || null;
        return { messageId: form.get(`id_${i}`) ?? '', tagId: tag && known.has(tag) ? tag : null };
      });
      if (picks.length === 0) {
        throw new HttpError(400, 'Nothing selected.');
      }
      if (form.get('action') === 'dismiss') {
        runner.dismiss(picks.map((p) => p.messageId));
        flashRedirect(res, 'ok', `Dismissed ${picks.length}.`);
      } else {
        const changed = await runner.approve(picks);
        flashRedirect(res, 'ok', `Applied — ${changed} transaction(s) changed in ZenMoney.`);
      }
      return;
    }
    throw new HttpError(404, 'Not found');
  }

  return createServer((req, res) => {
    route(req, res).catch((err: unknown) => {
      const status = err instanceof HttpError ? err.status : 500;
      if (status >= 500) {
        deps.log.error({ err, url: req.url }, 'request failed');
      }
      if (res.headersSent) {
        res.end();
        return;
      }
      const message = err instanceof Error ? err.message : String(err);
      if (req.method === 'POST' && status !== 404) {
        flashRedirect(res, 'err', message);
        return;
      }
      res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' });
      res.end(message);
    });
  });
}
