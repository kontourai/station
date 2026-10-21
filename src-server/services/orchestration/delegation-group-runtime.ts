import { createHash } from 'node:crypto';
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { FileAuthorizationLedger } from '@kontourai/dispatch';
import {
  type DelegationExecutionBindingV2,
  type DelegationReferenceV2,
  validateRootAuthorityV2,
} from '@kontourai/flow-agents/delegation-authority-contract';
import type { DelegationAuthorityStore } from '@kontourai/flow-agents/delegation-authority-service';
import { createDelegationAuthorityService } from '@kontourai/flow-agents/delegation-authority-service';
import {
  delegationEnvelopeDigestV2,
  rootAuthorityReferenceV2,
  validateDelegationAncestryV2,
  validateDelegationEnvelopeV2,
} from '@kontourai/flow-agents/delegation-envelope-v2';
import type { DelegationFlowExecutionHost } from '@kontourai/flow-agents/delegation-flow-execution';
import {
  createDelegationGroupControllerV2,
  type DelegationGroupProjectionV2,
  type DelegationGroupSpecV2,
  type DelegationGroupStoreV2,
  type GroupEventV2,
  validateDelegationGroupSpecV2,
} from '@kontourai/flow-agents/delegation-group-v2';
import { canonicalJson, type ModelInvocationRequest } from '@kontourai/relay';
import {
  DELEGATION_GROUP_LIMITS,
  DELEGATION_GROUP_TRANSPORT_VERSION,
  type DelegationGroupEventPage,
  type DelegationGroupMemberEventPage,
  type DelegationGroupView,
} from '@kontourai/station-contracts/delegation-group';
import type { PrincipalRef } from '@kontourai/station-contracts/principal';
import {
  isSessionReadAuthority,
  type SessionReadAuthority,
} from '@kontourai/station-contracts/tenancy';
import { inputRequestFromRequestEvent } from '@kontourai/station-shared/input-request';
import { publishJsonFileWithOwnedLock } from '@kontourai/station-shared/json-file-storage';
import { acquireFileMutationLockAsync } from '@kontourai/station-shared/lifecycle-events';
import { z } from 'zod/v3';
import type { RequestDelegationResolver } from '../../runtime/agents/request-delegation.js';
import { createPersonalRuntimeRequestGuard } from '../../runtime/bootstrap/runtime-tenant-context.js';
import { isOperatorInPersonNotAgent } from '../../security/coding-authority.js';
import {
  type CurrentRuntimeRequestPrincipalSecurity,
  isBoundLocalGrantMintedOperator,
  isRuntimeRequestPrincipalCurrent,
} from '../../security/runtime-request-security.js';
import { stationControlRequestAuthority } from '../../security/station-control-request-authority.js';
import { LOCAL_OPERATOR_PRINCIPAL_ID } from '../identity/principal-resolver.js';
import { DelegationGroupBindingService } from './delegation-group-binding-service.js';
import {
  type DelegationGroupBinding,
  delegationGroupBindingKey,
  FileDelegationGroupBindingStore,
} from './delegation-group-binding-store.js';
import { StationDelegationPersistence } from './delegation-group-persistence.js';
import {
  belongsToAcceptedGroupTurn,
  type GroupPageIterator,
  isActionableGroupRequest,
  pageByBytes,
  watchGroupPages,
} from './delegation-group-transport.js';
import type { EventBus } from './event-bus.js';
import type { OrchestrationService } from './orchestration-service.js';

const publicId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);
const hash = (value: unknown) =>
  createHash('sha256').update(canonicalJson(value)).digest('hex');
const same = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
const privateSlot = z
  .object({
    seatId: publicId,
    taskId: publicId,
    conversationId: publicId,
    sessionId: publicId,
    clientTurnId: publicId,
    invocationId: publicId,
  })
  .strict();
const preparationSchema = z
  .object({
    version: z.literal(1),
    groupId: publicId,
    subjectConversationId: publicId.nullable(),
    hostId: publicId,
    callerLineageDigest: z
      .string()
      .regex(/^sha256:[a-f0-9]{64}$/)
      .nullable(),
    root: z.unknown(),
    envelopes: z.array(z.unknown()).min(1).max(65),
    spec: z.unknown(),
    slots: z.array(privateSlot).min(1).max(64),
  })
  .strict();

export class DelegationGroupRuntimeRefusal extends Error {
  constructor(
    readonly code:
      | 'group_authority_required'
      | 'group_stale'
      | 'group_unavailable'
      | 'group_invalid'
      | 'group_not_found'
      | 'group_cancellation_pending',
  ) {
    super(code);
  }
}
type RequestContext = {
  request: Request;
  principal: PrincipalRef;
  readAuthority: SessionReadAuthority;
  subject: string;
  lineageDigest: string | null;
};
type Prepared = ReturnType<typeof parsePreparation>;

