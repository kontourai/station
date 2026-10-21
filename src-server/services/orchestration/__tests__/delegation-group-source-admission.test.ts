import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  isRuntimeRequestPrincipalCurrent,
  runtimeRequestPrincipalMayAccessHttpRoute,
} from '../../../security/runtime-request-security.js';
import type { TrustedFinalWireOwnerPort } from '../delegation-group-source-admission.js';
import {
  deferred,
  fixture,
  reply,
  sdk,
  selection,
  setup,
  subject,
  tick,
} from './delegation-source-fixtures/sdk.js';

function contains(
  value: unknown,
  needle: string,
  seen = new WeakSet<object>(),
  depth = 0,
): boolean {
  if (typeof value === 'string') return value.includes(needle);
  if (!value || typeof value !== 'object' || depth > 20 || seen.has(value))
    return false;
  seen.add(value);
  for (const key of Reflect.ownKeys(value)) {
    const d = Object.getOwnPropertyDescriptor(value, key);
    if (d && 'value' in d && contains(d.value, needle, seen, depth + 1))
      return true;
  }
  return false;
}
function canonical(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  return `{${Object.entries(v)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, x]) => `${JSON.stringify(k)}:${canonical(x)}`)
    .join(',')}}`;
}

test('F4 final source authorization does not invoke supplied request header callbacks after action check', async () => {
  const f = await fixture();
  const request = f.request('/api/projects/source/file-preview');
  let armed = false,
    reads = 0;
  f.req = request;
  f.context = () => ({
    env: undefined,
    req: {
      raw: request,
      header(name: string) {
        if (armed && ++reads === 8)
          f.environment.devicePairing.setDeviceScope(
            f.paired.device.id,
            ['orchestration:read'],
            { kind: 'local-grant' },
          );
        return request.headers.get(name) ?? undefined;
      },
    },
  });
  let authorizedAtRaw: boolean | undefined;
  const a = await setup(
    'anthropic',
    () => {
      authorizedAtRaw = runtimeRequestPrincipalMayAccessHttpRoute(
        request,
        f.environment,
        { method: 'POST', path: '/api/orchestration/chat' },
      );
      return Promise.resolve(reply('anthropic'));
    },
    f,
  );
  let response: Promise<Response> | undefined;
  let refused = false;
  try {
    armed = true;
    response = a.start();
  } catch {
    refused = true;
  } finally {
    armed = false;
  }
  const finalReads = reads;
  const actual = authorizedAtRaw;
  f.environment.devicePairing.setDeviceScope(
    f.paired.device.id,
    ['orchestration:read', 'orchestration:operate'],
    { kind: 'local-grant' },
  );
  if (response) {
    sdk.deliverSdkResponse(a.owner, a.prepared.sdkHandle, await response);
    await sdk.sdkResultPromise(a.owner, a.prepared.sdkHandle);
  } else sdk.disposeSdkSourceWire(a.owner, a.prepared.sdkHandle);
  await sdk.sdkDisposalPromise(a.owner, a.prepared.sdkHandle);
  assert.notEqual(
    actual,
    false,
    'raw fetch must never start without operate authority',
  );
  assert.equal(
    finalReads,
    0,
    'final authorization must use captured metadata, not caller callbacks',
  );
  assert.equal(refused, false);
});

for (const provider of ['anthropic', 'google'] as const)
  test(`F2 ${provider} SDK rejection is source-free after scope narrowing and disposal ACK`, async () => {
    const f = await fixture();
    const request = f.request('/api/projects/source/file-preview');
    f.req = request;
    f.context = () => ({
      env: undefined,
      req: { raw: request, header: (n) => request.headers.get(n) ?? undefined },
    });
    const a = await setup(
      provider,
      () => Promise.resolve(reply(provider, 503)),
      f,
    );
    const body = JSON.parse(a.wire.body);
    const source =
      provider === 'anthropic'
        ? body.messages[0].content[1].text
        : body.contents[0].parts[1].text;
    const result = sdk.sdkResultPromise(a.owner, a.prepared.sdkHandle);
    sdk.deliverSdkResponse(a.owner, a.prepared.sdkHandle, await a.start());
    f.environment.devicePairing.setDeviceScope(
      f.paired.device.id,
      ['orchestration:read'],
      { kind: 'local-grant' },
    );
    assert.equal(
      isRuntimeRequestPrincipalCurrent(request, f.environment),
      true,
    );
    let failure: unknown;
    try {
      await result;
    } catch (error) {
      failure = error;
    }
    await sdk.sdkDisposalPromise(a.owner, a.prepared.sdkHandle);
    await tick();
    f.environment.devicePairing.setDeviceScope(
      f.paired.device.id,
      ['orchestration:read', 'orchestration:operate'],
      { kind: 'local-grant' },
    );
    assert.ok(failure instanceof Error);
    assert.equal(
      contains(failure, source),
      false,
      'retained SDK rejection must not contain exact source',
    );
    assert.ok('code' in failure);
    assert.equal(failure.code, 'sdk_disclosure_unavailable');
    assert.equal(contains(failure, 'requestBodyValues'), false);
    assert.equal(Object.hasOwn(failure, 'cause'), false);
    assert.equal(Object.hasOwn(failure, 'requestBodyValues'), false);
    await assert.rejects(
      sdk.sdkResultPromise(a.owner, a.prepared.sdkHandle),
      (e) => !contains(e, source),
    );
  });

