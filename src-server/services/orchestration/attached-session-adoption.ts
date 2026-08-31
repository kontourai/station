import crypto from 'node:crypto';
import type {
  AdoptedSessionResult,
  OrchestrationCommandDispatchResult,
  OrchestrationCommandReceipt,
} from '@kontourai/station-contracts/orchestration';
import type {
  EngineId,
  ModelLaunchPlan,
  ProviderSession,
  ProviderSessionStartInput,
} from '@kontourai/station-contracts/provider';
import type { TenantExecutionContext } from '@kontourai/station-contracts/tenancy';
import { tenantExecutionContextFromSession } from '@kontourai/station-contracts/tenancy';
import type {
  ProviderAdapterShape,
  ProviderSessionAdoptInput,
} from '../../providers/adapter-shape.js';
import { withTenantExecutionContext } from '../../runtime/bootstrap/runtime-tenant-context.js';
import type {
  AdoptionLedger,
  AdoptionReservation,
  AdoptionReservationInput,
  AdoptionTransition,
  OwnedAdoption,
} from './adoption-ledger.js';
import { resolveAttachedProjectRoot } from './attached-session-follow-service.js';
import type { EventStore } from './event-store.js';

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
// the service's `initialize()`, NEVER from this constructor — the suite
// constructs the service 126 times per process, and a ctor-registered owner
// would mark every crashed test reservation as live (plan condition 3).

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
  project: { slug: string; cwd: string; workingDirectory: string };
  reservation: AdoptionReservationInput;
  adoption?: OwnedAdoption;
  providerAdoptionStarted: boolean;
  tenantExecutionContext?: TenantExecutionContext;
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
  listProjects?: () => Array<{ slug: string; workingDirectory?: string }>;
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
    );
  }

  private async performAttachedSessionAdoption(
    sourceThreadId: string,
    receipt: OrchestrationCommandReceipt,
    userId?: string,
    requestTenantExecutionContext?: TenantExecutionContext,
    idempotencyKey?: string,
  ): Promise<OrchestrationCommandDispatchResult<AdoptedSessionResult>> {
    await this.reconciliation;
    // Resolve and authorize the source before treating an existing child as
    // idempotent. A receipt is continuation metadata, so hosted callers must
    // not receive one unless their request binding matches every server-held
    // binding involved in this adoption.
    const context = this.resolveAdoptionContext(sourceThreadId);
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
        error: error instanceof Error ? error.message : String(error),
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

  private resolveAdoptionContext(sourceThreadId: string): AdoptionContext {
    const eventStore = this.deps.eventStore;
    if (!eventStore) {
      throw new Error(
        'Durable orchestration storage is required for adoption.',
      );
    }
    const source = this.findAttachedAdoptionSource(sourceThreadId, eventStore);
    const sourceSessionId = source.attachedSource!.externalSessionId;
    const project = this.resolveAdoptionProject(source);
    const adapter = this.requireAdoptionAdapter(source.provider);
    return this.buildAdoptionContext({
      source,
      sourceSessionId,
      project,
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

  private resolveAdoptionProject(
    source: ProviderSession,
  ): AdoptionContext['project'] {
    const attribution = resolveAttachedProjectRoot(
      source.cwd!,
      this.deps.listProjects?.() ?? [],
    );
    // archive#1462: adoption binds a session to one project, so an ambiguous
    // workspace refuses by name instead of adopting into an arbitrary winner.
    if (attribution.state === 'ambiguous') {
      throw new Error(
        `The attached session workspace ${attribution.workingDirectory} is configured as more than one project (${attribution.candidates.join(', ')}). Continue it from the project you meant, or remove the duplicate project.`,
      );
    }
    if (attribution.state === 'unattributed') {
      throw new Error(
        'The attached session workspace is no longer a configured project.',
      );
    }
    return {
      slug: attribution.slug,
      cwd: attribution.cwd,
      workingDirectory: attribution.workingDirectory,
    };
  }

  private requireAdoptionAdapter(provider: EngineId): ProviderAdapterShape {
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
    project: AdoptionContext['project'];
    adapter: ProviderAdapterShape;
  }): AdoptionContext {
    const now = new Date().toISOString();
    return {
      source: input.source,
      sourceSessionId: input.sourceSessionId,
      sourceKind: input.source.attachedSource!.kind,
      adapter: input.adapter,
      project: input.project,
      reservation: {
        sourceThreadId: input.source.threadId,
        targetThreadId: crypto.randomUUID(),
        ownerId: this.ownerId,
        ownerPid: process.pid,
        provider: input.source.provider,
        sourceSessionId: input.sourceSessionId,
        sourceKind: input.source.attachedSource!.kind,
        cwd: input.project.cwd,
        projectRoot: input.project.workingDirectory,
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
    const { adapter, project, reservation, source } = context;
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
      cwd: project.cwd,
      // archive#1165: these are server-owned facts. The public adoption
      // command has no metadata channel, so neither the plan nor identity
      // can be forged by an adopting client.
      metadata: {
        adoptedFromThreadId: reservation.sourceThreadId,
        ...(userId !== undefined ? { userId } : {}),
      },
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
    };
    await this.deps.assertAdapterReady(adapter);
    this.deps.assertAdapterCurrent(adapter);
    this.requireAdoptionTransition(
      this.requireOwnedAdoption(context).markForking(),
    );
    context.providerAdoptionStarted = true;
    const adopted = await adapter.adoptSession!(adoptionInput, {
      onProviderChildCreated: (cursor) => {
        this.requireAdoptionTransition(
          this.requireOwnedAdoption(context).recordProviderCursor(cursor),
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
      cwd: context.project.cwd,
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
