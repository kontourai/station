import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileAuthorizationLedger } from '@kontourai/dispatch';
import type { RootAuthorityV2 } from '@kontourai/flow-agents/delegation-authority-contract';
import { createDelegationAuthorityService } from '@kontourai/flow-agents/delegation-authority-service';
import {
  type DelegationEnvelopeV2,
  delegationEnvelopeDigestV2,
  rootAuthorityReferenceV2,
} from '@kontourai/flow-agents/delegation-envelope-v2';
import {
  createDelegationGroupControllerV2,
  type DelegationGroupSpecV2,
} from '@kontourai/flow-agents/delegation-group-v2';
import { canonicalJson } from '@kontourai/relay';
import { afterEach, expect, test } from 'vitest';
import { StationDelegationPersistence } from '../delegation-group-persistence.js';

// Requires published built Flow authority/group APIs plus Station finalizeCommit058d.
// No skip, controller mock, downloaded source import, install or provider execution.
const temporary: string[] = [];
afterEach(() => {
  for (const root of temporary.splice(0))
    rmSync(root, { recursive: true, force: true });
});
const digest = (value: unknown) =>
  createHash('sha256').update(canonicalJson(value)).digest('hex');
const reference = (id: string) => ({
  id,
  domain: 'fixture.observation',
  digest: `sha256:${digest(id)}`,
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'station-delegation-persistence-'));
  temporary.push(root);
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

test('revocation after actual temp staging refuses publication at final rename boundary', async () => {
  const f = fixture();
  let staged = false;
  const store = f.persistence.authorityStore(() => {
    const directory = join(f.root, 'station-delegation-authorities');
    if (
      existsSync(directory) &&
      readdirSync(directory).some((name) => name.endsWith('.tmp'))
    ) {
      staged = true;
      f.revoke();
    }
    return f.finalizeCurrent();
  });
  await expect(
    store.transact('authority', async () => ({
      ledger: f.ledger,
      result: undefined,
    })),
  ).rejects.toThrow('actual-request-revoked');
  expect(staged).toBe(true);
  expect(existsSync(f.file)).toBe(false);
});

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
});
