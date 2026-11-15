/**
 * A stand-in `opencode serve` that replays a captured 2.3.0 scenario
 * (`fixtures/opencode-serve-2.3.0-<scenario>.jsonl`, written by
 * `fixtures/capture-opencode-serve-fixtures.mjs`) to the native transport,
 * so tests drive the engine's own wire rather than a hand-written guess.
 *
 * - HTTP: a request is matched on its method and path template (each
 *   `ses_`/`msg_`/`per_`/`frm_`/`psv_`/`call_` segment is a placeholder,
 *   the query is ignored) and answered with the next recorded exchange of
 *   that template, the last one repeating. A template the scenario never
 *   recorded is answered from the fallback scenarios (by default the
 *   catalog and MCP captures), else 404 and listed in `misses`.
 *   `/openapi.json` is the captured document. Basic auth is required.
 * - SSE: each `GET /api/event` connection is the next recorded tap (`A`,
 *   then `B` after a recorded drop). Its frames are written in recorded
 *   order, but a frame recorded after a mutating request (POST, PUT, PATCH,
 *   DELETE) waits until the client has made that request as often as the
 *   capture had by then, so the engine never answers what was not asked.
 *   `sse-close` ends the connection.
 *
 * `omit` removes records (their answers and frames) from the scenario;
 * `ungated` keeps a request's answer but lets the frames after it flow
 * without it; `rewrite` changes a record as it is loaded; `holdUntil` holds
 * a request's answer until a given frame has been written to the feed (the
 * engine reporting something before the request that caused it returns);
 * History reads (`GET /api/session/{id}/message`) are answered from the
 * recorded history (each recorded read was `order=asc` with no limit, so it
 * is the whole history then; `historyRewrite` can lengthen it), paged as 2.3.0's handler pages it ({@link pageOpenCodeHistory}): a
 * read without a cursor takes the next recording, a cursor read pages the
 * same one.
 * `respond` answers a request itself (a failure, or an answer computed the
 * way the real handler computes it), ahead of anything recorded.
 * `holdFrame` holds a feed record (a frame, or a connection's end) until
 * the condition it returns holds, checked as the replay sees requests and
 * every few milliseconds.
 */
import { readFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import {
  OPENCODE_SERVE_USER,
  OpenCodeServeClient,
} from '../adapters/opencode-serve-client.js';
import type {
  OpenCodeServeAcquireInput,
  OpenCodeServeLease,
} from '../adapters/opencode-serve-pool.js';

export interface OpenCodeReplayRecord {
  t: number;
  kind: string;
  tap?: string;
  method?: string;
  path?: string;
  body?: unknown;
  status?: number;
  response?: unknown;
  event?: { type: string; data?: Record<string, unknown> } & Record<
    string,
    unknown
  >;
  text?: string;
}

const FIXTURES = fileURLToPath(new URL('./fixtures/', import.meta.url));
const PREFIX = 'opencode-serve-2.3.0-';

/**
 * The message ids the capture's prompts got, in order: Station chooses its
 * prompts' ids, so a replay gives it the recorded ones.
 */
export function recordedPromptIds(
  scenario: string,
  omit?: (record: OpenCodeReplayRecord) => boolean,
): string[] {
  return loadOpenCodeFixture(scenario).flatMap((record) => {
    if (
      omit?.(record) ||
      record.kind !== 'http' ||
      record.method !== 'POST' ||
      !record.path?.endsWith('/prompt')
    )
      return [];
    const id = (record.response as { data?: { id?: unknown } } | undefined)
      ?.data?.id;
    return typeof id === 'string' ? [id] : [];
  });
}

export function loadOpenCodeFixture(scenario: string): OpenCodeReplayRecord[] {
  return readFileSync(`${FIXTURES}${PREFIX}${scenario}.jsonl`, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as OpenCodeReplayRecord);
}

const OPENAPI = (): unknown =>
  JSON.parse(readFileSync(`${FIXTURES}${PREFIX}openapi.json`, 'utf8'));

const ID_SEGMENT = /^(?:ses|msg|per|frm|psv|call|prt)_/;

/** A request path as the replay matches it. */
export function openCodePathTemplate(path: string): string {
  const pathname = path.split('?', 1)[0] ?? '';
  return pathname
    .split('/')
    .map((segment) => (ID_SEGMENT.test(segment) ? ':id' : segment))
    .join('/');
}

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

function keyOf(method: string, path: string): string {
  return `${method} ${openCodePathTemplate(path)}`;
}

export interface OpenCodeServeReplayOptions {
  scenario: string;
  /** Scenarios that answer a template this one never recorded. */
  fallbacks?: string[];
  omit?: (record: OpenCodeReplayRecord) => boolean;
  ungated?: (record: OpenCodeReplayRecord) => boolean;
  rewrite?: (record: OpenCodeReplayRecord) => OpenCodeReplayRecord;
  holdUntil?: (
    request: OpenCodeReplayRequest,
  ) => ((record: OpenCodeReplayRecord) => boolean) | undefined;
  /** Changes each recorded history (oldest first) before it is paged. */
  historyRewrite?: (recorded: unknown[]) => unknown[];
  /** Holds a feed record until the condition returned holds; undefined: not held. */
  holdFrame?: (record: OpenCodeReplayRecord) => (() => boolean) | undefined;
  /** Answers a request instead of the recording; undefined: not this one. */
  respond?: (
    request: OpenCodeReplayRequest,
  ) => { status: number; body?: unknown } | undefined;
  password?: string;
}

type OpenCodePushedEvent = {
  type: string;
  data?: Record<string, unknown>;
} & Record<string, unknown>;

export interface OpenCodeReplayRequest {
  method: string;
  path: string;
  body: unknown;
}

export class OpenCodeServeReplay {
  readonly requests: OpenCodeReplayRequest[] = [];
  readonly misses: Array<{ method: string; path: string }> = [];
  readonly password: string;
  url = '';
  private readonly server: http.Server;
  private readonly timeline: Array<
    OpenCodeReplayRecord & { gate?: { key: string; count: number } }
  > = [];
  private readonly answers = new Map<string, OpenCodeReplayRecord[]>();
  private readonly fallbackAnswers = new Map<string, OpenCodeReplayRecord[]>();
  private readonly counts = new Map<string, number>();
  private readonly waiters: Array<() => void> = [];
  /** The poll timers of held frames' waits, cleared on close. */
  private readonly polls = new Set<ReturnType<typeof setTimeout>>();
  private readonly taps: string[] = [];
  private readonly written: OpenCodeReplayRecord[] = [];
  /** Feeds whose recorded tap has ended without closing: {@link push} writes to them. */
  private readonly live = new Set<http.ServerResponse>();
  private readonly pushed: OpenCodePushedEvent[] = [];
  private connections = 0;
  private closed = false;
  private readonly holdUntil: OpenCodeServeReplayOptions['holdUntil'];
  private readonly respond: OpenCodeServeReplayOptions['respond'];
  private readonly holdFrame: OpenCodeServeReplayOptions['holdFrame'];
  private readonly historyRewrite: (recorded: unknown[]) => unknown[];
  private history: readonly unknown[] = [];

  private constructor(options: OpenCodeServeReplayOptions) {
    this.password = options.password ?? 'replay-password';
    this.holdUntil = options.holdUntil;
    this.respond = options.respond;
    this.holdFrame = options.holdFrame;
    this.historyRewrite = options.historyRewrite ?? ((recorded) => recorded);
    const seen = new Map<string, number>();
    for (const loaded of loadOpenCodeFixture(options.scenario)) {
      if (options.omit?.(loaded)) continue;
      const record = options.rewrite ? options.rewrite(loaded) : loaded;
      if (record.kind === 'sse-open' && record.tap) this.taps.push(record.tap);
      if (record.kind === 'http' && record.method && record.path) {
        const key = keyOf(record.method, record.path);
        const list = this.answers.get(key) ?? [];
        list.push(record);
        this.answers.set(key, list);
        const count = (seen.get(key) ?? 0) + 1;
        seen.set(key, count);
        this.timeline.push(
          MUTATING.has(record.method) && !options.ungated?.(record)
            ? { ...record, gate: { key, count } }
            : record,
        );
        continue;
      }
      this.timeline.push(record);
    }
    for (const scenario of options.fallbacks ?? ['catalog', 'mcp']) {
      for (const record of loadOpenCodeFixture(scenario)) {
        if (record.kind !== 'http' || !record.method || !record.path) continue;
        const key = keyOf(record.method, record.path);
        if (this.answers.has(key)) continue;
        const list = this.fallbackAnswers.get(key) ?? [];
        list.push(record);
        this.fallbackAnswers.set(key, list);
      }
    }
    this.server = http.createServer((req, res) => {
      void this.serve(req, res);
    });
  }

  static async start(
    options: OpenCodeServeReplayOptions,
  ): Promise<OpenCodeServeReplay> {
    const replay = new OpenCodeServeReplay(options);
    await new Promise<void>((resolve) =>
      replay.server.listen(0, '127.0.0.1', resolve),
    );
    const { port } = replay.server.address() as AddressInfo;
    replay.url = `http://127.0.0.1:${port}`;
    return replay;
  }

  /** A client of this server, as the pool would hand one out. */
  client(): OpenCodeServeClient {
    return new OpenCodeServeClient({
      baseUrl: this.url,
      password: this.password,
    });
  }

  /** Requests the client made, by method and template. */
  made(method: string, template: string): OpenCodeReplayRequest[] {
    return this.requests.filter(
      (request) =>
        request.method === method &&
        openCodePathTemplate(request.path) === template,
    );
  }

  /**
   * Scripted mode: write `event` to every feed whose recorded tap has ended
   * (it stays open unless the tap recorded `sse-close`). Pushed before such
   * a feed exists, it waits for one.
   */
  push(event: OpenCodePushedEvent): void {
    if (this.closed) return;
    if (this.live.size === 0) {
      this.pushed.push(event);
      return;
    }
    for (const res of this.live)
      res.write(`data: ${JSON.stringify(event)}\n\n`);
  }

  async close(): Promise<void> {
    this.closed = true;
    this.live.clear();
    for (const poll of this.polls) clearTimeout(poll);
    this.polls.clear();
    for (const wake of this.waiters.splice(0)) wake();
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  private async serve(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    const expected = `Basic ${Buffer.from(
      `${OPENCODE_SERVE_USER}:${this.password}`,
    ).toString('base64')}`;
    if (req.headers.authorization !== expected) {
      res.writeHead(401).end();
      return;
    }
    const method = req.method ?? 'GET';
    const path = req.url ?? '/';
    if (method === 'GET' && path === '/api/event') {
      await this.stream(res);
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const text = Buffer.concat(chunks).toString('utf8');
    let body: unknown;
    try {
      body = text ? JSON.parse(text) : undefined;
    } catch {
      body = text;
    }
    this.requests.push({ method, path, body });
    if (method === 'GET' && path === '/openapi.json') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(OPENAPI()));
      return;
    }
    const key = keyOf(method, path);
    const query = new URL(path, 'http://replay').searchParams;
    const historyRead = method === 'GET' && key.endsWith('/message');
    const pagesOn = historyRead && query.has('cursor');
    // A cursor pages the history the read it continues was answered from.
    const count = (this.counts.get(key) ?? 0) + (pagesOn ? 0 : 1);
    this.counts.set(key, count);
    for (const wake of this.waiters.splice(0)) wake();
    // Counted first, so the frames it gates can flow while its answer waits.
    const hold = this.holdUntil?.({ method, path, body });
    // Re-checked on each new request or frame, and every 10ms, so a hold
    // can also wait on a condition the test sets.
    if (hold)
      while (!this.closed && !this.written.some(hold)) await this.poll();
    const own = this.respond?.({ method, path, body });
    if (own) {
      if (own.body === undefined) res.writeHead(own.status).end();
      else {
        res.writeHead(own.status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(own.body));
      }
      return;
    }
    const list = this.answers.get(key) ?? this.fallbackAnswers.get(key);
    const record = list?.[Math.min(count, list.length) - 1];
    if (!record) {
      this.misses.push({ method, path });
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'replay: nothing recorded' }));
      return;
    }
    if (historyRead && (record.status ?? 200) === 200) {
      if (!pagesOn)
        this.history = this.historyRewrite([
          ...((record.response as { data?: unknown[] } | undefined)?.data ??
            []),
        ]);
      const page = pageOpenCodeHistory(this.history, query);
      res.writeHead(page.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(page.body));
      return;
    }
    const status = record.status ?? 200;
    if (record.response === null || record.response === undefined) {
      res.writeHead(status).end();
      return;
    }
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(record.response));
  }

  /**
   * Wait for the next request or frame, or 10ms: whichever comes first
   * takes the other back out, so a held frame's polling leaves nothing
   * behind (and close clears a poll still pending).
   */
  private poll(): Promise<void> {
    return new Promise<void>((resolve) => {
      const wake = () => {
        clearTimeout(timer);
        this.polls.delete(timer);
        const index = this.waiters.indexOf(wake);
        if (index >= 0) this.waiters.splice(index, 1);
        resolve();
      };
      const timer = setTimeout(wake, 10);
      this.polls.add(timer);
      this.waiters.push(wake);
    });
  }

  private async gate(key: string, count: number): Promise<void> {
    while (!this.closed && (this.counts.get(key) ?? 0) < count) {
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
  }

  private async stream(res: http.ServerResponse): Promise<void> {
    const tap = this.taps[this.connections];
    this.connections += 1;
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
    });
    if (!tap) return;
    for (const record of this.timeline) {
      if (this.closed || res.destroyed) return;
      if (record.gate) await this.gate(record.gate.key, record.gate.count);
      if (record.tap !== tap) continue;
      const held = this.holdFrame?.(record);
      if (held)
        while (!this.closed && !res.destroyed && !held()) await this.poll();
      if (this.closed || res.destroyed) return;
      if (record.kind === 'sse' && record.event) {
        res.write(`data: ${JSON.stringify(record.event)}\n\n`);
        this.written.push(record);
        for (const wake of this.waiters.splice(0)) wake();
      } else if (record.kind === 'sse-comment')
        res.write(`: ${record.text ?? ''}\n\n`);
      else if (record.kind === 'sse-close') {
        res.end();
        return;
      }
      // Let the client read each frame before the next.
      await new Promise((resolve) => setImmediate(resolve));
    }
    if (this.closed || res.destroyed) return;
    this.live.add(res);
    res.on('close', () => this.live.delete(res));
    for (const event of this.pushed.splice(0)) this.push(event);
  }
}

