import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ACPConnectionConfig } from '@kontourai/station-contracts/acp';
import { describe, expect, test, vi } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import {
  acpRuntimeCatalogStatus,
  buildACPCapabilityInventory,
} from '../../connections/connection-service-helpers.js';
import { ACP_DECLARED_FACT_BOUNDS } from '../acp-handshake-facts.js';
import { getACPManagerStatus } from '../acp-manager-view.js';
import { ACPProbe } from '../acp-probe.js';
import { ACPProcess } from '../acp-process.js';

/**
 * Recorded `initialize` answers (2026-10-21), reduced to the fields these
 * tests read. Kiro `--v3`'s `_meta.kiro` also carried local log paths and a
 * longer method list; Grok's result `_meta` carried host and workspace
 * details. Both were removed.
 */
const KIRO_V3_INITIALIZE = {
  protocolVersion: 1,
  agentCapabilities: {
    loadSession: true,
    promptCapabilities: { image: true, embeddedContext: true },
    mcpCapabilities: { http: true, sse: true },
    sessionCapabilities: {
      list: {},
      close: {},
      delete: {},
      fork: { _meta: { kiro: { messageId: true } } },
    },
    _meta: {
      kiro: {
        checkpoints: true,
        sessionList: true,
        extensionMethods: [
          '_kiro/knowledge',
          '_kiro/session/compact',
          '_kiro/session/export',
        ],
      },
    },
  },
  authMethods: [
    { id: 'aws-builder-id', name: 'AWS Builder ID' },
    { id: 'aws-iam-identity-center', name: 'AWS IAM Identity Center' },
  ],
};

const OPENCODE_INITIALIZE = {
  protocolVersion: 1,
  agentCapabilities: {
    loadSession: true,
    mcpCapabilities: { http: true, sse: true },
    promptCapabilities: { embeddedContext: true, image: true },
    sessionCapabilities: { close: {}, fork: {}, list: {}, resume: {} },
  },
  authMethods: [
    {
      description: 'Run `opencode auth login` in the terminal',
      name: 'Login with opencode',
      id: 'opencode-login',
    },
  ],
  agentInfo: { name: 'OpenCode', version: '1.18.18' },
};

/** The #352 Grok shape: models on the session, no model config option. */
const MODELS_ONLY_SESSION = {
  models: {
    currentModelId: 'grok-4.6',
    availableModels: [
      { modelId: 'grok-4.6', name: 'Grok 4.6', _meta: { contextWindow: 1 } },
      { modelId: 'grok-4.5', name: 'Grok 4.5' },
    ],
  },
  configOptions: [],
};

/**
 * A real ACP agent on stdio: answers `initialize` and `session/new` from a
 * JSON file, records every request it receives, and answers anything else
 * with an empty result.
 */
const FAKE_AGENT = `
const fs = require('node:fs');
const [configPath, capturePath] = process.argv.slice(2);
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  for (;;) {
    const newline = buffer.indexOf('\\n');
    if (newline < 0) break;
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    if (!line) continue;
    const request = JSON.parse(line);
    if (request.id === undefined) continue;
    fs.appendFileSync(capturePath, JSON.stringify({ method: request.method, params: request.params }) + '\\n');
    const result =
      request.method === 'initialize'
        ? config.initialize
        : request.method === 'session/new'
          ? { sessionId: 'session-1', ...config.sessionNew }
          : {};
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\\n');
  }
});
`;

const makeTempDir = trackTempDirs();

function fakeAgent(answers: { initialize: unknown; sessionNew?: unknown }) {
  const directory = makeTempDir('station-acp-handshake-');
  const agentPath = join(directory, 'agent.cjs');
  const configPath = join(directory, 'answers.json');
  const capturePath = join(directory, 'requests.jsonl');
  writeFileSync(agentPath, FAKE_AGENT);
  writeFileSync(configPath, JSON.stringify({ sessionNew: {}, ...answers }));
  writeFileSync(capturePath, '');
  return {
    directory,
    command: process.execPath,
    args: [agentPath, configPath, capturePath],
    requests: (): Array<{ method: string; params: any }> =>
      readFileSync(capturePath, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line)),
  };
}

