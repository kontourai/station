import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs, {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { FileAuthorizationLedger } from '@kontourai/dispatch';
import type { RootAuthorityV2 } from '@kontourai/flow-agents/delegation-authority-contract';
import { createDelegationAuthorityService } from '@kontourai/flow-agents/delegation-authority-service';
import { createDelegationAuthorityServiceV3 } from '@kontourai/flow-agents/delegation-authority-service-v3';
import {
  type DelegationEnvelopeV2,
  delegationEnvelopeDigestV2,
  rootAuthorityReferenceV2,
} from '@kontourai/flow-agents/delegation-envelope-v2';
import {
  createDelegationRoundsController,
  type DelegationRoundsSpec,
} from '@kontourai/flow-agents/delegation-group-rounds';
import {
  createDelegationGroupControllerV2,
  type DelegationGroupSpecV2,
} from '@kontourai/flow-agents/delegation-group-v2';
import { canonicalJson } from '@kontourai/relay';
import { acquireFileMutationLockAsync } from '@kontourai/station-shared/lifecycle-events';
import {
  acquireStationHomeMaintenanceLease,
  StationHomeActiveError,
} from '@kontourai/station-shared/station-home-lifecycle';
import { ensureStationHomeSchemaSync } from '@kontourai/station-shared/station-home-schema';
import { expect, test, vi } from 'vitest';
import {
  executeOwnedProcess,
  terminateSuiteExecution,
  waitForSuiteSettlement,
} from '../../../../scripts/lib/owned-process.mjs';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import type { RuntimePublicationParticipant } from '../../../runtime/bootstrap/runtime-publication-participant.js';
import { StationRuntime } from '../../../runtime/bootstrap/station-runtime.js';
import { HomeWriterOwner } from '../../ssh/home-writer-owner.js';
import { StationDelegationPersistence } from '../delegation-group-persistence.js';
import type { ReportInterruptRecord } from '../station-report-group-cancellation.js';

const makeTempDir = trackTempDirs();

// Requires published built Flow authority/group APIs plus Station finalizeCommit058d.
// No skip, controller mock, downloaded source import, install or provider execution.
const digest = (value: unknown) =>
  createHash('sha256').update(canonicalJson(value)).digest('hex');
const reference = (id: string) => ({
  id,
  domain: 'fixture.observation',
  digest: `sha256:${digest(id)}`,
});
function fixture(runtimeHome = false) {
  const root = makeTempDir('station-delegation-persistence-');
  if (runtimeHome) ensureStationHomeSchemaSync(root);
  const persistence = new StationDelegationPersistence(root);
  let active = true;
  const finalizeCurrent = (): undefined => {
    if (!active) throw new Error('actual-request-revoked');
    return undefined;
  };
  const authority = {
    allowed_tools: [],
    allowed_effects: ['report'],
    readable_resources: [],
    mutable_resources: [],
    posture: 'report-only' as const,
    approval: 'automatic' as const,
    escalation: 'deny' as const,
  };
  const budget = {
    remaining_depth: 0,
    max_total_children: 1,
    max_total_envelopes: 1,
    max_concurrent_children: 1,
    max_runtime_ms: 60_000,
    max_input_tokens: 100,
    max_output_tokens: 10,
    max_cost_micros: 1000,
    max_attempts: 1,
    expires_at: '2099-01-01T00:00:00.000Z',
  };
  const binding = {
    runtime: {
      runtime_receipt_ref: reference('runtime'),
      model_receipt_ref: reference('model'),
      required_capabilities: [],
    },
    source: {
      repository_id: 'repository',
      source_state_id: 'revision',
      dirty_state_fingerprint: null,
      execution_worktree_id: 'worktree',
      source_admission_receipt: reference('source'),
    },
    flow_binding: {
      status: 'unbound' as const,
      reason: 'independent-advisory',
    },
  };
  const authorityRoot: RootAuthorityV2 = {
    schema_version: '2.0',
    authority_id: 'authority',
    authority_epoch: 1,
    issuer_host_id: 'host',
    authenticated_principal_ref: reference('principal'),
    authenticated_subject_ref: reference('subject'),
    source_origin: {
      repository_id: 'repository',
      worktree_id: 'worktree',
      source_state_id: 'revision',
      dirty_state_fingerprint: null,
    },
    execution_worktree_ids: ['worktree'],
    execution_grants: [
      { ...binding, grant_id: 'grant', authority_ceiling: authority },
    ],
    delegation_ceiling: authority,
    budget,
    revisions: {
      policy: reference('policy'),
      prompt: reference('prompt'),
      rubric: reference('rubric'),
    },
    root_trace: { trace_id: 'trace', span_id: 'span' },
    root_cancellation_ref: reference('cancel'),
  };
  const envelope: DelegationEnvelopeV2 = {
    schema_version: '2.0',
    envelope_id: 'envelope',
    generation: 0,
    parent: null,
    root_authority_ref: rootAuthorityReferenceV2(authorityRoot),
    execution_id: 'execution',
    actor: authorityRoot.authenticated_principal_ref,
    assignment_subject: authorityRoot.authenticated_subject_ref,
    trace_id: 'trace',
    span_id: 'span',
    parent_span_id: null,
    selected_grant_id: 'grant',
    remaining_allowed_grant_ids: [],
    execution_binding: binding,
    delegation_ceiling: authority,
    execution_authority: authority,
    budget,
    continuation_ref: reference('continue'),
    cancellation_ref: authorityRoot.root_cancellation_ref,
  };
  const store = persistence.authorityStore(finalizeCurrent);
  const service = createDelegationAuthorityService(store, {
    now: () => new Date().toISOString(),
    authorize: async (_action, actual) =>
      active && actual.authenticated_principal_ref.id === 'principal',
    confirmExecution: async (actual) =>
      active && actual.selected_grant_id === 'grant',
    confirmReconciliation: async (actual) =>
      active && actual.invocationId === 'invoke',
  });
  const ledger = {
    root: authorityRoot,
    envelopes: [] as DelegationEnvelopeV2[],
    cancelled: false,
    invocations: [],
  };
  const file = join(
    root,
    'station-delegation-authorities',
    `${createHash('sha256').update('authority').digest('hex')}.json`,
  );
  return {
    root,
    persistence,
    finalizeCurrent,
    authorityRoot,
    envelope,
    ledger,
    store,
    service,
    file,
    revoke: () => {
      active = false;
    },
  };
}

test.each(['execution', 'continuation'] as const)(
  'read-only %s snapshots sync the record and directory once and withhold failed durability',
  async (kind) => {
    const f = fixture();
    const prepare = async () => {
      if (kind === 'continuation') {
        const value = { receipt: 'retained continuation' };
        const reference = await f.persistence.retainReportContinuation(
          'group',
          value,
          f.finalizeCurrent,
        );
        return {
          directory: 'station-report-flow-observations-v1',
          file: `${reference.id}.json`,
          read: () =>
            f.persistence.loadReportContinuation(
              'group',
              reference,
              f.finalizeCurrent,
            ),
          expected: canonicalJson(value),
        };
      }
      const service = createDelegationAuthorityServiceV3(
        f.persistence.roundsAuthorityStore(f.finalizeCurrent),
        {
          now: () => new Date().toISOString(),
          authorize: async () => true,
          confirmExecution: async () => true,
          authenticateRenewal: async () => null,
        },
        { maxRenewals: 0 },
      );
      await service.issue(f.authorityRoot);
      return {
        directory: 'station-rounds-authorities-v3',
        file: `${createHash('sha256').update(f.authorityRoot.authority_id).digest('hex')}.json`,
        read: () =>
          f.persistence.readReportExecution(
            'missing-group',
            f.authorityRoot.authority_id,
            f.finalizeCurrent,
          ),
        expected: {
          group: null,
          authority: { epochs: [{ root: f.authorityRoot }] },
        },
      };
    };
    const target = await prepare();
    const directory = fs.statSync(join(f.root, target.directory));
    const record = fs.statSync(join(f.root, target.directory, target.file));
    const sync = fs.fsyncSync;
    let directorySyncs = 0;
    let recordSyncs = 0;
    let fail = false;
    let revoke = false;
    const failure = new Error('controlled snapshot directory sync failure');
    const observe = vi.spyOn(fs, 'fsyncSync').mockImplementation((fd) => {
      const status = fs.fstatSync(fd);
      if (status.dev === record.dev && status.ino === record.ino) recordSyncs++;
      if (status.dev === directory.dev && status.ino === directory.ino) {
        directorySyncs++;
        if (fail) throw failure;
        if (revoke) f.revoke();
      }
      return sync(fd);
    });
    syncBuiltinESMExports();
    const read = target.read;
    try {
      const snapshot = await read();
      if (typeof target.expected === 'string')
        expect(snapshot).toBe(target.expected);
      else expect(snapshot).toMatchObject(target.expected);
      expect(recordSyncs).toBe(1);
      expect(
        directorySyncs,
        `one read-only ${kind} snapshot directory flush`,
      ).toBe(1);
      fail = true;
      await expect(read()).rejects.toBe(failure);
      fail = false;
      await expect(read()).resolves.toEqual(snapshot);
      revoke = true;
      await expect(read()).rejects.toThrow('actual-request-revoked');
    } finally {
      observe.mockRestore();
      syncBuiltinESMExports();
    }
  },
);

test('real public authority service preserves unknown hold on reopen and cancellation', async () => {
  const f = fixture();
  await f.service.issue(f.authorityRoot);
  await f.service.derive('authority', f.envelope);
  await f.service.reserveInvocation('authority', 'envelope', 'invoke', {
    inputTokens: 100,
    outputTokens: 10,
    costMicros: 1000,
  });
  await f.service.reconcileInvocation('authority', 'invoke', null, true);
  await f.service.cancel('authority');
  const reopened = new StationDelegationPersistence(f.root).authorityStore(
    f.finalizeCurrent,
  );
  const retained = await reopened.transact('authority', async (current) => {
    if (!current) throw new Error('missing');
    return { ledger: current, result: current };
  });
  expect(retained.cancelled).toBe(true);
  expect(retained.invocations).toEqual([
    {
      invocationId: 'invoke',
      envelopeId: 'envelope',
      allocation: { inputTokens: 100, outputTokens: 10, costMicros: 1000 },
      usage: null,
      terminal: true,
    },
  ]);
  await expect(
    reopened.transact('authority', async (current) => {
      if (!current) throw new Error('missing');
      return { ledger: { ...current, cancelled: false }, result: undefined };
    }),
  ).rejects.toThrow('delegation_authority_history_changed');
});

test('revocation while waiting for the real host lock prevents the second body from running', async () => {
  const f = fixture();
  let enter!: () => void;
  let release!: () => void;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const first = f.store.transact('authority', async () => {
    enter();
    await held;
    return { ledger: f.ledger, result: undefined };
  });
  await entered;
  let secondActive = true;
  let secondBodies = 0;
  const secondStore = new StationDelegationPersistence(f.root).authorityStore(
    () => {
      if (!secondActive) throw new Error('second-revoked');
      return undefined;
    },
  );
  const second = secondStore.transact('authority', async () => {
    secondBodies++;
    return { ledger: f.ledger, result: undefined };
  });
  const rejection = expect(second).rejects.toThrow('second-revoked');
  secondActive = false;
  release();
  await first;
  await rejection;
  expect(secondBodies).toBe(0);
});

test.each(['legacy', 'rounds'] as const)(
  'revocation after actual temp staging refuses %s publication at final rename boundary',
  async (protocol) => {
    const f = fixture();
    const directory = join(
      f.root,
      protocol === 'legacy'
        ? 'station-delegation-authorities'
        : 'station-rounds-authorities-v3',
    );
    const file = join(
      directory,
      `${createHash('sha256').update('authority').digest('hex')}.json`,
    );
    let staged = false;
    const finalize = (): undefined => {
      if (
        existsSync(directory) &&
        readdirSync(directory).some((name) => name.endsWith('.tmp'))
      ) {
        staged = true;
        f.revoke();
      }
      return f.finalizeCurrent();
    };
    const publish =
      protocol === 'legacy'
        ? () =>
            f.persistence
              .authorityStore(finalize)
              .transact('authority', async () => ({
                ledger: f.ledger,
                result: undefined,
              }))
        : () =>
            f.persistence
              .roundsAuthorityStore(finalize)
              .transact('authority', async () => ({
                ledger: {
                  schemaVersion: '3.0',
                  revision: 1,
                  maxRenewals: 0,
                  importedFromV2: null,
                  epochs: [
                    { root: f.authorityRoot, envelopes: [], renewal: null },
                  ],
                  cancelled: false,
                  invocations: [],
                  origins: [],
                },
                result: undefined,
              }));
    await expect(publish()).rejects.toThrow('actual-request-revoked');
    expect(staged).toBe(true);
    expect(existsSync(file)).toBe(false);
  },
);

test('a visible commit does not authorize disclosing its result after revocation', async () => {
  const f = fixture();
  const store = f.persistence.authorityStore(() => {
    if (existsSync(f.file)) f.revoke();
    return f.finalizeCurrent();
  });
  await expect(
    store.transact('authority', async () => ({
      ledger: f.ledger,
      result: 'private-result',
    })),
  ).rejects.toThrow('actual-request-revoked');
  expect(existsSync(f.file)).toBe(true);
});

test('corruption and cross-authority execution reuse cannot erase retained custody', async () => {
  const f = fixture();
  await f.service.issue(f.authorityRoot);
  await f.service.derive('authority', f.envelope);
  const otherRoot = { ...f.authorityRoot, authority_id: 'another-authority' };
  const other = {
    ...f.envelope,
    root_authority_ref: rootAuthorityReferenceV2(otherRoot),
  };
  await expect(
    f.store.transact('another-authority', async () => ({
      ledger: {
        root: otherRoot,
        envelopes: [other],
        cancelled: false,
        invocations: [],
      },
      result: undefined,
    })),
  ).rejects.toThrow('delegation_execution_custody_conflict');
  writeFileSync(f.file, 'null');
  await expect(
    f.store.transact('authority', async () => ({
      ledger: f.ledger,
      result: undefined,
    })),
  ).rejects.toThrow();
});

test('public controller can inspect authority under group lock; duplicate root custody refuses', async () => {
  const f = fixture();
  await f.service.issue(f.authorityRoot);
  await f.service.derive('authority', f.envelope);
  mkdirSync(join(f.root, 'dispatch'), { mode: 0o700 });
  const controller = createDelegationGroupControllerV2({
    store: f.persistence.groupStore(f.finalizeCurrent),
    authorityService: f.service,
    dispatchLedger: new FileAuthorizationLedger({
      root: join(f.root, 'dispatch'),
    }),
    host: {
      authorize: async ({ groupId }) =>
        groupId === null || groupId === 'group-1' || groupId === 'group-2'
          ? reference('authenticated-fixture')
          : null,
      executionHost: () => {
        throw new Error('No execution in storage fixture');
      },
      retainMemberOutcome: async () => {
        throw new Error('No outcomes in storage fixture');
      },
      retainRunObservation: async () => {
        throw new Error('No run in storage fixture');
      },
      retainRunFailure: async () => {
        throw new Error('No run in storage fixture');
      },
      requestDescendantCancellation: async () => {
        throw new Error('No descendant proof in storage fixture');
      },
    },
  });
  const spec: DelegationGroupSpecV2 = {
    schemaVersion: '2.0',
    groupId: 'group-1',
    rootAuthorityRef: rootAuthorityReferenceV2(f.authorityRoot),
    controller: { id: 'controller', generation: 1 },
    policy: { reference: f.authorityRoot.revisions.policy, maxConcurrent: 1 },
    topology: { kind: 'independent-advisory' },
    seats: [
      {
        seatId: 'seat',
        envelope: {
          id: f.envelope.envelope_id,
          generation: 0,
          digest: delegationEnvelopeDigestV2(f.envelope),
        },
        stepId: null,
        effect: 'report',
        allocation: { inputTokens: 100, outputTokens: 10, costMicros: 1000 },
      },
    ],
  };
  const command = {
    kind: 'create',
    groupId: 'group-1',
    operationKey: 'create-1',
    expectedRevision: 0,
    controller: spec.controller,
    spec,
  };
  expect((await controller.create(command)).projection.revision).toBe(1);
  expect((await controller.create(command)).replayed).toBe(true);
  expect((await controller.get('group-1')).acceptance).toBe('unassessed');
  expect(await controller.events('group-1', 0)).toHaveLength(1);
  await expect(
    controller.create({
      ...command,
      groupId: 'group-2',
      operationKey: 'create-2',
      spec: { ...spec, groupId: 'group-2' },
    }),
  ).rejects.toThrow('delegation_group_authority_custody_conflict');
  let entered = false;
  await expect(
    f.persistence
      .roundsStore(f.finalizeCurrent)
      .transact('group-1', async () => {
        entered = true;
        throw Error('must not enter');
      }),
  ).rejects.toThrow('delegation_group_protocol_conflict');
  expect(entered).toBe(false);
});

test('new rounds preserve unknown accounting and legacy custody across cancellation and reopen', async () => {
  const f = fixture(true);
  await f.service.issue(f.authorityRoot);
  await f.service.derive('authority', f.envelope);
  await f.service.reserveInvocation('authority', 'envelope', 'invoke', {
    inputTokens: 100,
    outputTokens: 10,
    costMicros: 1000,
  });
  const legacyBytes = readFileSync(f.file);
  const root = { ...f.authorityRoot, authority_id: 'rounds-authority' };
  const envelope = {
    ...f.envelope,
    envelope_id: 'rounds-envelope',
    execution_id: 'rounds-execution',
    root_authority_ref: rootAuthorityReferenceV2(root),
  };
  let preparationActive = true;
  const preparationCurrent = (): undefined => {
    if (!preparationActive) throw Error('preparation-changed');
    return undefined;
  };
  const compose = (
    roundsOverride?: ReturnType<StationDelegationPersistence['roundsStore']>,
  ) => {
    const persistence = new StationDelegationPersistence(f.root);
    const store = persistence.roundsAuthorityStore(
      f.finalizeCurrent,
      preparationCurrent,
    );
    const service = createDelegationAuthorityServiceV3(
      store,
      {
        now: () => new Date().toISOString(),
        authorize: async () => true,
        confirmExecution: async () => true,
        confirmReconciliation: async () => true,
        authenticateRenewal: async () => null,
      },
      { maxRenewals: 0 },
    );
    const controller = createDelegationRoundsController({
      store:
        roundsOverride ??
        persistence.roundsStore(f.finalizeCurrent, preparationCurrent),
      authorityService: service,
      dispatchLedger: new FileAuthorizationLedger({
        root: join(f.root, 'rounds-dispatch'),
      }),
      host: {
        accountingProtocol: 'retained-tariff-v1',
        authorize: async () => reference('authenticated-rounds-fixture'),
        executionHost: () => {
          throw Error('no provider in custody fixture');
        },
        prepareRequest: async () => {
          throw Error('no request in custody fixture');
        },
        retainObservation: async () => {
          throw Error('no output in custody fixture');
        },
        confirmTerminal: async () => null,
        requestDescendantCancellation: async () =>
          reference('cancel-request-only'),
      },
    });
    return {
      store,
      service,
      controller,
      rounds: persistence.roundsStore(f.finalizeCurrent, preparationCurrent),
    };
  };
  mkdirSync(join(f.root, 'rounds-dispatch'), { mode: 0o700 });
  const first = compose();
  await first.service.issue(root);
  await first.service.derive(root.authority_id, envelope);
  await first.service.reserveInvocation(
    root.authority_id,
    envelope.envelope_id,
    'rounds-invoke',
    {
      inputTokens: 100,
      outputTokens: 10,
      costMicros: 1000,
    },
  );
  await first.service.reconcileInvocation(
    root.authority_id,
    'rounds-invoke',
    null,
    false,
  );
  const spec: DelegationRoundsSpec = {
    schemaVersion: '1.0',
    groupId: 'rounds-group',
    rootAuthorityRef: rootAuthorityReferenceV2(root),
    controller: { id: 'rounds-controller', generation: 1 },
    topology: { kind: 'independent-advisory' },
    policy: {
      reference: root.revisions.policy,
      maxRounds: 1,
      maxAttempts: 1,
      maxConcurrent: 1,
    },
    seats: [
      {
        seatId: 'seat',
        envelope: {
          id: envelope.envelope_id,
          generation: 0,
          digest: delegationEnvelopeDigestV2(envelope),
        },
        effect: 'report',
        allocation: { inputTokens: 100, outputTokens: 10, costMicros: 1000 },
      },
    ],
  };
  const command = {
    kind: 'create',
    groupId: spec.groupId,
    operationKey: 'create-rounds',
    expectedRevision: 0,
    controller: spec.controller,
    spec,
  };
  expect((await first.controller.create(command)).projection.revision).toBe(1);
  expect((await first.controller.create(command)).replayed).toBe(true);
  const snapshot = await f.persistence.readReportExecution(
    spec.groupId,
    root.authority_id,
    f.finalizeCurrent,
  );
  expect(snapshot.group?.spec).toEqual(spec);
  expect(snapshot.authority?.epochs[0].root).toEqual(root);
  const noOpReadbacks = [
    {
      directory: 'station-rounds-authorities-v3',
      id: root.authority_id,
      read: (duringRead: () => void) =>
        first.store.transact(root.authority_id, async (ledger) => {
          if (!ledger) throw Error('authority missing');
          duringRead();
          return { ledger, result: 'retained' };
        }),
    },
    {
      directory: 'station-delegation-rounds',
      id: spec.groupId,
      read: (duringRead: () => void) =>
        first.rounds.transact(spec.groupId, async (journal) => {
          if (!journal) throw Error('rounds missing');
          duringRead();
          return { journal, result: 'retained' };
        }),
    },
  ];
  for (const noOp of noOpReadbacks) {
    const file = join(
      f.root,
      noOp.directory,
      `${createHash('sha256').update(noOp.id).digest('hex')}.json`,
    );
    const formatted = `${JSON.stringify(JSON.parse(readFileSync(file, 'utf8')), null, 3)}\n\n`;
    writeFileSync(file, formatted);
    expect(await noOp.read(() => {})).toBe('retained');
    expect(readFileSync(file, 'utf8')).toBe(formatted);
    for (const fault of [
      'rewritten-format',
      'truncated',
      'invalid-utf8',
      'missing',
      'permissions',
      'hard-link',
      'symlink',
    ] as const) {
      const alias = `${file}.readback-alias`;
      let faultApplied = false;
      try {
        await expect(
          noOp.read(() => {
            if (fault === 'rewritten-format')
              writeFileSync(file, `${formatted} `);
            else if (fault === 'truncated') writeFileSync(file, '{');
            else if (fault === 'invalid-utf8')
              writeFileSync(file, Buffer.from([0xff]));
            else if (fault === 'missing') unlinkSync(file);
            else if (fault === 'hard-link') linkSync(file, alias);
            else if (fault === 'symlink') {
              writeFileSync(alias, formatted, { mode: 0o600 });
              unlinkSync(file);
              symlinkSync(alias, file);
            } else chmodSync(file, 0o644);
            faultApplied = true;
          }),
        ).rejects.toThrow();
        expect(faultApplied).toBe(true);
      } finally {
        if (fault === 'symlink' && faultApplied) unlinkSync(file);
        if (existsSync(alias)) unlinkSync(alias);
        writeFileSync(file, formatted, { mode: 0o600 });
        chmodSync(file, 0o600);
      }
    }
    expect(await noOp.read(() => {})).toBe('retained');
  }
  await expect(
    first.controller.create({
      ...command,
      groupId: 'second-rounds',
      operationKey: 'second-rounds',
      spec: { ...spec, groupId: 'second-rounds' },
    }),
  ).rejects.toThrow('delegation_group_authority_custody_conflict');
  const legacyController = createDelegationGroupControllerV2({
    store: f.persistence.groupStore(f.finalizeCurrent),
    authorityService: first.service,
    dispatchLedger: new FileAuthorizationLedger({
      root: join(f.root, 'rounds-dispatch'),
    }),
    host: {
      authorize: async () => reference('fixture-legacy-caller'),
      executionHost: () => {
        throw Error('no execution');
      },
      retainMemberOutcome: async () => {
        throw Error('no member');
      },
      retainRunObservation: async () => {
        throw Error('no run');
      },
      retainRunFailure: async () => {
        throw Error('no run');
      },
      requestDescendantCancellation: async () => {
        throw Error('no cancellation');
      },
    },
  });
  const legacySpec: DelegationGroupSpecV2 = {
    ...spec,
    schemaVersion: '2.0',
    groupId: 'legacy-alias',
    policy: { reference: root.revisions.policy, maxConcurrent: 1 },
    seats: spec.seats.map((seat) => ({ ...seat, stepId: null })),
  };
  await expect(
    legacyController.create({
      kind: 'create',
      groupId: legacySpec.groupId,
      operationKey: 'legacy-alias',
      expectedRevision: 0,
      controller: spec.controller,
      spec: legacySpec,
    }),
  ).rejects.toThrow('delegation_group_authority_custody_conflict');
  let crossedGroupBody = false;
  await expect(
    f.persistence
      .groupStore(f.finalizeCurrent)
      .transact(spec.groupId, async () => {
        crossedGroupBody = true;
        throw Error('must not enter');
      }),
  ).rejects.toThrow('delegation_group_protocol_conflict');
  expect(crossedGroupBody).toBe(false);
  const runtime = new StationRuntime({ projectHomeDir: f.root });
  const eventStoreClose = vi.spyOn(
    Reflect.get(runtime, 'orchestrationEventStore'),
    'close',
  );
  const participant = Reflect.get(
    runtime,
    'runtimePublicationParticipant',
  ) as RuntimePublicationParticipant;
  let reached!: () => void;
  let resume!: () => void;
  const bodyDone = new Promise<void>((resolve) => {
    reached = resolve;
  });
  const barrier = new Promise<void>((resolve) => {
    resume = resolve;
  });
  const blocked = participant.run(async (lease) => {
    const real = f.persistence.roundsStore(() => {
      f.finalizeCurrent();
      lease.assertCurrent();
      return undefined;
    }, preparationCurrent);
    const blocking: typeof real = {
      transact: (groupId, body) =>
        real.transact(groupId, async (journal) => {
          const next = await body(journal);
          reached();
          await barrier;
          return next;
        }),
    };
    return compose(blocking).controller.cancel({
      kind: 'cancel',
      groupId: spec.groupId,
      operationKey: 'cancel-rounds',
      expectedRevision: 1,
      controller: spec.controller,
    });
  });
  let shutdown: Promise<void> | undefined;
  try {
    await bodyDone;
    shutdown = runtime.shutdown();
    expect(() => participant.acquire()).toThrow('publication');
    expect(eventStoreClose).not.toHaveBeenCalled();
    expect(() => acquireStationHomeMaintenanceLease(f.root)).toThrow(
      StationHomeActiveError,
    );
  } finally {
    resume();
  }
  await blocked;
  await shutdown;
  expect(eventStoreClose).toHaveBeenCalledOnce();
  const maintenance = acquireStationHomeMaintenanceLease(f.root);
  maintenance.release();
  const reopened = compose();
  expect((await reopened.controller.get(spec.groupId)).cancellation).toBe(
    'requested',
  );
  expect((await reopened.controller.get(spec.groupId)).attempts).toEqual([]);
  const actual = await reopened.service.inspect(root.authority_id);
  expect(actual.cancelled).toBe(true);
  expect(actual.invocations).toEqual([
    {
      invocationId: 'rounds-invoke',
      envelopeId: envelope.envelope_id,
      allocation: { inputTokens: 100, outputTokens: 10, costMicros: 1000 },
      usage: null,
      terminal: false,
    },
  ]);
  expect(readFileSync(f.file)).toEqual(legacyBytes);
  let entered = false;
  await expect(
    reopened.store.transact('authority', async () => {
      entered = true;
      throw Error('must not enter');
    }),
  ).rejects.toThrow('delegation_authority_custody_conflict');
  expect(entered).toBe(false);
  await expect(
    f.store.transact(root.authority_id, async () => {
      entered = true;
      throw Error('must not enter');
    }),
  ).rejects.toThrow('delegation_authority_custody_conflict');
  expect(entered).toBe(false);
  await expect(
    reopened.rounds.transact(spec.groupId, async (journal) => {
      if (!journal) throw Error('journal missing');
      return {
        journal: { ...journal, events: journal.events.slice(0, 1) },
        result: undefined,
      };
    }),
  ).rejects.toThrow('delegation_journal_history_changed');
  await expect(
    reopened.store.transact(root.authority_id, async (ledger) => {
      if (!ledger) throw Error('ledger missing');
      return {
        ledger: { ...ledger, cancelled: false, revision: ledger.revision + 1 },
        result: undefined,
      };
    }),
  ).rejects.toThrow('delegation_rounds_authority_history_changed');
  preparationActive = false;
  let staleBodyEntered = false;
  await expect(
    reopened.rounds.transact(spec.groupId, async () => {
      staleBodyEntered = true;
      throw Error('stale preparation entered group body');
    }),
  ).rejects.toThrow('preparation-changed');
  await expect(
    reopened.store.transact(root.authority_id, async () => {
      staleBodyEntered = true;
      throw Error('stale preparation entered authority body');
    }),
  ).rejects.toThrow('preparation-changed');
  expect(staleBodyEntered).toBe(false);
  preparationActive = true;
  await expect(
    reopened.rounds.transact(spec.groupId, async (journal) => {
      if (!journal) throw Error('journal missing');
      await Promise.resolve();
      preparationActive = false;
      return { journal, result: undefined };
    }),
  ).rejects.toThrow('preparation-changed');
  preparationActive = true;
  await expect(
    reopened.store.transact(root.authority_id, async (ledger) => {
      if (!ledger) throw Error('ledger missing');
      await Promise.resolve();
      preparationActive = false;
      return { ledger, result: undefined };
    }),
  ).rejects.toThrow('preparation-changed');
  preparationActive = true;
  expect((await reopened.controller.get(spec.groupId)).cancellation).toBe(
    'requested',
  );
  f.revoke();
  await expect(reopened.controller.get(spec.groupId)).rejects.toThrow(
    'actual-request-revoked',
  );
  expect(readFileSync(f.file)).toEqual(legacyBytes);
});

test('v2 and new-rounds authority publication share exclusive custody before either file exists', async () => {
  const f = fixture();
  let entered!: () => void, release!: () => void;
  const entry = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const first = f.store.transact('authority', async () => {
    entered();
    await held;
    return { ledger: f.ledger, result: undefined };
  });
  await entry;
  let crossed = false;
  const second = f.persistence
    .roundsAuthorityStore(f.finalizeCurrent)
    .transact('authority', async () => {
      crossed = true;
      throw Error('competing writer entered');
    });
  const observed = second.then(
    () => null,
    (error) => error,
  );
  try {
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(crossed).toBe(false);
  } finally {
    release();
    await first;
    await observed;
  }
  expect((await observed)?.code).toBe('delegation_authority_custody_conflict');
  expect(crossed).toBe(false);
});

test('interrupt intent reads and replay remain available during settlement and later acknowledgement preserves concurrent seats', async () => {
  const root = makeTempDir('report-interrupt-lock-');
  const store = new StationDelegationPersistence(root);
  const current = (): undefined => undefined;
  const intent: ReportInterruptRecord = {
    intent: {
      groupId: 'group:interrupt',
      operationId: 'cancel',
      hostId: 'host',
      principalId: 'operator',
      admissionSignature: 'A'.repeat(43),
      seatId: 'left',
      taskId: 'task:left',
      clientTurnId: 'client:left',
      sessionId: 'task:left',
      turnId: 'turn:left',
    },
    acknowledgement: null,
    signature: 'A'.repeat(43),
  };
  let signalEntered!: () => void;
  const entered = new Promise<void>((resolve) => {
    signalEntered = resolve;
  });
  let releaseAck!: () => void;
  const acknowledgementGate = new Promise<void>((resolve) => {
    releaseAck = resolve;
  });
  let effects = 0;
  const first = store.recordReportInterrupt(intent, current, async () => {
    effects++;
    signalEntered();
    await acknowledgementGate;
    return {
      ...intent,
      acknowledgement: { outcome: 'no-active-turn', threadId: 'task:left' },
    };
  });
  await entered;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const concurrent = (async () => {
    expect(
      await store.readReportInterrupt('group:interrupt', 'left', current),
    ).toEqual(intent);
    const replay = await store.recordReportInterrupt(
      intent,
      current,
      async () => {
        effects++;
        throw Error('replay must not issue');
      },
    );
    expect(replay).toEqual({ record: intent, replayed: true });
    const right: ReportInterruptRecord = {
      ...intent,
      intent: {
        ...intent.intent,
        seatId: 'right',
        taskId: 'task:right',
        sessionId: 'task:right',
        turnId: 'turn:right',
        clientTurnId: 'client:right',
      },
    };
    await store.recordReportInterrupt(right, current, async () => ({
      ...right,
      acknowledgement: {
        outcome: 'no-active-turn',
        threadId: 'task:right',
      },
    }));
  })();
  try {
    await Promise.race([
      concurrent,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () =>
            reject(Error('interrupt intent unavailable until effect settled')),
          10_000,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    releaseAck();
    await first;
    await concurrent;
  }
  expect(effects).toBe(1);
  expect(
    (await store.readReportInterrupt('group:interrupt', 'left', current))
      ?.acknowledgement?.threadId,
  ).toBe('task:left');
  expect(
    (await store.readReportInterrupt('group:interrupt', 'right', current))
      ?.acknowledgement?.threadId,
  ).toBe('task:right');
});

test.each(['after-finalizer', 'inside-body', 'queued'] as const)(
  'post-home acquisition execution read drains a separate publisher paused %s',
  {
    timeout: 30_000,
  },
  async (phase) => {
    const f = fixture();
    mkdirSync(join(f.root, 'security'), { mode: 0o700 });
    const barrier = join(f.root, 'publisher-paused');
    const resume = join(f.root, 'publisher-resume');
    const outcome = join(f.root, 'publisher-outcome');
    const ledger = {
      schemaVersion: '3.0',
      revision: 1,
      maxRenewals: 0,
      importedFromV2: null,
      epochs: [{ root: f.authorityRoot, envelopes: [], renewal: null }],
      cancelled: false,
      invocations: [],
      origins: [],
    };
    const payload = join(f.root, 'publisher-input.json');
    writeFileSync(payload, JSON.stringify(ledger));
    const source = `
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join, dirname } from 'node:path';


const root = fs.realpathSync(process.argv[1]);
const phase = process.argv[2];
const rename = fs.renameSync;
fs.renameSync = (from, to) => {
  if (phase === 'after-finalizer' && dirname(String(to)) === join(root, 'station-rounds-authorities-v3')) {
    fs.writeFileSync(join(root, 'publisher-paused'), 'after-finalizer');
    const end = Date.now() + 20000;
    while (!fs.existsSync(join(root, 'publisher-resume'))) {
      if (Date.now() > end) throw Error('publication barrier was not released');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
  }
  return rename(from, to);
};
syncBuiltinESMExports();
const { StationDelegationPersistence } = await import(${JSON.stringify(new URL('../delegation-group-persistence.ts', import.meta.url).href)});
const { HomeWriterOwner, HomeWriterUnavailableError } = await import(${JSON.stringify(new URL('../../ssh/home-writer-owner.ts', import.meta.url).href)});
const owner = await HomeWriterOwner.forHome(root);
const persistence = new StationDelegationPersistence(root);
try {
  await persistence.roundsAuthorityStore(() => owner.runSynchronous(() => undefined))
    .transact('authority', async () => {
      if (phase === 'inside-body') {
        fs.writeFileSync(join(root, 'publisher-paused'), 'inside-body');
        const end = Date.now() + 20000;
        while (!fs.existsSync(join(root, 'publisher-resume'))) {
          if (Date.now() > end) throw Error('transaction barrier was not released');
          await new Promise(resolve => setTimeout(resolve, 10));
        }
      }
      return { ledger: JSON.parse(fs.readFileSync(join(root, 'publisher-input.json'), 'utf8')), result: undefined };
    });
  throw Error('publisher disclosed success under a foreign home hold');
} catch (error) {
  if (!(error instanceof HomeWriterUnavailableError)) throw error;
  fs.writeFileSync(join(root, 'publisher-outcome'), 'authority-refused');
}
`;
    let queuedRelease: (() => Promise<void>) | undefined;
    let child: ReturnType<typeof executeOwnedProcess> | undefined;
    let hold: Awaited<ReturnType<HomeWriterOwner['acquire']>> | undefined;
    let pending: Promise<unknown> | undefined;
    const failures: unknown[] = [];
    try {
      queuedRelease =
        phase === 'queued'
          ? await acquireFileMutationLockAsync(
              join(f.root, 'station-delegation-authorities.mutation'),
            )
          : undefined;
      const started = executeOwnedProcess(
        process.execPath,
        ['--import', 'tsx', '--input-type=module', '-e', source, f.root, phase],
        spawn,
        'Accounting domain publisher',
        { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] },
      );
      child = started;
      let childError = '';
      started.child.stderr?.on('data', (chunk) => {
        childError = (childError + String(chunk)).slice(-16_384);
      });
      await vi.waitFor(
        () => {
          const admitted =
            phase === 'queued'
              ? readdirSync(f.root).some(
                  (name) =>
                    name.startsWith(
                      'station-delegation-authorities.mutation.',
                    ) &&
                    name.endsWith('.tmp') &&
                    JSON.parse(readFileSync(join(f.root, name), 'utf8')).pid ===
                      started.child.pid,
                )
              : existsSync(barrier);
          expect(admitted, childError).toBe(true);
        },
        { timeout: 15_000 },
      );
      const owner = await HomeWriterOwner.forHome(f.root);
      const acquired = await owner.acquire();
      hold = acquired;
      let disclosed = false;
      const read = f.persistence
        .readReportExecution('group', 'authority', () =>
          owner.runWithLease(acquired, () => undefined),
        )
        .then(
          (value) => {
            disclosed = true;
            return { value };
          },
          (error: unknown) => {
            disclosed = true;
            return { error };
          },
        );
      pending = read;
      const waiting = () =>
        readdirSync(f.root).some(
          (name) =>
            name.startsWith('station-delegation-authorities.mutation.') &&
            name.endsWith('.tmp') &&
            JSON.parse(readFileSync(join(f.root, name), 'utf8')).pid ===
              process.pid,
        );
      await vi.waitFor(() => expect(disclosed || waiting()).toBe(true), {
        timeout: 5000,
      });
      expect(disclosed).toBe(false);
      writeFileSync(resume, 'publish');
      await queuedRelease?.();
      queuedRelease = undefined;
      const drained = await read;
      if ('error' in drained) throw drained.error;
      expect(drained.value.authority).toEqual(
        phase === 'after-finalizer' ? ledger : null,
      );
      expect(await started.completion).toMatchObject({
        status: 0,
        signal: null,
      });
      expect(readFileSync(outcome, 'utf8')).toBe('authority-refused');
    } catch (error) {
      failures.push(error);
    } finally {
      const cleanup = [
        () => {
          writeFileSync(resume, 'cleanup');
        },
        () => queuedRelease?.(),
        async () => {
          if (!child) return;
          const result = await terminateSuiteExecution(child, {
            processLabel: 'Accounting domain publisher',
            waitForSuiteSettlement,
            terminationGraceMs: 1000,
            terminationForceMs: 1000,
          });
          expect(result).toMatchObject({ settled: true, errors: [] });
        },
        () => pending,
        () => hold?.release(),
      ];
      for (const settle of cleanup) {
        try {
          await settle();
        } catch (error) {
          failures.push(error);
        }
      }
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length)
      throw new AggregateError(
        failures,
        'Accounting publisher custody did not settle',
      );
  },
);

test('continuation receipt retention returns exact authenticated canonical bytes', async () => {
  const f = fixture();
  const value = { z: [1, 'text'], a: { status: 'unknown' } };
  const first = await f.persistence.retainReportContinuation(
    'group-1',
    value,
    f.finalizeCurrent,
  );
  const replay = await f.persistence.retainReportContinuation(
    'group-1',
    { a: { status: 'unknown' }, z: [1, 'text'] },
    f.finalizeCurrent,
  );
  expect(replay).toEqual(first);
  expect(first.digest).toBe(`sha256:${digest(value)}`);
  expect(
    await f.persistence.loadReportContinuation(
      'group-1',
      first,
      f.finalizeCurrent,
    ),
  ).toBe(canonicalJson(value));
  await expect(
    f.persistence.loadReportContinuation(
      'other-group',
      first,
      f.finalizeCurrent,
    ),
  ).rejects.toThrow();
  await expect(
    f.persistence.loadReportContinuation(
      'group-1',
      { ...first, digest: `sha256:${'0'.repeat(64)}` },
      f.finalizeCurrent,
    ),
  ).rejects.toThrow();
  await expect(
    f.persistence.loadReportContinuation(
      'group-1',
      { ...first, domain: 'foreign' },
      f.finalizeCurrent,
    ),
  ).rejects.toThrow();
});