test('F1 duplicate denial cannot settle or free the original pending HTTP attempt', async () => {
  const raw = deferred<Response>();
  const a = await setup('anthropic', () => raw.promise);
  const first = a.start();
  let disposed = false;
  void sdk.sdkDisposalPromise(a.owner, a.prepared.sdkHandle).then(() => {
    disposed = true;
  });
  assert.throws(a.start);
  await tick();
  const earlyDisposed = disposed;
  const held: object[] = [];
  let refused = false;
  try {
    for (let i = 0; i < 4; i++)
      held.push(
        (await a.f.owner.captureSnapshot(a.f.context(), subject, selection))
          .capability,
      );
  } catch {
    refused = true;
  }
  for (const cap of held) a.f.owner.releaseSnapshot(cap);
  raw.resolve(reply('anthropic'));
  const response = await first;
  if (!earlyDisposed) {
    sdk.deliverSdkResponse(a.owner, a.prepared.sdkHandle, response);
    await sdk.sdkResultPromise(a.owner, a.prepared.sdkHandle);
  }
  await sdk.sdkDisposalPromise(a.owner, a.prepared.sdkHandle);
  await tick();
  assert.equal(a.starts, 1);
  assert.equal(
    earlyDisposed,
    false,
    'duplicate denial must not ACK while first HTTP is pending',
  );
  assert.equal(
    refused,
    true,
    'original pending attempt must retain one of four slots',
  );
});

test('F3 reentrant failed prototype disposal retains its capacity quarantine', async () => {
  const f = await fixture();
  const held: string[] = [];
  let calls = 0;
  for (let i = 0; i < 4; i++) {
    const sealed = await f.owner.captureSnapshot(
      f.context(),
      subject,
      selection,
    );
    const request = {};
    const port: TrustedFinalWireOwnerPort = {
      async prepareSnapshotRequest(actual, input) {
        held.push(input.serialization);
        return {
          request: actual,
          wire: {
            url: 'https://no-network.invalid',
            method: 'POST',
            headers: [],
            body: canonical({
              format: 'station.sealed-source.request.v1',
              instruction: 'R4 hostile disposal',
              source: {
                encoding: 'canonical-json-utf8',
                serialization: input.serialization,
                digest: input.digest,
              },
              tools: [],
              filesystem: 'none',
              cwd: null,
            }),
          },
          assertCurrentSync: () => undefined,
          consumeExactSync: () => undefined,
          disposeSync() {
            calls++;
            f.owner.releaseSnapshot(sealed.capability);
            throw Error('owned disposal negative ACK');
          },
        };
      },
    };
    await f.owner.prepareSnapshot(
      f.context(),
      subject,
      sealed.capability,
      port,
      request,
    );
    assert.throws(
      () => f.owner.releaseSnapshot(sealed.capability),
      /negative ACK/,
    );
  }
  assert.equal(calls, 4);
  assert.equal(held.length, 4);
  await assert.rejects(
    () => f.owner.captureSnapshot(f.context(), subject, selection),
    (e) =>
      e instanceof Error &&
      'code' in e &&
      e.code === 'snapshot_capacity_exceeded',
  );
});

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

