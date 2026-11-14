import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { FileAuthorizationLedger } from '@kontourai/dispatch';
import { createDelegationAuthorityServiceV3 } from '@kontourai/flow-agents/delegation-authority-service-v3';
import { canonicalJson } from '@kontourai/relay';
import { test, vi } from 'vitest';
import { StationAgentAdapter } from '../../../providers/adapters/station-agent-adapter.js';
import { AnthropicSealedPreparation } from '../../../runtime/conversation/anthropic-sealed-preparation.js';
import {
  captureEnvironmentLocalGrantObservationOwner,
  captureEnvironmentLocalGrantReadOwner,
} from '../../../runtime/conversation/local-grant-observation-owner.js';
import * as observedCredentials from '../../../runtime/conversation/provider-credential-observation.js';
import { RuntimeFencedCredentialObservationOwner } from '../../../runtime/conversation/runtime-fenced-credential-observation.js';
import { StationDelegationPersistence } from '../delegation-group-persistence.js';
import {
  createPreparedSdkSourceWireOwner,
  disposeSdkSourceWire,
  inspectSdkSourceWire,
  sdkDisposalPromise,
} from '../delegation-group-sdk-source-wire-owner.js';
import { validateReportIntent } from '../station-report-group-admission.js';
import { signReportInterrupt } from '../station-report-group-cancellation.js';
import { StationReportGroupCustody } from '../station-report-group-custody.js';
import {
  type PreparedStationReportGroup,
  StationReportGroupPreparation,
} from '../station-report-group-preparation.js';
import { createReportFlow } from './delegation-source-fixtures/flow.js';
import {
  installControl,
  newGrant,
  requestFor,
  setup,
} from './delegation-source-fixtures/report.js';
import { taskDriver } from './delegation-source-fixtures/report-task-driver.js';

test('authenticated preparation issues exact source/task envelopes consumed by the published durable v3 authority', async () => {
  const h = await setup();
  const handle = await h.owner.prepare(h.f.context(), h.input);
  try {
    const prepared = h.owner.read(handle, h.f.req);
    assert.equal(prepared.root.issuer_host_id, h.f.record.environmentId);
    assert.equal(prepared.root.budget.max_attempts, h.input.members.length);
    assert.equal(
      prepared.envelopes[1].execution_binding.runtime.runtime_receipt_ref
        .domain,
      'station.sealed-sdk.runtime.v1',
    );
    assert.ok(
      prepared.envelopes.slice(1).every((e) => e.budget.max_attempts === 1),
    );
    assert.deepEqual(prepared.root.delegation_ceiling.allowed_effects, [
      'report',
    ]);
    assert.equal(prepared.spec.policy.maxSyncs, undefined);
    assert.equal(prepared.spec.policy.maxRenewals, undefined);
    assert.equal(
      prepared.root.authenticated_principal_ref.id,
      'human:local:operator',
    );
    assert.equal(prepared.envelopes.length, 3);
    assert.equal(prepared.members.length, 2);
    assert.equal(new Set(prepared.members.map((m) => m.taskId)).size, 2);
    for (const member of prepared.members)
      assert.match(member.taskId, /^task:[0-9a-f-]{36}$/);
    assert.deepEqual(
      prepared.spec.seats.map((s) => s.allocation),
      [
        { inputTokens: 1048576, outputTokens: 10, costMicros: 3145878 },
        { inputTokens: 1048576, outputTokens: 10, costMicros: 3145878 },
      ],
    );
    assert.ok(!JSON.stringify(prepared).includes('synthetic-not-a-live-key'));
    const persistence = new StationDelegationPersistence(
      join(h.f.home, 'report-groups'),
    );
    const current = (): undefined => {
      h.owner.read(handle, h.f.req);
      return undefined;
    };
    const service = createDelegationAuthorityServiceV3(
      persistence.roundsAuthorityStore(current),
      {
        now: () => new Date(Date.now()).toISOString(),
        authorize: async (_action, root, envelope) =>
          h.owner.authorizes(handle, h.f.req, root, envelope),
        confirmExecution: async (envelope) =>
          h.owner.confirmsExecution(handle, h.f.req, envelope),
        authenticateRenewal: async () => null,
      },
      { maxRenewals: 0 },
    );
    await service.issue(prepared.root);
    for (const envelope of prepared.envelopes)
      await service.derive(prepared.root.authority_id, envelope);
    await service.reserveInvocation(
      prepared.root.authority_id,
      prepared.envelopes[1].envelope_id,
      'first-reservation',
      prepared.spec.seats[0].allocation,
    );
    const ledger = await service.inspect(prepared.root.authority_id);
    assert.equal(ledger.envelopes.length, 3);
    assert.equal(ledger.invocations.length, 1);
    assert.equal(ledger.invocations[0].usage, null);
    assert.equal(ledger.invocations[0].terminal, false);
    assert.equal(h.rawFetch.mock.calls.length, 0);
    const changed = structuredClone(prepared.root);
    changed.budget.max_cost_micros++;
    assert.equal(h.owner.authorizes(handle, h.f.req, changed, null), false);
    prepared.root.budget.max_cost_micros = 0;
    assert.equal(
      h.owner.read(handle, h.f.req).root.budget.max_cost_micros,
      6291756,
    );
  } finally {
    h.owner.close(handle);
  }
});

test('same Request and intent joins one preparation; changed intent, foreign Request and copied capability refuse', async () => {
  const h = await setup();
  const [a, b] = await Promise.all([
    h.owner.prepare(h.f.context(), h.input),
    h.owner.prepare(h.f.context(), h.input),
  ]);
  try {
    assert.equal(a, b);
    await assert.rejects(() =>
      h.owner.prepare(h.f.context(), { ...h.input, maxConcurrent: 1 }),
    );
    await assert.rejects(() =>
      h.owner.prepare(h.f.context(h.f.request()), h.input),
    );
    assert.throws(() => h.owner.read(JSON.parse('{}'), h.f.req));
    assert.equal(h.rawFetch.mock.calls.length, 0);
  } finally {
    h.owner.close(a);
  }
});