async function probeConnection(
  agent: ReturnType<typeof fakeAgent>,
  name: string,
) {
  const config: ACPConnectionConfig = {
    id: 'engine',
    name,
    command: agent.command,
    args: agent.args,
    cwd: agent.directory,
    enabled: true,
  };
  const logger = { warn: vi.fn(), debug: vi.fn() };
  const probe = new ACPProbe(config, logger, agent.directory);
  try {
    await expect(probe.probe()).resolves.toBe(true);
  } finally {
    await probe.dispose();
  }
  const status = getACPManagerStatus(
    new Map([[config.id, probe]]),
    new Map([[config.id, config]]),
    0,
  );
  return { config, connection: status.connections[0]!, logger };
}

describe('declared handshake facts reach the connection inventory', () => {
  test('a Kiro --v3 shaped engine: lifecycle, sign-in methods and declared extension methods', async () => {
    const agent = fakeAgent({ initialize: KIRO_V3_INITIALIZE });
    const { connection } = await probeConnection(agent, 'Kiro v3');

    const inventory = buildACPCapabilityInventory({
      connection,
      displayName: 'Kiro v3',
      configuredCount: 1,
      connectedCount: 1,
      enabled: true,
    });

    expect(inventory.displayName).toBe('Kiro v3');
    expect(inventory.checkedAt).toBe(connection.handshakeObservedAt);
    expect(inventory.declaredHandshake).toEqual({
      observedAt: connection.handshakeObservedAt,
      protocolVersion: 1,
      sessionCapabilities: ['list', 'close', 'fork', 'delete'],
      authMethods: KIRO_V3_INITIALIZE.authMethods,
      extensionMethods: [
        '_kiro/knowledge',
        '_kiro/session/compact',
        '_kiro/session/export',
      ],
    });
    // v3 sends no agentInfo, so nothing names a version.
    expect(inventory.declaredHandshake).not.toHaveProperty('agentInfo');
    expect(inventory).not.toHaveProperty('version');
  });

  test('an engine that names itself: agentInfo and version are its own', async () => {
    const agent = fakeAgent({ initialize: OPENCODE_INITIALIZE });
    const { connection } = await probeConnection(agent, 'My OpenCode');

    const inventory = buildACPCapabilityInventory({
      connection,
      displayName: 'My OpenCode',
      configuredCount: 1,
      connectedCount: 1,
      enabled: true,
    });

    expect(inventory.displayName).toBe('My OpenCode');
    expect(inventory.version).toBe('1.18.18');
    expect(inventory.declaredHandshake).toMatchObject({
      agentInfo: { name: 'OpenCode', version: '1.18.18' },
      sessionCapabilities: ['list', 'resume', 'close', 'fork'],
      authMethods: OPENCODE_INITIALIZE.authMethods,
      extensionMethods: [],
    });
  });

  test('no successful handshake declares nothing', () => {
    const inventory = buildACPCapabilityInventory({
      connection: { id: 'engine', status: 'unavailable' },
      displayName: 'Never met',
      configuredCount: 1,
      connectedCount: 1,
      enabled: true,
    });
    expect(inventory.displayName).toBe('Never met');
    expect(inventory).not.toHaveProperty('declaredHandshake');
    expect(inventory).not.toHaveProperty('checkedAt');
  });
});

