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
 * without it.
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
  password?: string;
}

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
  private readonly taps: string[] = [];
  private connections = 0;
  private closed = false;

  private constructor(options: OpenCodeServeReplayOptions) {
    this.password = options.password ?? 'replay-password';
    const seen = new Map<string, number>();
    for (const record of loadOpenCodeFixture(options.scenario)) {
      if (options.omit?.(record)) continue;
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

  async close(): Promise<void> {
    this.closed = true;
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
    const count = (this.counts.get(key) ?? 0) + 1;
    this.counts.set(key, count);
    for (const wake of this.waiters.splice(0)) wake();
    const list = this.answers.get(key) ?? this.fallbackAnswers.get(key);
    const record = list?.[Math.min(count, list.length) - 1];
    if (!record) {
      this.misses.push({ method, path });
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'replay: nothing recorded' }));
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
      if (record.kind === 'sse' && record.event)
        res.write(`data: ${JSON.stringify(record.event)}\n\n`);
      else if (record.kind === 'sse-comment')
        res.write(`: ${record.text ?? ''}\n\n`);
      else if (record.kind === 'sse-close') {
        res.end();
        return;
      }
      // Let the client read each frame before the next.
      await new Promise((resolve) => setImmediate(resolve));
    }
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
      };
    },
    async stopAll() {},
    exit: () => markExited(),
  };
  return leaser;
}
