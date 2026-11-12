import {
  parseManagedPolicyDocument,
  summarizeManagedPolicy,
} from '@kontourai/station-contracts/managed-policy';
import type { ProviderConnectionConfig } from '@kontourai/station-contracts/tool';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { installManagedEngineLimits } from '../../../security/managed-engine-limits.js';
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

/** The test runner's own environment must not decide the route. */
function clearRouteEnv() {
  for (const name of [
    'ANTHROPIC_BASE_URL',
    'OPENAI_BASE_URL',
    'CLAUDE_CODE_USE_BEDROCK',
    'CLAUDE_CODE_USE_VERTEX',
    'anthropic_base_url',
  ])
    vi.stubEnv(name, undefined);
}

function installPin(instances: unknown) {
  const parsed = parseManagedPolicyDocument({
    schemaVersion: 1,
    organization: 'Acme',
    limits: { engines: { instances } },
  });
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.problems));
  installManagedEngineLimits({
    document: parsed.document,
    summary: summarizeManagedPolicy(parsed.document),
  });
}

beforeEach(clearRouteEnv);
afterEach(() => {
  vi.unstubAllEnvs();
  installManagedEngineLimits(null);
});

describe('observeEngineRoute', () => {
  test('a saved proxy is the route, named, with its origin only', () => {
    vi.stubEnv('ANTHROPIC_BASE_URL', 'https://ignored.example');
    expect(
      observeEngineRoute('claude', { proxyConnectionId: proxy.id }, [proxy]),
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
      vi.stubEnv(
        name,
        'https://user:secret@gateway.example:9443/v1/proxy?token=abc',
      );
      const observed = observeEngineRoute(engine, {}, []);
      expect(observed).toEqual({
        kind: 'ambient',
        origin: 'https://gateway.example:9443',
        source: 'station',
      });
      const text = JSON.stringify(observed);
      for (const leaked of ['user', 'secret', 'token', 'abc', '/v1'])
        expect(text).not.toContain(leaked);
    },
  );

  test('the connection env wins over the inherited one, and an empty value masks it', () => {
    vi.stubEnv('ANTHROPIC_BASE_URL', 'https://inherited.example');
    expect(
      observeEngineRoute(
        'claude',
        { env: { ANTHROPIC_BASE_URL: 'http://localhost:4000/anthropic' } },
        [],
      ),
    ).toEqual({
      kind: 'ambient',
      origin: 'http://localhost:4000',
      source: 'connection',
    });
    expect(
      observeEngineRoute('claude', { env: { ANTHROPIC_BASE_URL: '' } }, []),
    ).toEqual({ kind: 'account' });
  });

  test('no endpoint override in the launch is account (an unobserved route)', () => {
    expect(observeEngineRoute('codex', {}, [])).toEqual({ kind: 'account' });
  });

  test.each([
    ['an unparseable endpoint', {}, { ANTHROPIC_BASE_URL: 'not a url' }],
    ['a non-HTTP endpoint', {}, { ANTHROPIC_BASE_URL: 'file:///etc/endpoint' }],
    ['the Bedrock switch', {}, { CLAUDE_CODE_USE_BEDROCK: '1' }],
    ['a saved proxy the launch refuses', { proxyConnectionId: 'missing' }, {}],
  ])('%s is unknown, never the account', (_, config, env) => {
    for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value);
    expect(observeEngineRoute('claude', config, [proxy])).toEqual({
      kind: 'unknown',
    });
  });

  test('on Windows a differently cased variable is still the endpoint', () => {
    vi.stubEnv('anthropic_base_url', 'https://gateway.example/v1');
    expect(observeEngineRoute('claude', {}, [], 'win32')).toEqual({
      kind: 'ambient',
      origin: 'https://gateway.example',
      source: 'station',
    });
  });
});

describe('observeEngineRoute under a managed policy', () => {
  test('a locked pinned endpoint is the route, from the policy, over the connection and the proxy', () => {
    installPin({
      claude: {
        locked: true,
        environment: { ANTHROPIC_BASE_URL: 'https://gw.acme.example/v1' },
      },
    });
    vi.stubEnv('ANTHROPIC_BASE_URL', 'https://inherited.example');
    for (const config of [
      { env: { ANTHROPIC_BASE_URL: 'https://user.example' } },
      { proxyConnectionId: proxy.id },
    ])
      expect(observeEngineRoute('claude', config, [proxy])).toEqual({
        kind: 'ambient',
        origin: 'https://gw.acme.example',
        source: 'policy',
      });
  });

  test('an unlocked pinned endpoint only fills a variable nothing set', () => {
    installPin({
      claude: {
        locked: false,
        environment: { ANTHROPIC_BASE_URL: 'https://gw.acme.example' },
      },
    });
    expect(observeEngineRoute('claude', {}, [])).toEqual({
      kind: 'ambient',
      origin: 'https://gw.acme.example',
      source: 'policy',
    });
    vi.stubEnv('ANTHROPIC_BASE_URL', 'https://inherited.example');
    expect(observeEngineRoute('claude', {}, [])).toEqual({
      kind: 'ambient',
      origin: 'https://inherited.example',
      source: 'station',
    });
  });

  test('a locked pin on Windows replaces every case variant of the variable', () => {
    installPin({
      claude: {
        locked: true,
        environment: { ANTHROPIC_BASE_URL: 'https://gw.acme.example' },
      },
    });
    vi.stubEnv('anthropic_base_url', 'https://inherited.example');
    expect(observeEngineRoute('claude', {}, [], 'win32')).toEqual({
      kind: 'ambient',
      origin: 'https://gw.acme.example',
      source: 'policy',
    });
  });

  test('a pinned Codex provider argument is unknown, even over a saved proxy', () => {
    installPin({
      codex: { locked: false, launchArgs: ['-c', 'model_provider="acme"'] },
    });
    expect(observeEngineRoute('codex', {}, [])).toEqual({ kind: 'unknown' });
    expect(
      observeEngineRoute('codex', { proxyConnectionId: proxy.id }, [proxy]),
    ).toEqual({ kind: 'unknown' });
  });

  test('pinned arguments that can choose a route make it unknown', () => {
    for (const launchArgs of [
      ['--config=model_provider=acme'],
      ['-p', 'work'],
      ['--profile=work'],
    ]) {
      installPin({ codex: { locked: true, launchArgs } });
      expect(observeEngineRoute('codex', {}, [])).toEqual({ kind: 'unknown' });
    }
    installPin({
      claude: {
        locked: true,
        launchArgs: [
          '--settings',
          '{"env":{"ANTHROPIC_BASE_URL":"https://gw.acme.example"}}',
        ],
      },
    });
    expect(observeEngineRoute('claude', {}, [])).toEqual({ kind: 'unknown' });
  });

  test('pinned arguments that choose no provider leave the route alone', () => {
    installPin({
      codex: { locked: true, launchArgs: ['-c', 'approval_policy="never"'] },
    });
    expect(observeEngineRoute('codex', {}, [])).toEqual({ kind: 'account' });
  });
});

describe('engine connection projection', () => {
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
      source: 'station',
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

  test('an engine with no endpoint override in the launch reads account', async () => {
    const [connection] = await serviceFor(
      'claude',
      {},
    ).listRuntimeConnections();
    expect(connection?.routeObservation).toEqual({ kind: 'account' });
  });
});
