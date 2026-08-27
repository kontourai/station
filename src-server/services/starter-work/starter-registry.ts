import type { AppConfig } from '@kontourai/station-contracts/config';
import type { AdoptedSessionResult } from '@kontourai/station-contracts/orchestration';
import type { SchedulerManualRunReceipt } from '@kontourai/station-contracts/scheduler';
import type {
  ContinueSessionStarterLaunchInput,
  ContinueSessionStarterLaunchResult,
  ScheduledCheckStarterLaunchInput,
  ScheduledCheckStarterLaunchResult,
  StarterInspectionCandidate,
  StarterInspectionId,
  StarterInspectionLaunchInput,
  StarterInspectionLaunchResult,
  StarterInspectionReference,
  StarterWorkBindInput,
  StarterWorkCatalogEntry,
  StarterWorkCorrelationDisposition,
  StarterWorkId,
  StarterWorkObservation,
  StarterWorkReference,
  StarterWorkStatus,
  StartTaskStarterLaunchInput,
  StartTaskStarterLaunchResult,
} from '@kontourai/station-contracts/starter-work';
import type { TaskDispatcher } from '../projects/task-dispatcher.js';
import type { TaskGraphService } from '../projects/task-graph-service.js';
import type {
  StarterOwnerAdapter,
  StarterOwnerResolution,
} from './starter-owner-adapter.js';
import {
  StarterWorkConflictError,
  type StarterWorkModule,
  StarterWorkUnavailableError,
} from './starter-work-module.js';

export type StarterLaunchReadiness = {
  check(
    input: StartTaskStarterLaunchInput,
  ): Promise<
    | { state: 'ready'; agentId?: string }
    | { state: 'deferred' | 'unavailable'; reason: string }
  >;
  checkScheduled(): Promise<
    | { state: 'ready'; agentId?: string }
    | { state: 'deferred' | 'unavailable'; reason: string }
  >;
};

export interface StarterScheduledCheckOwner {
  prepare(operationId: string): {
    readonly replayed: boolean;
    readonly completion: 'running' | 'completed' | 'failed' | 'indeterminate';
    readonly reference: Extract<
      StarterWorkReference,
      { kind: 'receipt'; owner: 'scheduler-run' }
    >;
    readonly receipt: SchedulerManualRunReceipt;
    readonly activate?: () => Promise<SchedulerManualRunReceipt>;
    readonly releaseUnstarted?: () => {
      kind: 'applied' | 'stale' | 'unavailable';
      reason?: string;
    };
  };
}

type ScheduledCheckPrepareFailure = Extract<
  ScheduledCheckStarterLaunchResult,
  { state: 'deferred' | 'unavailable' | 'conflict' }
>;

function scheduledCheckPrepareFailure(
  error: unknown,
): Omit<ScheduledCheckPrepareFailure, 'starterId'> {
  const code =
    error instanceof Error && error.name === 'StarterScheduledCheckPrepareError'
      ? (error as Error & { code?: unknown }).code
      : undefined;
  switch (code) {
    case 'busy':
      return {
        state: 'deferred',
        reason: 'A scheduled readiness check is already running.',
        retrySafe: true,
      };
    case 'collision':
      return {
        state: 'conflict',
        reason:
          'The canonical scheduled-check job name is already in use. Inspect Schedule before running this Starter.',
        retrySafe: false,
      };
    case 'capacity':
      return {
        state: 'unavailable',
        reason:
          'Scheduled-check Starter intent capacity is full. Inspect Schedule before running this Starter.',
        retrySafe: false,
      };
    case 'corrupt':
      return {
        state: 'unavailable',
        reason:
          'Scheduled-check storage needs operator repair before this Starter can run.',
        retrySafe: false,
      };
    case 'invalid':
      return {
        state: 'unavailable',
        reason: 'The scheduled-check Starter identity is invalid.',
        retrySafe: false,
      };
    default:
      return {
        state: 'unavailable',
        reason: 'Scheduled-check Starter could not prepare an exact run.',
        retrySafe: true,
      };
  }
}