test('snapshot receipt deletion refuses execution confirmation without inventing stopped work', async () => {
  const h = await setup();
  const handle = await h.owner.prepare(h.f.context(), h.input);
  try {
    const prepared = h.owner.read(handle, h.f.req);
    const envelope = prepared.envelopes[1];
    assert.equal(h.owner.confirmsExecution(handle, h.f.req, envelope), true);
    unlinkSync(
      join(
        h.f.store,
        `snapshot-${envelope.execution_binding.source.source_admission_receipt.id}.json`,
      ),
    );
    assert.throws(() => h.owner.confirmsExecution(handle, h.f.req, envelope));
    assert.equal(h.rawFetch.mock.calls.length, 0);
  } finally {
    h.owner.close(handle);
  }
});

test('aggregate operator budget too small for the immutable roster refuses before any provider request', async () => {
  const h = await setup();
  await assert.rejects(() =>
    h.owner.prepare(h.f.context(), {
      ...h.input,
      budget: { inputTokens: 1048576, outputTokens: 10, costMicros: 3145878 },
    }),
  );
  assert.equal(h.rawFetch.mock.calls.length, 0);
});

test('bootstrap credentials cannot issue an operator report root', async () => {
  const h = await setup('ui-bootstrap');
  await assert.rejects(() => h.owner.prepare(h.f.context(), h.input));
  assert.equal(h.rawFetch.mock.calls.length, 0);
});

test('current operator revocation invalidates the prepared root and reserved member access', async () => {
  const h = await setup();
  let handle: PreparedStationReportGroup | undefined;
  try {
    handle = await h.owner.prepare(h.f.context(), h.input);
    assert.equal(h.owner.read(handle, h.f.req).members.length, 2);
    h.f.environment.devicePairing.revokeDevice(
      h.f.paired.device.id,
      'operator-credential',
    );
    assert.throws(() => h.owner.read(handle!, h.f.req));
    assert.throws(() => h.owner.sdk(handle!, h.f.req, 'left'));
    assert.equal(h.rawFetch.mock.calls.length, 0);
  } finally {
    if (handle) h.owner.close(handle);
  }
});

test.each(['abort', 'deadline', 'close'] as const)(
  'prepared reads refuse %s reached during their final credential check',
  async (fault) => {
    const h = await setup();
    const abort = new AbortController();
    const request = h.f.request('/api/orchestration/chat', {
      signal: abort.signal,
    });
    const input = {
      ...h.input,
      maxConcurrent: 1,
      members: h.input.members.slice(0, 1),
    };
    const handle = await h.owner.prepare(h.f.context(request), input);
    const clock = Date.now();
    const read = observedCredentials.readObservedSdkProviderCredential;
    let faultApplied = false;
    let reads = 0;
    try {
      assert.equal(h.owner.read(handle, request).members.length, 1);
      const observed = vi
        .spyOn(observedCredentials, 'readObservedSdkProviderCredential')
        .mockImplementation((...args) => {
          const value = read(...args);
          reads++;
          if (!faultApplied) {
            faultApplied = true;
            if (fault === 'abort')
              abort.abort(new Error('controlled report read abort'));
            else if (fault === 'deadline')
              vi.mocked(Date.now).mockReturnValue(input.deadlineAt);
            else h.owner.close(handle);
          }
          return value;
        });
      try {
        assert.throws(() => h.owner.read(handle, request), {
          code: 'group_preparation_unavailable',
        });
        assert.equal(
          faultApplied,
          true,
          'the real credential check must reach its controlled bound-state change',
        );
        assert.equal(
          reads,
          1,
          'one participating credential is read before the closing bound-state check',
        );
        assert.equal(h.rawFetch.mock.calls.length, 0);
      } finally {
        observed.mockRestore();
      }
    } finally {
      vi.mocked(Date.now).mockReturnValue(clock);
      h.owner.close(handle);
    }
  },
);