test('F2 retained disposed SDK handles contain zero exact source bytes across fourteen distinct large failures', async () => {
  const f = await fixture();
  const retained: Array<{
    owner: object;
    handle: object;
    result: ReturnType<typeof sdk.sdkResultPromise>;
    source: string;
  }> = [];
  for (let i = 0; i < 14; i++) {
    writeFileSync(join(f.repo, 'source.txt'), Buffer.alloc(720 * 1024, 65 + i));
    await f.git('add', 'source.txt');
    await f.git('commit', '-qm', `R4 distinct source ${i}`);
    const a = await setup(
      'anthropic',
      () => Promise.resolve(reply('anthropic', 503)),
      f,
    );
    const source: string = JSON.parse(a.wire.body).messages[0].content[1].text;
    const result = sdk.sdkResultPromise(a.owner, a.prepared.sdkHandle);
    sdk.deliverSdkResponse(a.owner, a.prepared.sdkHandle, await a.start());
    await assert.rejects(result, (e) => !contains(e, source));
    await sdk.sdkDisposalPromise(a.owner, a.prepared.sdkHandle);
    await tick();
    retained.push({
      owner: a.owner,
      handle: a.prepared.sdkHandle,
      result,
      source,
    });
  }
  const processedBytes = retained.reduce(
    (n, r) => n + Buffer.byteLength(r.source),
    0,
  );
  assert.ok(processedBytes > 12 * 1024 * 1024);
  for (const r of retained) {
    assert.equal(sdk.sdkResultPromise(r.owner, r.handle), r.result);
    await assert.rejects(
      r.result,
      (e) =>
        e instanceof Error &&
        !contains(e, r.source) &&
        !Object.hasOwn(e, 'requestBodyValues') &&
        !Object.hasOwn(e, 'cause'),
    );
  }
  const fresh = await f.owner.captureSnapshot(f.context(), subject, selection);
  f.owner.releaseSnapshot(fresh.capability);
});

test.each(['throw', 'reject', 'throw-owned-error'] as const)(
  'F2 raw transport %s exposes bounded source-free errors',
  async (variant) => {
    let rawBody = '';
    const a = await setup('anthropic', (_input, init) => {
      rawBody = String(init?.body);
      const error = Object.assign(new Error(rawBody), {
        prompt: rawBody,
        headers: init?.headers,
        cause: new Error(rawBody),
      });
      if (variant === 'throw') throw error;
      if (variant === 'throw-owned-error')
        throw new sdk.SdkSourceRefusal(rawBody);
      return Promise.reject(error);
    });
    const result = sdk.sdkResultPromise(a.owner, a.prepared.sdkHandle);
    let failure: unknown;
    try {
      await a.start();
    } catch (error) {
      failure = error;
    }
    assert.ok(failure instanceof Error);
    assert.equal(contains(failure, rawBody), false);
    assert.ok(failure.message.length < 128);
    assert.equal(Object.hasOwn(failure, 'cause'), false);
    await assert.rejects(result, (e) => !contains(e, rawBody));
    await sdk.sdkDisposalPromise(a.owner, a.prepared.sdkHandle);
  },
);

test.each(['consume-throw', 'async'] as const)(
  'F3 %s disposal retains its reservation',
  async (variant) => {
    const f = await fixture();
    let calls = 0;
    for (let i = 0; i < 4; i++) {
      const sealed = await f.owner.captureSnapshot(
        f.context(),
        subject,
        selection,
      );
      const request = {};
      const port = {
        async prepareSnapshotRequest(
          actual: object,
          input: { serialization: string; digest: string },
        ) {
          return {
            request: actual,
            wire: {
              url: 'https://no-network.invalid',
              method: 'POST' as const,
              headers: [],
              body: canonical({
                format: 'station.sealed-source.request.v1',
                instruction: 'consume disposal',
                source: {
                  encoding: 'canonical-json-utf8',
                  serialization: input.serialization,
                  digest: input.digest,
                },
                tools: [],
                filesystem: 'none',
                cwd: null,
              }),
            },
            assertCurrentSync: () => undefined,
            consumeExactSync(input: { assertCurrentSync(): undefined }) {
              input.assertCurrentSync();
              return undefined;
            },
            disposeSync() {
              calls++;
              f.owner.releaseSnapshot(sealed.capability);
              if (variant === 'async')
                return Promise.reject(Error('asynchronous negative ACK'));
              throw Error('consume negative ACK');
            },
          };
        },
      };
      const prepared = await f.owner.prepareSnapshot(
        f.context(),
        subject,
        sealed.capability,
        port,
        request,
      );
      assert.throws(() =>
        f.owner.consumeSnapshotSync(
          f.context(),
          subject,
          prepared.capability,
          request,
        ),
      );
      f.owner.releaseSnapshot(sealed.capability);
    }
    await tick();
    assert.equal(calls, 4);
    await assert.rejects(
      () => f.owner.captureSnapshot(f.context(), subject, selection),
      (e) =>
        e instanceof Error &&
        'code' in e &&
        e.code === 'snapshot_capacity_exceeded',
    );
  },
);
