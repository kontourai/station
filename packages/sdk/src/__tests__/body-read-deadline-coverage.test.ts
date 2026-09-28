/**
 * #2377 C2b review: a request deadline that fires while the response body is
 * being read reaches the caller as `StationRequestTimeoutError`, through every
 * SDK helper that unwraps a body.
 *
 * Two halves:
 * - Structural (a structural rule, proved structurally): every catch in the
 *   SDK source around a body read that does not also cover the request
 *   starts with `rethrowDeadline(...)`, and every `body().catch(...)` goes
 *   through `unlessDeadline(...)`. A new helper written the old way fails
 *   here by name.
 * - Behavioural: one exported fetcher per unwrap family, against a server
 *   that sends its headers and then stalls the body, including the non-2xx
 *   branches that used to report "not JSON".
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { StationRequestTimeoutError } from '../client/http';

const SRC = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const READ = /\.(json|text|arrayBuffer|blob|formData|bytes)\(\)/;
const ISSUES =
  /\b(getJson|mutateJson|request|fetch|authenticatedFetch|postJson)\(/;

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory())
      return name === '__tests__' ? [] : sources(path);
    return /\.tsx?$/.test(name) && !name.endsWith('.d.ts') ? [path] : [];
  });
}

/** The text between a `{` at `open` and its matching `}`. */
function block(source: string, open: number): { body: string; end: number } {
  let depth = 1;
  let index = open + 1;
  while (depth > 0 && index < source.length) {
    const char = source[index];
    if (char === '{') depth += 1;
    else if (char === '}') depth -= 1;
    index += 1;
  }
  return { body: source.slice(open + 1, index - 1), end: index };
}

interface Site {
  where: string;
  guarded: boolean;
}

function bodyReadCatches(): Site[] {
  const sites: Site[] = [];
  for (const file of sources(SRC)) {
    const source = readFileSync(file, 'utf8');
    for (const match of source.matchAll(/try \{/g)) {
      const tryBlock = block(source, match.index! + match[0].length - 1);
      const handler = /^\s*catch\s*(\((\w+)\))?\s*\{/.exec(
        source.slice(tryBlock.end, tryBlock.end + 80),
      );
      if (!handler) continue;
      if (!READ.test(tryBlock.body) || ISSUES.test(tryBlock.body)) continue;
      const catchOpen = tryBlock.end + handler[0].length - 1;
      const catchBody = block(source, catchOpen).body;
      const first = catchBody.trim().split('\n')[0] ?? '';
      const line = source.slice(0, match.index).split('\n').length;
      sites.push({
        where: `${relative(SRC, file)}:${line}`,
        guarded:
          handler[2] !== undefined &&
          first.startsWith(`rethrowDeadline(${handler[2]});`),
      });
    }
    for (const match of source.matchAll(
      /\.(?:json|text|arrayBuffer|blob|formData|bytes)\(\)\s*\.catch\(/g,
    )) {
      const line = source.slice(0, match.index).split('\n').length;
      const after = source.slice(match.index! + match[0].length).trimStart();
      sites.push({
        where: `${relative(SRC, file)}:${line} (.catch)`,
        guarded: after.startsWith('unlessDeadline('),
      });
    }
  }
  return sites;
}

describe('every SDK body-read catch passes a deadline on', () => {
  it('holds every catch around a body read to the shared guard', () => {
    const sites = bodyReadCatches();
    // Anchor: the scan really finds the unwrap helpers (a broken scan that
    // finds nothing must not pass).
    expect(sites.length).toBeGreaterThanOrEqual(40);
    expect(
      sites.filter((site) => !site.guarded).map((site) => site.where),
    ).toEqual([]);
  });
});

/**
 * A server that answers `status` headers and then stalls its body until the
 * request signal aborts: the body read is what the deadline interrupts.
 */
function stalledBodyFetch(status = 200) {
  return vi.fn(async (_input: unknown, init?: RequestInit) => {
    const signal = init?.signal;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"success":'));
        signal?.addEventListener('abort', () =>
          controller.error(signal.reason ?? new Error('aborted')),
        );
      },
    });
    return new Response(body, {
      status,
      headers: { 'content-type': 'application/json' },
    });
  });
}

const BASE = 'https://station.example.test';
const opts = { timeoutMs: 20 } as const;

const families: Array<[string, () => Promise<unknown>]> = [
  [
    'readEnvelopeOrThrow (integrations)',
    async () =>
      (await import('../client/integrations')).listIntegrations(BASE, opts),
  ],
  ['runs', async () => (await import('../client/runs')).listRuns(BASE, opts)],
  [
    'delegations',
    async () =>
      (await import('../client/delegations')).observeDelegatedTask(
        BASE,
        'task:1',
        undefined,
        opts,
      ),
  ],
  [
    'board',
    async () =>
      (await import('../client/board')).getBoard(
        BASE,
        { kind: 'session', id: 's1' } as never,
        opts,
      ),
  ],
  [
    'scheduler',
    async () => (await import('../client/scheduler')).listJobs(BASE, opts),
  ],
  [
    'knowledge',
    async () =>
      (await import('../client/knowledge')).listKnowledgeRoots(BASE, opts),
  ],
  [
    'conversations',
    async () =>
      (await import('../client/conversations')).listAgentConversations(
        BASE,
        'writer',
        opts,
      ),
  ],
  [
    'agents',
    async () =>
      (await import('../client/agents')).fetchAgentCatalog(BASE, opts),
  ],
  [
    'skills',
    async () =>
      (await import('../client/skills')).fetchInstalledSkills(BASE, opts),
  ],
  [
    'orchestration',
    async () =>
      (await import('../client/orchestration')).getOrchestrationSession(
        BASE,
        't1',
        opts,
      ),
  ],
  [
    'projects (readJsonBody)',
    async () =>
      (await import('../client/projects')).getProject(BASE, 'p', opts),
  ],
];

describe('a deadline that fires mid-body reaches the caller as a timeout', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.each(
    families.flatMap(([name, call]) => [
      [name, 200, call] as const,
      [name, 502, call] as const,
    ]),
  )('%s (HTTP %i headers, stalled body)', async (_name, status, call) => {
    vi.stubGlobal('fetch', stalledBodyFetch(status));
    const error = await call().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(StationRequestTimeoutError);
    expect((error as StationRequestTimeoutError).mutation).toBe(false);
  });
});