test('issued preparation reaches canonical delegated-task dispatch and retained accounting without synthetic root grants', async () => {
  const h = await setup();
  installControl(h);
  const input = {
    ...h.input,
    maxConcurrent: 1,
    members: h.input.members.slice(0, 1),
  };
  const handle = await h.owner.prepare(h.f.context(), input);
  const groupId = await h.custody.retain(h.f.context(), h.owner, handle);
  const before = await h.custody.findOperation(
    h.f.context(requestFor(h)),
    input.operationId,
  );
  assert.ok(before);
  assert.equal(before.group, null);
  assert.equal(before.authority, null);
  try {
    const { prepared, sdk, driver } = await taskDriver(h, handle);
    assert.equal(h.rawFetch.mock.calls.length, 0);
    assert.equal(
      await h.custody.inspectDelivery(
        h.f.context(requestFor(h)),
        groupId,
        'left',
        driver.orchestration,
      ),
      null,
    );
    await driver.run();
    assert.equal(
      h.rawFetch.mock.calls.length,
      1,
      String(driver.invocationFailure),
    );
    assert.equal(driver.relayCalls, 0);
    assert.equal(driver.task?.taskId, prepared.members[0].taskId);
    assert.ok(driver.task?.initialTurnId);
    const task = await driver.taskSnapshot();
    assert.equal(task.taskId, prepared.members[0].taskId);
    assert.equal(task.status, 'completed');
    await assert.rejects(() => driver.repeatTaskDispatch());
    assert.equal(h.rawFetch.mock.calls.length, 1);
    const ledger = await driver.ledger();
    assert.equal(ledger.root.authority_id, prepared.root.authority_id);
    assert.equal(ledger.envelopes[1].execution_id, prepared.members[0].taskId);
    assert.deepEqual(ledger.invocations[0].usage, {
      inputTokens: 4,
      outputTokens: 2,
      costMicros: 42,
    });
    assert.ok(
      driver.canonicalEvents().some((e) => e.method === 'turn.completed'),
    );
    await sdkDisposalPromise(sdk.owner, sdk.sdkHandle);
    h.owner.close(handle);
    const admissionFile = join(
      h.f.home,
      'report-groups',
      'station-report-admissions-v1',
      `${createHash('sha256').update(groupId).digest('hex')}.json`,
    );
    const admissionBytes = readFileSync(admissionFile);
    unlinkSync(admissionFile);
    const resealer = new StationReportGroupPreparation(h.preparationOwners);
    const returning = newGrant(h);
    const retryContext = h.f.context(
      requestFor(h, 'POST', returning.credential),
    );
    const retry = await resealer.prepare(retryContext, input);
    try {
      assert.equal(
        resealer.read(retry, retryContext.req.raw).spec.groupId,
        groupId,
      );
      await assert.rejects(
        () => h.custody.retain(retryContext, resealer, retry),
        {
          code: 'report_admission_execution_conflict',
        },
      );
      assert.equal(h.rawFetch.mock.calls.length, 1);
    } finally {
      resealer.close(retry);
      writeFileSync(admissionFile, admissionBytes, { mode: 0o600 });
    }
    vi.mocked(Date.now).mockReturnValue(Date.parse('2026-11-14T08:18:01Z'));
    await assert.rejects(() => AnthropicSealedPreparation.create(), {
      code: 'stale_contract',
    });
    const current = newGrant(h);
    const reader = new StationReportGroupCustody(h.custodyOwners);
    const historical = await reader.findOperation(
      h.f.context(requestFor(h, 'GET', current.credential)),
      input.operationId,
    );
    assert.ok(historical?.group && historical.authority);
    assert.equal(historical.admission.spec.groupId, groupId);
    assert.equal(
      historical.admission.members[0].reservedTaskId,
      prepared.members[0].taskId,
    );
    assert.equal(
      historical.admission.members[0].requestedModelId,
      prepared.members[0].modelId,
    );
    assert.deepEqual(historical.authority.invocations[0].usage, {
      inputTokens: 4,
      outputTokens: 2,
      costMicros: 42,
    });
    assert.equal(historical.group.attempts.length, 1);
    const delivery = await reader.inspectDelivery(
      h.f.context(requestFor(h, 'GET', current.credential)),
      groupId,
      'left',
      driver.orchestration,
    );
    assert.deepEqual(delivery, {
      seatId: 'left',
      taskId: prepared.members[0].taskId,
      outcome: 'started',
      sessionId: driver.task.sessionId,
      turnId: driver.task.initialTurnId,
    });
    const lookup = vi
      .spyOn(driver.orchestration, 'inspectTurnDelivery')
      .mockReturnValue({
        outcome: 'started',
        sessionId: 'foreign-successor-session',
        turnId: driver.task.initialTurnId,
      });
    await assert.rejects(
      () =>
        reader.inspectDelivery(
          h.f.context(requestFor(h, 'GET', current.credential)),
          groupId,
          'left',
          driver.orchestration,
        ),
      { code: 'group_custody_unavailable' },
    );
    lookup.mockRestore();
    h.f.environment.devicePairing.setDeviceScope(
      current.device.id,
      ['orchestration:read'],
      { kind: 'presented-credential' },
    );
    await assert.rejects(() =>
      reader.revokeExecutionAuthority(
        h.f.context(requestFor(h, 'POST', current.credential)),
        groupId,
      ),
    );
    const stillActive = await reader.inspect(
      h.f.context(requestFor(h, 'GET', current.credential)),
      groupId,
    );
    assert.equal(stillActive?.authority?.cancelled, false);
    h.f.environment.devicePairing.setDeviceScope(
      current.device.id,
      ['orchestration:read', 'orchestration:operate'],
      { kind: 'presented-credential' },
    );
    const revoked = await reader.revokeExecutionAuthority(
      h.f.context(requestFor(h, 'POST', current.credential)),
      groupId,
    );
    assert.equal(revoked.authority.cancelled, true);
    assert.deepEqual(
      revoked.authority.invocations,
      historical.authority.invocations,
    );
    assert.equal(revoked.group?.cancellation, 'none');
    const repeated = await reader.revokeExecutionAuthority(
      h.f.context(requestFor(h, 'POST', current.credential)),
      groupId,
    );
    assert.deepEqual(
      repeated.authority.invocations,
      historical.authority.invocations,
    );
    const dispatch = vi.spyOn(driver.orchestration, 'dispatchWithReceipt');
    const interrupted = await reader.requestMemberInterrupt(
      h.f.context(requestFor(h, 'POST', current.credential)),
      groupId,
      'left',
      'cancel-left',
      driver.orchestration,
    );
    assert.equal(interrupted.replayed, false);
    assert.equal(interrupted.record.intent.turnId, driver.task.initialTurnId);
    assert.equal(interrupted.record.intent.sessionId, driver.task.sessionId);
    assert.ok(interrupted.record.acknowledgement);
    assert.ok(interrupted.reference);
    assert.equal(
      dispatch.mock.calls.filter(
        ([command]) => command.type === 'interruptTurn',
      ).length,
      1,
    );
    const reconnected = new StationReportGroupCustody(h.custodyOwners);
    const replay = await reconnected.requestMemberInterrupt(
      h.f.context(requestFor(h, 'POST', current.credential)),
      groupId,
      'left',
      'cancel-left',
      driver.orchestration,
    );
    assert.equal(replay.replayed, true);
    assert.deepEqual(replay.record, interrupted.record);
    const saved = await reconnected.inspectMemberInterrupt(
      h.f.context(requestFor(h, 'GET', current.credential)),
      groupId,
      'left',
    );
    assert.deepEqual(saved?.record, interrupted.record);
    assert.deepEqual(saved?.reference, interrupted.reference);
    const cancellationFile = join(
      h.f.home,
      'report-groups',
      'station-report-interrupts-v1',
      `${createHash('sha256').update(groupId).digest('hex')}.json`,
    );
    const receiptBytes = readFileSync(cancellationFile);
    const substituted = JSON.parse(receiptBytes.toString('utf8'));
    substituted.entries[0].intent.operationId = 'forged-cancellation';
    writeFileSync(cancellationFile, JSON.stringify(substituted), {
      mode: 0o600,
    });
    await assert.rejects(
      () =>
        reconnected.inspectMemberInterrupt(
          h.f.context(requestFor(h, 'GET', current.credential)),
          groupId,
          'left',
        ),
      { code: 'group_custody_unavailable' },
    );
    writeFileSync(cancellationFile, receiptBytes, { mode: 0o600 });
    assert.deepEqual(
      (
        await reconnected.inspectMemberInterrupt(
          h.f.context(requestFor(h, 'GET', current.credential)),
          groupId,
          'left',
        )
      )?.record,
      interrupted.record,
    );
    assert.equal(
      dispatch.mock.calls.filter(
        ([command]) => command.type === 'interruptTurn',
      ).length,
      1,
    );
    const afterInterrupt = await reader.inspect(
      h.f.context(requestFor(h, 'GET', current.credential)),
      groupId,
    );
    assert.deepEqual(
      afterInterrupt?.authority?.invocations,
      historical.authority.invocations,
    );
    dispatch.mockRestore();
    assert.equal(h.rawFetch.mock.calls.length, 1);
    assert.throws(() => h.owner.read(handle, h.f.req));
  } finally {
    h.owner.close(handle);
  }
}, 60000);