export type StarterSessionOwner = {
  read(sessionId: string): Promise<{
    threadId: string;
    controlMode: 'read-only-attached' | 'station-owned';
  } | null>;
  continue(input: { sourceSessionId: string; operationId: string }): Promise<
    | {
        state: 'continued';
        session: AdoptedSessionResult;
        receiptId?: string;
      }
    | {
        state: 'failed' | 'unavailable' | 'indeterminate';
        reason: string;
        retrySafe: boolean;
        receiptId?: string;
      }
  >;
};

export class UnknownStarterWorkError extends Error {
  constructor() {
    super('Starter Work is not available.');
  }
}
export class StarterWorkTargetError extends Error {
  constructor(target: 'Task' | 'Session' | 'Approval' | 'Receipt' = 'Task') {
    const copy = {
      Task: 'Starter Work must target an existing Task in its exact Project.',
      Session: 'Starter Work must target an existing Station-owned Session.',
      Approval: 'Starter Work must target an exact approval notification.',
      Receipt: 'Starter Work must target an exact owner receipt.',
    } as const;
    super(copy[target]);
  }
}
export class StarterWorkPrerequisiteError extends Error {
  constructor(reason = 'Complete Station setup before starting guided work.') {
    super(reason);
  }
}

function inspectionHref(reference: StarterInspectionReference): string {
  if (reference.kind === 'approval')
    return `/notifications?approval=${encodeURIComponent(reference.id)}`;
  const params = new URLSearchParams({
    receipt: reference.id,
    ...(reference.owner === 'independent-review'
      ? { project: reference.projectSlug }
      : {}),
  });
  return reference.owner === 'independent-review'
    ? `/review-queue?${params.toString()}`
    : `/schedule?run=${encodeURIComponent(reference.id)}`;
}

function inspectionFailureReason(
  starterId: StarterInspectionId,
  state: Exclude<StarterOwnerResolution['state'], 'current'>,
): string {
  const owner =
    starterId === 'inspect-approval' ? 'approval request' : 'receipt';
  if (state === 'missing') return `The exact ${owner} is missing.`;
  if (state === 'stale') return `The exact ${owner} is stale.`;
  if (state === 'unavailable') return `The ${owner} owner is unavailable.`;
  return `The exact ${owner} could not be verified.`;
}

function scheduledReceiptCompletion(
  receipt: SchedulerManualRunReceipt,
): 'completed' | 'failed' | 'indeterminate' {
  if (receipt.outcome === 'completed') return 'completed';
  return receipt.outcome === 'indeterminate' ? 'indeterminate' : 'failed';
}

/**
 * Bounded Starter Work composition.  It is deliberately not a plugin registry:
 * adding an id requires adding its prerequisite, exact target validator, launch
 * intent, and observation adapter at this server-owned seam.
 */
export class StarterRegistry {
  constructor(
    private readonly module: StarterWorkModule,
    private readonly tasks: Pick<
      TaskGraphService,
      'createTaskIdempotent' | 'readTaskForOpen' | 'readTaskGraph'
    >,
    private readonly dispatcher: TaskDispatcher,
    private readonly readiness: StarterLaunchReadiness,
    private readonly sessions: StarterSessionOwner,
    private readonly getAppConfig: () => AppConfig,
    private readonly owners?: StarterOwnerAdapter,
    private readonly scheduledChecks?: StarterScheduledCheckOwner,
  ) {}

