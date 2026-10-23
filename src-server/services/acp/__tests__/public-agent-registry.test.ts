/**
 * The public agent registry source at its fetch seam: the injected `fetch`
 * is the only network, and the cache is a real directory. The fixture is
 * the registry index as published on 2026-10-21.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test, vi } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import {
  createPublicAgentRegistrySource,
  PUBLIC_AGENT_REGISTRY_LIMITS,
  PUBLIC_AGENT_REGISTRY_URL,
  type PublicAgentRegistryLimits,
  PublicAgentRegistrySource,
  parsePublicAgentRegistry,
} from '../public-agent-registry.js';

const FIXTURE = readFileSync(
  join(import.meta.dirname, 'fixtures', 'public-agent-registry-20261021.json'),
  'utf8',
);
const FIXTURE_AGENT_COUNT = 43;
const makeTempDir = trackTempDirs();

function serve(body: string, init: ResponseInit = {}) {
  return vi.fn(
    async (_url: string | URL | Request, _init?: RequestInit) =>
      new Response(body, { status: 200, ...init }),
  );
}

function offline() {
  return vi.fn(async () => {
    throw new TypeError('fetch failed');
  });
}

function source(
  fetchImpl: ReturnType<typeof vi.fn>,
  options: {
    cacheDir?: string;
    now?: () => number;
    limits?: Partial<PublicAgentRegistryLimits>;
  } = {},
) {
  return new PublicAgentRegistrySource({
    cacheDir: options.cacheDir ?? makeTempDir('public-registry-'),
    fetch: fetchImpl as unknown as typeof fetch,
    now: options.now,
    limits: { minRefreshIntervalMs: 0, ...options.limits },
    commandExists: () => false,
  });
}

function withAgents(agents: unknown[], version = '1.0.0'): string {
  return JSON.stringify({ version, agents, extensions: [] });
}

/** Lets a refresh that `refreshIfStale` started reach its fetch, if it will. */
async function settle() {
  for (let i = 0; i < 5; i += 1) await new Promise((r) => setTimeout(r, 0));
}

function fixtureAgents(): Array<Record<string, any>> {
  return JSON.parse(FIXTURE).agents;
}

