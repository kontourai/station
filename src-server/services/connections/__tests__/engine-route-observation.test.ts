import type { ProviderConnectionConfig } from '@kontourai/station-contracts/tool';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { observeEngineRoute } from '../engine-route-observation.js';
import { createConnectionServiceForTest } from './connection-service-test-helper.js';

const proxy: ProviderConnectionConfig = {
  id: 'home-proxy',
  type: 'openai-compat',
  name: 'home-media',
  enabled: true,
  capabilities: ['llm'],
  config: {
    baseUrl: 'https://proxy.example:8317/v1',
    apiKey: 'private-test-key',
  },
};

describe('observeEngineRoute', () => {
  test('a saved proxy is the route, named, with its origin only', () => {
    expect(
      observeEngineRoute('claude', { proxyConnectionId: proxy.id }, [proxy], {
        ANTHROPIC_BASE_URL: 'https://ignored.example',
      }),
    ).toEqual({
      kind: 'proxy',
      origin: 'https://proxy.example:8317',
      label: 'home-media',
    });
  });

  test.each([
    ['claude', 'ANTHROPIC_BASE_URL'],
    ['codex', 'OPENAI_BASE_URL'],
  ] as const)(
    'an inherited %s endpoint is ambient, with userinfo, path and query removed',
    (engine, name) => {
      const observed = observeEngineRoute(engine, {}, [], {
        [name]: 'https://user:secret@gateway.example:9443/v1/proxy?token=abc',
      });
      expect(observed).toEqual({
        kind: 'ambient',
        origin: 'https://gateway.example:9443',
      });
      const text = JSON.stringify(observed);
      for (const leaked of ['user', 'secret', 'token', 'abc', '/v1'])
        expect(text).not.toContain(leaked);
    },
  );

  test('the connection env wins over the inherited one, and an empty value masks it', () => {
    expect(
      observeEngineRoute(
        'claude',
        { env: { ANTHROPIC_BASE_URL: 'http://localhost:4000/anthropic' } },
        [],
        { ANTHROPIC_BASE_URL: 'https://inherited.example' },
      ),
    ).toEqual({ kind: 'ambient', origin: 'http://localhost:4000' });
    expect(
      observeEngineRoute('claude', { env: { ANTHROPIC_BASE_URL: '' } }, [], {
        ANTHROPIC_BASE_URL: 'https://inherited.example',
      }),
    ).toEqual({ kind: 'account' });
  });

  test('no endpoint override reads the account', () => {
    expect(observeEngineRoute('codex', {}, [], {})).toEqual({
      kind: 'account',
    });
  });

  test.each([
    ['an unparseable endpoint', {}, { ANTHROPIC_BASE_URL: 'not a url' }],
    ['a non-HTTP endpoint', {}, { ANTHROPIC_BASE_URL: 'file:///etc/endpoint' }],
    ['the Bedrock switch', {}, { CLAUDE_CODE_USE_BEDROCK: '1' }],
    ['a saved proxy the launch refuses', { proxyConnectionId: 'missing' }, {}],
  ])('%s is unknown, never the account', (_, config, env) => {
    expect(observeEngineRoute('claude', config, [proxy], env)).toEqual({
      kind: 'unknown',
    });
  });
});

describe('engine connection projection', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  function serviceFor(engine: 'claude' | 'codex', config: object) {
    return createConnectionServiceForTest(
      {
        listProviderConnections: vi.fn(() => [proxy]),
        saveProviderConnection: vi.fn(),
        deleteProviderConnection: vi.fn(),
        checkHealth: vi.fn(),
      } as any,
      () =>
        [
          {
            provider: engine,
            metadata: {
              displayName: engine === 'claude' ? 'Claude Code' : 'Codex',
              description: engine,
              capabilities: ['agent-runtime'],
              runtimeId: engine,
              executionClass: 'connected',
            },
            getPrerequisites: vi.fn().mockResolvedValue([]),
            listModels: vi.fn().mockResolvedValue([]),
          },
        ] as any,
      async () => [],
      () => ({ connections: [] }),
      async () => ({ agentConnections: { [engine]: { config } } }) as any,
      vi.fn(),
    );
  }

  test('an engine read carries the inherited endpoint origin and nothing else of it', async () => {
    vi.stubEnv(
      'ANTHROPIC_BASE_URL',
      'https://ops:hunter2@gateway.internal.example/route?key=k',
    );
    const [connection] = await serviceFor(
      'claude',
      {},
    ).listRuntimeConnections();
    expect(connection?.routeObservation).toEqual({
      kind: 'ambient',
      origin: 'https://gateway.internal.example',
    });
    expect(JSON.stringify(connection)).not.toContain('hunter2');
  });

  test('a saved proxy is reported as the route the engine uses', async () => {
    vi.stubEnv('OPENAI_BASE_URL', 'https://ignored.example');
    const [connection] = await serviceFor('codex', {
      proxyConnectionId: proxy.id,
    }).listRuntimeConnections();
    expect(connection?.routeObservation).toEqual({
      kind: 'proxy',
      origin: 'https://proxy.example:8317',
      label: 'home-media',
    });
  });

  test('an engine with no endpoint override reads the account', async () => {
    vi.stubEnv('ANTHROPIC_BASE_URL', '');
    vi.stubEnv('CLAUDE_CODE_USE_BEDROCK', '');
    vi.stubEnv('CLAUDE_CODE_USE_VERTEX', '');
    const [connection] = await serviceFor(
      'claude',
      {},
    ).listRuntimeConnections();
    expect(connection?.routeObservation).toEqual({ kind: 'account' });
  });
});