  private assertKnown(id: string): asserts id is StarterWorkId {
    if (
      id !== 'start-task' &&
      id !== 'continue-session' &&
      id !== 'inspect-approval' &&
      id !== 'inspect-receipt' &&
      id !== 'run-scheduled-check'
    )
      throw new UnknownStarterWorkError();
  }
  private assertPrerequisite() {
    if (this.getAppConfig().firstRun?.status !== 'completed')
      throw new StarterWorkPrerequisiteError();
  }
  private requireOwners(): StarterOwnerAdapter {
    if (!this.owners)
      throw new StarterWorkPrerequisiteError(
        'Starter inspection owners are unavailable.',
      );
    return this.owners;
  }
  private requireScheduledChecks(): StarterScheduledCheckOwner {
    if (!this.scheduledChecks)
      throw new StarterWorkPrerequisiteError(
        'Scheduled-check Starter owner is unavailable.',
      );
    return this.scheduledChecks;
  }
  async status(id: string): Promise<StarterWorkStatus> {
    this.assertKnown(id);
    return this.module.status(id);
  }
  async list(): Promise<StarterWorkCatalogEntry[]> {
    const [
      taskStatus,
      sessionStatus,
      approvalStatus,
      receiptStatus,
      scheduledCheckStatus,
    ] = await Promise.all([
      this.module.status('start-task'),
      this.module.status('continue-session'),
      this.module.status('inspect-approval'),
      this.module.status('inspect-receipt'),
      this.module.status('run-scheduled-check'),
    ]);
    return [
      {
        id: 'start-task',
        title: 'Start your first task',
        description:
          'Create and dispatch one real Station Task, then inspect its receipt.',
        targetKind: 'task',
        prerequisite: 'first-run-completed',
        status: taskStatus,
      },
      {
        id: 'continue-session',
        title: 'Continue an attached session',
        description:
          'Continue one exact read-only Session as a Station-owned child.',
        targetKind: 'session',
        prerequisite: 'first-run-completed',
        status: sessionStatus,
      },
      {
        id: 'inspect-approval',
        title: 'Inspect an approval',
        description:
          'Open one exact approval request without deciding it automatically.',
        targetKind: 'approval',
        prerequisite: 'first-run-completed',
        status: approvalStatus,
      },
      {
        id: 'inspect-receipt',
        title: 'Inspect a review receipt',
        description:
          'Open one exact independent-review receipt as evidence input.',
        targetKind: 'receipt',
        prerequisite: 'first-run-completed',
        status: receiptStatus,
      },
      {
        id: 'run-scheduled-check',
        title: 'Run a scheduled readiness check',
        description:
          'Create a disabled recurring check and run it once with an exact scheduler receipt.',
        targetKind: 'receipt',
        prerequisite: 'first-run-completed',
        status: scheduledCheckStatus,
      },
    ];
  }
  async bind(input: StarterWorkBindInput) {
    this.assertKnown(input.starterId);
    this.assertPrerequisite();
    if (input.starterId === 'start-task') {
      if (input.targetRef.kind !== 'task') throw new StarterWorkTargetError();
      const task = await this.tasks.readTaskForOpen(input.targetRef.id);
      if (!task || task.projectId !== input.targetRef.projectId)
        throw new StarterWorkTargetError();
      return this.module.bind(input);
    }
    if (input.starterId === 'continue-session') {
      if (input.targetRef.kind !== 'session')
        throw new StarterWorkTargetError('Session');
      const session = await this.sessions.read(input.targetRef.id);
      if (session?.controlMode !== 'station-owned')
        throw new StarterWorkTargetError('Session');
      return this.module.bind(input);
    }
    if (input.starterId === 'run-scheduled-check') {
      if (
        input.targetRef.kind !== 'receipt' ||
        input.targetRef.owner !== 'scheduler-run'
      )
        throw new StarterWorkTargetError('Receipt');
      const resolution = await this.requireOwners().resolve(input.targetRef);
      if (resolution.state !== 'current')
        throw new StarterWorkTargetError('Receipt');
      return this.module.bind(input);
    }
    if (input.starterId === 'inspect-approval') {
      if (input.targetRef.kind !== 'approval')
        throw new StarterWorkTargetError('Approval');
      const resolution = await this.requireOwners().resolve(input.targetRef);
      if (resolution.state !== 'current')
        throw new StarterWorkTargetError('Approval');
      return this.module.bind(input);
    }
    if (input.starterId === 'inspect-receipt') {
      if (input.targetRef.kind !== 'receipt')
        throw new StarterWorkTargetError('Receipt');
      const resolution = await this.requireOwners().resolve(input.targetRef);
      if (resolution.state !== 'current')
        throw new StarterWorkTargetError('Receipt');
      return this.module.bind(input);
    }
    throw new UnknownStarterWorkError();
  }

  async candidate(id: string): Promise<StarterInspectionCandidate> {
    this.assertKnown(id);
    this.assertPrerequisite();
    if (id !== 'inspect-approval' && id !== 'inspect-receipt')
      throw new UnknownStarterWorkError();
    const candidate = await this.requireOwners().candidate(
      id === 'inspect-approval' ? 'approval' : 'receipt',
    );
    return candidate.state === 'current'
      ? { ...candidate, starterId: id }
      : {
          ...candidate,
          starterId: id,
          reason:
            candidate.state === 'missing'
              ? `No ${id === 'inspect-approval' ? 'approval request' : 'review receipt'} is available to inspect.`
              : 'The exact owner could not be read.',
          retrySafe: true,
        };
  }

