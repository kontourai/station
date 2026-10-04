import { MCPLocalConnectionCustody } from '@kontourai/station-shared/mcp';
import { Client } from '@modelcontextprotocol/client';
import { afterEach, expect, test, vi } from 'vitest';
import { stationKnowledgeRuntimeIdentity } from '../../bootstrap/station-control-runtime-env.js';
import { runWithAuthorizedTurnCorrelation } from '../../conversation/authorized-turn-correlation.js';
import { __resetStationControlMcpTokensForTests } from '../station-control-mcp-token.js';
import {
  beginNativeKnowledgeTurn,
  createNativeStationKnowledgeTools,
  startNativeKnowledgeSession,
  stopNativeKnowledgeSession,
} from '../station-knowledge-native-tools.js';

const owners: MCPLocalConnectionCustody[] = [];
afterEach(async () => {
  await stopNativeKnowledgeSession('native-session');
  await Promise.all(owners.splice(0).map((owner) => owner.shutdown()));
  __resetStationControlMcpTokensForTests();
  vi.restoreAllMocks();
});
function fixture() {
  const owner = new MCPLocalConnectionCustody();
  owners.push(owner);
  const definition = {
    id: 'station-knowledge',
    kind: 'mcp' as const,
    transport: 'stdio' as const,
    ...stationKnowledgeRuntimeIdentity(41031),
  };
  const claim = owner.acquire(definition.id, 'managed');
  const native = createNativeStationKnowledgeTools(
    definition,
    41031,
    claim,
    owner,
  );
  startNativeKnowledgeSession('native-session');
  const controller = new AbortController();
  beginNativeKnowledgeTurn('native-session', 'turn-1', controller.signal);
  const invoke = (turnId = 'turn-1') =>
    runWithAuthorizedTurnCorrelation(
      {
        accountId: 'owner',
        sessionId: 'native-session',
        turnId,
        correlationId: 'correlation',
      },
      () =>
        native.tools
          .find((tool) => tool.name === 'list_knowledge_roots')!
          .execute({}),
    );
  return { owner, definition, native, invoke, controller };
}

test('queued and late calls cannot open a connection after stop or use a restarted session', async () => {
  const connect = vi
    .spyOn(Client.prototype, 'connect')
    .mockResolvedValue(undefined);
  const { invoke } = fixture();
  const queued = invoke();
  const stopped = stopNativeKnowledgeSession('native-session');
  await expect(queued).rejects.toThrow('stopped');
  await stopped;
  expect(() => invoke()).toThrow('active authorized session turn');
  startNativeKnowledgeSession('native-session');
  beginNativeKnowledgeTurn(
    'native-session',
    'turn-2',
    new AbortController().signal,
  );
  expect(() => invoke()).toThrow('active authorized session turn');
  expect(connect).not.toHaveBeenCalled();
});

test('stopping during connection prevents the tool call and closes the real client', async () => {
  let connected!: () => void;
  const connecting = new Promise<void>((resolve) => {
    connected = resolve;
  });
  const connect = vi
    .spyOn(Client.prototype, 'connect')
    .mockReturnValue(connecting);
  const call = vi.spyOn(Client.prototype, 'callTool');
  const close = vi
    .spyOn(Client.prototype, 'close')
    .mockResolvedValue(undefined);
  const { invoke } = fixture();
  const pending = invoke();
  await vi.waitFor(() => expect(connect).toHaveBeenCalledTimes(1));
  await stopNativeKnowledgeSession('native-session');
  connected();
  await expect(pending).rejects.toThrow('retired');
  expect(call).not.toHaveBeenCalled();
  expect(close).toHaveBeenCalled();
});

test('repeated registrations share one custodied bridge without retiring published tools', async () => {
  const { owner, definition, native, invoke } = fixture();
  for (let i = 0; i < 300; i++) {
    const claim = owner.acquire(definition.id, 'managed');
    const next = createNativeStationKnowledgeTools(
      definition,
      41031,
      claim,
      owner,
    );
    expect(next.retained).toBe(false);
    expect(next.tools).toBe(native.tools);
    await owner.release(claim);
  }
  expect(owner.inspect().retained).toBe(1);
  expect((await owner.shutdown()).state).toBe('settled');
  expect(() => invoke()).toThrow('stale');
});

test('an interrupted turn cancels the outstanding SDK call and closes its client', async () => {
  vi.spyOn(Client.prototype, 'connect').mockResolvedValue(undefined);
  const close = vi
    .spyOn(Client.prototype, 'close')
    .mockResolvedValue(undefined);
  const call = vi.spyOn(Client.prototype, 'callTool').mockImplementation(
    (_input, options) =>
      new Promise((_resolve, reject) => {
        options?.signal?.addEventListener(
          'abort',
          () => reject(new Error('SDK request aborted')),
          { once: true },
        );
      }),
  );
  const { invoke, controller } = fixture();
  const pending = invoke();
  await vi.waitFor(() => expect(call).toHaveBeenCalledTimes(1));
  controller.abort('interrupted');
  await expect(pending).rejects.toThrow('SDK request aborted');
  expect(close).toHaveBeenCalled();
});
