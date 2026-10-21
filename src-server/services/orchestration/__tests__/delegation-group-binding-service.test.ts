import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { beforeEach, expect, test, vi } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';

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
const fixtureAuthority = (): undefined => undefined;
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
  dir = makeTempDir('station-group-caller-');
  store = new FileDelegationGroupBindingStore(dir);
});

async function reserve() {
  const result = await store.reserve(
    {
      binding,
      operationId: 'operation',
      intentDigest: digest,
    },
    fixtureAuthority,
  );
  if (result.kind !== 'created') throw new Error('No reservation owner');
  return { binding, ownerToken: result.ownerToken, expectedRevision: 1 };
}

test('real physical restriction refuses before model resolution with durable launch intent', async () => {
  const input = await reserve();
  const authorizations: {
    state: string;
    revision: number;
    required: boolean;
  }[] = [];
  const service = new DelegationGroupBindingService(store, {
    async assertCurrent(record) {
      const companion = currentBoundedApiTurnCompanion();
      authorizations.push({
        state: record.state,
        revision: record.revision,
        required: companion !== undefined,
      });
      if (companion) {
        await Promise.resolve();
        expect(currentBoundedApiTurnCompanion()).toBe(companion);
        expect(
          await new FileDelegationGroupBindingStore(dir).findTurn(
            binding.scope,
            'session',
            'client-turn',
          ),
        ).toMatchObject({ state: 'launch-intent' });
      }
      return fixtureAuthority;
    },
  });
  const resolveModel = vi.fn(async () => 'paid result');
  await expect(service.execute(input, resolveModel)).rejects.toMatchObject({
    code: 'bounded_api_execution_unavailable',
    surface: 'delegation-group-binding',
  });
  expect(authorizations).toEqual([
    { state: 'reserved', revision: 1, required: false },
    { state: 'launch-intent', revision: 2, required: true },
  ]);
  expect(resolveModel).not.toHaveBeenCalled();
  expect(currentBoundedApiTurnCompanion()).toBeUndefined();
  expect(() =>
    assertBoundedApiExecutionAvailable('unbound-interactive'),
  ).not.toThrow();
  await expect(service.execute(input, resolveModel)).rejects.toThrow(
    'revision_conflict',
  );
  expect(authorizations).toEqual([
    { state: 'reserved', revision: 1, required: false },
    { state: 'launch-intent', revision: 2, required: true },
    { state: 'launch-intent', revision: 2, required: false },
  ]);
  expect(
    await store.findTurn(binding.scope, 'session', 'client-turn'),
  ).toMatchObject({ state: 'launch-intent', revision: 2 });
  expect(resolveModel).not.toHaveBeenCalled();
});

