import crypto from 'node:crypto';
import { resolve } from 'node:path';
import { externalSessionContinuationSupport } from '@kontourai/station-contracts/engine-capability-matrix';
import type {
  AdoptedSessionResult,
  AdoptSessionTarget,
  OrchestrationCommandDispatchResult,
  OrchestrationCommandReceipt,
} from '@kontourai/station-contracts/orchestration';
import {
  type EngineId,
  type ModelLaunchPlan,
  type ProviderSession,
  type ProviderSessionStartInput,
  STATION_CONFINEMENT_GRANTOR_METADATA_KEY,
  STATION_CONFINEMENT_METADATA_KEY,
  type StationConfinement,
} from '@kontourai/station-contracts/provider';
import type { TenantExecutionContext } from '@kontourai/station-contracts/tenancy';
import { tenantExecutionContextFromSession } from '@kontourai/station-contracts/tenancy';
import type {
  ProviderAdapterShape,
  ProviderSessionAdoptInput,
} from '../../providers/adapter-shape.js';
import {
  isSessionSourceAffinity,
  snapshotSessionSourceAffinity,
} from '../../providers/sessions/session-source-affinity.js';
import { withTenantExecutionContext } from '../../runtime/bootstrap/runtime-tenant-context.js';
import type { FullAccessGrantor } from '../../security/coding-authority.js';
import { errorMessage } from '../../utils/error-message.js';
import { expandTilde } from '../../utils/paths.js';
import {
  adoptedChildExecutionBindingMetadata,
  type ResolveAdoptedChildExecutionBinding,
} from './adopted-child-execution-binding.js';
import type {
  AdoptionLedger,
  AdoptionReservation,
  AdoptionReservationInput,
  AdoptionTransition,
  OwnedAdoption,
} from './adoption-ledger.js';
import {
  type ContinuationPlace,
  resolveContinuationPlace,
} from './attached-session-continuation-place.js';
import type { AttachedProjectRoot } from './attached-session-follow-service.js';
import { DISPATCH_CANONICAL_CWD_METADATA_KEY } from './dispatch-cwd-admission.js';
import type { EventStore } from './event-store.js';
import { readCompletedSourceBoundary } from './external-session-continuation-context.js';
import {
  type SessionOwnerAttribution,
  sessionOwnerAttributionMetadata,
} from './session-owner-attribution.js';
import { SESSION_LOCAL_PROJECT_ID_METADATA_KEY } from './session-project-identity.js';

// Attached-session adoption (epic archive#4024, archive#4143): the C14 cluster
// from the seam map — 25 of its 27 methods, its reservation/intent state,
// and the module-global live-owner registry move here. Two members stay on
// the service by design (extraction plan §7/§8, Option A):
// `clearAbandonedAdoptionMemory` (the declared teardown-seam call site — the
// source-invariant test pins exactly six sites in ONE file) reached via
// `deps.forgetAbandonedAdoptionMemory`, and `logAdoptionCleanupFailure`
// beside it. The adoption ledger INSTANCE also stays on the service:
// `evictCollidingAttachedAliases` (C16) both serves this cluster and reads
// the ledger, and moving it would make that edge bidirectional.
//
// The reconciliation handshake is identity-critical (plan §4): boot calls
// `startReconciliation()` exactly once, which stores AND returns the same
// promise `adopt()` awaits; its rejection must reach the adoption path (no
// internal catch), and the `Promise.resolve()` initializer keeps
// pre-initialize adoptions from hanging. `registerOwner()` is called from
// the service's `initialize()` and `unregisterOwner()` from `shutdown()`
// (plan condition 3). `dispatch()` initializes before `adopt()` can reserve,
// so no reservation carries the id of an owner that never initialized.

export class AdoptionContinuationInProgressError extends Error {
  readonly code = 'adoption_continuation_in_progress';
  readonly retryable = true;

  constructor() {
    super('Continuation is being created — retry shortly.');
    this.name = 'AdoptionContinuationInProgressError';
  }
}

interface AdoptionContext {
  source: ProviderSession;
  sourceSessionId: string;
  sourceKind: string;
  adapter: ProviderAdapterShape;
  /** #3386: where the child runs and the project it belongs to (none for a No project chat). */
  place: ContinuationPlace;
  /** #3386: the caller's choice for a conversation no project claims. */
  target?: AdoptSessionTarget;
  reservation: AdoptionReservationInput;
  adoption?: OwnedAdoption;
  providerAdoptionStarted: boolean;
  tenantExecutionContext?: TenantExecutionContext;
  /** Station #90 lane D (R1): stamped on the adopted child's start. */
  ownerAttribution?: SessionOwnerAttribution;
  /**
   * #2493: the adopting caller's grant, as the child's confinement stamp
   * (`STATION_CONFINEMENT_METADATA_KEY`): `host` only when the request that
   * adopted may grant full access, the same rule as `prepareStart`.
   */
  confinementStamp?: AdoptionConfinement;
}