  async launchInspection(
    input: StarterInspectionLaunchInput,
  ): Promise<StarterInspectionLaunchResult> {
    this.assertKnown(input.starterId);
    this.assertPrerequisite();
    const expectedKind =
      input.starterId === 'inspect-approval' ? 'approval' : 'receipt';
    if (input.targetRef.kind !== expectedKind)
      throw new StarterWorkTargetError(
        expectedKind === 'approval' ? 'Approval' : 'Receipt',
      );
    const resolution = await this.requireOwners().resolve(input.targetRef);
    if (resolution.state !== 'current')
      return {
        state: resolution.state,
        starterId: input.starterId,
        reason: inspectionFailureReason(input.starterId, resolution.state),
        retrySafe: true,
      };
    const bound = await this.module.bind(input);
    if (bound.outcome !== 'bound')
      throw new StarterWorkConflictError(bound.binding);
    return {
      state: 'opened',
      starterId: input.starterId,
      targetRef: input.targetRef,
      correlation: {
        state: 'bound',
        binding: bound.binding,
        replayed: bound.replayed,
      },
      href: inspectionHref(input.targetRef),
      completion: { state: resolution.completion },
      evidence: {
        state: 'NOT_VERIFIED',
        reason:
          input.starterId === 'inspect-approval'
            ? 'Inspecting an approval does not decide or verify its outcome.'
            : 'Independent review findings are evidence input, not a gate verdict.',
      },
    };
  }