test('source changes between member seals cannot produce a mixed-source report root', async () => {
  const h = await setup();
  const capture = h.f.owner.captureSnapshot.bind(h.f.owner);
  let seals = 0;
  h.f.owner.captureSnapshot = async (...args) => {
    if (++seals === 2) {
      writeFileSync(join(h.f.repo, 'source.txt'), 'changed between members\n');
      await h.f.git('add', '--', 'source.txt');
      await h.f.git('commit', '-qm', 'Controlled changed source');
    }
    return capture(...args);
  };
  await assert.rejects(() => h.owner.prepare(h.f.context(), h.input), {
    code: 'group_preparation_unavailable',
  });
  assert.equal(seals, 2);
  assert.equal(h.rawFetch.mock.calls.length, 0);
});

test('removing orchestration operation scope invalidates report preparation authority', async () => {
  const h = await setup();
  const handle = await h.owner.prepare(h.f.context(), h.input);
  try {
    assert.equal(h.owner.read(handle, h.f.req).members.length, 2);
    h.f.environment.devicePairing.setDeviceScope(
      h.f.paired.device.id,
      ['orchestration:read'],
      { kind: 'presented-credential' },
    );
    assert.throws(() => h.owner.read(handle, h.f.req));
    assert.equal(h.rawFetch.mock.calls.length, 0);
  } finally {
    h.owner.close(handle);
  }
});

for (const defect of [
  'seat',
  'invocation',
  'environment',
  'admission',
] as const) {
  test(`a foreign reservation ${defect} is refused before canonical task creation and keeps the reservation unknown-held`, async () => {
    const h = await setup();
    installControl(
      h,
      defect === 'environment'
        ? 'different-environment'
        : h.f.record.environmentId,
    );
    const handle = await h.owner.prepare(h.f.context(), {
      ...h.input,
      maxConcurrent: 1,
      members: h.input.members.slice(0, 1),
    });
    const dispatch = h.owner.dispatch.bind(h.owner);
    vi.spyOn(h.owner, 'dispatch').mockImplementation(
      (handle, context, seat, attempt, service) => {
        if (defect === 'admission') {
          const groupId = h.owner.read(handle, h.f.req).spec.groupId;
          unlinkSync(
            join(
              h.f.home,
              'report-groups',
              'station-report-admissions-v1',
              `${createHash('sha256').update(groupId).digest('hex')}.json`,
            ),
          );
        }
        return dispatch(
          handle,
          context,
          seat,
          {
            ...attempt,
            transport: {
              ...attempt.transport,
              reservation: {
                ...attempt.transport.reservation,
                ...(defect === 'seat'
                  ? { seatId: 'foreign-seat' }
                  : defect === 'invocation'
                    ? { invocationId: 'absent-invocation' }
                    : {}),
              },
            },
          },
          service,
        );
      },
    );
    try {
      const { driver } = await taskDriver(h, handle);
      await driver.run();
      assert.equal(h.rawFetch.mock.calls.length, 0);
      assert.equal(driver.canonicalEvents().length, 0);
      assert.equal(driver.task, undefined);
      const ledger = await driver.ledger();
      assert.equal(ledger.invocations.length, 1);
      assert.equal(ledger.invocations[0].usage, null);
      assert.equal(ledger.invocations[0].terminal, false);
      if (defect === 'environment') {
        const groupId = h.owner.read(handle, h.f.req).spec.groupId;
        h.owner.close(handle);
        const returning = newGrant(h);
        const revoked = await h.custody.revokeExecutionAuthority(
          h.f.context(requestFor(h, 'POST', returning.credential)),
          groupId,
        );
        assert.equal(revoked.authority.cancelled, true);
        assert.deepEqual(revoked.authority.invocations, ledger.invocations);
        assert.equal(h.rawFetch.mock.calls.length, 0);
      }
    } finally {
      h.owner.close(handle);
    }
  });
}