/** A pool stand-in that leases the replay server. */
export function replayLeaser(
  replay: OpenCodeServeReplay,
  cwd = '/replay/proj',
): {
  acquire(input: OpenCodeServeAcquireInput): Promise<OpenCodeServeLease>;
  stopAll(): Promise<void>;
  acquired: OpenCodeServeAcquireInput[];
  released: number;
  discarded: number;
  /** Each lease's `rekey` digest, in order. */
  rekeyed: string[];
  exit(): void;
} {
  let markExited!: () => void;
  const exited = new Promise<void>((resolve) => {
    markExited = resolve;
  });
  const leaser = {
    acquired: [] as OpenCodeServeAcquireInput[],
    released: 0,
    discarded: 0,
    rekeyed: [] as string[],
    async acquire(input: OpenCodeServeAcquireInput) {
      leaser.acquired.push(input);
      return {
        url: replay.url,
        client: replay.client(),
        cwd,
        exited,
        release: () => {
          leaser.released += 1;
        },
        discard: () => {
          leaser.discarded += 1;
        },
        rekey: (mcpDigest: string) => {
          leaser.rekeyed.push(mcpDigest);
          return true;
        },
      };
    },
    async stopAll() {},
    exit: () => markExited(),
  };
  return leaser;
}

function encodeHistoryCursor(
  id: string,
  order: 'asc' | 'desc',
  direction: 'previous' | 'next',
): string {
  return Buffer.from(JSON.stringify({ id, order, direction })).toString(
    'base64url',
  );
}