  async launchScheduledCheck(
    input: ScheduledCheckStarterLaunchInput,
  ): Promise<ScheduledCheckStarterLaunchResult> {
    this.assertKnown(input.starterId);
    this.assertPrerequisite();
    const readiness = await this.readiness.checkScheduled();
    if (readiness.state !== 'ready')
      return {
        state: readiness.state,
        starterId: 'run-scheduled-check',
        reason: readiness.reason,
        retrySafe: true,
      };
    let prepared: ReturnType<StarterScheduledCheckOwner['prepare']>;
    try {
      prepared = this.requireScheduledChecks().prepare(input.operationId);
    } catch (error) {
      return {
        starterId: 'run-scheduled-check',
        ...scheduledCheckPrepareFailure(error),
      };
    }
    let bound: Awaited<ReturnType<StarterWorkModule['bind']>>;
    try {
      bound = await this.bind({
        starterId: 'run-scheduled-check',
        operationId: input.operationId,
        targetRef: prepared.reference,
      });
    } catch (error) {
      if (!prepared.replayed && prepared.releaseUnstarted) {
        const released = prepared.releaseUnstarted();
        if (released.kind === 'unavailable')
          throw new StarterWorkUnavailableError(
            'Scheduled-check Starter could not release an unstarted intent.',
          );
      }
      throw error;
    }
    if (bound.outcome !== 'bound')
      throw new StarterWorkConflictError(bound.binding);
    let receipt = prepared.receipt;
    let completion = prepared.completion;
    if (prepared.activate) {
      try {
        receipt = await prepared.activate();
        completion = scheduledReceiptCompletion(receipt);
      } catch {
        completion = 'indeterminate';
      }
    }
    return {
      state: 'started',
      starterId: 'run-scheduled-check',
      receipt: prepared.reference,
      correlation: {
        state: 'bound',
        binding: bound.binding,
        replayed: bound.replayed,
      },
      replayed: prepared.replayed,
      href: inspectionHref(prepared.reference),
      completion: { state: completion },
      evidence: {
        state: 'NOT_VERIFIED',
        reason:
          'Scheduler completion proves that the check ran, not that its findings passed a gate.',
      },
    };
  }
  /** One owner-controlled create → bind → dispatch transaction. */
  async launchStartTask(
    input: StartTaskStarterLaunchInput,
  ): Promise<StartTaskStarterLaunchResult> {
    this.assertKnown(input.starterId);
    this.assertPrerequisite();
    const readiness = await this.readiness.check(input);
    if (readiness.state !== 'ready')
      return {
        state: readiness.state,
        reason: readiness.reason,
        retrySafe: true,
      };
    const task = await this.tasks.createTaskIdempotent(
      {
        ...input.task,
        agentId: input.task.agentId ?? readiness.agentId,
      },
      'starter-work:start-task',
      input.operationId,
    );
    const taskRef = {
      kind: 'task' as const,
      id: task.id,
      projectId: task.projectId,
    };
    let correlation: Extract<
      StartTaskStarterLaunchResult,
      { state: 'started' }
    >['correlation'];
    try {
      const bound = await this.module.bind({
        starterId: 'start-task',
        operationId: input.operationId,
        targetRef: taskRef,
      });
      if (bound.outcome !== 'bound') throw new StarterWorkTargetError();
      correlation = {
        state: 'bound',
        binding: bound.binding,
        replayed: bound.replayed,
      };
    } catch (error) {
      return {
        state: 'started',
        task: taskRef,
        correlation: {
          state: 'not_verified',
          reason:
            error instanceof Error
              ? error.message
              : 'Starter Work binding is unavailable.',
        },
        dispatch: {
          state: 'failed',
          reason:
            'Dispatch was not requested because starter correlation is not verified.',
          retrySafe: false,
        },
        evidence: {
          state: 'NOT_VERIFIED',
          reason: 'Starter correlation was not durably confirmed.',
        },
      };
    }
    const evidence = {
      state: 'NOT_VERIFIED' as const,
      reason:
        'Task receipt evidence has not yet established a pass or exception.',
    };
    const fenced = await this.module.beginLaunch({
      operationId: input.operationId,
      task: taskRef,
      binding: correlation.binding,
    });
    if (fenced.replayed) {
      if (fenced.record.dispatch && fenced.record.evidence)
        return {
          state: 'started',
          task: taskRef,
          correlation,
          dispatch: fenced.record.dispatch,
          evidence: fenced.record.evidence,
        };
      return {
        state: 'started',
        task: taskRef,
        correlation,
        dispatch: {
          state: 'indeterminate',
          reason:
            'A prior starter dispatch was admitted but has no durable terminal outcome. Do not retry dispatch automatically.',
          retrySafe: false,
        },
        evidence: {
          state: 'NOT_VERIFIED',
          reason: 'The prior dispatch outcome is indeterminate.',
        },
      };
    }
    const outcome = await this.dispatcher.dispatch(task.id, {
      ...input.dispatch,
      agentId: input.dispatch?.agentId ?? task.agentId ?? readiness.agentId,
      skillName: input.dispatch?.skillName ?? task.skillName,
      sourceSurface: 'starter-work',
    });
    let dispatch: Extract<
      StartTaskStarterLaunchResult,
      { state: 'started' }
    >['dispatch'];
    if (outcome.kind === 'dispatched') {
      dispatch = {
        state: 'dispatched',
        session: { kind: 'session', id: outcome.result.session.threadId },
      };
    } else if (outcome.kind === 'indeterminate') {
      dispatch = {
        state: 'indeterminate',
        reason: outcome.reason,
        retrySafe: false,
      };
    } else {
      dispatch = {
        state:
          outcome.kind === 'aborted'
            ? 'aborted'
            : outcome.kind === 'unavailable'
              ? 'unavailable'
              : 'failed',
        reason: outcome.reason,
        retrySafe:
          outcome.kind === 'aborted' ||
          (outcome.kind === 'unavailable' && outcome.retryable),
      };
    }
    const completed = await this.module.completeLaunch(
      input.operationId,
      dispatch,
      evidence,
    );
    return {
      state: 'started',
      task: taskRef,
      correlation,
      dispatch: completed.dispatch!,
      evidence: completed.evidence!,
    };
  }