describe('#352 session models dialect', () => {
  test('the probe lists a models-only session as the catalog and its current model', async () => {
    const agent = fakeAgent({
      initialize: OPENCODE_INITIALIZE,
      sessionNew: MODELS_ONLY_SESSION,
    });
    const { config, connection } = await probeConnection(agent, 'Grok');

    expect(connection.currentModel).toBe('grok-4.6');
    expect(acpRuntimeCatalogStatus(connection, config)).toMatchObject({
      source: 'live',
      models: [
        { id: 'grok-4.6', name: 'Grok 4.6' },
        { id: 'grok-4.5', name: 'Grok 4.5' },
      ],
    });
    expect(
      buildACPCapabilityInventory({
        connection,
        displayName: 'Grok',
        configuredCount: 1,
        connectedCount: 1,
        enabled: true,
      }).models,
    ).toEqual([
      { id: 'grok-4.6', name: 'Grok 4.6' },
      { id: 'grok-4.5', name: 'Grok 4.5' },
    ]);
  });

  test('a model config option outranks the models list when both are sent', async () => {
    const agent = fakeAgent({
      initialize: OPENCODE_INITIALIZE,
      sessionNew: {
        ...MODELS_ONLY_SESSION,
        configOptions: [
          {
            id: 'model',
            name: 'Model',
            category: 'model',
            type: 'select',
            currentValue: 'option-b',
            options: [
              { value: 'option-a', name: 'Option A' },
              { value: 'option-b', name: 'Option B' },
            ],
          },
        ],
      },
    });
    const { config, connection } = await probeConnection(agent, 'Both');

    expect(connection.currentModel).toBe('option-b');
    expect(acpRuntimeCatalogStatus(connection, config).models).toEqual([
      { id: 'option-a', name: 'Option A', originalId: 'option-a' },
      { id: 'option-b', name: 'Option B', originalId: 'option-b' },
    ]);
  });

  test('setModel sends session/set_model for the live session on the wire', async () => {
    const agent = fakeAgent({
      initialize: OPENCODE_INITIALIZE,
      sessionNew: MODELS_ONLY_SESSION,
    });
    const acpProcess = new ACPProcess({
      command: agent.command,
      args: agent.args,
      cwd: agent.directory,
      createClient: () => ({}) as any,
      clientCapabilities: {},
      logger: { debug: vi.fn(), warn: vi.fn() },
    });
    try {
      await acpProcess.start();
      const session = await acpProcess.newSession(agent.directory);
      expect(session.models).toEqual(MODELS_ONLY_SESSION.models);
      await acpProcess.setModel('grok-4.5');
    } finally {
      await acpProcess.destroy();
    }
    expect(agent.requests().at(-1)).toEqual({
      method: 'session/set_model',
      params: { sessionId: 'session-1', modelId: 'grok-4.5' },
    });
  });
});