test('revocation during launch admission retains intent and prevents resolution', async () => {
  const input = await reserve();
  const resolveModel = vi.fn(async () => 'result');
  const service = new DelegationGroupBindingService(store, {
    async assertCurrent(record) {
      if (record.state === 'launch-intent')
        throw new Error('controller revoked');
      return fixtureAuthority;
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

test('request revoked as async authorization returns cannot persist launch intent', async () => {
  const input = await reserve();
  const file = join(dir, 'delegation-group-bindings', 'bindings.json');
  const retained = readFileSync(file, 'utf8');
  const controller = new AbortController();
  const request = new Request('http://station.test/groups/run', {
    signal: controller.signal,
  });
  const resolveModel = vi.fn(async () => 'result');
  const service = new DelegationGroupBindingService(store, {
    async assertCurrent() {
      await Promise.resolve();
      request.signal.throwIfAborted();
      queueMicrotask(() => controller.abort(new Error('request aborted')));
      return (): undefined => {
        request.signal.throwIfAborted();
      };
    },
  });
  await expect(service.execute(input, resolveModel)).rejects.toThrow(
    'request aborted',
  );
  expect(readFileSync(file, 'utf8')).toBe(retained);
  expect(
    await new FileDelegationGroupBindingStore(dir).findTurn(
      binding.scope,
      'session',
      'client-turn',
    ),
  ).toMatchObject({ state: 'reserved', revision: 1 });
  expect(resolveModel).not.toHaveBeenCalled();
});

test('current owner replaced as async execution admission returns is rejected by its finalizer', async () => {
  const input = await reserve();
  const capturedOwner = {};
  let currentOwner = capturedOwner;
  const resolveModel = vi.fn(async () => 'result');
  const service = new DelegationGroupBindingService(store, {
    async assertCurrent(record) {
      await Promise.resolve();
      if (record.state === 'launch-intent')
        queueMicrotask(() => {
          currentOwner = {};
        });
      return (): undefined => {
        if (currentOwner !== capturedOwner) throw new Error('owner replaced');
      };
    },
  });
  await expect(service.execute(input, resolveModel)).rejects.toThrow(
    'owner replaced',
  );
  expect(
    await store.findTurn(binding.scope, 'session', 'client-turn'),
  ).toMatchObject({ state: 'launch-intent', revision: 2 });
  expect(resolveModel).not.toHaveBeenCalled();
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
      return fixtureAuthority;
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
    assertCurrent: async () => fixtureAuthority,
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
    assertCurrent: async () => fixtureAuthority,
  });
  await expect(
    service.consumeStream(input, async () => resolveStream(), consume),
  ).rejects.toMatchObject({ code: 'bounded_api_execution_unavailable' });
  expect(resolveStream).not.toHaveBeenCalled();
  expect(consume).not.toHaveBeenCalled();
});

test.each([
  'rejecting',
  'resolving',
  'scalar',
  'then-getter',
  'current',
] as const)(
  'synchronous finalizer containment survives a child process (%s)',
  (variant) => {
    const child = spawnSync(
      process.execPath,
      [
        '--unhandled-rejections=strict',
        '--import',
        createRequire(import.meta.url).resolve('tsx'),
        '--input-type=module',
        '--eval',
        `const variant = ${JSON.stringify(variant)};
const directory = ${JSON.stringify(dir)};
const moduleUrl = ${JSON.stringify(new URL('../delegation-group-binding-service.ts', import.meta.url).href)};
const binding = ${JSON.stringify(binding)};
const storeUrl = ${JSON.stringify(new URL('../delegation-group-binding-store.ts', import.meta.url).href)};
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { join } from 'node:path';
import { setImmediate as immediate } from 'node:timers/promises';

const makeTempDir = trackTempDirs();
const invalidResult = () => {
  if (variant === 'rejecting') return (async () => {
    await Promise.resolve();
    throw new Error('async authority revoked');
  })();
  if (variant === 'resolving') return Promise.resolve();
  if (variant === 'scalar') return 'invalid authority result';
  if (variant === 'then-getter') return { get then() { throw new Error('then getter revoked'); } };
  return undefined;
};
let refusal;
const { DelegationGroupBindingService } = await import(moduleUrl);
const { FileDelegationGroupBindingStore } = await import(storeUrl);
const store = new FileDelegationGroupBindingStore(directory);
const created = await store.reserve({ binding, operationId: 'containment', intentDigest: binding.authorityDigest }, () => undefined);
assert.equal(created.kind, 'created');
const ledgerDir = join(directory, 'delegation-group-bindings');
const target = join(ledgerDir, 'bindings.json');
let retained;
let finalized = false;
let resolved = false;
const service = new DelegationGroupBindingService(store, {
  async assertCurrent(record) {
    if (record.state === 'reserved') return () => undefined;
    retained = fs.readFileSync(target, 'utf8');
    return () => { finalized = true; return invalidResult(); };
  },
});
try {
  await service.execute({ binding, ownerToken: created.ownerToken, expectedRevision: 1 }, async () => { resolved = true; });
} catch (error) { refusal = error; }
assert.equal(finalized, true);
assert.equal(resolved, false);
assert.equal(refusal?.code, variant === 'current' ? 'bounded_api_execution_unavailable' : 'synchronous_authority_required');
assert.equal(fs.readFileSync(target, 'utf8'), retained);
assert.equal(JSON.parse(retained).records[0].state, 'launch-intent');
assert.deepEqual(fs.readdirSync(ledgerDir), ['bindings.json']);
await immediate();
await immediate();
console.log('finalizer-check-survived');
`,
      ],
      { encoding: 'utf8', windowsHide: true, timeout: 20_000 },
    );
    expect(child.error).toBeUndefined();
    expect(child.status, child.stderr).toBe(0);
    expect(child.stdout).toContain('finalizer-check-survived');
  },
  30_000,
);