test('historical metadata GET authorization cannot issue POST source authority or disclose its credential', async () => {
  const h = await setup();
  const request = requestFor(h);
  const read = await captureEnvironmentLocalGrantReadOwner(
    request,
    h.f.environment,
    h.f.environment,
  );
  read.assertCurrent();
  assert.equal('principalCredential' in read, false);
  assert.ok(!JSON.stringify(read).includes(h.f.paired.credential));
  await assert.rejects(() =>
    captureEnvironmentLocalGrantObservationOwner(
      request,
      h.f.environment,
      h.f.environment,
    ),
  );
  await assert.rejects(() =>
    captureEnvironmentLocalGrantReadOwner(
      h.f.req,
      h.f.environment,
      h.f.environment,
    ),
  );
  await assert.rejects(() => h.owner.prepare(h.f.context(request), h.input));
  assert.equal(h.rawFetch.mock.calls.length, 0);
});

test('signed admission refuses a well-shaped metadata substitution and restored bytes recover the historical read', async () => {
  const h = await setup();
  const handle = await h.owner.prepare(h.f.context(), h.input);
  try {
    const groupId = await h.custody.retain(h.f.context(), h.owner, handle);
    const context = h.f.context(requestFor(h));
    assert.ok(await h.custody.inspect(context, groupId));
    const file = join(
      h.f.home,
      'report-groups',
      'station-report-admissions-v1',
      `${createHash('sha256').update(groupId).digest('hex')}.json`,
    );
    const original = readFileSync(file, 'utf8');
    const changed = JSON.parse(original);
    changed.data.members[0].requestedModelId = 'different-historical-model';
    writeFileSync(file, JSON.stringify(changed), { mode: 0o600 });
    await assert.rejects(() => h.custody.inspect(context, groupId), {
      code: 'group_custody_unavailable',
    });
    writeFileSync(file, original, { mode: 0o600 });
    const restored = await h.custody.inspect(context, groupId);
    assert.equal(
      restored?.admission.members[0].requestedModelId,
      'claude-sonnet-4-6',
    );
    assert.ok(!original.includes('Review correctness'));
    assert.equal(restored?.admission.intentRef, undefined);
    await assert.rejects(
      h.custody.loadIntentForMutation(
        h.f.context(requestFor(h, 'POST')),
        groupId,
      ),
      { code: 'group_custody_unavailable' },
    );
    assert.ok(!original.includes('synthetic-not-a-live-key'));
    assert.equal(h.rawFetch.mock.calls.length, 0);
  } finally {
    h.owner.close(handle);
  }
});

test('a returning operator credential can read the same admission but cannot replace its operation with a resealed root', async () => {
  const h = await setup();
  const handle = await h.owner.prepare(h.f.context(), h.input);
  let second: PreparedStationReportGroup | undefined;
  const renewed = new StationReportGroupPreparation(h.preparationOwners);
  try {
    const groupId = await h.custody.retain(h.f.context(), h.owner, handle);
    const grant = newGrant(h);
    const get = h.f.context(requestFor(h, 'GET', grant.credential));
    assert.equal(
      (await h.custody.findOperation(get, h.input.operationId))?.admission.spec
        .groupId,
      groupId,
    );
    const post = h.f.context(requestFor(h, 'POST', grant.credential));
    second = await renewed.prepare(post, h.input);
    assert.equal(renewed.read(second, post.req.raw).spec.groupId, groupId);
    await assert.rejects(() => h.custody.retain(post, renewed, second!), {
      code: 'report_admission_conflict',
    });
    assert.equal(
      (await h.custody.findOperation(get, h.input.operationId))?.admission.spec
        .groupId,
      groupId,
    );
    h.f.environment.devicePairing.setDeviceScope(
      grant.device.id,
      ['orchestration:read'],
      { kind: 'presented-credential' },
    );
    assert.ok(await h.custody.inspect(get, groupId));
    h.f.environment.devicePairing.setDeviceScope(
      grant.device.id,
      ['orchestration:operate'],
      { kind: 'presented-credential' },
    );
    await assert.rejects(() => h.custody.inspect(get, groupId));
    h.f.environment.devicePairing.setDeviceScope(
      grant.device.id,
      ['orchestration:read'],
      { kind: 'presented-credential' },
    );
    assert.ok(await h.custody.inspect(get, groupId));
    h.f.environment.devicePairing.revokeDevice(
      grant.device.id,
      'operator-credential',
    );
    await assert.rejects(() => h.custody.inspect(get, groupId));
    assert.equal(h.rawFetch.mock.calls.length, 0);
  } finally {
    h.owner.close(handle);
    if (second) renewed.close(second);
  }
});

