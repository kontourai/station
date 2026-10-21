import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import filesystem from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  DelegationExecutionBindingV2,
  RootAuthorityV2,
} from '@kontourai/flow-agents/delegation-authority-contract';
import {
  type DelegationEnvelopeV2,
  delegationEnvelopeDigestV2,
  rootAuthorityReferenceV2,
} from '@kontourai/flow-agents/delegation-envelope-v2';
import type { DelegationGroupSpecV2 } from '@kontourai/flow-agents/delegation-group-v2';
import { canonicalJson } from '@kontourai/relay';
import { sessionReadAuthorityFromRequest } from '@kontourai/station-contracts/tenancy';
import * as lifecycle from '@kontourai/station-shared/lifecycle-events';
import { Hono } from 'hono';
import { afterEach, expect, test, vi } from 'vitest';
import { createDelegationGroupRoutes } from '../../../routes/orchestration/delegation-groups.js';
import { createOrchestrationRequestPrincipalResolver } from '../../../runtime/bootstrap/orchestration-request-principal.js';
import {
  bindRuntimeLocalOperator,
  setRuntimeAuthenticatedRequestPrincipal,
} from '../../../security/runtime-request-security.js';
import {
  LOCAL_OPERATOR_PRINCIPAL_ID,
  resolvePrincipal,
} from '../../identity/principal-resolver.js';
import { EnvironmentSecurityService } from '../../ssh/environment-security-service.js';
import { DelegationGroupRuntime } from '../delegation-group-runtime.js';
import { EventBus } from '../event-bus.js';

// Runtime owner tests use a real local-grant Request on an existing scoped ingress.
// Group HTTP scope/mount acceptance belongs to the serving composition tests.
const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  syncBuiltinESMExports();
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
const sha = (value: unknown) =>
  createHash('sha256').update(canonicalJson(value)).digest('hex');
const ref = (id: string) => ({
  id,
  domain: 'fixture.observation',
  digest: `sha256:${sha(id)}`,
});