/**
 * One page of `history` (oldest first, in the store's `seq` order) as
 * OpenCode 2.3.0 answers `GET /api/session/{id}/message`
 * (`server/src/handlers/message.ts`, `core/src/session/store.ts`
 * `messageRows`): `order` (default `desc`) and `limit` (default 50), or an
 * opaque `cursor` that carries its own order and must not be combined with
 * one; the page's `cursor.previous`/`cursor.next` name its first and last
 * message.
 */
export function pageOpenCodeHistory(
  history: readonly unknown[],
  query: URLSearchParams,
): { status: number; body: unknown } {
  const rawCursor = query.get('cursor');
  if (rawCursor && query.has('order'))
    return {
      status: 400,
      body: {
        _tag: 'InvalidCursorError',
        message: 'Cursor cannot be combined with order',
      },
    };
  let decoded:
    | { id: string; order: 'asc' | 'desc'; direction: 'previous' | 'next' }
    | undefined;
  if (rawCursor) {
    try {
      decoded = JSON.parse(
        Buffer.from(rawCursor, 'base64url').toString('utf8'),
      );
    } catch {
      return {
        status: 400,
        body: { _tag: 'InvalidCursorError', message: 'Invalid cursor' },
      };
    }
  }
  const order =
    decoded?.order ?? (query.get('order') === 'asc' ? 'asc' : 'desc');
  const limit = Number(query.get('limit') ?? 50);
  const direction = decoded?.direction ?? 'next';
  const effective =
    direction === 'previous' ? (order === 'asc' ? 'desc' : 'asc') : order;
  const idOf = (message: unknown) =>
    (message as { id?: unknown } | null)?.id as string | undefined;
  const indexed = history.map((message, index) => ({ message, index }));
  let rows = indexed;
  if (decoded) {
    const anchor = indexed.find((row) => idOf(row.message) === decoded?.id);
    if (!anchor) rows = [];
    else
      rows = indexed.filter((row) =>
        effective === 'asc'
          ? row.index > anchor.index
          : row.index < anchor.index,
      );
  }
  if (effective === 'desc') rows = [...rows].reverse();
  rows = rows.slice(0, limit);
  if (direction === 'previous') rows = rows.reverse();
  const data = rows.map((row) => row.message);
  const first = data[0];
  const last = data.at(-1);
  return {
    status: 200,
    body: {
      data,
      // An empty page names neither end (`null`, as 2.3.0 encodes it).
      cursor: {
        previous: first
          ? encodeHistoryCursor(idOf(first) as string, order, 'previous')
          : null,
        next: last
          ? encodeHistoryCursor(idOf(last) as string, order, 'next')
          : null,
      },
    },
  };
}