test.each(['lost-ack', 'lost-journal-commit'] as const)(
  'cancellation recovery observes retained receipts without another interrupt (%s)',
  async (variant) => {
    const h = await setup();
    installControl(h);
    const handle = await h.owner.prepare(h.f.context(), {
      ...h.input,
      maxConcurrent: 1,
      members: h.input.members.slice(0, 1),
    });
    try {
      const { driver, sdk, prepared } = await taskDriver(h, handle);
      await driver.run();
      assert.equal(h.rawFetch.mock.calls.length, 1);
      await sdkDisposalPromise(sdk.owner, sdk.sdkHandle);
      h.owner.close(handle);
      const grant = newGrant(h);
      const groupId = prepared.spec.groupId;
      const before = await h.custody.inspect(
        h.f.context(requestFor(h, 'GET', grant.credential)),
        groupId,
      );
      assert.ok(before?.group && before.authority);
      const cancelCommand = {
        operationKey: 'cancel-left',
        expectedRevision: before.group.revision,
      };
      const dispatchLedger = new FileAuthorizationLedger({
        root: join(h.f.root, 'dispatch'),
      });
      if (variant === 'lost-journal-commit') {
        const roundsStore = h.custodyOwners.persistence.roundsStore.bind(
          h.custodyOwners.persistence,
        );
        vi.spyOn(h.custodyOwners.persistence, 'roundsStore').mockImplementation(
          (current) => {
            const store = roundsStore(current);
            return {
              transact: (id, body) =>
                store.transact(id, async (previous) => {
                  const next = await body(previous);
                  if (
                    next.journal.events[next.journal.events.length - 1]
                      ?.kind === 'cancel_requested'
                  )
                    throw Error('controlled lost cancellation journal commit');
                  return next;
                }),
            };
          },
        );
      }
      const dispatch = driver.orchestration.dispatchWithReceipt.bind(
        driver.orchestration,
      );
      const lost = vi
        .spyOn(driver.orchestration, 'dispatchWithReceipt')
        .mockImplementation(async (...args) => {
          const response = await dispatch(...args);
          if (args[0].type === 'interruptTurn' && variant === 'lost-ack')
            throw Error('controlled lost interrupt acknowledgement');
          return response;
        });
      await assert.rejects(
        () =>
          h.custody.cancel(
            h.f.context(requestFor(h, 'POST', grant.credential)),
            groupId,
            cancelCommand,
            driver.orchestration,
            dispatchLedger,
          ),
        /controlled lost (interrupt acknowledgement|cancellation journal commit)/,
      );
      const reader = new StationReportGroupCustody(h.custodyOwners);
      const replayedCancel = await reader.cancel(
        h.f.context(requestFor(h, 'POST', grant.credential)),
        groupId,
        cancelCommand,
        driver.orchestration,
        dispatchLedger,
      );
      assert.equal(replayedCancel.replayed, true);
      assert.equal(replayedCancel.projection.cancellation, 'pending');
      const replay = await reader.requestMemberInterrupt(
        h.f.context(requestFor(h, 'POST', grant.credential)),
        groupId,
        'left',
        'cancel-left',
        driver.orchestration,
      );
      assert.equal(replay.replayed, true);
      assert.equal(
        replay.record.acknowledgement === null,
        variant === 'lost-ack',
      );
      assert.equal(replay.reference === null, variant === 'lost-ack');
      const retainedUnknown = await reader.inspectMemberInterrupt(
        h.f.context(requestFor(h, 'GET', grant.credential)),
        groupId,
        'left',
      );
      assert.ok(retainedUnknown);
      assert.equal(
        retainedUnknown.record.acknowledgement === null,
        variant === 'lost-ack',
      );
      assert.equal(retainedUnknown.reference === null, variant === 'lost-ack');
      assert.equal(
        lost.mock.calls.filter(([command]) => command.type === 'interruptTurn')
          .length,
        1,
      );
      await assert.rejects(
        () =>
          reader.requestMemberInterrupt(
            h.f.context(requestFor(h, 'POST', grant.credential)),
            groupId,
            'left',
            'changed-cancel-key',
            driver.orchestration,
          ),
        { code: 'report_interrupt_identity_conflict' },
      );
      assert.equal(
        lost.mock.calls.filter(([command]) => command.type === 'interruptTurn')
          .length,
        1,
      );
      const after = await reader.inspect(
        h.f.context(requestFor(h, 'GET', grant.credential)),
        groupId,
      );
      assert.equal(after?.authority?.cancelled, true);
      assert.equal(after?.group?.cancellation, 'pending');
      assert.deepEqual(
        after?.authority?.invocations,
        before.authority.invocations,
      );
      assert.ok(after?.group);
      const finalizeCommand = {
        operationKey: 'finalize-left',
        cancelOperationKey: 'cancel-left',
        expectedRevision: after.group.revision,
      };
      const finalize = (
        credential = grant.credential,
        command = finalizeCommand,
      ) =>
        reader.finalizeCancel(
          h.f.context(requestFor(h, 'POST', credential)),
          groupId,
          command,
          driver.orchestration,
          dispatchLedger,
        );
      await assert.rejects(() => finalize('invalid-credential'));
      await assert.rejects(() =>
        finalize(grant.credential, {
          ...finalizeCommand,
          cancelOperationKey: 'foreign-cancel',
        }),
      );
      if (variant === 'lost-ack') {
        await assert.rejects(() => finalize(), {
          code: 'rounds_cancel_confirmation_required',
        });
      } else {
        const file = join(
          h.f.home,
          'report-groups',
          'station-report-interrupts-v1',
          `${createHash('sha256').update(groupId).digest('hex')}.json`,
        );
        const bytes = readFileSync(file);
        const differentOperation = JSON.parse(bytes.toString());
        const receipt = differentOperation.entries[0];
        differentOperation.entries[0] = signReportInterrupt(
          { ...receipt.intent, operationId: 'another-operation' },
          receipt.acknowledgement,
          h.f.environment,
        );
        writeFileSync(file, JSON.stringify(differentOperation), {
          mode: 0o600,
        });
        await assert.rejects(() => finalize(), {
          code: 'rounds_cancel_confirmation_required',
        });
        writeFileSync(file, bytes, { mode: 0o600 });
        const finalized = await finalize();
        assert.equal(finalized.replayed, false);
        assert.equal(finalized.projection.cancellation, 'requested');
        const repeated = await finalize();
        assert.equal(repeated.replayed, true);
        assert.deepEqual(repeated.projection, finalized.projection);
      }
      assert.equal(
        lost.mock.calls.filter(([command]) => command.type === 'interruptTurn')
          .length,
        1,
      );
      const final = await reader.inspect(
        h.f.context(requestFor(h, 'GET', grant.credential)),
        groupId,
      );
      assert.deepEqual(
        final?.authority?.invocations,
        before.authority.invocations,
      );
      assert.equal(
        final?.group?.cancellation,
        variant === 'lost-ack' ? 'pending' : 'requested',
      );
      assert.equal(h.rawFetch.mock.calls.length, 1);
    } finally {
      h.owner.close(handle);
    }
  },
  60000,
);

