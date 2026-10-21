import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import {
  assertBoundedApiExecutionAvailable,
  currentBoundedApiTurnCompanion,
} from '../../../runtime/conversation/bounded-api-turn-grant.js';
import { DelegationGroupBindingService } from '../delegation-group-binding-service.js';
import {
  type DelegationGroupBinding,
  FileDelegationGroupBindingStore,
} from '../delegation-group-binding-store.js';

let dir: string;
let store: FileDelegationGroupBindingStore;
const digest = `sha256:${'a'.repeat(64)}`;
const binding: DelegationGroupBinding = {
  scope: { hostId: 'host', principalId: 'operator', tenantId: null },
  groupId: 'group',
  seatId: 'seat',
  controllerId: 'controller',
  controllerGeneration: 1,
  authorityId: 'authority',
  authorityEpoch: 1,
  authorityDigest: digest,
  envelopeId: 'envelope',
  envelopeGeneration: 1,
  envelopeDigest: digest,
  taskId: 'task:1',
  conversationId: 'conversation',
  sessionId: 'session',
  clientTurnId: 'client-turn',
  invocationId: 'invocation',
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'station-group-caller-'));
  store = new FileDelegationGroupBindingStore(dir);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

async function reserve() {
  const result = await store.reserve({
    binding,
    operationId: 'operation',
    intentDigest: digest,
  });
  if (result.kind !== 'created') throw new Error('No reservation owner');
  return { binding, ownerToken: result.ownerToken, expectedRevision: 1 };
}

test('real physical restriction refuses before model resolution with durable launch intent', async () => {
  const input = await reserve();
  const currentStates: string[] = [];
  const service = new DelegationGroupBindingService(store, {
    async assertCurrent(record) {
      currentStates.push(record.state);
      if (record.state === 'launch-intent') {
        expect(currentBoundedApiTurnCompanion()).toBeDefined();
        await Promise.resolve();
        expect(currentBoundedApiTurnCompanion()).toBeDefined();
        expect(
          await new FileDelegationGroupBindingStore(dir).findTurn(
            binding.scope,
            'session',
            'client-turn',
          ),
        ).toMatchObject({ state: 'launch-intent' });
      }
    },
  });
  const resolveModel = vi.fn(async () => 'paid result');
  await expect(service.execute(input, resolveModel)).rejects.toMatchObject({
    code: 'bounded_api_execution_unavailable',
    surface: 'delegation-group-binding',
  });
  expect(currentStates).toEqual(['reserved', 'launch-intent']);
  expect(resolveModel).not.toHaveBeenCalled();
  expect(currentBoundedApiTurnCompanion()).toBeUndefined();
  expect(() =>
    assertBoundedApiExecutionAvailable('unbound-interactive'),
  ).not.toThrow();
  await expect(service.execute(input, resolveModel)).rejects.toThrow(
    'revision_conflict',
  );
  expect(resolveModel).not.toHaveBeenCalled();
});

test('revocation during launch admission retains intent and prevents resolution', async () => {
  const input = await reserve();
  const resolveModel = vi.fn(async () => 'result');
  const service = new DelegationGroupBindingService(store, {
    async assertCurrent(record) {
      if (record.state === 'launch-intent')
        throw new Error('controller revoked');
    },
  });
  await expect(service.execute(input, resolveModel)).rejects.toThrow(
    'controller revoked',
  );
  expect(resolveModel).not.toHaveBeenCalled();
  expect(
    await store.findTurn(binding.scope, 'session', 'client-turn'),
  ).toMatchObject({ state: 'launch-intent' });
});

test('caller mutation across authorization cannot retarget the captured launch', async () => {
  const input = await reserve();
  const service = new DelegationGroupBindingService(store, {
    async assertCurrent(record) {
      if (record.state === 'reserved') {
        await Promise.resolve();
        input.binding = { ...binding, clientTurnId: 'mutated-turn' };
        input.ownerToken = 'b'.repeat(64);
        input.expectedRevision = 99;
      }
    },
  });
  const resolveModel = vi.fn(async () => 'result');
  await expect(service.execute(input, resolveModel)).rejects.toMatchObject({
    code: 'bounded_api_execution_unavailable',
  });
  expect(
    await store.findTurn(binding.scope, 'session', 'client-turn'),
  ).toMatchObject({ state: 'launch-intent' });
  expect(
    await store.findTurn(binding.scope, 'session', 'mutated-turn'),
  ).toBeUndefined();
  expect(resolveModel).not.toHaveBeenCalled();
});

test('missing or forged exact binding cannot invoke resolver or claim a launch', async () => {
  const input = await reserve();
  const resolveModel = vi.fn(async () => 'result');
  const service = new DelegationGroupBindingService(store, {
    assertCurrent: async () => {},
  });
  await expect(
    service.execute(
      { ...input, binding: { ...binding, envelopeGeneration: 2 } },
      resolveModel,
    ),
  ).rejects.toThrow('binding_unavailable');
  await expect(
    service.execute(
      { ...input, binding: { ...binding, clientTurnId: 'missing' } },
      resolveModel,
    ),
  ).rejects.toThrow('binding_unavailable');
  expect(resolveModel).not.toHaveBeenCalled();
  expect(
    await store.findTurn(binding.scope, 'session', 'client-turn'),
  ).toMatchObject({ state: 'reserved' });
});

test('stream route refuses before creating a lazy model stream or delivering chunks', async () => {
  const input = await reserve();
  const resolveStream = vi.fn(async function* () {
    yield 'chunk';
  });
  const consume = vi.fn(async (_value: string) => {});
  const service = new DelegationGroupBindingService(store, {
    assertCurrent: async () => {},
  });
  await expect(
    service.consumeStream(input, async () => resolveStream(), consume),
  ).rejects.toMatchObject({ code: 'bounded_api_execution_unavailable' });
  expect(resolveStream).not.toHaveBeenCalled();
  expect(consume).not.toHaveBeenCalled();
});
