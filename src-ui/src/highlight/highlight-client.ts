/**
 * archive#3354 — async client for chat syntax highlighting.
 *
* This module is loaded ONLY via dynamic `import` from
 * `components/chat/HighlightedCodeBlock.tsx`, so the worker bootstrap and
 * everything Shiki-related stay out of the entry bundle (same posture as
 * DiffPanel's `?worker` import, which lives in its own lazy chunk).
 *
 * What this module guarantees:
*  - The pool holds AT MOST ONE request per worker. A request waits in a
*    client-side queue until a worker is idle, and its wedge timer is armed
*    at dispatch, so the deadline measures that worker's service time rather
*    than time spent queued behind other blocks. (Arming at `postMessage`
*    with round-robin dispatch gave every block mounted in the same commit
*    one shared deadline that the worker's cold Shiki init had to fit into.)
*  - Recycling a worker rejects the request bound to it before replacing it.
*    One-in-flight makes that exactly one request, so no request is ever
*    left waiting on a terminated worker, and no timeout can fire against a
*    worker its request never owned. A hung worker can therefore neither
*    wedge the caller nor poison the pool.
*  - Every request settles. It is dispatched to an idle worker, then either
*    answered or rejected within WEDGE_TIMEOUT_MS of that dispatch; a queued
*    request is never dropped, because each recycle re-pumps the queue.
*  - A worker that dies asynchronously (script/CSP load failure, uncaught
*    error, undeserializable message) fires `error`/`messageerror` instead
*    of answering. `withWorkerErrorFallback` then switches permanently to
*    `highlightOnMainThread`, rather than every later block burning a full
*    timeout and rendering plain forever behind a memoised client.
 *
 * Costs of one worker with no queue deadline, accepted rather than hidden: a
 * request's clock starts at dispatch, so a worker that wedges on its cold
 * Shiki init stalls every queued block for the full WEDGE_TIMEOUT_MS before
 * the queue moves at all, and the recycle then spawns a replacement that
 * redoes that cold init from scratch. Nothing counts consecutive wedges, so a
 * repeatedly wedging worker is never escalated to the fallback. In practice
 * it self-heals — the replacement fetches the same chunks from a warm HTTP
 * cache, so its init is the fast one.
 *
 * What it does NOT guarantee: that only closed blocks arrive. The streaming
 * layer splits an unclosed trailing fence out of the markdown before it is
 * rendered (components/chat/open-fence.ts) so a growing block is not
 * tokenized flush by flush, but that scanner has documented blind spots
 * (fences inside blockquotes, or indented 4+ spaces). Correctness survives —
 * the key is content-addressed, so a partial result is never served for
 * different code — but the cost is not one wasted entry: `cache` below is
 * module-global and holds 300 entries for the whole page, so a blind-spot
 * block re-tokenized on every ~80ms flush of a long stream writes hundreds of
 * distinct keys and evicts the cached HTML of settled messages elsewhere in
 * the transcript. A page-wide cache flush, not a wasted entry.
 */

import { initShiki } from '../contexts/SyntaxHighlighterContext';
import { escapeHtml, HighlightCache, highlightCacheKey, THEME } from './shared';

/**
 * archive#3354 — main-thread fallback used when `Worker` is unavailable
 * (jsdom/SSR) or worker bootstrap fails. Awaits the shared Shiki singleton,
 * then tokenizes with the same language resolution and escaped-HTML fallback
 * the context's own highlighter uses. Lives HERE (the async chunk), not in
 * the entry-reachable context — that 200-odd bytes is entry budget.
 */
async function highlightOnMainThread(
  code: string,
  lang: string,
): Promise<string> {
  const highlighter = await initShiki();
  const resolvedLang = highlighter.getLoadedLanguages().includes(lang)
    ? lang
    : 'text';
  try {
    return highlighter.codeToHtml(code, { lang: resolvedLang, theme: THEME });
  } catch {
    return `<pre style="background:#0d1117;color:#e6edf3;padding:12px;border-radius:6px;overflow-x:auto"><code>${escapeHtml(code)}</code></pre>`;
  }
}

/** Worker-shaped interface so tests can inject fakes. */
export interface HighlightWorkerLike {
  postMessage(message: unknown): void;
  terminate(): void;
  set onmessage(handler:
    | ((e: MessageEvent<unknown>) => void)
    | null
    | undefined,);
/** Fired when the worker script fails to load or throws uncaught. */
  set onerror(handler: ((e: ErrorEvent) => void) | null | undefined);
/** Fired when a posted message cannot be deserialized. */
  set onmessageerror(handler:
    | ((e: MessageEvent<unknown>) => void)
    | null
    | undefined,);
}