test('canonical interrupt refuses request currency lost during adapter resolution', async () => {
  const h = await setup();
  installControl(h);
  const handle = await h.owner.prepare(h.f.context(), {
    ...h.input,
    maxConcurrent: 1,
    members: h.input.members.slice(0, 1),
  });
  try {
    const { driver, sdk, prepared } = await taskDriver(h, handle);
    await driver.run();
    assert.ok(driver.task?.initialTurnId);
    await sdkDisposalPromise(sdk.owner, sdk.sdkHandle);
    const task = driver.task;
    let current = true;
    const resolution = vi
      .spyOn(StationAgentAdapter.prototype, 'hasSession')
      .mockImplementationOnce(async () => {
        current = false;
        return true;
      });
    const interrupt = vi.spyOn(StationAgentAdapter.prototype, 'interruptTurn');
    await assert.rejects(
      () =>
        driver.orchestration.dispatchWithReceipt(
          {
            type: 'interruptTurn',
            threadId: task.sessionId,
            turnId: task.initialTurnId,
          },
          {
            userId: prepared.root.authenticated_principal_ref.id,
            requestCurrent: () => current,
          },
        ),
      /Request authority changed before interruption/,
    );
    assert.equal(resolution.mock.calls.length, 1);
    assert.equal(interrupt.mock.calls.length, 0);
    assert.equal(h.rawFetch.mock.calls.length, 1);
  } finally {
    h.owner.close(handle);
  }
}, 60000);

