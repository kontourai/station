/**
 * What Station announces at `initialize`, observed by the engine itself: the
 * fake ACP agent (the ACP SDK's agent side) records the `clientCapabilities`
 * it received. A client `_meta` flag is announced only while every method it
 * promises answers through the real inbound-extension registry, so removing a
 * handler is enough to withdraw the flag.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, test } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import type { ACPClientCallbacks } from '../acp-bridge-types.js';
import {
  AcpInboundExtensionRegistry,
  createAcpInboundExtensionRequestHandler,
  type EngineSecretStore,
  REVIEWED_ENGINE_SECRET_BINDINGS,
} from '../acp-inbound-extension-policy.js';
import { ACPProcess } from '../acp-process.js';

const FAKE_AGENT = fileURLToPath(
  new URL(
    '../../../providers/__tests__/fixtures/fake-acp-agent.mjs',
    import.meta.url,
  ),
);
const PROFILE = fileURLToPath(
  new URL(
    '../../../providers/__tests__/fixtures/acp-engine-profiles/kiro.json',
    import.meta.url,
  ),
);
const makeTempDir = trackTempDirs();
const quiet = { debug() {}, info() {}, warn() {}, error() {} };
const started: ACPProcess[] = [];

afterEach(async () => {
  await Promise.all(started.splice(0).map((process) => process.destroy()));
});

const store: EngineSecretStore = {
  scope: { connectionId: 'conn-1', credentialProfileRef: 'default' },
  get: async () => undefined,
  store: async () => undefined,
  delete: async () => undefined,
};

/** A registry with every announceable handler a parity lane will register. */
function fullRegistry(): AcpInboundExtensionRegistry {
  const registry = new AcpInboundExtensionRegistry();
  registry.register('_kiro/userInput', () => ({
    action: 'answered',
    answer: 'x',
  }));
  registry.register('_kiro/openExternalUrl', () => ({}));
  registry.registerSecretResponder(REVIEWED_ENGINE_SECRET_BINDINGS[0]!, store);
  return registry;
}

async function launch(
  client: Partial<ACPClientCallbacks>,
  session?: { meta: Record<string, unknown> },
): Promise<Array<Record<string, unknown>>> {
  const dir = makeTempDir('station-acp-announce-');
  const record = join(dir, 'record.jsonl');
  writeFileSync(record, '');
  const acpProcess = new ACPProcess({
    command: process.execPath,
    args: [FAKE_AGENT, '--engine-profile', PROFILE, '--record', record],
    cwd: dir,
    createClient: () => client as ACPClientCallbacks,
    logger: quiet,
  });
  started.push(acpProcess);
  await acpProcess.start();
  if (session) await acpProcess.newSession(dir, [], session.meta);
  return readFileSync(record, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function clientFor(
  registry: AcpInboundExtensionRegistry,
): Partial<ACPClientCallbacks> {
  const handler = createAcpInboundExtensionRequestHandler({ registry });
  return {
    extMethod: async (method, params) => handler(method, params),
    answersExtensionMethod: (method) => registry.answers(method),
  };
}

const initializeOf = (lines: Array<Record<string, unknown>>) =>
  lines.find((line) => line.method === 'initialize');

describe('client capabilities announced at initialize', () => {
  test('each flag whose handlers answer is announced, and only those', async () => {
    const lines = await launch(clientFor(fullRegistry()));
    expect(initializeOf(lines)?.clientMeta).toEqual({
      kiro: { userInput: true, openExternalUrl: true, secretStorage: true },
    });
  });

  test('removing a handler withdraws its flag; one missing method withdraws a multi-method flag', async () => {
    const registry = fullRegistry();
    registry.unregister('_kiro/userInput');
    registry.unregister(REVIEWED_ENGINE_SECRET_BINDINGS[0]!.methods.delete);
    const lines = await launch(clientFor(registry));
    expect(initializeOf(lines)?.clientMeta).toEqual({
      kiro: { openExternalUrl: true },
    });
  });

  test('with no handler at all, no _meta is announced', async () => {
    const lines = await launch(clientFor(new AcpInboundExtensionRegistry()));
    expect(initializeOf(lines)).toBeDefined();
    expect(initializeOf(lines)).not.toHaveProperty('clientMeta');
  });

  test('elicitation is announced with exactly the modes its handler takes', async () => {
    const handle = async () => ({ action: 'cancel' });
    const both = await launch({
      createElicitation: { modes: { form: true, url: true }, handle },
    });
    expect(initializeOf(both)?.clientElicitation).toEqual({
      form: {},
      url: {},
    });

    const formOnly = await launch({
      createElicitation: { modes: { form: true, url: false }, handle },
    });
    expect(initializeOf(formOnly)?.clientElicitation).toEqual({ form: {} });

    const none = await launch({});
    expect(initializeOf(none)).not.toHaveProperty('clientElicitation');
  });

  test('session/new carries _meta only when given', async () => {
    const meta = {
      kiro: { customAgents: [{ name: 'reviewer', tools: ['*'] }] },
    };
    const withMeta = await launch({}, { meta });
    expect(withMeta.find((line) => line.method === 'session/new')).toEqual({
      method: 'session/new',
      meta,
    });
  });
});