function parsePreparation(value: unknown) {
  const parsed = preparationSchema.parse(value);
  const root = validateRootAuthorityV2(parsed.root);
  const envelopes = parsed.envelopes.map(validateDelegationEnvelopeV2);
  const spec = validateDelegationGroupSpecV2(parsed.spec);
  if (
    root.authority_id !== parsed.groupId ||
    spec.groupId !== parsed.groupId ||
    !same(spec.rootAuthorityRef, rootAuthorityReferenceV2(root)) ||
    parsed.slots.length !== spec.seats.length ||
    new Set(parsed.slots.map((s) => s.seatId)).size !== parsed.slots.length
  )
    throw new DelegationGroupRuntimeRefusal('group_invalid');
  for (const seat of spec.seats) {
    const envelope = envelopes.find((e) => e.envelope_id === seat.envelope.id);
    if (
      !envelope ||
      envelope.generation !== seat.envelope.generation ||
      delegationEnvelopeDigestV2(envelope) !== seat.envelope.digest ||
      !parsed.slots.some((s) => s.seatId === seat.seatId)
    )
      throw new DelegationGroupRuntimeRefusal('group_invalid');
  }
  return { ...parsed, root, envelopes, spec };
}

/** A prepared file is host-authored admission data, never accepted by a route. */
function readPrivateJson(path: string, maxBytes: number): unknown {
  const fd = openSync(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const stat = fstatSync(fd);
    if (
      !stat.isFile() ||
      stat.nlink !== 1 ||
      stat.uid !== process.getuid?.() ||
      (stat.mode & 0o7777) !== 0o600 ||
      stat.size > maxBytes
    )
      throw new DelegationGroupRuntimeRefusal('group_unavailable');
    return JSON.parse(readFileSync(fd, 'utf8'));
  } finally {
    closeSync(fd);
  }
}
function privateDirectory(path: string) {
  const stat = lstatSync(path);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    stat.uid !== process.getuid?.() ||
    (stat.mode & 0o7777) !== 0o700
  )
    throw new DelegationGroupRuntimeRefusal('group_unavailable');
}

export interface DelegationGroupRuntimeOwners {
  /** Isolated host-owned root; all group roots in this host use this ONE custody root. */
  privateRoot: string;
  hostId: string;
  security: CurrentRuntimeRequestPrincipalSecurity;
  resolveDelegation: RequestDelegationResolver;
  readAuthority(
    request: Request,
    principal: PrincipalRef,
  ): SessionReadAuthority;
  /** Actual current inventory/source admission receipt, not configuration existence. */
  currentExecutionBinding(
    grantId: string,
    request: Request,
  ): Promise<DelegationExecutionBindingV2>;
  eventBus: Pick<EventBus, 'subscribe'>;
  orchestration: Pick<
    OrchestrationService,
    'readSessionEventPage' | 'inspectAttentionRequest'
  >;
  flow: Pick<
    DelegationFlowExecutionHost,
    'confirmClaim' | 'recordScheduleEvent' | 'recordMemberOutcome'
  >;
}

// UNWIRED(#91): serving composition and qualified physical execution remain required.
export class DelegationGroupRuntime {
  readonly #personal = createPersonalRuntimeRequestGuard();
  readonly #bindings: FileDelegationGroupBindingStore;
  readonly #persistence: StationDelegationPersistence;
  readonly #dispatchLedger: FileAuthorizationLedger;
  readonly #bindingOwners = new Map<string, string>();
  readonly #rawResults = new Map<string, DelegationReferenceV2>();

  constructor(private readonly owners: DelegationGroupRuntimeOwners) {
    privateDirectory(owners.privateRoot);
    privateDirectory(join(owners.privateRoot, 'prepared'));
    const rawRoot = join(owners.privateRoot, 'observations');
    try {
      mkdirSync(rawRoot, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    privateDirectory(rawRoot);
    this.#bindings = new FileDelegationGroupBindingStore(owners.privateRoot);
    this.#persistence = new StationDelegationPersistence(owners.privateRoot);
    this.#dispatchLedger = new FileAuthorizationLedger({
      root: join(owners.privateRoot, 'dispatch'),
    });
  }