type HighlightResponse = { id: number; html?: string; error?: string };

const WEDGE_TIMEOUT_MS = 8000;

/**
 * One worker. Chat shows a handful of code blocks and each tokenizes in
 * single-digit milliseconds once the highlighter is warm — the win here is
 * getting Shiki off the main thread, not parallelism. A second worker means
 * a second full 18-grammar `createHighlighter` (time and resident memory)
 * on top of the still-eager main-thread provider, to shave a few ms. Size is
 * a constructor parameter, so raising it needs evidence, not an edit here.
 */
const POOL_SIZE = 1;

type QueuedRequest = {
  code: string;
  lang: string;
  resolve: (html: string) => void;
  reject: (err: Error) => void;
};

type InFlightRequest = QueuedRequest & {
  id: number;
  timer: ReturnType<typeof setTimeout>;
};

export interface HighlightWorkerPoolOptions {
/**
* Called when a worker dies asynchronously — `error` (script/CSP load
* failure, uncaught throw) or `messageerror` — rather than answering. The
* pool still recycles the slot; the client uses this to stop routing work
* to workers at all, because a worker that cannot load will not load on
* the replacement either.
*/
  onWorkerError?: (err: Error) => void;
}

/**
 * Worker pool with wedge detection. Requests queue client-side and each
 * worker holds at most one at a time, so a request's timeout measures that
 * worker's service time; a request that outlives it terminates the owning
 * worker, rejects (the caller renders a plain <pre>), and the replacement
 * picks up the queue.
 */
export class HighlightWorkerPool {
  private workers: HighlightWorkerLike[];
  private inFlight: (InFlightRequest | null)[];
  private queue: QueuedRequest[] = [];
  private nextId = 1;
  private pumping = false;
  private disposed = false;

  constructor(
    private readonly factory: () => HighlightWorkerLike,
    private readonly timeoutMs = WEDGE_TIMEOUT_MS,
    size = POOL_SIZE,
    private readonly options: HighlightWorkerPoolOptions = {},
  ) {
    this.inFlight = Array.from({ length: size }, () => null);
    this.workers = Array.from({ length: size }, (_, index) =>
      this.spawn(index),
    );
  }

  private spawn(index: number): HighlightWorkerLike {
    const worker = this.factory();
    worker.onmessage = (e) => {
// A recycled worker's handler is detached, but guard on identity too:
// the slot it used to own now belongs to a different worker.
      if (this.workers[index] !== worker) return;
      this.settle(index, e.data as HighlightResponse);
    };
    const died = (reason: string) => {
      if (this.workers[index] !== worker) return;
      const err = new Error(`highlight worker failed to start (${reason})`);
      this.options.onWorkerError?.(err);
      this.recycle(index, err);
    };
    worker.onerror = () => died('error');
    worker.onmessageerror = () => died('messageerror');
    return worker;
  }

  private settle(index: number, response: HighlightResponse): void {
    const entry = this.inFlight[index];
// Stale or duplicate answer for a request that already settled.
    if (!entry || entry.id !== response.id) return;
    clearTimeout(entry.timer);
    this.inFlight[index] = null;
    if (typeof response.html === 'string') entry.resolve(response.html);
    else entry.reject(new Error(response.error ?? 'highlight worker failed'));
    this.pump();
  }

/**
* Terminate a worker, reject the request bound to it, and replace it.
*
* Rejecting first is the whole point: a terminated worker can never answer,
* so anything still bound to the slot would otherwise wait out its own
* timeout and recycle the slot AGAIN — destroying the freshly-spawned
* replacement and orphaning whatever it had just been handed.
*/
  private recycle(index: number, reason: Error): void {
    const worker = this.workers[index];
    worker.onmessage = null;
    worker.onerror = null;
    worker.onmessageerror = null;
    try {
      worker.terminate();
    } catch {
// A worker that cannot even be terminated is dropped either way.
    }
    const entry = this.inFlight[index];
    this.inFlight[index] = null;
    if (entry) {
      clearTimeout(entry.timer);
      entry.reject(reason);
    }
    if (this.disposed) return;
    this.workers[index] = this.spawn(index);
    this.pump();
  }

  highlight(code: string, lang: string): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      if (this.disposed) {
        reject(new Error('highlight pool disposed'));
        return;
      }
      this.queue.push({ code, lang, resolve, reject });
      this.pump();
    });
  }