/** #2493 / #1796: the adopting request's confinement and who granted it. */
export interface AdoptionConfinement {
  readonly stamp: StationConfinement;
  readonly grantor?: FullAccessGrantor;
}

const liveAdoptionOwners = new Set<string>();

function adoptionReservationOwnerIsLive(
  reservation: AdoptionReservation,
): boolean {
  if (!reservation.ownerId || reservation.ownerPid === undefined) return false;
  if (!Number.isInteger(reservation.ownerPid) || reservation.ownerPid <= 0) {
    return false;
  }
  if (reservation.ownerPid === process.pid) {
    return liveAdoptionOwners.has(reservation.ownerId);
  }
  try {
    process.kill(reservation.ownerPid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export interface AttachedSessionAdoptionDeps {
  eventStore?: EventStore;
  /** The service-owned ledger instance (plan §8: it stays on the service). */
  adoptionLedger?: AdoptionLedger;
  adapterRegistry: {
    get(provider: EngineId): ProviderAdapterShape | undefined;
  };
  flowRunService?: {
    discardRun(projectRoot: string, flowRunId: string): Promise<void>;
  };
  listProjects?: () => AttachedProjectRoot[];
  /**
   * #3429: the Agent and Environment the child runs as, so the dock can open
   * it and `/chat` follow-ups find a verified execution binding. Absent (or
   * answering undefined), the child is created without one, as before.
   */
  resolveExecutionBinding?: ResolveAdoptedChildExecutionBinding;
  requireTenantExecutionContext?: () => boolean;
  logger: {
    warn(message: string, meta?: Record<string, unknown>): void;
  };
  canReadSessionForCommand: (
    threadId: string,
    userId: string | undefined,
    tenantExecutionContext: TenantExecutionContext | undefined,
  ) => boolean;
  tenantContextFor: (threadId: string) => TenantExecutionContext | undefined;
  liveSessions: () => Iterable<ProviderSession>;
  trackSession: (
    session: ProviderSession,
    adapter?: ProviderAdapterShape,
  ) => void;
  evictCollidingAttachedAliases: () => void;
  persistReceipt: (receipt: OrchestrationCommandReceipt) => void;
  requireAdapter: (provider: EngineId) => ProviderAdapterShape;
  assertAdapterCurrent: (adapter: ProviderAdapterShape) => void;
  assertAdapterReady: (adapter: ProviderAdapterShape) => Promise<void>;
  withAcceptedModelLaunchPlan: (
    adapter: ProviderAdapterShape,
    input: ProviderSessionStartInput,
    lifecycle: 'start' | 'resume',
    retainedModelId?: string,
  ) => ProviderSessionStartInput;
  recordAcceptedModelLaunchPlan: (
    adapter: ProviderAdapterShape,
    plan: ModelLaunchPlan,
    lifecycle: 'start' | 'resume' | 'turn',
    requestedOverride: boolean,
  ) => void;
  modelLaunchPlanFromInput: (
    input: ProviderSessionStartInput,
  ) => ModelLaunchPlan;
  modelLaunchRequestedOverrideFromInput: (
    input: ProviderSessionStartInput,
  ) => boolean;
  forgetAbandonedAdoptionMemory: (reservation: AdoptionReservation) => void;
  logCleanupFailure: (
    resource: string,
    reservation: AdoptionReservation,
    error: unknown,
  ) => void;
}

export class AttachedSessionAdoption {
  private readonly ownerId = crypto.randomUUID();
  private readonly adoptingSourceThreads = new Set<string>();
  private readonly adoptionIntents = new Map<
    string,
    Promise<OrchestrationCommandDispatchResult<AdoptedSessionResult>>
  >();
  private reconciliation: Promise<void> = Promise.resolve();

  constructor(private readonly deps: AttachedSessionAdoptionDeps) {}

  /** `initialize()`: this process's reservations count as live from here on. */
  registerOwner(): void {
    liveAdoptionOwners.add(this.ownerId);
  }

  /** `shutdown()`: stop vouching for this process's reservations. */
  unregisterOwner(): void {
    liveAdoptionOwners.delete(this.ownerId);
  }

  /**
   * Boot reclamation kickoff. Stores AND returns the same promise `adopt()`
   * awaits — never a second `reconcilePendingAdoptions()` call, and never an
   * internal catch (a rejected reclamation must fail the adoption path, not
   * silently proceed against an unreclaimed ledger).
   */
  startReconciliation(): Promise<void> {
    this.reconciliation = this.reconcilePendingAdoptions();
    return this.reconciliation;
  }

  async adopt(
    sourceThreadId: string,
    receipt: OrchestrationCommandReceipt,
    userId?: string,
    requestTenantExecutionContext?: TenantExecutionContext,
    idempotencyKey?: string,
    ownerAttribution?: SessionOwnerAttribution,
    confinementStamp?: AdoptionConfinement,
    target?: AdoptSessionTarget,
  ): Promise<OrchestrationCommandDispatchResult<AdoptedSessionResult>> {
    if (idempotencyKey) {
      // Coalescing must retain the same authority boundary as durable lookup:
      // a caller cannot join another source/user/tenant's in-flight intent by
      // presenting its key.
      const intentScope = JSON.stringify([
        sourceThreadId,
        userId ?? null,
        requestTenantExecutionContext?.tenantId ?? null,
        idempotencyKey,
        // #3386: a different choice of where to continue is a different intent.
        target ?? null,
      ]);
      const inFlight = this.adoptionIntents.get(intentScope);
      if (inFlight) {
        const settled = await inFlight;
        this.deps.persistReceipt(receipt);
        return {
          receipt,
          result: { ...settled.result, alreadyAdopted: true },
        };
      }
      const intent = this.performAttachedSessionAdoption(
        sourceThreadId,
        receipt,
        userId,
        requestTenantExecutionContext,
        idempotencyKey,
        ownerAttribution,
        confinementStamp,
        target,
      );
      this.adoptionIntents.set(intentScope, intent);
      try {
        return await intent;
      } finally {
        this.adoptionIntents.delete(intentScope);
      }
    }
    return this.performAttachedSessionAdoption(
      sourceThreadId,
      receipt,
      userId,
      requestTenantExecutionContext,
      undefined,
      ownerAttribution,
      confinementStamp,
      target,
    );
  }

  private async performAttachedSessionAdoption(
    sourceThreadId: string,
    receipt: OrchestrationCommandReceipt,
    userId?: string,
    requestTenantExecutionContext?: TenantExecutionContext,
    idempotencyKey?: string,
    ownerAttribution?: SessionOwnerAttribution,
    confinementStamp?: AdoptionConfinement,
    target?: AdoptSessionTarget,
  ): Promise<OrchestrationCommandDispatchResult<AdoptedSessionResult>> {
    await this.reconciliation;
    // Resolve and authorize the source before treating an existing child as
    // idempotent. A receipt is continuation metadata, so hosted callers must
    // not receive one unless their request binding matches every server-held
    // binding involved in this adoption.
    if (
      !this.deps.canReadSessionForCommand(
        sourceThreadId,
        userId,
        requestTenantExecutionContext,
      )
    ) {
      // Do not distinguish an unauthorized source from an absent attachment.
      throw new Error('Attached session not found.');
    }
    const context = await this.resolveAdoptionContext(sourceThreadId, target);
    const sourceTenantExecutionContext =
      this.deps.tenantContextFor(sourceThreadId) ??
      context.source.tenantExecutionContext;
    // Keyless requests keep the PRE-EXISTING source-scoped dedup (any live
    // continuation of this source is THE continuation — pinned by the hosted
    // tenant-validation test, and broken here once when the key made the
    // lookup conditional). A key narrows the match: only the continuation
    // created under the SAME intent joins; a different key is a new intent.
    const existingChild = this.findExistingAdoptedChild(
      sourceThreadId,
      idempotencyKey,
    );
    const existingTenantExecutionContext = existingChild
      ? (this.deps.tenantContextFor(existingChild.threadId) ??
        existingChild.tenantExecutionContext)
      : undefined;
    if (
      existingChild &&
      !this.deps.canReadSessionForCommand(
        existingChild.threadId,
        userId,
        requestTenantExecutionContext,
      )
    ) {
      throw new Error('Attached session not found.');
    }
    const tenantExecutionContext = requestTenantExecutionContext;
    if (
      tenantExecutionContext &&
      [sourceTenantExecutionContext, existingTenantExecutionContext].some(
        (binding) =>
          binding && binding.tenantId !== tenantExecutionContext.tenantId,
      )
    ) {
      throw new Error(
        `Tenant execution context does not match session: ${sourceThreadId}`,
      );
    }
    if (
      this.deps.requireTenantExecutionContext?.() &&
      !tenantExecutionContext
    ) {
      throw new Error(
        'Tenant execution context is required for hosted session adoption.',
      );
    }
    if (existingChild) {
      this.deps.persistReceipt(receipt);
      return {
        receipt,
        result: {
          ...this.publicAdoptedSession(existingChild),
          alreadyAdopted: true,
        },
      };
    }
    const contendingReservation = this.deps.adoptionLedger
      ?.reservations()
      .find((item) => item.sourceThreadId === sourceThreadId);
    if (
      idempotencyKey &&
      contendingReservation?.idempotencyKey === idempotencyKey
    ) {
      return this.joinCommittedAdoption(
        sourceThreadId,
        idempotencyKey,
        receipt,
      );
    }
    if (
      this.adoptingSourceThreads.has(sourceThreadId) ||
      contendingReservation
    ) {
      throw new Error('This attached session is already being continued.');
    }
    context.tenantExecutionContext =
      tenantExecutionContext ?? sourceTenantExecutionContext;
    context.reservation.idempotencyKey = idempotencyKey;
    context.ownerAttribution = ownerAttribution;
    context.confinementStamp = confinementStamp;
    const reservation = this.deps.adoptionLedger?.reserve(context.reservation);
    if (reservation?.kind !== 'owner') {
      if (idempotencyKey) {
        return this.joinCommittedAdoption(
          sourceThreadId,
          idempotencyKey,
          receipt,
        );
      }
      throw new Error('This attached session is already being continued.');
    }
    context.adoption = reservation.adoption;
    this.adoptingSourceThreads.add(sourceThreadId);
    try {
      return await withTenantExecutionContext(tenantExecutionContext, () =>
        this.executeAdoption(context, receipt, userId),
      );
    } catch (error) {
      const cleanupComplete = await this.rollbackAdoption(context);
      this.deps.logger.warn('Attached session adoption failed', {
        provider: context.source.provider,
        sourceThreadId,
        error: errorMessage(error),
      });
      if (
        idempotencyKey &&
        cleanupComplete &&
        this.isAdoptionIdempotencyConstraint(error)
      ) {
        return this.joinCommittedAdoption(
          sourceThreadId,
          idempotencyKey,
          receipt,
        );
      }
      throw new Error(
        cleanupComplete
          ? 'Station could not continue this attached session. No continuation was kept.'
          : 'Station could not continue this attached session. Continuation cleanup is pending and will be retried on startup.',
      );
    } finally {
      this.adoptingSourceThreads.delete(sourceThreadId);
    }
  }

  private findExistingAdoptedChild(
    sourceThreadId: string,
    idempotencyKey?: string,
  ): ProviderSession | undefined {
    // Lifecycle state is deliberately not a predicate here. An idempotency
    // key names the continuation that intent created even after it closes or
    // errors; callers must see that real terminal state. A fresh Continue is
    // a new intent with a new key, never an implicit replacement child.
    this.deps.evictCollidingAttachedAliases();
    return [
      ...this.deps.liveSessions(),
      ...(this.deps.eventStore?.readSessions() ?? []),
    ].find(
      (session) =>
        session.continuationSourceThreadId === sourceThreadId &&
        (idempotencyKey === undefined ||
          session.adoptionIdempotencyKey === idempotencyKey) &&
        session.controlMode !== 'read-only-attached',
    );
  }

  private async joinCommittedAdoption(
    sourceThreadId: string,
    idempotencyKey: string,
    receipt: OrchestrationCommandReceipt,
  ): Promise<OrchestrationCommandDispatchResult<AdoptedSessionResult>> {
    for (const delayMs of [0, 10, 20, 40]) {
      if (delayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
      const winner = this.findExistingAdoptedChild(
        sourceThreadId,
        idempotencyKey,
      );
      if (winner) {
        this.deps.persistReceipt(receipt);
        return {
          receipt,
          result: {
            ...this.publicAdoptedSession(winner),
            alreadyAdopted: true,
          },
        };
      }
    }
    throw new AdoptionContinuationInProgressError();
  }

  private isAdoptionIdempotencyConstraint(error: unknown): boolean {
    let current = error;
    for (let depth = 0; depth < 4; depth += 1) {
      if (!current || typeof current !== 'object') return false;
      const candidate = current as {
        code?: unknown;
        message?: unknown;
        cause?: unknown;
      };
      if (
        candidate.code === 'SQLITE_CONSTRAINT_UNIQUE' ||
        (typeof candidate.message === 'string' &&
          candidate.message.includes(
            'idx_provider_session_adoption_idempotency',
          ))
      ) {
        return true;
      }
      current = candidate.cause;
    }
    return false;
  }

  private async resolveAdoptionContext(
    sourceThreadId: string,
    target: AdoptSessionTarget | undefined,
  ): Promise<AdoptionContext> {
    const eventStore = this.deps.eventStore;
    if (!eventStore) {
      throw new Error(
        'Durable orchestration storage is required for adoption.',
      );
    }
    const source = this.findAttachedAdoptionSource(sourceThreadId, eventStore);
    const sourceSessionId = source.attachedSource!.externalSessionId;
    // The engine's support is settled before the folder is read: an engine
    // that cannot continue refuses the same way wherever the folder is.
    const adapter = this.requireAdoptionAdapter(source.provider);
    const place = await this.resolveAdoptionPlace(source, target);
    return this.buildAdoptionContext({
      source,
      sourceSessionId,
      place,
      target,
      adapter,
    });
  }

  private findAttachedAdoptionSource(
    sourceThreadId: string,
    eventStore: EventStore,
  ): ProviderSession {
    this.deps.evictCollidingAttachedAliases();
    const source = [
      ...this.deps.liveSessions(),
      ...eventStore.readSessions(),
    ].find((candidate) => candidate.threadId === sourceThreadId);
    if (!source) throw new Error('Attached session not found.');
    if (source.controlMode !== 'read-only-attached') {
      throw new Error('Only read-only attached sessions can be continued.');
    }
    const sourceSessionId = source.attachedSource?.externalSessionId;
    if (!source.cwd || !sourceSessionId || !source.attachedSource) {
      throw new Error('Attached session source metadata is unavailable.');
    }
    return source;
  }

  /**
   * #3386: where the child runs, decided from the folder itself at adoption
   * time (`attached-session-continuation-place.ts`): a folder inside a
   * project's folder or in a genuine worktree of its repository continues
   * there under that project; a folder no project claims continues only as
   * a No project chat the caller chose, confined to that folder.
   */
  private resolveAdoptionPlace(
    source: ProviderSession,
    target: AdoptSessionTarget | undefined,
  ): Promise<ContinuationPlace> {
    return resolveContinuationPlace({
      cwd: source.cwd!,
      projects: this.deps.listProjects?.() ?? [],
      ...(target ? { target } : {}),
      hosted: this.deps.requireTenantExecutionContext?.() === true,
    });
  }

  /**
   * #3386: the folder is checked again just before the engine is started in
   * it, so a worktree removed, replaced or re-pointed while the reservation
   * was being written is refused rather than handed to the engine. The
   * window that remains is the engine's own start.
   */
  private async reverifyAdoptionPlace(context: AdoptionContext): Promise<void> {
    const now = await this.resolveAdoptionPlace(context.source, context.target);
    if (
      now.cwd !== context.place.cwd ||
      now.project?.slug !== context.place.project?.slug
    )
      throw new Error(
        "The conversation's folder changed while Station was continuing it.",
      );
  }

  private requireAdoptionAdapter(provider: EngineId): ProviderAdapterShape {
    const support = externalSessionContinuationSupport(provider);
    if (support.state !== 'native') throw new Error(support.reason);
    const adapter = this.deps.requireAdapter(provider);
    if (!adapter.adoptSession || !adapter.discardSession) {
      throw new Error(
        `${adapter.metadata.displayName} does not support continuing attached sessions in Station.`,
      );
    }
    return adapter;
  }

  private buildAdoptionContext(input: {
    source: ProviderSession;
    sourceSessionId: string;
    place: ContinuationPlace;
    target: AdoptSessionTarget | undefined;
    adapter: ProviderAdapterShape;
  }): AdoptionContext {
    const now = new Date().toISOString();
    const affinity = input.source.attachedSource?.affinity;
    if (affinity !== undefined && !isSessionSourceAffinity(affinity)) {
      throw new Error('The attached source configuration identity is invalid.');
    }
    const support = externalSessionContinuationSupport(input.source.provider);
    if (
      support.state === 'native' &&
      support.requiresSourceAffinity &&
      !affinity
    )
      throw new Error('Waiting for the source configuration to be verified.');
    const sourceBoundary =
      support.state === 'native' && support.boundary === 'completed-turn'
        ? readCompletedSourceBoundary(
            this.deps.eventStore!,
            input.source.provider,
            input.source.threadId,
          )
        : undefined;
    if (
      support.state === 'native' &&
      support.boundary === 'completed-turn' &&
      (!affinity || !sourceBoundary)
    ) {
      throw new Error(
        'A verified source configuration and completed turn are required for this continuation.',
      );
    }
    return {
      source: input.source,
      sourceSessionId: input.sourceSessionId,
      sourceKind: input.source.attachedSource!.kind,
      adapter: input.adapter,
      place: input.place,
      ...(input.target ? { target: input.target } : {}),
      reservation: {
        sourceThreadId: input.source.threadId,
        targetThreadId: crypto.randomUUID(),
        ownerId: this.ownerId,
        ownerPid: process.pid,
        provider: input.source.provider,
        sourceSessionId: input.sourceSessionId,
        sourceKind: input.source.attachedSource!.kind,
        ...(affinity
          ? { sourceAffinity: snapshotSessionSourceAffinity(affinity) }
          : {}),
        ...(sourceBoundary ? { sourceBoundary } : {}),
        cwd: input.place.cwd,
        projectRoot: resolve(expandTilde(input.place.workingDirectory)),
        createdAt: now,
        updatedAt: now,
      },
      providerAdoptionStarted: false,
    };
  }

  private async executeAdoption(
    context: AdoptionContext,
    receipt: OrchestrationCommandReceipt,
    userId?: string,
  ): Promise<OrchestrationCommandDispatchResult<AdoptedSessionResult>> {
    const adopted = await this.forkReservedProviderChild(context, userId);
    this.validateAdoptedProviderChild(context, adopted);
    this.requireAdoptionTransition(
      this.requireOwnedAdoption(context).recordProviderCursor(
        adopted.resumeCursor,
      ),
    );
    this.deps.assertAdapterCurrent(context.adapter);
    const child = this.buildAdoptedChild(context, adopted);
    this.commitAdoptedSession(context, child, receipt);
    return { receipt, result: this.publicAdoptedSession(child) };
  }

  private async forkReservedProviderChild(
    context: AdoptionContext,
    userId?: string,
  ): Promise<ProviderSession> {
    const { adapter, place, reservation, source } = context;
    // #3429: resolved before the engine is touched, so a failed read rolls
    // back an adoption that never started a child.
    const executionBinding = await this.deps.resolveExecutionBinding?.(
      source.provider,
    );
    // Adoption starts a fresh provider child from a persisted transcript, so
    // it follows the same retained-selector resume contract as recovery.
    // Do not replay `source.model` as a caller override: Station-backed
    // adapters receive it only when their declared omission semantics retain
    // an accepted session model; external engines deliberately choose their
    // own continuation default.
    const baseAdoptionInput: ProviderSessionAdoptInput = {
      provider: source.provider,
      threadId: reservation.targetThreadId,
      sourceSessionId: context.sourceSessionId,
      sourceKind: context.sourceKind,
      cwd: place.cwd,
      // archive#1165: these are server-owned facts. The public adoption
      // command has no metadata channel, so neither the plan nor identity
      // can be forged by an adopting client.
      metadata: {
        adoptedFromThreadId: reservation.sourceThreadId,
        // #3429: the same Agent identity and execution binding a chat
        // started from the dock records, so the dock opens this child and a
        // `/chat` follow-up passes `readSessionBinding`. Confinement and cwd
        // below are adoption's own and are not derived from the Agent.
        ...adoptedChildExecutionBindingMetadata(
          executionBinding,
          reservation.targetThreadId,
        ),
        // #3386: the child belongs to the project its folder was verified
        // against just now (by folder, or by repository from a worktree),
        // with that project's local id the same way `prepareStart` records
        // a verified one. A No project chat names none.
        ...(place.project
          ? {
              projectSlug: place.project.slug,
              // #3429: what a project chat records beside its slug. The
              // child runs in its own folder, not a worktree Station made,
              // so its isolation is `shared`.
              workspaceIsolation: { mode: 'shared' },
              ...(place.project.id
                ? { [SESSION_LOCAL_PROJECT_ID_METADATA_KEY]: place.project.id }
                : {}),
            }
          : {}),
        // #3386: the folder the child was admitted into, symlink-resolved,
        // so every later engine start for it (a restart, a recovery) checks
        // the folder still resolves there and refuses if it was swapped
        // (`assertDispatchCwdUnmoved`), as for an admitted dispatch.
        [DISPATCH_CANONICAL_CWD_METADATA_KEY]: place.cwd,
        ...(userId !== undefined ? { userId } : {}),
        ...sessionOwnerAttributionMetadata(context.ownerAttribution),
        // #2493: server-built, so no strip is needed; absent is `workspace`.
        [STATION_CONFINEMENT_METADATA_KEY]:
          context.confinementStamp?.stamp === 'host' ? 'host' : 'workspace',
        // #1796: who granted the `host` stamp, as `prepareStart` records it.
        ...(context.confinementStamp?.stamp === 'host' &&
        context.confinementStamp.grantor
          ? {
              [STATION_CONFINEMENT_GRANTOR_METADATA_KEY]:
                context.confinementStamp.grantor,
            }
          : {}),
      },
      confinement:
        context.confinementStamp?.stamp === 'host' ? 'host' : 'workspace',
      ...(context.tenantExecutionContext
        ? { tenantExecutionContext: context.tenantExecutionContext }
        : {}),
    };
    const launchInput = this.deps.withAcceptedModelLaunchPlan(
      adapter,
      baseAdoptionInput,
      'resume',
      source.model,
    );
    const adoptionInput: ProviderSessionAdoptInput = {
      ...baseAdoptionInput,
      ...launchInput,
      sourceSessionId: context.sourceSessionId,
      sourceKind: context.sourceKind,
      ...(context.reservation.sourceAffinity
        ? { sourceAffinity: context.reservation.sourceAffinity }
        : {}),
      ...(context.reservation.sourceBoundary
        ? { sourceBoundary: context.reservation.sourceBoundary }
        : {}),
    };
    await this.deps.assertAdapterReady(adapter);
    this.deps.assertAdapterCurrent(adapter);
    await this.reverifyAdoptionPlace(context);
    const startCreation = () => {
      if (context.providerAdoptionStarted)
        throw new Error('Provider reported child creation more than once.');
      this.requireAdoptionTransition(
        this.requireOwnedAdoption(context).markForking(),
      );
      context.providerAdoptionStarted = true;
    };
    if (adapter.adoptionLifecycle !== 'reported') startCreation();
    const adopted = await adapter.adoptSession!(adoptionInput, {
      onProviderChildCreationStarted: startCreation,
      onProviderChildCreated: (cursor) => {
        const missingStart = !context.providerAdoptionStarted;
        if (missingStart) startCreation();
        this.requireAdoptionTransition(
          this.requireOwnedAdoption(context).recordProviderCursor(cursor),
        );
        if (missingStart)
          throw new Error(
            'Provider created a child without reporting its creation boundary.',
          );
      },
    });
    this.deps.recordAcceptedModelLaunchPlan(
      adapter,
      this.deps.modelLaunchPlanFromInput(adoptionInput),
      'resume',
      this.deps.modelLaunchRequestedOverrideFromInput(adoptionInput),
    );
    return adopted;
  }

  private commitAdoptedSession(
    context: AdoptionContext,
    child: ProviderSession,
    receipt: OrchestrationCommandReceipt,
  ): void {
    this.requireAdoptionTransition(
      this.requireOwnedAdoption(context).commit(child, receipt),
    );
    this.deps.trackSession(child, context.adapter);
  }

  private validateAdoptedProviderChild(
    context: AdoptionContext,
    adopted: ProviderSession,
  ): void {
    if (
      adopted.threadId !== context.reservation.targetThreadId ||
      adopted.provider !== context.source.provider ||
      adopted.resumeCursor === undefined ||
      adopted.resumeCursor === context.sourceSessionId
    ) {
      throw new Error('Provider did not confirm an independent child.');
    }
  }

  private buildAdoptedChild(
    context: AdoptionContext,
    adopted: ProviderSession,
  ): ProviderSession {
    const tenantExecutionContext = context.tenantExecutionContext;
    return {
      ...adopted,
      controlMode: 'station-owned',
      attachedSource: undefined,
      cwd: context.place.cwd,
      continuationSourceThreadId: context.reservation.sourceThreadId,
      ...(context.reservation.idempotencyKey
        ? { adoptionIdempotencyKey: context.reservation.idempotencyKey }
        : {}),
      persistSession: true,
      ...(tenantExecutionContext
        ? {
            tenantExecutionContext: tenantExecutionContextFromSession(
              tenantExecutionContext,
            ),
          }
        : {}),
    };
  }

  private async rollbackAdoption(context: AdoptionContext): Promise<boolean> {
    const adoption = this.requireOwnedAdoption(context);
    const { reservation } = adoption;
    if (!this.persistAdoptionRollbackState(context)) return false;
    this.deps.forgetAbandonedAdoptionMemory(reservation);
    try {
      await this.cleanupAdoptionReservation(adoption, context.adapter);
    } catch (error) {
      this.deps.logCleanupFailure('reserved resources', reservation, error);
    }
    return this.adoptionReservationWasDeleted(reservation);
  }

  private requireOwnedAdoption(context: AdoptionContext): OwnedAdoption {
    if (!context.adoption) {
      throw new Error('Adoption reservation ownership is unavailable.');
    }
    return context.adoption;
  }

  private requireAdoptionTransition(result: AdoptionTransition): void {
    if (result.kind === 'applied') return;
    if (result.kind === 'ownership-lost') {
      throw new Error('Adoption reservation ownership was lost.');
    }
    throw new Error(`Invalid adoption transition: ${result.reason}.`);
  }
  private persistAdoptionRollbackState(context: AdoptionContext): boolean {
    const adoption = this.requireOwnedAdoption(context);
    const reservation = adoption.reservation;
    try {
      this.requireAdoptionTransition(adoption.markRollbackPending());
    } catch (error) {
      this.deps.logCleanupFailure('reservation state', reservation, error);
      return false;
    }
    if (!context.providerAdoptionStarted) {
      try {
        this.requireAdoptionTransition(adoption.markProviderCleanupComplete());
      } catch (error) {
        this.deps.logCleanupFailure('reservation state', reservation, error);
        return false;
      }
    }
    return true;
  }

  private adoptionReservationWasDeleted(
    reservation: AdoptionReservation,
  ): boolean {
    try {
      return !this.deps.adoptionLedger
        ?.reservations()
        .some((item) => item.sourceThreadId === reservation.sourceThreadId);
    } catch (error) {
      this.deps.logCleanupFailure('reservation state', reservation, error);
      return false;
    }
  }

  private async reconcilePendingAdoptions(): Promise<void> {
    for (const reservation of this.deps.adoptionLedger?.reservations() ?? []) {
      if (adoptionReservationOwnerIsLive(reservation)) continue;
      const adapter = this.deps.adapterRegistry.get(reservation.provider);
      if (!adapter?.discardSession) continue;
      try {
        const reclaimed = this.deps.adoptionLedger?.reclaim({
          reservation,
          ownerId: this.ownerId,
          ownerPid: process.pid,
        });
        if (reclaimed?.kind !== 'owner') continue;
        const adoption = reclaimed.adoption;
        this.requireAdoptionTransition(adoption.markRollbackPending());
        if (
          reservation.status === 'pending' &&
          reservation.providerResumeCursor === undefined
        ) {
          this.requireAdoptionTransition(
            adoption.markProviderCleanupComplete(),
          );
        }
        await this.cleanupAdoptionReservation(adoption, adapter);
      } catch (error) {
        this.deps.logCleanupFailure('reserved resources', reservation, error);
      }
    }
  }

  private async cleanupAdoptionReservation(
    adoption: OwnedAdoption,
    adapter: ProviderAdapterShape,
  ): Promise<void> {
    await this.cleanupReservedFlowRun(adoption);
    await this.cleanupReservedProviderChild(adoption, adapter);
    this.requireAdoptionTransition(adoption.completeCleanup());
  }

  private async cleanupReservedFlowRun(adoption: OwnedAdoption): Promise<void> {
    const reservation = adoption.reservation;
    if (reservation.flowCleanupComplete) return;
    if (!reservation.flowRunId || reservation.flowRunResumed) {
      this.requireAdoptionTransition(adoption.markFlowCleanupComplete());
      return;
    }
    try {
      await this.deps.flowRunService?.discardRun(
        reservation.projectRoot,
        reservation.flowRunId,
      );
      this.requireAdoptionTransition(adoption.markFlowCleanupComplete());
    } catch (error) {
      this.deps.logCleanupFailure('Flow run', reservation, error);
    }
  }

  private async cleanupReservedProviderChild(
    adoption: OwnedAdoption,
    adapter: ProviderAdapterShape,
  ): Promise<void> {
    const reservation = adoption.reservation;
    if (reservation.providerCleanupComplete) return;
    try {
      await adapter.discardSession?.(reservation.targetThreadId, {
        adoptionKey: reservation.targetThreadId,
        createdAt: reservation.createdAt,
        cwd: reservation.cwd,
        resumeCursor: reservation.providerResumeCursor,
        sourceAffinity: reservation.sourceAffinity,
        sourceSessionId: reservation.sourceSessionId,
        sourceKind: reservation.sourceKind,
      });
      this.requireAdoptionTransition(adoption.markProviderCleanupComplete());
    } catch (error) {
      this.deps.logCleanupFailure('provider child', reservation, error);
    }
  }
  /** Adoption responses contain Station identity only, never provider cursors or paths. */
  private publicAdoptedSession(session: ProviderSession): AdoptedSessionResult {
    return {
      threadId: session.threadId,
      provider: session.provider,
      controlMode: 'station-owned',
      status: session.status,
      ...(session.model ? { model: session.model } : {}),
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
    };
  }
}