  #load(groupId: string): Prepared {
    publicId.parse(groupId);
    privateDirectory(this.owners.privateRoot);
    privateDirectory(join(this.owners.privateRoot, 'prepared'));
    try {
      const result = parsePreparation(
        readPrivateJson(
          join(this.owners.privateRoot, 'prepared', `${hash(groupId)}.json`),
          1_048_576,
        ),
      );
      if (
        result.groupId !== groupId ||
        result.hostId !== this.owners.hostId ||
        result.root.issuer_host_id !== this.owners.hostId
      )
        throw new DelegationGroupRuntimeRefusal('group_stale');
      return result;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT')
        throw new DelegationGroupRuntimeRefusal('group_not_found');
      throw error;
    }
  }

  #assertRequest(request: Request, principal: PrincipalRef): void {
    if (
      !this.#personal(request) ||
      !isRuntimeRequestPrincipalCurrent(request, this.owners.security)
    )
      throw new DelegationGroupRuntimeRefusal('group_authority_required');
    const caller = stationControlRequestAuthority(request);
    if (caller?.kind === 'caller') {
      if (
        caller.caller.assurance !== 'bound' ||
        caller.caller.principal?.source !== 'session-owner' ||
        caller.caller.principal.id !== principal.id
      )
        throw new DelegationGroupRuntimeRefusal('group_authority_required');
    } else if (
      !isOperatorInPersonNotAgent(request) ||
      !isBoundLocalGrantMintedOperator(request) ||
      principal.id !== LOCAL_OPERATOR_PRINCIPAL_ID
    )
      throw new DelegationGroupRuntimeRefusal('group_authority_required');
  }

  assertAuthority(request: Request, principal: PrincipalRef): void {
    this.#assertRequest(request, principal);
  }

  async #context(
    request: Request,
    principal: PrincipalRef,
  ): Promise<RequestContext> {
    this.#assertRequest(request, principal);
    const caller = stationControlRequestAuthority(request);
    let subject = principal.id;
    let lineageDigest: string | null = null;
    if (caller?.kind === 'caller') {
      const lineage = await this.owners.resolveDelegation(request, {});
      const conversation =
        caller.caller.conversationId ?? caller.caller.sessionId;
      if (
        lineage?.provenance !== 'caller-derived' ||
        lineage.context.parentConversationId !== conversation
      )
        throw new DelegationGroupRuntimeRefusal('group_authority_required');
      subject = conversation;
      lineageDigest = `sha256:${hash(lineage.context)}`;
    }
    const readAuthority = this.owners.readAuthority(request, principal);
    if (
      !isSessionReadAuthority(readAuthority) ||
      readAuthority.mode !== 'personal' ||
      readAuthority.userId !== principal.id
    )
      throw new DelegationGroupRuntimeRefusal('group_authority_required');
    this.#assertRequest(request, principal);
    return { request, principal, readAuthority, subject, lineageDigest };
  }

  /** Host-only integration seam; no route accepts an authority callback. */
  async captureMetadataMutationFence(
    request: Request,
    principal: PrincipalRef,
    groupId: string,
  ): Promise<() => undefined> {
    const context = await this.#context(request, principal);
    const prepared = this.#load(groupId);
    this.#authorize(context, prepared);
    return this.#finalizeCurrent(context, prepared);
  }

  #finalizeCurrent(
    context: RequestContext,
    prepared: Prepared,
  ): () => undefined {
    return (): undefined => {
      context.request.signal.throwIfAborted();
      this.#authorize(context, prepared);
      return undefined;
    };
  }

  #authorize(context: RequestContext, prepared: Prepared): void {
    context.request.signal.throwIfAborted();
    this.#assertRequest(context.request, context.principal);
    if (
      prepared.callerLineageDigest !== context.lineageDigest ||
      prepared.root.authenticated_principal_ref.id !== context.principal.id ||
      prepared.root.authenticated_subject_ref.id !== context.subject ||
      prepared.subjectConversationId !==
        (context.subject === context.principal.id ? null : context.subject) ||
      !same(this.#load(prepared.groupId), prepared)
    )
      throw new DelegationGroupRuntimeRefusal('group_authority_required');
  }

  async #confirmExecution(
    context: RequestContext,
    prepared: Prepared,
    envelope: Prepared['envelopes'][number],
  ): Promise<void> {
    this.#authorize(context, prepared);
    const chain: Prepared['envelopes'] = [];
    const visited = new Set<string>();
    let cursor: typeof envelope | undefined = envelope;
    while (cursor) {
      if (visited.has(cursor.envelope_id))
        throw new DelegationGroupRuntimeRefusal('group_stale');
      visited.add(cursor.envelope_id);
      chain.unshift(cursor);
      const parentId: string | undefined = cursor.parent?.id;
      cursor = parentId
        ? prepared.envelopes.find((e) => e.envelope_id === parentId)
        : undefined;
    }
    validateDelegationAncestryV2(
      prepared.root,
      chain,
      new Date().toISOString(),
    );
    const observed = await this.owners.currentExecutionBinding(
      envelope.selected_grant_id,
      context.request,
    );
    if (!same(observed, envelope.execution_binding))
      throw new DelegationGroupRuntimeRefusal('group_stale');
    this.#authorize(context, prepared);
    validateDelegationAncestryV2(
      prepared.root,
      chain,
      new Date().toISOString(),
    );
  }

  #binding(
    context: RequestContext,
    prepared: Prepared,
    seatId: string,
  ): DelegationGroupBinding {
    const slot = prepared.slots.find((s) => s.seatId === seatId);
    const seat = prepared.spec.seats.find((s) => s.seatId === seatId);
    if (!slot || !seat)
      throw new DelegationGroupRuntimeRefusal('group_invalid');
    return {
      scope: {
        hostId: this.owners.hostId,
        principalId: context.principal.id,
        tenantId: null,
      },
      groupId: prepared.groupId,
      seatId,
      controllerId: prepared.spec.controller.id,
      controllerGeneration: prepared.spec.controller.generation,
      authorityId: prepared.root.authority_id,
      authorityEpoch: prepared.root.authority_epoch,
      authorityDigest: prepared.spec.rootAuthorityRef.digest,
      envelopeId: seat.envelope.id,
      envelopeGeneration: seat.envelope.generation,
      envelopeDigest: seat.envelope.digest,
      taskId: slot.taskId,
      conversationId: slot.conversationId,
      sessionId: slot.sessionId,
      clientTurnId: slot.clientTurnId,
      invocationId: slot.invocationId,
    };
  }

  async #retain(
    context: RequestContext,
    prepared: Prepared,
    value: unknown,
  ): Promise<DelegationReferenceV2> {
    this.#authorize(context, prepared);
    const raw = { version: 1, groupId: prepared.groupId, observation: value };
    const digest = hash(raw);
    const path = join(
      this.owners.privateRoot,
      'observations',
      `${digest}.json`,
    );
    const release = await acquireFileMutationLockAsync(`${path}.mutation`);
    try {
      privateDirectory(join(this.owners.privateRoot, 'observations'));
      this.#authorize(context, prepared);
      await publishJsonFileWithOwnedLock(path, raw, { maxBytes: 1_048_576 });
      const fd = openSync(
        join(this.owners.privateRoot, 'observations'),
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      );
      try {
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      return {
        id: `observation_${digest}`,
        domain: 'station.group-observation',
        digest: `sha256:${digest}`,
      };
    } finally {
      await release();
    }
  }

  #composition(context: RequestContext, initialPrepared?: Prepared) {
    const captures = new Map<string, Prepared>();
    if (initialPrepared) captures.set(initialPrepared.groupId, initialPrepared);
    const capture = (id: string): Prepared => {
      const prepared = captures.get(id) ?? this.#load(id);
      this.#authorize(context, prepared);
      captures.set(id, prepared);
      return prepared;
    };
    const finalizeScan = (): undefined => {
      context.request.signal.throwIfAborted();
      this.#assertRequest(context.request, context.principal);
      for (const prepared of captures.values())
        this.#finalizeCurrent(context, prepared)();
      return undefined;
    };
    const authorityStore: DelegationAuthorityStore = {
      transact: (id, body) => {
        const prepared = capture(id);
        return this.#persistence
          .authorityStore(this.#finalizeCurrent(context, prepared))
          .transact(id, body);
      },
    };
    const service = createDelegationAuthorityService(authorityStore, {
      now: () => new Date().toISOString(),
      authorize: async (_action, root) => {
        const prepared = capture(root.authority_id);
        return same(root, prepared.root);
      },
      confirmExecution: async (envelope, root) => {
        const prepared = capture(root.authority_id);
        if (!same(root, prepared.root)) return false;
        await this.#confirmExecution(context, prepared, envelope);
        return true;
      },
      confirmReconciliation: async () => {
        throw new DelegationGroupRuntimeRefusal('group_unavailable');
      },
    });
    const executionHost = (
      spec: DelegationGroupSpecV2,
    ): DelegationFlowExecutionHost => ({
      resolveRuntime: async () => {
        throw new DelegationGroupRuntimeRefusal('group_unavailable');
      },
      invokeFenced: async () => {
        throw new DelegationGroupRuntimeRefusal('group_unavailable');
      },
      retainFailure: async (_error, envelope, invocationId) => {
        await this.#retain(context, this.#load(spec.groupId), {
          kind: 'failure',
          envelopeId: envelope.envelope_id,
          invocationId,
          reason: 'execution_incomplete',
        });
      },
      retainResult: async (result, envelope, invocationId) => {
        const reference = await this.#retain(
          context,
          this.#load(spec.groupId),
          {
            kind: 'raw-result',
            envelopeId: envelope.envelope_id,
            invocationId,
            result,
          },
        );
        this.#rawResults.set(
          hash([spec.groupId, envelope.envelope_id]),
          reference,
        );
      },
      confirmClaim: this.owners.flow.confirmClaim.bind(this.owners.flow),
      recordScheduleEvent: this.owners.flow.recordScheduleEvent.bind(
        this.owners.flow,
      ),
      recordMemberOutcome: this.owners.flow.recordMemberOutcome.bind(
        this.owners.flow,
      ),
      prepareRequest: async (claim, envelope) => {
        const prepared = this.#load(spec.groupId);
        await this.#confirmExecution(context, prepared, envelope);
        const seat = spec.seats.find(
          (s) =>
            s.stepId === claim.step_id &&
            s.envelope.id === envelope.envelope_id,
        );
        if (!seat) throw new DelegationGroupRuntimeRefusal('group_stale');
        return this.#request(context, prepared, seat.seatId);
      },
    });
    // Filter ownership before the controller's per-journal list authorization.
    const scopedStore: DelegationGroupStoreV2 = {
      transact: (id, body) => {
        const prepared = capture(id);
        return this.#persistence
          .groupStore(this.#finalizeCurrent(context, prepared))
          .transact(id, body);
      },
      scan: (body) =>
        this.#persistence.groupStore(finalizeScan).scan(async (journals) => {
          const owned = journals.filter((j) => {
            const p = this.#load(j.groupId);
            return (
              p.root.authenticated_principal_ref.id === context.principal.id &&
              p.root.authenticated_subject_ref.id === context.subject
            );
          });
          return body(owned);
        }),
    };
    const controller = createDelegationGroupControllerV2({
      store: scopedStore,
      authorityService: service,
      dispatchLedger: this.#dispatchLedger,
      host: {
        authorize: async (input) => {
          this.#assertRequest(context.request, context.principal);
          if (input.groupId) {
            const prepared = capture(input.groupId);
            if (input.spec && !same(input.spec, prepared.spec)) return null;
          }
          return {
            id: context.subject,
            domain: 'station.authenticated-group-access',
            digest: `sha256:${hash([context.principal.id, context.subject])}`,
          };
        },
        executionHost,
        prepareIndependentRequest: async (spec, seat, envelope) => {
          const prepared = this.#load(spec.groupId);
          await this.#confirmExecution(context, prepared, envelope);
          return this.#request(context, prepared, seat.seatId);
        },
        retainMemberOutcome: async (spec, seat, outcome) => {
          const reference = await this.#retain(
            context,
            this.#load(spec.groupId),
            {
              seatId: seat.seatId,
              rawResultRef:
                this.#rawResults.get(hash([spec.groupId, seat.envelope.id])) ??
                null,
              outcome,
            },
          );
          return {
            outcomeRef: reference,
            dissentRefs: [],
            uncertaintyRefs: [reference],
          };
        },
        retainRunObservation: async (spec, observation) =>
          this.#retain(context, this.#load(spec.groupId), {
            kind: 'run-observation',
            observation,
          }),
        retainRunFailure: async (spec) =>
          this.#retain(context, this.#load(spec.groupId), {
            kind: 'run-failure',
            reason: 'execution_incomplete',
          }),
        requestDescendantCancellation: async () => {
          throw new DelegationGroupRuntimeRefusal('group_cancellation_pending');
        },
        confirmDescendantCancellation: async () => null,
        confirmTerminal: async () => null,
        confirmNotLaunched: async () => null,
      },
    });
    return { service, controller, captures };
  }

  async #request(
    context: RequestContext,
    prepared: Prepared,
    seatId: string,
  ): Promise<ModelInvocationRequest> {
    const binding = this.#binding(context, prepared, seatId);
    const envelope = prepared.envelopes.find(
      (e) => e.envelope_id === binding.envelopeId,
    );
    if (!envelope) throw new DelegationGroupRuntimeRefusal('group_stale');
    const key = delegationGroupBindingKey(binding);
    const ownerToken = this.#bindingOwners.get(key);
    const record = await this.#bindings.read(binding.scope, key);
    if (!ownerToken || !record)
      throw new DelegationGroupRuntimeRefusal('group_unavailable');
    const caller = new DelegationGroupBindingService(this.#bindings, {
      assertCurrent: async (current) => {
        if (!same(current.binding, binding))
          throw new DelegationGroupRuntimeRefusal('group_stale');
        await this.#confirmExecution(context, prepared, envelope);
        return this.#finalizeCurrent(context, prepared);
      },
    });
    return caller.execute(
      { binding, ownerToken, expectedRevision: record.revision },
      async () => {
        throw new DelegationGroupRuntimeRefusal('group_unavailable');
      },
    );
  }

  async #view(
    context: RequestContext,
    projection: DelegationGroupProjectionV2,
    prepared: Prepared,
  ): Promise<DelegationGroupView> {
    this.#authorize(context, prepared);
    if (!same(projection.spec, prepared.spec))
      throw new DelegationGroupRuntimeRefusal('group_stale');
    const members = await Promise.all(
      prepared.spec.seats.map(async (seat) => {
        const binding = this.#binding(context, prepared, seat.seatId);
        const record = await this.#bindings.read(
          binding.scope,
          delegationGroupBindingKey(binding),
        );
        if (!record || !same(record.binding, binding))
          throw new DelegationGroupRuntimeRefusal('group_unavailable');
        const observed = projection.members.find(
          (m) => m.seatId === seat.seatId,
        );
        return {
          seatId: seat.seatId,
          taskId: binding.taskId,
          conversationId: binding.conversationId,
          sessionId: binding.sessionId,
          clientTurnId: binding.clientTurnId,
          claimId: observed?.claimId ?? null,
          invocationId: observed?.invocationId ?? null,
          providerTurnId: record.providerTurnId,
          bindingState: record.state,
          outcome: observed?.observation?.outcome ?? null,
          outputRef: observed?.observation?.outcomeRef ?? null,
          dissentRefs: observed?.observation?.dissentRefs ?? [],
          uncertaintyRefs: observed?.observation?.uncertaintyRefs ?? [],
          terminalProof: observed?.terminalReference
            ? ('proven' as const)
            : ('unproven' as const),
        };
      }),
    );
    this.#authorize(context, prepared);
    const topology = projection.spec.topology;
    return {
      version: DELEGATION_GROUP_TRANSPORT_VERSION,
      groupId: prepared.groupId,
      revision: projection.revision,
      execution: projection.execution,
      cancellation: projection.cancellation,
      terminal: projection.terminal,
      acceptance: projection.acceptance,
      executionCapability: {
        status: 'unavailable',
        code: 'physical_adapter_unqualified',
      },
      topology:
        topology.kind === 'flow'
          ? {
              kind: 'flow',
              runId: topology.runId,
              definition: topology.definition,
            }
          : { kind: 'independent-advisory' },
      members,
    };
  }

  async create(
    request: Request,
    principal: PrincipalRef,
    input: { preparationId: string; operationId: string },
  ) {
    const context = await this.#context(request, principal);
    const prepared = this.#load(input.preparationId);
    this.#authorize(context, prepared);
    const { service, controller } = this.#composition(context, prepared);
    this.#authorize(context, prepared);
    await service.issue(prepared.root);
    for (const envelope of [...prepared.envelopes].sort(
      (a, b) => a.generation - b.generation,
    )) {
      this.#authorize(context, prepared);
      await service.derive(prepared.root.authority_id, envelope);
    }
    for (const seat of prepared.spec.seats) {
      this.#authorize(context, prepared);
      const binding = this.#binding(context, prepared, seat.seatId);
      const finalizeCurrent = this.#finalizeCurrent(context, prepared);
      const reserved = await this.#bindings.reserve(
        {
          binding,
          operationId: `group:${prepared.groupId}:seat:${seat.seatId}`,
          intentDigest: `sha256:${hash(binding)}`,
        },
        finalizeCurrent,
      );
      finalizeCurrent();
      if (reserved.kind === 'created')
        this.#bindingOwners.set(
          delegationGroupBindingKey(binding),
          reserved.ownerToken,
        );
    }
    const result = await controller.create({
      kind: 'create',
      groupId: prepared.groupId,
      operationKey: input.operationId,
      expectedRevision: 0,
      controller: prepared.spec.controller,
      spec: prepared.spec,
    });
    return {
      replayed: result.replayed,
      group: await this.#view(context, result.projection, prepared),
    };
  }

  async get(request: Request, principal: PrincipalRef, groupId: string) {
    const context = await this.#context(request, principal);
    const prepared = this.#load(groupId);
    this.#authorize(context, prepared);
    const projection = await this.#composition(
      context,
      prepared,
    ).controller.get(groupId);
    const result = await this.#view(context, projection, prepared);
    this.#authorize(context, prepared);
    return result;
  }

  async list(request: Request, principal: PrincipalRef, afterGroupId?: string) {
    const context = await this.#context(request, principal);
    const composition = this.#composition(context);
    const projections = await composition.controller.list();
    const remaining = projections
      .filter(
        (p) => afterGroupId === undefined || p.spec.groupId > afterGroupId,
      )
      .sort((a, b) =>
        a.spec.groupId < b.spec.groupId
          ? -1
          : a.spec.groupId > b.spec.groupId
            ? 1
            : 0,
      );
    const selected = remaining.slice(0, DELEGATION_GROUP_LIMITS.pageSize);
    const captured = composition.captures;
    const rows = await Promise.all(
      selected.map(async (p) => {
        const prepared = captured.get(p.spec.groupId);
        if (!prepared) throw new DelegationGroupRuntimeRefusal('group_stale');
        return {
          cursor: p.spec.groupId,
          value: await this.#view(context, p, prepared),
        };
      }),
    );
    for (const prepared of captured.values())
      this.#authorize(context, prepared);
    return pageByBytes({
      rows,
      after: afterGroupId ?? '',
      hasMore: remaining.length > selected.length,
      maxItems: DELEGATION_GROUP_LIMITS.pageSize,
      maxBytes: DELEGATION_GROUP_LIMITS.responseBytes,
      format: (groups, unavailable, nextGroupId, hasMore) => ({
        groups,
        unavailable,
        nextGroupId: nextGroupId || null,
        hasMore,
      }),
    });
  }

  async events(
    request: Request,
    principal: PrincipalRef,
    groupId: string,
    afterRevision: number,
  ): Promise<DelegationGroupEventPage> {
    const context = await this.#context(request, principal);
    const prepared = this.#load(groupId);
    this.#authorize(context, prepared);
    const controller = this.#composition(context, prepared).controller;
    const projection = await controller.get(groupId);
    if (!same(projection.spec, prepared.spec))
      throw new DelegationGroupRuntimeRefusal('group_stale');
    if (afterRevision > projection.revision)
      throw new DelegationGroupRuntimeRefusal('group_stale');
    const events = await controller.events(groupId, afterRevision);
    const selected = events.slice(0, DELEGATION_GROUP_LIMITS.pageSize);
    this.#authorize(context, prepared);
    return pageByBytes({
      rows: selected.map((event) => ({
        cursor: event.revision,
        value: projectEvent(event),
      })),
      after: afterRevision,
      hasMore: events.length > selected.length,
      maxItems: DELEGATION_GROUP_LIMITS.pageSize,
      maxBytes: DELEGATION_GROUP_LIMITS.responseBytes,
      format: (events, unavailable, nextRevision, hasMore) => ({
        groupId,
        afterRevision,
        nextRevision,
        hasMore,
        events,
        unavailable,
      }),
    });
  }

  async cancel(
    request: Request,
    principal: PrincipalRef,
    groupId: string,
    input: { operationId: string; expectedRevision: number },
  ) {
    const context = await this.#context(request, principal);
    const prepared = this.#load(groupId);
    this.#authorize(context, prepared);
    const controller = this.#composition(context, prepared).controller;
    try {
      const result = await controller.cancel({
        kind: 'cancel',
        groupId,
        operationKey: input.operationId,
        expectedRevision: input.expectedRevision,
        controller: prepared.spec.controller,
      });
      return {
        disposition:
          result.projection.cancellation === 'requested'
            ? ('requested' as const)
            : ('pending' as const),
        group: await this.#view(context, result.projection, prepared),
      };
    } catch (error) {
      if (
        !(error instanceof DelegationGroupRuntimeRefusal) ||
        error.code !== 'group_cancellation_pending'
      )
        throw error;
      return {
        disposition: 'pending' as const,
        group: await this.#view(
          context,
          await controller.get(groupId),
          prepared,
        ),
      };
    }
  }
  async launch(
    request: Request,
    principal: PrincipalRef,
    groupId: string,
    input: { operationId: string; expectedRevision: number },
  ) {
    const context = await this.#context(request, principal);
    const prepared = this.#load(groupId);
    this.#authorize(context, prepared);
    const result = await this.#composition(context, prepared).controller.run(
      {
        kind: 'run',
        groupId,
        operationKey: input.operationId,
        expectedRevision: input.expectedRevision,
        controller: prepared.spec.controller,
      },
      { signal: request.signal },
    );
    return {
      replayed: result.replayed,
      group: await this.#view(context, result.projection, prepared),
    };
  }
  async watchGroupEvents(
    request: Request,
    principal: PrincipalRef,
    groupId: string,
    afterRevision: number,
    stop: AbortSignal,
  ): Promise<GroupPageIterator<DelegationGroupEventPage>> {
    const context = await this.#context(request, principal);
    const prepared = this.#load(groupId);
    this.#authorize(context, prepared);
    const group = await this.get(request, principal, groupId);
    this.#authorize(context, prepared);
    const sessions = new Set(group.members.map((member) => member.sessionId));
    let cursor = afterRevision;
    return watchGroupPages({
      signal: AbortSignal.any([request.signal, stop]),
      lifetimeMs: 60_000,
      refreshMs: 15_000,
      subscribe: (listener) => this.owners.eventBus.subscribe(listener),
      relevant: (hint) => relevantGroupHint(hint.data, groupId, sessions),
      read: async () => {
        const page = await this.events(request, principal, groupId, cursor);
        this.#authorize(context, prepared);
        cursor = page.nextRevision;
        return page;
      },
      fingerprint: (page) =>
        canonicalJson([page.nextRevision, page.events, page.unavailable]),
      hasMore: (page) => page.hasMore,
    });
  }

  async watchMemberEvents(
    request: Request,
    principal: PrincipalRef,
    groupId: string,
    seatId: string,
    afterSequence: number,
    stop: AbortSignal,
  ): Promise<GroupPageIterator<DelegationGroupMemberEventPage>> {
    const context = await this.#context(request, principal);
    const prepared = this.#load(groupId);
    this.#authorize(context, prepared);
    const group = await this.get(request, principal, groupId);
    this.#authorize(context, prepared);
    const seat = group.members.find((member) => member.seatId === seatId);
    if (!seat) throw new DelegationGroupRuntimeRefusal('group_not_found');
    let cursor = afterSequence;
    return watchGroupPages({
      signal: AbortSignal.any([request.signal, stop]),
      lifetimeMs: 60_000,
      refreshMs: 15_000,
      subscribe: (listener) => this.owners.eventBus.subscribe(listener),
      relevant: (hint) =>
        relevantGroupHint(hint.data, groupId, new Set([seat.sessionId])),
      read: async () => {
        const page = await this.memberEvents(
          request,
          principal,
          groupId,
          seatId,
          cursor,
        );
        this.#authorize(context, prepared);
        cursor = page.nextSequence;
        return page;
      },
      fingerprint: (page) =>
        canonicalJson([
          page.state,
          page.nextSequence,
          page.events,
          page.unavailable,
        ]),
      hasMore: (page) => page.hasMore,
    });
  }

  async rawOutput(
    request: Request,
    principal: PrincipalRef,
    groupId: string,
    seatId: string,
  ) {
    const context = await this.#context(request, principal);
    const prepared = this.#load(groupId);
    this.#authorize(context, prepared);
    const group = await this.get(request, principal, groupId);
    this.#authorize(context, prepared);
    const reference = group.members.find((s) => s.seatId === seatId)?.outputRef;
    if (
      reference?.domain !== 'station.group-observation' ||
      !/^sha256:[a-f0-9]{64}$/.test(reference.digest)
    )
      throw new DelegationGroupRuntimeRefusal('group_not_found');
    privateDirectory(join(this.owners.privateRoot, 'observations'));
    const raw = readPrivateJson(
      join(
        this.owners.privateRoot,
        'observations',
        `${reference.digest.slice(7)}.json`,
      ),
      1_048_576,
    );
    if (
      `sha256:${hash(raw)}` !== reference.digest ||
      z.object({ groupId: publicId }).passthrough().parse(raw).groupId !==
        groupId
    )
      throw new DelegationGroupRuntimeRefusal('group_unavailable');
    const retained = z
      .object({
        observation: z
          .object({
            rawResultRef: z
              .object({
                id: publicId,
                domain: z.literal('station.group-observation'),
                digest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
              })
              .strict()
              .nullable(),
          })
          .passthrough(),
      })
      .passthrough()
      .parse(raw);
    let rawResult: unknown = null;
    if (retained.observation.rawResultRef) {
      const resultRef = retained.observation.rawResultRef;
      rawResult = readPrivateJson(
        join(
          this.owners.privateRoot,
          'observations',
          `${resultRef.digest.slice(7)}.json`,
        ),
        1_048_576,
      );
      if (
        `sha256:${hash(rawResult)}` !== resultRef.digest ||
        z.object({ groupId: publicId }).passthrough().parse(rawResult)
          .groupId !== groupId
      )
        throw new DelegationGroupRuntimeRefusal('group_unavailable');
    }
    await this.get(request, principal, groupId);
    this.#authorize(context, prepared);
    return { reference, raw, rawResult };
  }
  async memberEvents(
    request: Request,
    principal: PrincipalRef,
    groupId: string,
    seatId: string,
    afterSequence: number,
  ): Promise<DelegationGroupMemberEventPage> {
    const context = await this.#context(request, principal);
    const prepared = this.#load(groupId);
    this.#authorize(context, prepared);
    const group = await this.get(request, principal, groupId);
    this.#authorize(context, prepared);
    const seat = group.members.find((m) => m.seatId === seatId);
    if (!seat) throw new DelegationGroupRuntimeRefusal('group_not_found');
    const binding = this.#binding(context, prepared, seatId);
    const key = delegationGroupBindingKey(binding);
    const record = await this.#bindings.read(binding.scope, key);
    if (!record || !same(record.binding, binding))
      throw new DelegationGroupRuntimeRefusal('group_stale');
    const page = await this.owners.orchestration.readSessionEventPage(
      binding.sessionId,
      {
        authority: context.readAuthority,
        afterSequence,
        limit: DELEGATION_GROUP_LIMITS.memberPageSize,
      },
    );
    const current = await this.#bindings.read(binding.scope, key);
    if (
      !current ||
      !same(current.binding, record.binding) ||
      current.providerTurnId !== record.providerTurnId
    )
      throw new DelegationGroupRuntimeRefusal('group_stale');
    await this.get(request, principal, groupId);
    this.#authorize(context, prepared);
    if (!page)
      return {
        state: 'unavailable',
        groupId,
        seatId,
        nextSequence: afterSequence,
        hasMore: false,
        events: [],
        unavailable: [],
      };
    const rows = page.events.map(({ sequence, event }) => {
      let value: DelegationGroupMemberEventPage['events'][number] | undefined;
      if (belongsToAcceptedGroupTurn(current, event)) {
        value = {
          eventId: event.eventId,
          sequence,
          kind: event.method,
          ...(event.turnId ? { turnId: event.turnId } : {}),
        };
        if (event.method === 'request.opened') {
          const inspected = this.owners.orchestration.inspectAttentionRequest(
            {
              threadId: binding.sessionId,
              requestId: event.requestId,
              requestEventId: event.eventId,
            },
            context.readAuthority,
          );
          const form = isActionableGroupRequest(current, event, inspected)
            ? inputRequestFromRequestEvent(event)
            : null;
          if (form)
            value.inputRequest = {
              requestId: event.requestId,
              requestEventId: event.eventId,
              form,
            };
        }
      }
      // Excluded session events still consume their canonical session cursor.
      return { cursor: sequence, value };
    });
    if (!rows.length && page.hasMore && page.nextSequence <= afterSequence)
      throw new DelegationGroupRuntimeRefusal('group_unavailable');
    if (!rows.length && page.nextSequence > afterSequence)
      rows.push({ cursor: page.nextSequence, value: undefined });
    const result = pageByBytes({
      rows,
      after: afterSequence,
      hasMore: page.hasMore,
      maxItems: DELEGATION_GROUP_LIMITS.memberPageSize,
      maxBytes: DELEGATION_GROUP_LIMITS.responseBytes,
      format: (events, unavailable, nextSequence, hasMore) => ({
        state: 'available' as const,
        groupId,
        seatId,
        nextSequence,
        hasMore,
        events,
        unavailable,
      }),
    });
    this.#authorize(context, prepared);
    return result;
  }
}

function projectEvent(
  event: GroupEventV2,
): DelegationGroupEventPage['events'][number] {
  return {
    revision: event.revision,
    kind: event.kind,
    ...('seatId' in event ? { seatId: event.seatId } : {}),
    ...('invocationId' in event ? { invocationId: event.invocationId } : {}),
    ...(event.kind === 'member_observed'
      ? { outputRef: event.observation.outcomeRef }
      : {}),
  };
}

function relevantGroupHint(
  data: Record<string, unknown> | undefined,
  groupId: string,
  sessions: ReadonlySet<string>,
): boolean {
  if (!data) return false;
  if (data.groupId === groupId) return true;
  const event =
    typeof data.event === 'object' && data.event !== null ? data.event : {};
  const nestedThreadId = 'threadId' in event ? event.threadId : undefined;
  return [data.threadId, data.sessionId, nestedThreadId].some(
    (value) => typeof value === 'string' && sessions.has(value),
  );
}