  async launchContinueSession(
    input: ContinueSessionStarterLaunchInput,
  ): Promise<ContinueSessionStarterLaunchResult> {
    this.assertKnown(input.starterId);
    this.assertPrerequisite();
    const source = {
      kind: 'session' as const,
      id: input.sourceSessionId,
    };
    const observed = await this.sessions.read(input.sourceSessionId);
    if (observed?.controlMode !== 'read-only-attached')
      return {
        state: 'unavailable',
        source,
        reason:
          'The exact read-only attached Session is unavailable or already owned by Station.',
        retrySafe: false,
      };
    let continuation: Awaited<ReturnType<StarterSessionOwner['continue']>>;
    try {
      continuation = await this.sessions.continue({
        sourceSessionId: input.sourceSessionId,
        operationId: input.operationId,
      });
    } catch (error) {
      return {
        state: 'indeterminate',
        source,
        reason:
          error instanceof Error
            ? error.message
            : 'The Session continuation outcome is unavailable.',
        retrySafe: true,
      };
    }
    if (continuation.state !== 'continued')
      return {
        ...continuation,
        source,
        ...(continuation.receiptId
          ? {
              receipt: {
                kind: 'receipt' as const,
                id: continuation.receiptId,
              },
            }
          : {}),
      };
    let correlation: StarterWorkCorrelationDisposition;
    try {
      const bound = await this.module.bind({
        starterId: 'continue-session',
        operationId: input.operationId,
        targetRef: {
          kind: 'session',
          id: continuation.session.threadId,
        },
      });
      if (bound.outcome !== 'bound') throw new StarterWorkTargetError();
      correlation = {
        state: 'bound',
        binding: bound.binding,
        replayed: bound.replayed,
      };
    } catch (error) {
      correlation = {
        state: 'not_verified',
        reason:
          error instanceof Error
            ? error.message
            : 'Session starter correlation is unavailable.',
      };
    }
    return {
      state: 'continued',
      source,
      session: continuation.session,
      correlation,
      ...(continuation.receiptId
        ? {
            receipt: {
              kind: 'receipt' as const,
              id: continuation.receiptId,
            },
          }
        : {}),
      evidence: {
        state: 'NOT_VERIFIED',
        reason:
          'The continuation command receipt does not prove that the Session completed useful Work.',
      },
    };
  }