describe('public agent registry source', () => {
  test('downloads the published index without credentials and admits every real listing', async () => {
    const fetchImpl = serve(FIXTURE);
    const registry = source(fetchImpl);

    const status = await registry.refresh();

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe(PUBLIC_AGENT_REGISTRY_URL);
    expect(init?.credentials).toBe('omit');
    expect(new Headers(init?.headers).has('authorization')).toBe(false);
    expect(status).toMatchObject({
      enabled: true,
      origin: 'network',
      lastError: null,
      refreshing: false,
      refused: [],
    });
    expect(registry.agents()).toHaveLength(FIXTURE_AGENT_COUNT);
    const goose = registry.agents().find((agent) => agent.id === 'goose');
    expect(goose).toMatchObject({
      name: 'goose',
      version: '1.55.0',
      publishers: ['Block'],
      license: 'Apache-2.0',
    });
    expect(goose?.binary['darwin-aarch64']).toEqual({
      cmd: './goose',
      args: ['acp'],
    });
    const droid = registry.agents().find((a) => a.id === 'factory-droid');
    expect(droid?.packages).toEqual([
      {
        kind: 'npx',
        package: 'droid@0.245.1',
        args: ['exec', '--output-format', 'acp-daemon'],
        env: {
          DROID_DISABLE_AUTO_UPDATE: 'true',
          FACTORY_DROID_AUTO_UPDATE_ENABLED: 'false',
        },
      },
    ]);
  });

  test('serves the saved copy when the network is absent', async () => {
    const cacheDir = makeTempDir('public-registry-');
    await source(serve(FIXTURE), { cacheDir }).refresh();

    const offlineFetch = offline();
    const restarted = source(offlineFetch, { cacheDir });
    await restarted.ready();
    expect(restarted.status().origin).toBe('cache');
    expect(restarted.agents()).toHaveLength(FIXTURE_AGENT_COUNT);

    const status = await restarted.refresh();
    expect(offlineFetch).toHaveBeenCalledTimes(1);
    expect(status.origin).toBe('cache');
    expect(status.lastError).toBe('The registry could not be reached.');
    expect(restarted.agents()).toHaveLength(FIXTURE_AGENT_COUNT);
  });

  test('refuses an index whose declared size is over the bound and keeps the saved copy', async () => {
    const cacheDir = makeTempDir('public-registry-');
    await source(serve(FIXTURE), { cacheDir }).refresh();
    const oversized = serve(FIXTURE, {
      headers: {
        'content-length': String(PUBLIC_AGENT_REGISTRY_LIMITS.maxBytes + 1),
      },
    });
    const registry = source(oversized, { cacheDir });

    const status = await registry.refresh();

    expect(status.lastError).toBe(
      `The registry index is larger than ${PUBLIC_AGENT_REGISTRY_LIMITS.maxBytes} bytes.`,
    );
    expect(status.origin).toBe('cache');
    expect(registry.agents()).toHaveLength(FIXTURE_AGENT_COUNT);
    // The saved copy on disk is still the good one.
    const saved = JSON.parse(
      readFileSync(join(cacheDir, 'registry.json'), 'utf8'),
    );
    expect(saved.body).toBe(FIXTURE);
  });

  test('counts the body as it arrives when no size is declared', async () => {
    const maxBytes = 1024;
    const chunk = new TextEncoder().encode('x'.repeat(400));
    let pulled = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1;
        controller.enqueue(chunk);
        if (pulled > 50) controller.close();
      },
    });
    const registry = source(
      vi.fn(async () => new Response(stream)),
      { limits: { maxBytes } },
    );

    const status = await registry.refresh();

    expect(status.lastError).toBe(
      `The registry index is larger than ${maxBytes} bytes.`,
    );
    // Stopped at the first chunk past the bound, not after reading it all.
    expect(pulled).toBeLessThan(10);
    expect(status.origin).toBe('none');
  });

  test.each([
    ['not JSON', '{"version": "1.0.0", "agents": [', 'not valid JSON'],
    ['no agent list', '{"version": "1.0.0"}', 'no list of agents'],
    [
      'a format version Station does not read',
      withAgents([], '2.0.0'),
      'format version Station does not read',
    ],
  ])(
    'refuses an index that is %s, whole, keeping the saved copy',
    async (_, body, reason) => {
      const cacheDir = makeTempDir('public-registry-');
      await source(serve(FIXTURE), { cacheDir }).refresh();
      const registry = source(serve(body), { cacheDir });

      const status = await registry.refresh();

      expect(status.lastError).toContain(reason);
      expect(status.origin).toBe('cache');
      expect(registry.agents()).toHaveLength(FIXTURE_AGENT_COUNT);
    },
  );

  test('refuses an index listing more agents than the bound', () => {
    const agents = fixtureAgents();
    const result = parsePublicAgentRegistry(withAgents(agents), {
      maxBytes: PUBLIC_AGENT_REGISTRY_LIMITS.maxBytes,
      maxAgents: agents.length - 1,
    });
    expect(result).toEqual({
      ok: false,
      reason: `The registry index lists more than ${agents.length - 1} agents.`,
    });
    expect(
      parsePublicAgentRegistry(withAgents(agents), {
        maxBytes: PUBLIC_AGENT_REGISTRY_LIMITS.maxBytes,
        maxAgents: agents.length,
      }).ok,
    ).toBe(true);
  });

  test('refuses single listings with every reason and keeps the rest', () => {
    const [first, second, third] = fixtureAgents();
    const result = parsePublicAgentRegistry(
      withAgents([
        first,
        { ...second, id: 'Bad_Id', website: 'http://example.test' },
        { ...third, name: 'Evil‮name', authors: [] },
        { ...first },
        'not an object',
      ]),
    );
    if (!result.ok) throw new Error(result.reason);
    expect(result.agents.map((agent) => agent.id)).toEqual([first.id]);
    expect(result.refused).toEqual([
      {
        id: 'Bad_Id',
        reasons: [
          'id must be lowercase letters, digits and single hyphens',
          'website is not an https URL',
        ],
      },
      {
        id: third.id,
        reasons: [
          'name is missing, too long or not plain text',
          'authors must list 1-16 publishers',
        ],
      },
      { id: first.id, reasons: ['listed more than once'] },
      { id: '(unknown)', reasons: ['not an object'] },
    ]);
  });

  test('refuses a listing whose field is over its length bound', () => {
    const [agent] = fixtureAgents();
    const result = parsePublicAgentRegistry(
      withAgents([{ ...agent, description: 'd'.repeat(401) }]),
    );
    if (!result.ok) throw new Error(result.reason);
    expect(result.agents).toEqual([]);
    expect(result.refused[0].reasons).toEqual([
      'description is missing, too long or not plain text',
    ]);
  });

  test('keeps a listing with an unknown distribution kind, recording it', () => {
    const [agent] = fixtureAgents();
    const result = parsePublicAgentRegistry(
      withAgents([{ ...agent, distribution: { docker: { image: 'x' } } }]),
    );
    if (!result.ok) throw new Error(result.reason);
    expect(result.agents[0]).toMatchObject({
      binary: {},
      packages: [],
      unknownDistributions: ['docker'],
    });
  });

  test('gives up on a registry that does not answer within the timeout', async () => {
    const hanging = vi.fn(
      (_url: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_, reject) => {
          init?.signal?.addEventListener('abort', () =>
            reject(new DOMException('aborted', 'AbortError')),
          );
        }),
    );
    const registry = source(hanging, { limits: { fetchTimeoutMs: 20 } });

    const status = await registry.refresh();

    expect(status.lastError).toMatch(/^The registry did not answer within /);
    expect(status.refreshing).toBe(false);
  });

  test('refuses an HTTP error answer', async () => {
    const registry = source(serve('nope', { status: 503 }));
    const status = await registry.refresh();
    expect(status.lastError).toBe(
      'The registry answered with HTTP status 503.',
    );
  });

  test('ignores a saved copy that is no longer a valid index', async () => {
    const cacheDir = makeTempDir('public-registry-');
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(
      join(cacheDir, 'registry.json'),
      JSON.stringify({ fetchedAt: '2026-10-21T00:00:00.000Z', body: '{' }),
    );
    const registry = source(offline(), { cacheDir });
    await registry.ready();
    expect(registry.status().origin).toBe('none');
    expect(registry.agents()).toEqual([]);
  });

  test('refreshes in the background only when stale, and backs off after a failure', async () => {
    let now = Date.parse('2026-10-21T12:00:00.000Z');
    const fetchImpl = serve(FIXTURE);
    const registry = source(fetchImpl, { now: () => now });
    await registry.ready();

    registry.refreshIfStale();
    await vi.waitFor(() => expect(registry.status().origin).toBe('network'));
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    // A refresh that starts awaits the source's load before it fetches, so
    // every "no fetch" below is read only after that has had its chance.
    now += PUBLIC_AGENT_REGISTRY_LIMITS.refreshAfterMs - 1;
    registry.refreshIfStale();
    await settle();
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    now += 2;
    fetchImpl.mockImplementation(async () => {
      throw new TypeError('fetch failed');
    });
    registry.refreshIfStale();
    await vi.waitFor(() =>
      expect(registry.status().lastError).toBe(
        'The registry could not be reached.',
      ),
    );
    expect(fetchImpl).toHaveBeenCalledTimes(2);

    now += PUBLIC_AGENT_REGISTRY_LIMITS.retryAfterFailureMs - 1;
    registry.refreshIfStale();
    await settle();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    now += 2;
    registry.refreshIfStale();
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(3));
  });

  test('joins a download already running and reuses a very recent result', async () => {
    let release: (() => void) | undefined;
    const fetchImpl = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          release = () => resolve(new Response(FIXTURE));
        }),
    );
    const registry = new PublicAgentRegistrySource({
      cacheDir: makeTempDir('public-registry-'),
      fetch: fetchImpl as unknown as typeof fetch,
      commandExists: () => false,
    });

    const first = registry.refresh();
    const second = registry.refresh();
    await vi.waitFor(() => expect(release).toBeDefined());
    release?.();
    await Promise.all([first, second]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    await registry.refresh();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  test('treats a saved copy dated in the future as stale', async () => {
    const cacheDir = makeTempDir('public-registry-');
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(
      join(cacheDir, 'registry.json'),
      JSON.stringify({ fetchedAt: '2099-01-01T00:00:00.000Z', body: FIXTURE }),
    );
    const fetchImpl = serve(FIXTURE);
    const registry = source(fetchImpl, { cacheDir });
    await registry.ready();
    registry.refreshIfStale();
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1));
  });

  test('accepts an answer from the address it asked for, however it was spelled', async () => {
    const fetchImpl = vi.fn(async () => {
      const response = new Response(FIXTURE);
      Object.defineProperty(response, 'url', {
        value: 'https://cdn.example.test/registry/v1/latest/registry.json',
      });
      return response;
    });
    const registry = new PublicAgentRegistrySource({
      cacheDir: makeTempDir('public-registry-'),
      fetch: fetchImpl as unknown as typeof fetch,
      url: 'https://CDN.example.test:443/registry/v1/latest/registry.json',
      commandExists: () => false,
    });
    const status = await registry.refresh();
    expect(status.lastError).toBeNull();
    expect(registry.agents()).toHaveLength(FIXTURE_AGENT_COUNT);
  });

  test('does not follow redirects, and refuses an answer from another address', async () => {
    const cacheDir = makeTempDir('public-registry-');
    await source(serve(FIXTURE), { cacheDir }).refresh();
    const redirected = vi.fn(
      async (_url: string | URL | Request, _init?: RequestInit) => {
        const response = new Response(FIXTURE);
        Object.defineProperty(response, 'url', {
          value: 'http://cdn.example.test/registry.json',
        });
        return response;
      },
    );
    const registry = source(redirected, { cacheDir });

    const status = await registry.refresh();

    expect(redirected.mock.calls[0][1]?.redirect).toBe('error');
    expect(status.lastError).toBe(
      'The registry answered from an address other than the one Station asked.',
    );
    expect(status.origin).toBe('cache');
    expect(registry.agents()).toHaveLength(FIXTURE_AGENT_COUNT);
  });

  test.each([
    ['a zero-width space', 'Goo\u200Bse'],
    ['a byte order mark', '\uFEFFGoose'],
    ['an Arabic letter mark', 'Goose\u061C'],
    ['a line separator', 'Goose\u2028x'],
    ['a tag character', 'Goose\u{E0041}'],
    ['a variation selector', 'Goose\uFE0F'],
    ['a word joiner', 'Go\u2060ose'],
    ['a soft hyphen', 'Go\u00ADose'],
    ['a combining grapheme joiner', 'Go\u034Fose'],
    ['a Hangul choseong filler', 'Goose\u115F'],
    ['a Hangul filler', 'Goose\u3164'],
    ['a halfwidth Hangul filler', 'Goose\uFFA0'],
  ])('refuses a listing whose text hides %s', (_, name) => {
    const [agent] = fixtureAgents();
    const result = parsePublicAgentRegistry(withAgents([{ ...agent, name }]));
    if (!result.ok) throw new Error(result.reason);
    expect(result.agents).toEqual([]);
    expect(result.refused[0].reasons).toEqual([
      'name is missing, too long or not plain text',
    ]);
  });

  test('refuses an https link that carries a user name or password', () => {
    const [agent] = fixtureAgents();
    const result = parsePublicAgentRegistry(
      withAgents([{ ...agent, website: 'https://user:pw@example.test/' }]),
    );
    if (!result.ok) throw new Error(result.reason);
    expect(result.refused[0].reasons).toEqual([
      'website must not carry a user name or password',
    ]);
  });

  test.each(['off', 'OFF', '0', 'false', 'No'])(
    'STATION_PUBLIC_AGENT_REGISTRY=%s turns the source off',
    (value) => {
      expect(
        createPublicAgentRegistrySource('/tmp/home', {
          STATION_PUBLIC_AGENT_REGISTRY: value,
        }),
      ).toBeUndefined();
    },
  );

  test('the source is on by default', () => {
    expect(createPublicAgentRegistrySource('/tmp/home', {})).toBeInstanceOf(
      PublicAgentRegistrySource,
    );
  });
});