/** Hand queued requests to idle workers. Re-entrancy-safe. */
  private pump(): void {
    if (this.pumping || this.disposed) return;
    this.pumping = true;
    try {
      while (this.queue.length > 0) {
        const index = this.inFlight.indexOf(null);
        if (index === -1) return;
        const next = this.queue.shift();
        if (!next) return;
        this.dispatch(index, next);
      }
    } finally {
      this.pumping = false;
    }
  }

  private dispatch(index: number, request: QueuedRequest): void {
    const id = this.nextId++;
    const timer = setTimeout(() => {
      this.recycle(
        index,
        new Error(`highlight worker wedged (>${this.timeoutMs}ms)`),
      );
    }, this.timeoutMs);
    this.inFlight[index] = { ...request, id, timer };
    try {
      this.workers[index].postMessage({
        id,
        code: request.code,
        lang: request.lang,
      });
    } catch (err) {
// A worker that rejects the post is as dead as one that never answers.
      this.recycle(index, err instanceof Error ? err : new Error(String(err)));
    }
  }

  dispose(): void {
    this.disposed = true;
    for (const entry of this.inFlight) {
      if (!entry) continue;
      clearTimeout(entry.timer);
      entry.reject(new Error('highlight pool disposed'));
    }
    this.inFlight = this.inFlight.map(() => null);
    for (const queued of this.queue.splice(0, this.queue.length)) {
      queued.reject(new Error('highlight pool disposed'));
    }
    for (const w of this.workers) {
      w.onmessage = null;
      w.onerror = null;
      w.onmessageerror = null;
      try {
        w.terminate();
      } catch {
// ignore
      }
    }
  }
}

const cache = new HighlightCache(300);

type HighlightFn = (code: string, lang: string) => Promise<string>;

/**
 * Wrap a worker pool with a permanent main-thread fallback.
 *
 * `createClient`'s try/catch only ever covered a SYNCHRONOUS construction
 * throw. A worker that constructs and *then* fails — a CSP `worker-src`
 * refusal, a chunk fetch that fails offline, a blob-URL policy — emits an
 * `error` event and answers nothing, so without this every block waited a
 * full timeout, rendered plain, and (because the client promise is memoised)
 * never re-evaluated. One such event switches this client to the main-thread
 * highlighter for the rest of the page: slower, but it actually highlights.
 */
export function withWorkerErrorFallback(
  makeWorker: () => HighlightWorkerLike,
  fallback: HighlightFn,
  timeoutMs = WEDGE_TIMEOUT_MS,
  size = POOL_SIZE,
): HighlightFn {
  let degraded = false;
  const pool = new HighlightWorkerPool(makeWorker, timeoutMs, size, {
    onWorkerError: () => {
      if (degraded) return;
      degraded = true;
// Rejects everything in flight and queued; the catch below routes each
// of those callers to the fallback instead of surfacing the failure.
      pool.dispose();
    },
  });
  return (code, lang) => {
    if (degraded) return fallback(code, lang);
    return pool.highlight(code, lang).catch((err: unknown) => {
      if (degraded) return fallback(code, lang);
      throw err;
    });
  };
}

let clientPromise: Promise<HighlightFn> | null = null;

async function createClient(): Promise<HighlightFn> {
  if (typeof Worker === 'undefined') {
// jsdom / SSR: no workers; tokenize on the main thread (test-only path).
    return (code, lang) => highlightOnMainThread(code, lang);
  }
  try {
    const { default: HighlightWorker } = await import(
      './highlight-worker?worker'
    );
    return withWorkerErrorFallback(
      () => new HighlightWorker(),
      highlightOnMainThread,
    );
  } catch {
// Worker bootstrap failed synchronously (e.g. hostile embedding context)
// degrade to the main-thread highlighter rather than shipping
// unhighlighted code.
    return (code, lang) => highlightOnMainThread(code, lang);
  }
}

/**
 * Highlight `code` as `lang`. Resolves with Shiki HTML, or rejects on worker
 * wedge/failure — callers render a plain <pre> on rejection or while pending.
 * Results (including the main-thread fallback's escaped-HTML fallback) are
 * LRU-cached under a content-addressed key, so a rejection caches nothing and
 * a later attempt at the same code retries.
 */
export function highlightCode(code: string, lang: string): Promise<string> {
  const key = highlightCacheKey(code, lang);
  const cached = cache.get(key);
  if (cached !== undefined) return Promise.resolve(cached);
  if (!clientPromise) clientPromise = createClient();
  return clientPromise
    .then((fn) => fn(code, lang))
    .then((html) => {
      cache.set(key, html);
      return html;
    });
}

/** Test-only visibility into the highlight cache (see highlight-code.test.ts). */
export function highlightCacheSize(): number {
  return cache.size;
}
