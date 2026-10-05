/**
 * #2377 C2b review: a request deadline that fires while the response body is
 * being read reaches the caller as `StationRequestTimeoutError`, through one
 * exported fetcher per SDK unwrap family, against a server that sends its
 * headers and then stalls the body, including the non-2xx branches that used
 * to report "not JSON". The structural half (every body-read catch in the
 * SDK source uses the shared guard) is the repo scan
 * `body-read-deadline.scan.test.ts`.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { StationRequestTimeoutError } from '../client/http';

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
    'station usage overview',
    async () =>
      (await import('../client/analytics')).fetchStationUsage(BASE, opts),
  ],
  [
    'usage rollup',
    async () =>
      (await import('../client/analytics')).fetchUsageRollup(
        BASE,
        { days: 14 },
        opts,
      ),
  ],
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