  async observe(id: string): Promise<StarterWorkObservation> {
    this.assertKnown(id);
    const status = await this.module.status(id);
    if (id === 'run-scheduled-check') {
      if (status.state !== 'bound')
        return {
          starterId: id,
          correlation: { state: 'unbound' },
          completion: { state: 'NOT_VERIFIED' },
          evidence: {
            state: 'NOT_VERIFIED',
            reason: 'No exact scheduled-check receipt is bound.',
          },
        };
      const receipt = status.binding.targetRef;
      if (receipt.kind !== 'receipt' || receipt.owner !== 'scheduler-run')
        return {
          starterId: id,
          correlation: {
            state: 'not_verified',
            reason: 'The scheduled-check target is not a Scheduler receipt.',
          },
          completion: { state: 'NOT_VERIFIED' },
          evidence: {
            state: 'NOT_VERIFIED',
            reason: 'The scheduled-check receipt is not observable.',
          },
        };
      const resolution = await this.requireOwners().resolve(receipt);
      return {
        starterId: id,
        correlation: {
          state: 'bound',
          binding: status.binding,
          replayed: true,
        },
        receipt,
        href: inspectionHref(receipt),
        completion:
          resolution.state === 'current'
            ? { state: resolution.completion }
            : {
                state:
                  resolution.state === 'not_verified'
                    ? 'NOT_VERIFIED'
                    : resolution.state,
              },
        evidence: {
          state: 'NOT_VERIFIED',
          reason:
            'Scheduler completion proves that the check ran, not that its findings passed a gate.',
        },
      };
    }
    if (id === 'inspect-approval' || id === 'inspect-receipt') {
      if (status.state !== 'bound')
        return {
          starterId: id,
          correlation: { state: 'unbound' },
          completion: { state: 'NOT_VERIFIED' },
          evidence: {
            state: 'NOT_VERIFIED',
            reason: 'No exact inspection target is bound.',
          },
        };
      const targetRef = status.binding.targetRef;
      const expectedKind = id === 'inspect-approval' ? 'approval' : 'receipt';
      if (targetRef.kind !== expectedKind)
        return {
          starterId: id,
          correlation: {
            state: 'not_verified',
            reason: 'The inspection target kind does not match its Starter.',
          },
          completion: { state: 'NOT_VERIFIED' },
          evidence: {
            state: 'NOT_VERIFIED',
            reason: 'The inspection target is not observable.',
          },
        };
      const reference = targetRef as StarterInspectionReference;
      const resolution = await this.requireOwners().resolve(reference);
      return {
        starterId: id,
        correlation: {
          state: 'bound',
          binding: status.binding,
          replayed: true,
        },
        targetRef: reference,
        href: inspectionHref(reference),
        completion:
          resolution.state === 'current'
            ? { state: resolution.completion }
            : {
                state:
                  resolution.state === 'not_verified'
                    ? 'NOT_VERIFIED'
                    : resolution.state,
              },
        evidence: {
          state: 'NOT_VERIFIED',
          reason:
            id === 'inspect-approval'
              ? 'Approval state is owner-derived; inspection does not decide it.'
              : 'Independent review evidence remains input-only.',
        },
      };
    }
    if (status.state !== 'bound') {
      return {
        starterId: id,
        correlation: { state: 'unbound' },
        evidence: {
          state: 'NOT_VERIFIED',
          reason: `No exact starter ${id === 'start-task' ? 'Task' : 'Session'} is bound.`,
        },
      };
    }
    const binding = status.binding;
    if (id === 'continue-session') {
      if (binding.targetRef.kind !== 'session')
        return {
          starterId: id,
          correlation: {
            state: 'not_verified',
            reason: 'The Session starter target is not observable.',
          },
          evidence: {
            state: 'NOT_VERIFIED',
            reason: 'The Session starter target is not observable.',
          },
        };
      const session = await this.sessions.read(binding.targetRef.id);
      const owned = session?.controlMode === 'station-owned';
      return {
        starterId: id,
        correlation: owned
          ? { state: 'bound', binding, replayed: true }
          : {
              state: 'not_verified',
              reason: 'The exact continued Session is unavailable.',
            },
        session: { kind: 'session', id: binding.targetRef.id },
        evidence: {
          state: 'NOT_VERIFIED',
          reason: owned
            ? 'The exact Session exists; its owner has not supplied completion evidence.'
            : 'The exact continued Session is unavailable or is not Station-owned.',
        },
      };
    }
    if (binding.targetRef.kind !== 'task') {
      return {
        starterId: 'start-task',
        correlation: {
          state: 'not_verified',
          reason: 'Starter target is not observable.',
        },
        evidence: {
          state: 'NOT_VERIFIED',
          reason: 'Starter target is not observable.',
        },
      };
    }
    const task = await this.tasks.readTaskForOpen(binding.targetRef.id);
    if (!task || task.projectId !== binding.targetRef.projectId) {
      return {
        starterId: 'start-task',
        correlation: {
          state: 'not_verified',
          reason: 'The exact starter Task is unavailable.',
        },
        task: binding.targetRef,
        evidence: {
          state: 'NOT_VERIFIED',
          reason: 'The Task owner could not be read.',
        },
      };
    }
    const graph = await this.tasks.readTaskGraph(binding.targetRef.id);
    const session = graph?.links.find(
      (link) =>
        link.sourceType === 'task' &&
        link.sourceId === binding.targetRef.id &&
        link.targetType === 'session' &&
        link.relationType === 'spawned_session',
    );
    const receipt = graph?.links.find(
      (link) =>
        link.sourceType === 'task' &&
        link.sourceId === binding.targetRef.id &&
        link.targetType === 'receipt' &&
        link.relationType === 'references_receipt',
    );
    return {
      starterId: 'start-task',
      correlation: { state: 'bound', binding, replayed: true },
      task: binding.targetRef,
      ...(session
        ? { session: { kind: 'session' as const, id: session.targetId } }
        : {}),
      ...(receipt
        ? { receipt: { kind: 'receipt' as const, id: receipt.targetId } }
        : {}),
      evidence: {
        state: 'NOT_VERIFIED',
        reason: receipt
          ? 'The exact receipt owner has not supplied a pass or exception verdict.'
          : 'No exact receipt is linked to this Task; Task status alone is not completion evidence.',
      },
    };
  }
  async clear(id: string) {
    this.assertKnown(id);
    return this.module.clearBinding(id);
  }
}
