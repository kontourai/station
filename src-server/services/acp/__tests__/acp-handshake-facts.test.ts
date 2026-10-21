import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ACPConnectionConfig } from '@kontourai/station-contracts/acp';
import { describe, expect, test, vi } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import {
  acpRuntimeCatalogStatus,
  buildACPCapabilityInventory,
} from '../../connections/connection-service-helpers.js';
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
  const probe = new ACPProbe(
    config,
    { warn: vi.fn(), debug: vi.fn() },
    agent.directory,
  );
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
  return { config, connection: status.connections[0]! };
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