describe('what is served of declared facts is projected and bounded', () => {
  function inventoryOf(
    connection: Parameters<typeof buildACPCapabilityInventory>[0]['connection'],
  ) {
    return buildACPCapabilityInventory({
      connection,
      displayName: 'Engine',
      configuredCount: 1,
      connectedCount: 1,
      enabled: true,
    });
  }

  test('a terminal sign-in method is served without its arguments, environment or _meta', async () => {
    const agent = fakeAgent({
      initialize: {
        ...OPENCODE_INITIALIZE,
        authMethods: [
          {
            type: 'terminal',
            id: 'terminal-login',
            name: 'Sign in',
            description: 'Opens a terminal',
            args: ['login', '--token-file', '/secret/path'],
            env: { LOGIN_SECRET: 'do-not-serve' },
            _meta: { vendor: 'do-not-serve' },
          },
        ],
      },
    });
    const { connection } = await probeConnection(agent, 'Engine');

    const inventory = inventoryOf(connection);
    expect(inventory.declaredHandshake?.authMethods).toEqual([
      {
        id: 'terminal-login',
        name: 'Sign in',
        description: 'Opens a terminal',
        type: 'terminal',
      },
    ]);
    const served = JSON.stringify({ connection, inventory });
    expect(served).not.toContain('do-not-serve');
    expect(served).not.toContain('/secret/path');
  });

  test('the bounds are the documented values', () => {
    expect(ACP_DECLARED_FACT_BOUNDS).toEqual({
      label: 256,
      description: 1024,
      authMethods: 32,
      extensionMethods: 256,
      availableModels: 1024,
    });
  });

  test('a fact at its bound is served; one past it is refused whole and logged, and the probe still succeeds', async () => {
    const atBound = 'a'.repeat(256);
    const pastBound = 'a'.repeat(257);
    const methods = (count: number) =>
      Array.from({ length: count }, (_, index) => `_acme/m${index}`);
    const authMethods = (count: number) =>
      Array.from({ length: count }, (_, index) => ({
        id: `m${index}`,
        name: 'M',
      }));
    const handshake = (overrides: {
      name: string;
      methods: string[];
      auth: unknown[];
    }) => ({
      ...OPENCODE_INITIALIZE,
      agentInfo: { name: overrides.name, version: '1' },
      agentCapabilities: {
        ...OPENCODE_INITIALIZE.agentCapabilities,
        _meta: { acme: { extensionMethods: overrides.methods } },
      },
      authMethods: overrides.auth,
    });

    const within = await probeConnection(
      fakeAgent({
        initialize: handshake({
          name: atBound,
          methods: methods(256),
          auth: authMethods(32),
        }),
      }),
      'Engine',
    );
    expect(within.connection.declaredHandshake).toMatchObject({
      agentInfo: { name: atBound },
    });
    expect(within.connection.declaredHandshake?.extensionMethods).toHaveLength(
      256,
    );
    expect(within.connection.declaredHandshake?.authMethods).toHaveLength(32);
    expect(within.connection.declaredHandshake).not.toHaveProperty('refused');
    expect(within.logger.warn).not.toHaveBeenCalledWith(
      expect.stringContaining('refused'),
      expect.anything(),
    );

    const beyond = await probeConnection(
      fakeAgent({
        initialize: handshake({
          name: pastBound,
          methods: methods(257),
          auth: authMethods(33),
        }),
      }),
      'Engine',
    );
    const declared = beyond.connection.declaredHandshake;
    expect(declared?.refused).toEqual([
      'agentInfo',
      'authMethods',
      'extensionMethods',
    ]);
    expect(declared).not.toHaveProperty('agentInfo');
    expect(declared).not.toHaveProperty('authMethods');
    expect(declared).not.toHaveProperty('extensionMethods');
    expect(beyond.connection.status).toBe('available');
    expect(beyond.logger.warn).toHaveBeenCalledWith(
      'ACPProbe refused engine-declared facts beyond Station bounds',
      {
        id: 'engine',
        refused: ['agentInfo', 'authMethods', 'extensionMethods'],
      },
    );
    expect(JSON.stringify(inventoryOf(beyond.connection))).not.toContain(
      pastBound,
    );
  });

  test('an oversized models list is refused, not shortened, and offers no catalog', async () => {
    const { config, connection, logger } = await probeConnection(
      fakeAgent({
        initialize: OPENCODE_INITIALIZE,
        sessionNew: {
          models: {
            currentModelId: 'm0',
            availableModels: Array.from({ length: 1025 }, (_, index) => ({
              modelId: `m${index}`,
            })),
          },
        },
      }),
      'Engine',
    );
    expect(connection).not.toHaveProperty('sessionModels');
    expect(connection.declaredHandshake?.refused).toEqual(['models']);
    expect(connection.currentModel).toBeNull();
    expect(acpRuntimeCatalogStatus(connection, config).models).toEqual([]);
    expect(logger.warn).toHaveBeenCalledWith(
      'ACPProbe refused engine-declared facts beyond Station bounds',
      { id: 'engine', refused: ['models'] },
    );
  });
});

describe('one model-option rule', () => {
  test('an option without an id is not a model selector, so the models list is the catalog', async () => {
    const { config, connection } = await probeConnection(
      fakeAgent({
        initialize: OPENCODE_INITIALIZE,
        sessionNew: {
          ...MODELS_ONLY_SESSION,
          configOptions: [
            {
              category: 'model',
              currentValue: 'idless',
              options: [{ value: 'idless', name: 'Idless' }],
            },
          ],
        },
      }),
      'Engine',
    );
    expect(connection.currentModel).toBe('grok-4.6');
    expect(acpRuntimeCatalogStatus(connection, config).models).toEqual([
      { id: 'grok-4.6', name: 'Grok 4.6', originalId: 'grok-4.6' },
      { id: 'grok-4.5', name: 'Grok 4.5', originalId: 'grok-4.5' },
    ]);
    expect(connection.advertisedModels).toEqual([
      { id: 'grok-4.6', name: 'Grok 4.6' },
      { id: 'grok-4.5', name: 'Grok 4.5' },
    ]);
  });

  test('the current model falls back to the list when the option reports none', async () => {
    const { connection } = await probeConnection(
      fakeAgent({
        initialize: OPENCODE_INITIALIZE,
        sessionNew: {
          ...MODELS_ONLY_SESSION,
          configOptions: [
            {
              id: 'model',
              category: 'model',
              options: [{ value: 'grok-4.6', name: 'Grok 4.6' }],
            },
          ],
        },
      }),
      'Engine',
    );
    expect(connection.currentModel).toBe('grok-4.6');
    expect(connection.advertisedModels).toEqual([
      { id: 'grok-4.6', name: 'Grok 4.6' },
    ]);
  });
});
