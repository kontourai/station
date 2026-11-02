import assert from 'node:assert/strict';
import {
  cpSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import {
  cancelRun,
  claimReadyStep,
  flowRuntimeRoot,
  pauseRun,
  releaseStepClaim,
  renewStepClaim,
  resumeRun,
  startRun,
  withRunMutationLock,
} from '@kontourai/flow';
import { test } from 'vitest';
import {
  isRuntimeRequestPrincipalCurrent,
  runtimeRequestPrincipalMayAccessHttpRoute,
} from '../../../security/runtime-request-security.js';
import { HomeWriterOwner } from '../../ssh/home-writer-owner.js';
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

test('fresh sealed source captures preserve one physical execution slot without sharing source or member identities', async () => {
  const f = await fixture();
  const first = await f.owner.captureSnapshot(f.context(), subject, selection);
  f.owner.releaseSnapshot(first.capability);
  writeFileSync(
    join(f.repo, 'source.txt'),
    'source after explicit operator change\n',
  );
  await f.git('add', '--', 'source.txt');
  await f.git('commit', '-qm', 'operator source update');
  const changed = await f.owner.captureSnapshot(
    f.context(),
    subject,
    selection,
  );
  try {
    assert.equal(
      changed.source.execution_worktree_id,
      first.source.execution_worktree_id,
    );
    assert.notEqual(
      changed.source.source_state_id,
      first.source.source_state_id,
    );
    assert.notEqual(
      changed.source.source_admission_receipt.id,
      first.source.source_admission_receipt.id,
    );
    assert.notEqual(
      changed.source.source_admission_receipt.digest,
      first.source.source_admission_receipt.digest,
    );
    const otherMember = await f.owner.captureSnapshot(
      f.context(),
      { ...subject, workItemId: 'child-2' },
      selection,
    );
    try {
      assert.notEqual(
        otherMember.source.execution_worktree_id,
        changed.source.execution_worktree_id,
      );
    } finally {
      f.owner.releaseSnapshot(otherMember.capability);
    }
    const otherGroup = await f.owner.captureSnapshot(
      f.context(),
      { ...subject, groupId: 'group-other' },
      selection,
    );
    try {
      assert.notEqual(
        otherGroup.source.execution_worktree_id,
        changed.source.execution_worktree_id,
      );
    } finally {
      f.owner.releaseSnapshot(otherGroup.capability);
    }
  } finally {
    f.owner.releaseSnapshot(changed.capability);
  }
  const replaced = `${f.repo}-original`;
  renameSync(f.repo, replaced);
  mkdirSync(f.repo, { mode: 0o700 });
  cpSync(join(replaced, 'source.txt'), join(f.repo, 'source.txt'));
  renameSync(join(replaced, '.git'), join(f.repo, '.git'));
  const replacement = await f.owner.captureSnapshot(
    f.context(),
    subject,
    selection,
  );
  try {
    assert.notEqual(
      replacement.source.execution_worktree_id,
      changed.source.execution_worktree_id,
    );
    assert.equal(
      replacement.source.repository_id,
      changed.source.repository_id,
    );
  } finally {
    f.owner.releaseSnapshot(replacement.capability);
  }
});

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
    const retire = f.owner.prepareSnapshotRetirement(sealed.capability);
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
    await assert.rejects(retire, { code: 'snapshot_disposal_unconfirmed' });
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

test('sealed source supports real generated Flow state without disclosing it or ignoring other files', async () => {
  const f = await fixture();
  mkdirSync(join(f.repo, '.flow'));
  const definitionPath = join(f.repo, '.flow', 'report.json');
  writeFileSync(
    definitionPath,
    JSON.stringify({
      id: 'report-flow',
      version: '1',
      steps: [{ id: 'report', next: null }],
      gates: {
        report: {
          step: 'report',
          expects: [
            {
              id: 'report',
              kind: 'trust.bundle',
              required: true,
              description: 'A separate reviewer owns acceptance.',
              bundle_claim: {
                claimType: 'quality.report',
                accepted_statuses: ['assumed'],
              },
            },
          ],
        },
      },
    }),
  );
  writeFileSync(join(f.repo, '.gitignore'), '.kontourai/\n');
  await f.git('add', '.flow/report.json', '.gitignore');
  await f.git('commit', '-qm', 'tracked Flow definition');
  const secret = 'FLOW_RUNTIME_PRIVATE_MARKER_3178';
  const run = await startRun(definitionPath, {
    cwd: f.repo,
    runId: 'source-flow',
    params: { secret },
  });
  assert.ok(readFileSync(join(run.dir, 'state.json'), 'utf8').includes(secret));
  const before = await f.owner.admitSource(f.context(), subject, selection);
  await pauseRun(run.runId, {
    cwd: f.repo,
    reason: 'Owned lifecycle probe',
    authority: {
      kind: 'operator_request',
      actor: 'owned-fixture',
      request_ref: 'source-flow-pause',
      requested_at: new Date().toISOString(),
    },
  });
  const after = await f.owner.admitSource(f.context(), subject, selection);
  assert.equal(after.source_state_id, before.source_state_id);
  const a = await setup(
    'anthropic',
    () => Promise.resolve(reply('anthropic')),
    f,
  );
  try {
    assert.ok(a.wire.body.includes('source.txt'));
    assert.ok(
      !a.wire.body.includes('.kontourai/flow/runs/source-flow/state.json'),
    );
    assert.ok(!a.wire.body.includes(secret));
  } finally {
    sdk.disposeSdkSourceWire(a.owner, a.prepared.sdkHandle);
    await sdk.sdkDisposalPromise(a.owner, a.prepared.sdkHandle);
  }
  const other = join(f.repo, '.kontourai', 'unrelated.txt');
  writeFileSync(other, 'must not disappear from source admission');
  await assert.rejects(
    () => f.owner.admitSource(f.context(), subject, selection),
    { code: 'untracked_source_unsupported' },
  );
  rmSync(other);
  const runtimeRoot = flowRuntimeRoot(f.repo);
  const retained = join(f.root, 'retained-flow-runtime');
  renameSync(runtimeRoot, retained);
  symlinkSync(retained, runtimeRoot, 'dir');
  try {
    await assert.rejects(() =>
      f.owner.admitSource(f.context(), subject, selection),
    );
  } finally {
    rmSync(runtimeRoot);
    renameSync(retained, runtimeRoot);
  }
  await f.git(
    'add',
    '-f',
    '--',
    '.kontourai/flow/runs/source-flow/definition.json',
  );
  await f.git(
    'commit',
    '-qm',
    'tracked runtime file is not generated source exclusion',
  );
  await assert.rejects(
    () => f.owner.admitSource(f.context(), subject, selection),
    { code: 'tracked_flow_runtime_unsupported' },
  );
});

test('source-owned Flow launch admits a renewed active claim and refuses removed, rebound and paused claims', async () => {
  const f = await fixture();
  mkdirSync(join(f.repo, '.flow'));
  const definitionPath = join(f.repo, '.flow', 'report.json');
  writeFileSync(
    definitionPath,
    JSON.stringify({
      id: 'report-flow',
      version: '1',
      execution: { mode: 'multi-cursor', claim_contract_version: '1' },
      steps: [{ id: 'report', next: null, mutable_resources: [] }],
      gates: {
        report: {
          step: 'report',
          expects: [
            {
              id: 'report',
              kind: 'trust.bundle',
              required: true,
              description: 'Separate evidence owns acceptance.',
              bundle_claim: {
                claimType: 'quality.report',
                accepted_statuses: ['assumed'],
              },
            },
          ],
        },
      },
    }),
  );
  writeFileSync(join(f.repo, '.gitignore'), '.kontourai/\n');
  await f.git('add', '.flow/report.json', '.gitignore');
  await f.git('commit', '-qm', 'real multi-cursor Flow');
  const run = await startRun(definitionPath, {
    cwd: f.repo,
    runId: 'launch-flow',
  });
  const sealed = await f.owner.captureSnapshot(f.context(), subject, selection);
  const flow = await f.owner.prepareFlowSnapshot(
    f.context(),
    subject,
    sealed.capability,
    run.runId,
  );
  const claimed = await claimReadyStep(run.runId, {
    cwd: f.repo,
    step_id: 'report',
    claim_id: 'claim-1',
    liveness_id: 'live-1',
    actor: flow.topology.actor,
    lease_seconds: 30,
  });
  await renewStepClaim(run.runId, {
    cwd: f.repo,
    claim_id: claimed.claim.claim_id,
    liveness_id: claimed.claim.liveness_id,
    actor: flow.topology.actor,
    lease_seconds: 60,
  });
  let launches = 0;
  const pending = deferred<Response>();
  const homeOwner = await HomeWriterOwner.forHome(f.home);
  const heldHome = await homeOwner.acquire();
  try {
    const scoped = await flow.withCurrentClaim(
      claimed.claim,
      () => {
        assert.throws(
          () => homeOwner.runSynchronous(() => undefined),
          { name: 'HomeWriterUnavailableError', reason: 'busy' },
          'Flow launch cannot lend its home authority to the callback',
        );
        homeOwner.runWithLease(heldHome, () => homeOwner.assertSynchronous());
        return { value: 'scoped' };
      },
      { owner: homeOwner, lease: heldHome },
    );
    assert.equal(scoped.value, 'scoped');
  } finally {
    await heldHome.release();
  }
  await assert.rejects(
    flow.withCurrentClaim(claimed.claim, () => ({ value: ++launches }), {
      owner: homeOwner,
      lease: heldHome,
    }),
  );
  const foreignHome = join(f.root, 'foreign-flow-home');
  mkdirSync(join(foreignHome, 'security'), { recursive: true, mode: 0o700 });
  const foreignOwner = await HomeWriterOwner.forHome(foreignHome);
  const foreignLease = await foreignOwner.acquire();
  try {
    await assert.rejects(
      flow.withCurrentClaim(claimed.claim, () => ({ value: ++launches }), {
        owner: foreignOwner,
        lease: foreignLease,
      }),
      { code: 'flow_home_mismatch' },
    );
  } finally {
    await foreignLease.release();
  }
  assert.equal(launches, 0);
  const launched = await flow.withCurrentClaim(claimed.claim, () => ({
    value: { response: pending.promise, count: ++launches },
  }));
  assert.equal(launched.value.count, 1);
  // A pending provider response must not hold the Flow mutation lock.
  await withRunMutationLock(run.runId, f.repo, async () => undefined);
  await assert.rejects(
    flow.withCurrentClaim({ ...claimed.claim, liveness_id: 'foreign' }, () => ({
      value: ++launches,
    })),
  );
  await releaseStepClaim(run.runId, {
    cwd: f.repo,
    claim_id: claimed.claim.claim_id,
    liveness_id: claimed.claim.liveness_id,
    actor: flow.topology.actor,
  });
  await assert.rejects(
    flow.withCurrentClaim(claimed.claim, () => ({ value: ++launches })),
    /flow_active_claim_unavailable/,
  );
  const replacement = await claimReadyStep(run.runId, {
    cwd: f.repo,
    step_id: 'report',
    claim_id: 'claim-2',
    liveness_id: 'live-2',
    actor: flow.topology.actor,
  });
  await pauseRun(run.runId, {
    cwd: f.repo,
    reason: 'Owned final-effect control',
    authority: {
      kind: 'operator_request',
      actor: flow.topology.actor.key,
      request_ref: 'pause-before-effect',
      requested_at: new Date().toISOString(),
    },
  });
  await assert.rejects(
    flow.withCurrentClaim(replacement.claim, () => ({ value: ++launches })),
    /run_paused/,
  );
  await resumeRun(run.runId, {
    cwd: f.repo,
    reason: 'Owned cancellation control',
    authority: {
      kind: 'operator_request',
      actor: flow.topology.actor.key,
      request_ref: 'resume-before-cancel',
      requested_at: new Date().toISOString(),
    },
  });
  await cancelRun(run.runId, {
    cwd: f.repo,
    reason: 'Owned final-effect cancellation control',
    authority: {
      kind: 'operator_request',
      actor: flow.topology.actor.key,
      request_ref: 'cancel-before-effect',
      requested_at: new Date().toISOString(),
    },
  });
  await assert.rejects(
    flow.withCurrentClaim(replacement.claim, () => ({ value: ++launches })),
    /run_canceled/,
  );
  assert.equal(launches, 1);
  pending.resolve(new Response('controlled'));
  await launched.value.response;
  f.owner.releaseSnapshot(sealed.capability);
});