async function fixture() {
  const directory = realpathSync(
    mkdtempSync(join(tmpdir(), 'station-group-runtime-')),
  );
  roots.push(directory);
  const privateRoot = join(directory, 'groups');
  mkdirSync(privateRoot, { mode: 0o700 });
  mkdirSync(join(privateRoot, 'prepared'), { mode: 0o700 });
  const security = new EnvironmentSecurityService({
    homeDir: join(directory, 'security'),
  });
  const { credential: operatorCredential } = await security.initialize();
  const offer = security.devicePairing.createOffer({
    endpoint: 'http://127.0.0.1',
  });
  const request = security.devicePairing.requestPairing({
    requesterPosition: 'off-box',
    offerId: offer.offerId,
    proof: offer.challenge,
    deviceName: 'Group fixture',
  });
  security.devicePairing.confirmRequest(request.requestId, {
    kind: 'local-grant',
  });
  const local = security.devicePairing.exchange({
    offerId: offer.offerId,
    proof: offer.challenge,
    requestId: request.requestId,
    locality: 'home-possession',
    mintKind: 'local-grant',
  });
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
  const observed: DelegationExecutionBindingV2 = {
    runtime: {
      runtime_receipt_ref: ref('runtime'),
      model_receipt_ref: ref('model'),
      required_capabilities: [],
    },
    source: {
      repository_id: 'repository',
      source_state_id: 'source-revision',
      dirty_state_fingerprint: null,
      execution_worktree_id: 'worktree',
      source_admission_receipt: ref('source-admission'),
    },
    flow_binding: { status: 'unbound', reason: 'independent-advisory' },
  };
  const root: RootAuthorityV2 = {
    schema_version: '2.0',
    authority_id: 'group-fixture',
    authority_epoch: 1,
    issuer_host_id: 'fixture-host',
    authenticated_principal_ref: ref(LOCAL_OPERATOR_PRINCIPAL_ID),
    authenticated_subject_ref: ref(LOCAL_OPERATOR_PRINCIPAL_ID),
    source_origin: {
      repository_id: 'repository',
      worktree_id: 'worktree',
      source_state_id: 'source-revision',
      dirty_state_fingerprint: null,
    },
    execution_worktree_ids: ['worktree'],
    execution_grants: [
      { ...observed, grant_id: 'grant', authority_ceiling: authority },
    ],
    delegation_ceiling: authority,
    budget,
    revisions: {
      policy: ref('policy'),
      prompt: ref('prompt'),
      rubric: ref('rubric'),
    },
    root_trace: { trace_id: 'trace', span_id: 'span' },
    root_cancellation_ref: ref('cancellation'),
  };
  const envelope: DelegationEnvelopeV2 = {
    schema_version: '2.0',
    envelope_id: 'envelope',
    generation: 0,
    parent: null,
    root_authority_ref: rootAuthorityReferenceV2(root),
    execution_id: 'execution',
    actor: root.authenticated_principal_ref,
    assignment_subject: root.authenticated_subject_ref,
    trace_id: 'trace',
    span_id: 'span',
    parent_span_id: null,
    selected_grant_id: 'grant',
    remaining_allowed_grant_ids: [],
    execution_binding: observed,
    delegation_ceiling: authority,
    execution_authority: authority,
    budget,
    continuation_ref: ref('continuation'),
    cancellation_ref: root.root_cancellation_ref,
  };
  const spec: DelegationGroupSpecV2 = {
    schemaVersion: '2.0',
    groupId: root.authority_id,
    rootAuthorityRef: rootAuthorityReferenceV2(root),
    controller: { id: 'controller', generation: 1 },
    policy: { reference: root.revisions.policy, maxConcurrent: 1 },
    topology: { kind: 'independent-advisory' },
    seats: [
      {
        seatId: 'reviewer',
        envelope: {
          id: envelope.envelope_id,
          generation: 0,
          digest: delegationEnvelopeDigestV2(envelope),
        },
        stepId: null,
        effect: 'report',
        allocation: { inputTokens: 100, outputTokens: 10, costMicros: 1000 },
      },
    ],
  };
  const prepared = {
    version: 1,
    groupId: spec.groupId,
    subjectConversationId: null,
    callerLineageDigest: null,
    hostId: 'fixture-host',
    root,
    envelopes: [envelope],
    spec,
    slots: [
      {
        seatId: 'reviewer',
        taskId: 'task:fixture',
        conversationId: 'conversation',
        sessionId: 'session',
        clientTurnId: 'client-turn',
        invocationId: 'station-invocation',
      },
    ],
  };
  const preparationPath = join(
    privateRoot,
    'prepared',
    `${sha(spec.groupId)}.json`,
  );
  writeFileSync(preparationPath, JSON.stringify(prepared), { mode: 0o600 });
  const current = structuredClone(observed);
  const readMemberEvents = vi.fn(async () => null);
  const owners = {
    privateRoot,
    eventBus: new EventBus(),
    hostId: 'fixture-host',
    security,
    resolveDelegation: async () => undefined,
    readAuthority: (_request: Request, principal: { id: string }) =>
      sessionReadAuthorityFromRequest(principal.id, undefined, undefined, {
        localHomePossession: true,
      }),
    currentExecutionBinding: async () => structuredClone(current),
    orchestration: {
      readSessionEventPage: readMemberEvents,
      inspectAttentionRequest: () => null,
    },
    flow: {
      confirmClaim: async () => {
        throw new Error('No Flow claim in advisory fixture');
      },
      recordScheduleEvent: async () => {
        throw new Error('No Flow schedule in advisory fixture');
      },
      recordMemberOutcome: async () => {
        throw new Error('No Flow member in advisory fixture');
      },
    },
  };
  const appFor = (runtime: DelegationGroupRuntime) => {
    const app = new Hono();
    app.use('*', async (c, next) => {
      const credential =
        c.req.header('Authorization')?.replace(/^Bearer /, '') ?? '';
      if (
        security.authorizeCredential(credential, {
          method: c.req.method,
          path: c.req.path,
        })
      ) {
        setRuntimeAuthenticatedRequestPrincipal(c.req.raw, {
          kind: 'credential',
          credential,
          authority: security.verifyOperatorCredential(credential)
            ? 'operator-credential'
            : 'device-credential',
          source: 'bearer',
          deviceId: security.identifyDevice(credential)?.id,
          locality: security.credentialLocality(credential),
          mintKind: security.credentialMintKind(credential),
        });
        bindRuntimeLocalOperator(c.req.raw);
      }
      await next();
    });
    app.route(
      '/api/orchestration/groups',
      createDelegationGroupRoutes(
        runtime,
        createOrchestrationRequestPrincipalResolver({
          environmentSecurityService: security,
        }),
      ),
    );
    return app;
  };
  let runtime = new DelegationGroupRuntime(owners);
  let app = appFor(runtime);
  return {
    directory,
    privateRoot,
    prepared,
    owners,
    readMemberEvents,
    get runtime() {
      return runtime;
    },
    principal: resolvePrincipal(
      null,
      'personal',
      { locality: 'home-possession' },
      undefined,
    ),
    hostRequest: (signal?: AbortSignal) => {
      const request = new Request(
        'http://127.0.0.1/api/orchestration/chat/delegated',
        { method: 'POST', signal },
      );
      expect(
        security.authorizeCredential(local.credential, {
          method: request.method,
          path: new URL(request.url).pathname,
        }),
      ).toBe(true);
      setRuntimeAuthenticatedRequestPrincipal(request, {
        kind: 'credential',
        credential: local.credential,
        authority: 'device-credential',
        source: 'bearer',
        deviceId: security.identifyDevice(local.credential)?.id,
        locality: security.credentialLocality(local.credential),
        mintKind: security.credentialMintKind(local.credential),
      });
      expect(bindRuntimeLocalOperator(request)).toBe(true);
      return request;
    },
    replacePreparation: () => {
      const replacement = structuredClone(prepared);
      replacement.slots[0].sessionId = 'replacement-session';
      writeFileSync(preparationPath, JSON.stringify(replacement));
    },
    restorePreparation: () => {
      writeFileSync(preparationPath, JSON.stringify(prepared));
    },
    request: (
      path: string,
      method = 'GET',
      body?: unknown,
      credential = local.credential,
    ) =>
      app.request(`http://127.0.0.1/api/orchestration/groups${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${credential}`,
          'Content-Type': 'application/json',
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    operatorCredential,
    drift: () => {
      current.source.source_state_id = 'different-revision';
    },
    reopen: () => {
      runtime = new DelegationGroupRuntime(owners);
      app = appFor(runtime);
    },
  };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;
const createInput = {
  preparationId: 'group-fixture',
  operationId: 'create-1',
};
const authorityDomain = 'station-delegation-authorities';
const groupDomain = 'station-delegation-groups';
const recordFile = (f: Fixture, domain: string) =>
  join(
    f.privateRoot,
    domain,
    `${createHash('sha256').update('group-fixture').digest('hex')}.json`,
  );
const records = (f: Fixture, domain: string) => {
  const directory = join(f.privateRoot, domain);
  return existsSync(directory)
    ? readdirSync(directory).filter((name) => name.endsWith('.json'))
    : [];
};
const create = (f: Fixture, request = f.hostRequest()) =>
  f.runtime.create(request, f.principal, createInput);

function invalidateAfterStaging(
  f: Fixture,
  domain: string,
  invalidate: () => void,
) {
  const open = filesystem.open;
  let staged = 0;
  vi.spyOn(filesystem, 'open').mockImplementation(async (...args) => {
    const descriptor = await open(...args);
    if (
      String(args[0]).startsWith(`${recordFile(f, domain)}.`) &&
      String(args[0]).endsWith('.tmp')
    ) {
      const sync = descriptor.sync.bind(descriptor);
      vi.spyOn(descriptor, 'sync').mockImplementation(async () => {
        await sync();
        staged++;
        invalidate();
      });
    }
    return descriptor;
  });
  syncBuiltinESMExports();
  return () => staged;
}

test('actual public controller persists create/get/list/events/replay/cancel with private custody', async () => {
  const f = await fixture();
  const created = await create(f);
  expect(created).toMatchObject({
    replayed: false,
    group: {
      groupId: 'group-fixture',
      revision: 1,
      execution: 'idle',
      cancellation: 'none',
      terminal: 'unproven',
      executionCapability: { status: 'unavailable' },
      members: [{ sessionId: 'session', providerTurnId: null }],
    },
  });
  const authorityBefore = readFileSync(recordFile(f, authorityDomain), 'utf8');
  const groupBefore = readFileSync(recordFile(f, groupDomain), 'utf8');
  const bindingsFile = join(
    f.privateRoot,
    'delegation-group-bindings',
    'bindings.json',
  );
  const bindingsBefore = readFileSync(bindingsFile, 'utf8');
  const bindings = JSON.parse(bindingsBefore).records;
  expect(bindings).toHaveLength(1);
  expect(bindings[0]).toMatchObject({
    binding: { groupId: 'group-fixture', sessionId: 'session' },
    state: 'reserved',
    revision: 1,
    providerTurnId: null,
  });
  expect(JSON.parse(authorityBefore)).toMatchObject({
    cancelled: false,
    envelopes: [{ envelope_id: 'envelope' }],
    invocations: [],
  });
  expect(JSON.parse(groupBefore)).toMatchObject({
    groupId: 'group-fixture',
    events: [{ revision: 1, kind: 'created' }],
  });
  expect(records(f, authorityDomain)).toHaveLength(1);
  expect(records(f, groupDomain)).toHaveLength(1);
  for (const domain of [authorityDomain, groupDomain]) {
    const directory = lstatSync(join(f.privateRoot, domain));
    const record = lstatSync(recordFile(f, domain));
    expect(directory.mode & 0o7777).toBe(0o700);
    expect(record.mode & 0o7777).toBe(0o600);
    expect(record.uid).toBe(process.getuid?.());
    expect(record.nlink).toBe(1);
  }
  for (const legacy of ['delegation-authorities', 'delegation-groups-v2'])
    expect(existsSync(join(f.privateRoot, legacy))).toBe(false);
  f.reopen();
  expect(await create(f)).toEqual({ ...created, replayed: true });
  expect(
    await f.runtime.get(f.hostRequest(), f.principal, 'group-fixture'),
  ).toEqual(created.group);
  expect(await f.runtime.list(f.hostRequest(), f.principal)).toMatchObject({
    groups: [created.group],
    hasMore: false,
  });
  expect(
    await f.runtime.events(f.hostRequest(), f.principal, 'group-fixture', 0),
  ).toMatchObject({
    events: [{ kind: 'created', revision: 1 }],
    nextRevision: 1,
    hasMore: false,
  });
  expect(readFileSync(recordFile(f, authorityDomain), 'utf8')).toBe(
    authorityBefore,
  );
  expect(readFileSync(recordFile(f, groupDomain), 'utf8')).toBe(groupBefore);
  const cancellation = { operationId: 'cancel-1', expectedRevision: 1 };
  const cancelled = await f.runtime.cancel(
    f.hostRequest(),
    f.principal,
    'group-fixture',
    cancellation,
  );
  expect(cancelled).toMatchObject({
    disposition: 'pending',
    group: { revision: 2, cancellation: 'pending', terminal: 'unproven' },
  });
  const authorityAfter = readFileSync(recordFile(f, authorityDomain), 'utf8');
  const groupAfter = readFileSync(recordFile(f, groupDomain), 'utf8');
  expect(JSON.parse(authorityAfter)).toMatchObject({
    cancelled: true,
    invocations: [],
  });
  expect(
    JSON.parse(groupAfter).events.map((event: { kind: string }) => event.kind),
  ).toEqual(['created', 'cancel_pending']);
  f.reopen();
  expect(
    await f.runtime.cancel(
      f.hostRequest(),
      f.principal,
      'group-fixture',
      cancellation,
    ),
  ).toEqual(cancelled);
  expect(readFileSync(recordFile(f, authorityDomain), 'utf8')).toBe(
    authorityAfter,
  );
  expect(readFileSync(recordFile(f, groupDomain), 'utf8')).toBe(groupAfter);
  expect(records(f, authorityDomain)).toHaveLength(1);
  expect(records(f, groupDomain)).toHaveLength(1);
  expect(readFileSync(bindingsFile, 'utf8')).toBe(bindingsBefore);
  expect(readdirSync(join(f.privateRoot, 'observations'))).toEqual([]);
  expect(f.readMemberEvents).not.toHaveBeenCalled();
});

test.each([
  ['create', authorityDomain],
  ['create', groupDomain],
  ['cancel', authorityDomain],
  ['cancel', groupDomain],
] as const)(
  '%s refuses stale staged %s writes under the actual request finalizer',
  async (operation, domain) => {
    for (const fault of ['abort', 'replacement'] as const) {
      const f = await fixture();
      if (operation === 'cancel') await create(f);
      const baseline = existsSync(recordFile(f, domain))
        ? readFileSync(recordFile(f, domain), 'utf8')
        : null;
      const abort = new AbortController();
      const reason = new Error('request-aborted-after-staging');
      const staged = invalidateAfterStaging(f, domain, () => {
        if (fault === 'abort') abort.abort(reason);
        else f.replacePreparation();
      });
      const request = f.hostRequest(abort.signal);
      const result =
        operation === 'create'
          ? create(f, request)
          : f.runtime.cancel(request, f.principal, 'group-fixture', {
              operationId: 'cancel-1',
              expectedRevision: 1,
            });
      await expect(result).rejects.toMatchObject(
        fault === 'abort'
          ? { message: reason.message }
          : { code: 'group_authority_required' },
      );
      expect(staged()).toBe(1);
      expect(
        existsSync(recordFile(f, domain))
          ? readFileSync(recordFile(f, domain), 'utf8')
          : null,
      ).toBe(baseline);
      expect(readdirSync(join(f.privateRoot, domain))).toEqual(
        baseline === null ? [] : [recordFile(f, domain).split('/').at(-1)],
      );
      expect(records(f, authorityDomain)).toHaveLength(
        operation === 'create' && domain === authorityDomain ? 0 : 1,
      );
      expect(records(f, groupDomain)).toHaveLength(
        operation === 'cancel' ? 1 : 0,
      );
      expect(readdirSync(join(f.privateRoot, 'observations'))).toEqual([]);
      vi.restoreAllMocks();
      syncBuiltinESMExports();
      f.restorePreparation();
      f.reopen();
      if (operation === 'create')
        expect((await create(f)).group.revision).toBe(1);
      else
        expect(
          (await f.runtime.get(f.hostRequest(), f.principal, 'group-fixture'))
            .cancellation,
        ).toBe(domain === authorityDomain ? 'pending' : 'none');
    }
  },
);

test.each([authorityDomain, groupDomain])(
  'captures preparation before awaiting the %s lock',
  async (domain) => {
    const f = await fixture();
    await create(f);
    const baseline = readFileSync(recordFile(f, domain), 'utf8');
    const lock = join(f.privateRoot, `${domain}.mutation`);
    const acquire = lifecycle.acquireFileMutationLockAsync;
    const release = await acquire(lock);
    const reached = new Promise<void>((resolve) => {
      vi.spyOn(lifecycle, 'acquireFileMutationLockAsync').mockImplementation(
        (path, options) => {
          const pending = acquire(path, options);
          if (path === lock) resolve();
          return pending;
        },
      );
    });
    const pending = f.runtime.get(
      f.hostRequest(),
      f.principal,
      'group-fixture',
    );
    const refused = expect(pending).rejects.toMatchObject({
      code: 'group_authority_required',
    });
    try {
      await reached;
      f.replacePreparation();
    } finally {
      await release();
    }
    await refused;
    vi.restoreAllMocks();
    expect(readFileSync(recordFile(f, domain), 'utf8')).toBe(baseline);
  },
);

test.each([
  ['abort', true],
  ['replacement', true],
  ['abort', false],
] as const)(
  'list refuses %s after the scan lock releases (populated=%s)',
  async (fault, populated) => {
    const f = await fixture();
    if (populated) await create(f);
    const baseline = populated
      ? readFileSync(recordFile(f, groupDomain), 'utf8')
      : null;
    const abort = new AbortController();
    const reason = new Error('request-aborted-after-scan-release');
    const acquire = lifecycle.acquireFileMutationLockAsync;
    let released = 0;
    vi.spyOn(lifecycle, 'acquireFileMutationLockAsync').mockImplementation(
      async (path, options) => {
        const release = await acquire(path, options);
        return async () => {
          await release();
          if (path === join(f.privateRoot, `${groupDomain}.mutation`)) {
            released++;
            if (fault === 'abort') abort.abort(reason);
            else f.replacePreparation();
          }
        };
      },
    );
    await expect(
      f.runtime.list(f.hostRequest(abort.signal), f.principal),
    ).rejects.toMatchObject(
      fault === 'abort'
        ? { message: reason.message }
        : { code: 'group_authority_required' },
    );
    expect(released).toBe(1);
    expect(
      existsSync(recordFile(f, groupDomain))
        ? readFileSync(recordFile(f, groupDomain), 'utf8')
        : null,
    ).toBe(baseline);
  },
);

test('routes reject supplied authority and unapproved operator credentials before storage mutation', async () => {
  const f = await fixture();
  expect(
    (
      await f.request('/', 'POST', {
        preparationId: 'group-fixture',
        operationId: 'create-1',
        root: f.prepared.root,
      })
    ).status,
  ).toBe(400);
  expect(
    (
      await f.request(
        '/',
        'POST',
        { preparationId: 'group-fixture', operationId: 'create-1' },
        f.operatorCredential,
      )
    ).status,
  ).toBe(403);
  expect(f.readMemberEvents).not.toHaveBeenCalled();
});