test('initial Flow continuation limits are immutable intent and reserve aggregate headroom before any provider call', async () => {
  const h = await setup();
  const flow = await createReportFlow(h.f, 'continuation-policy', [
    { id: 'left' },
  ]);
  const input = {
    ...h.input,
    members: h.input.members.slice(0, 1),
    maxConcurrent: 1,
    flow,
    continuation: {
      attemptsPerMember: 3,
      maxRounds: 3,
      maxSyncs: 1,
      maxRenewals: 2,
      maxEvaluations: 2,
      maxRecoveries: 2,
    },
    budget: {
      inputTokens: 3 * 1048576,
      outputTokens: 30,
      costMicros: 3 * 3145878,
    },
  };
  const handle = await h.owner.prepare(h.f.context(), input);
  try {
    const prepared = h.owner.read(handle, h.f.req);
    assert.equal(prepared.root.budget.max_attempts, 3);
    assert.deepEqual(prepared.root.delegation_ceiling.allowed_effects, [
      'report',
      'context-sync',
    ]);
    const child = prepared.envelopes.find(
      (e) => e.execution_id === prepared.members[0].taskId,
    );
    assert.ok(child);
    assert.equal(child.budget.max_attempts, 3);
    const groupId = await h.custody.retain(h.f.context(), h.owner, handle);
    const stored = await h.custodyOwners.persistence.readReportAdmission(
      groupId,
      () => undefined,
    );
    assert.ok(stored?.data.intentRef);
    const locatorInput = {
      source: child.execution_binding.source,
      subject: { groupId, workItemId: prepared.members[0].taskId },
      admission: stored,
      principalId: prepared.root.authenticated_principal_ref.id,
      hostContextId: prepared.root.issuer_host_id,
      current: () => undefined,
    };
    assert.equal(
      (await h.f.owner.readHistoricalFlowLocation(locatorInput)).cwd,
      h.f.repo,
    );
    await assert.rejects(
      h.f.owner.readHistoricalFlowLocation({
        ...locatorInput,
        admission: { ...stored, signature: 'forged' },
      }),
      { code: 'flow_location_unavailable' },
    );
    await assert.rejects(
      h.f.owner.readHistoricalFlowLocation({
        ...locatorInput,
        subject: { ...locatorInput.subject, workItemId: 'foreign' },
      }),
      { code: 'flow_location_unavailable' },
    );

    assert.ok(!JSON.stringify(stored).includes('Review correctness'));
    const loaded = await h.custody.loadIntentForMutation(
      h.f.context(requestFor(h, 'POST')),
      groupId,
    );
    assert.deepEqual(loaded.intent, input);
    const legacy = structuredClone(loaded.admission);
    delete legacy.spec.policy.syncAdmission;
    assert.deepEqual(
      validateReportIntent(legacy, loaded.intent),
      loaded.intent,
    );
    const widened = structuredClone(loaded.admission);
    widened.spec.policy.maxRenewals = 3;
    assert.throws(
      () => validateReportIntent(widened, loaded.intent),
      /report_admission_intent_invalid/,
    );
    loaded.intent.members[0].brief = 'returned copies are detached';
    assert.equal(
      (
        await h.custody.loadIntentForMutation(
          h.f.context(requestFor(h, 'POST')),
          groupId,
        )
      ).intent.members[0].brief,
      'Review correctness',
    );
    const intentFile = join(
      h.f.home,
      'report-groups',
      'station-report-intents-v1',
      `${stored.data.intentRef.id}.json`,
    );
    const intentBytes = readFileSync(intentFile);
    try {
      const changed = JSON.parse(intentBytes.toString());
      changed.intent.members[0].brief = 'tampered saved assignment';
      writeFileSync(intentFile, JSON.stringify(changed), { mode: 0o600 });
      await assert.rejects(
        h.custodyOwners.persistence.readReportIntent(
          groupId,
          stored.data.intentRef,
          () => undefined,
        ),
        { code: 'report_intent_digest_invalid' },
      );
      await assert.rejects(
        h.custody.loadIntentForMutation(
          h.f.context(requestFor(h, 'POST')),
          groupId,
        ),
      );
      assert.ok(await h.custody.inspect(h.f.context(requestFor(h)), groupId));
      unlinkSync(intentFile);
      await assert.rejects(
        h.custody.loadIntentForMutation(
          h.f.context(requestFor(h, 'POST')),
          groupId,
        ),
        { code: 'report_intent_missing' },
      );
      assert.ok(await h.custody.inspect(h.f.context(requestFor(h)), groupId));
    } finally {
      writeFileSync(intentFile, intentBytes, { mode: 0o600 });
    }
    const original = h.owner.sdk(handle, h.f.req, 'left');
    const initialWire = inspectSdkSourceWire(
      original.owner,
      original.sdkHandle,
    );
    const request = requestFor(h, 'POST');
    const context = h.f.context(request);
    const source = await h.f.owner.readmitSnapshot(
      context,
      {
        groupId: prepared.spec.groupId,
        workItemId: prepared.members[0].taskId,
      },
      child.execution_binding.source,
    );
    const credentialOwner = new RuntimeFencedCredentialObservationOwner(
      h.preparationOwners.runtime,
    );
    const selected = await credentialOwner.captureAgentSdkCredential(
      request,
      'reviewer',
    );
    const qualifier = await AnthropicSealedPreparation.create();
    const freshOwner = createPreparedSdkSourceWireOwner({
      outputDelivery: 'streamed',
      provider: 'anthropic',
      modelId: selected.modelId,
      credential: selected.credential,
      preparation: qualifier,
      brief: 'ACK SYNC controlled-context',
      instructions: selected.instructions,
      maxOutputTokens: 10,
      remaining: { ...input.budget, currency: 'USD' },
      now: Date.now,
      signal: request.signal,
      rawFetch: h.rawFetch,
    });
    let freshHandle: object | undefined;
    try {
      const fresh = await h.f.owner.prepareSdkSnapshot(
        context,
        {
          groupId: prepared.spec.groupId,
          workItemId: prepared.members[0].taskId,
        },
        source.capability,
        freshOwner,
      );
      freshHandle = fresh.sdkHandle;
      const captured = inspectSdkSourceWire(freshOwner, fresh.sdkHandle);
      assert.notEqual(captured.wireDigest, initialWire.wireDigest);
      assert.deepEqual(captured.contract, initialWire.contract);
      const expected = {
        agentId: 'reviewer',
        provider: 'anthropic',
        modelId: selected.modelId,
        instructionsDigest: `sha256:${createHash('sha256').update(selected.instructions).digest('hex')}`,
        outputTokensPerCall: 10,
        contract: captured.contract,
        source: captured.sourceBinding.source,
      };
      assert.deepEqual(child.execution_binding.runtime.runtime_receipt_ref, {
        id: 'left',
        domain: 'station.sealed-sdk.runtime.v2',
        digest: `sha256:${createHash('sha256').update(canonicalJson(expected)).digest('hex')}`,
      });
    } finally {
      h.f.owner.releaseSnapshot(source.capability);
      if (freshHandle) {
        disposeSdkSourceWire(freshOwner, freshHandle);
        await sdkDisposalPromise(freshOwner, freshHandle);
      }
    }

    assert.equal(child.budget.max_input_tokens, 3 * 1048576);
    assert.equal(child.budget.max_output_tokens, 30);
    assert.equal(child.budget.max_cost_micros, 3 * 3145878);
    assert.deepEqual(prepared.spec.seats[0].allocation, {
      inputTokens: 1048576,
      outputTokens: 10,
      costMicros: 3145878,
    });
    assert.deepEqual(
      { ...prepared.spec.policy, reference: undefined },
      {
        syncAdmission: 'initial-request',
        reference: undefined,
        maxConcurrent: 1,
        maxAttempts: 3,
        maxRounds: 3,
        maxSyncs: 1,
        maxRenewals: 2,
        maxEvaluations: 2,
        maxRecoveries: 2,
      },
    );
    await assert.rejects(
      h.owner.prepare(h.f.context(), {
        ...input,
        continuation: { ...input.continuation, maxRenewals: 3 },
      }),
    );
    await assert.rejects(
      h.owner.prepare(h.f.context(), {
        ...input,
        operationId: 'underfunded',
        budget: { ...input.budget, inputTokens: 1048576 },
      }),
    );
    assert.equal(h.rawFetch.mock.calls.length, 0);
    const receiptPath = join(
      h.f.store,
      `snapshot-${child.execution_binding.source.source_admission_receipt.id}.json`,
    );
    const receipt = readFileSync(receiptPath);
    try {
      writeFileSync(receiptPath, '{}');
      await assert.rejects(h.f.owner.readHistoricalFlowLocation(locatorInput), {
        code: 'flow_location_unavailable',
      });
      unlinkSync(receiptPath);
      await assert.rejects(h.f.owner.readHistoricalFlowLocation(locatorInput), {
        code: 'flow_location_unavailable',
      });
    } finally {
      writeFileSync(receiptPath, receipt, { mode: 0o600 });
    }
  } finally {
    h.owner.close(handle);
  }
});
