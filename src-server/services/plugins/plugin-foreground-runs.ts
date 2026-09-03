import { createHash } from 'node:crypto';
import { isCanonicalPluginId } from '@kontourai/station-contracts/plugin';
import type {
  PluginForegroundRun,
  PluginForegroundWorkDeclaration,
  PluginForegroundWorkEffectDepth,
  PluginForegroundWorkJson,
  PluginForegroundWorkStartRequest,
  PluginForegroundWorkState,
} from '@kontourai/station-contracts/plugin-foreground-work';
import {
  PLUGIN_FOREGROUND_WORK_LIMITS,
  PLUGIN_FOREGROUND_WORK_SCHEMA_VERSION,
} from '@kontourai/station-contracts/plugin-foreground-work';
import type { RunSummary } from '@kontourai/station-contracts/runs';
import type { SessionReadAuthority } from '@kontourai/station-contracts/tenancy';
import type { Logger } from '../../utils/logger.js';
import type { ActionOperationActor } from '../operations/action-operation-service.js';
import {
  type ActionOperationTrackingHandle,
  type ActionOperationTrackingService,
  beginActionOperationTracking,
} from '../operations/action-operation-tracker.js';

const JOB_KIND = /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/;
const HOST_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const PUBLIC_TEXT_MAX = 320;
const DEFAULT_OBSERVER_TIMEOUT_MS = 1_000;
const MAX_OBSERVER_TIMEOUT_MS = 30_000;

export interface PluginForegroundWorkOwner {
  /** Canonical manifest identity. */
  readonly pluginId: string;
  /** Opaque host-minted installation identity; never projected to a caller. */
  readonly installationKey: string;
  readonly installationGeneration: number;
  /** Tenant-qualified account identity derived by the host. */
  readonly accountId: string;
  readonly machineId?: string;
}

export type PluginForegroundExecutionOwner =
  | {
      readonly id: string;
      readonly pid: number;
      readonly birth: string;
      readonly identityKind: 'exact';
    }
  | {
      readonly id: string;
      readonly pid: number;
      readonly identityKind: 'unverified';
    };

export interface PluginForegroundProcessIdentity {
  probe(pid: number):
    | { readonly state: 'dead' }
    | { readonly state: 'unavailable' }
    | {
        readonly state: 'exact';
        readonly identity: { readonly pid: number; readonly start: string };
      };
}

export interface PluginForegroundRunRecord extends PluginForegroundRun {
  readonly installationKey: string;
  readonly accountId: string;
  readonly machineId?: string;
  readonly idempotencyDigest: string;
  readonly inputDigest: string;
  readonly executionOwnerId: string;
  readonly executionOwnerPid: number;
  readonly executionOwnerBirth?: string;
  readonly executionOwnerIdentityKind: 'exact' | 'unverified';
}

export type PluginForegroundRunTransition =
  | { readonly kind: 'applied'; readonly record: PluginForegroundRunRecord }
  | { readonly kind: 'stale'; readonly record?: PluginForegroundRunRecord }
  | { readonly kind: 'unavailable' };

/**
 * Persistence port supplied by Station's run authority. A plugin module never
 * receives this capability and must not implement a private job registry.
 */
export interface PluginForegroundRunCoordinator {
  admit(
    record: PluginForegroundRunRecord,
  ):
    | { readonly kind: 'admitted' }
    | { readonly kind: 'existing'; readonly record: PluginForegroundRunRecord }
    | { readonly kind: 'unavailable' };
  transition(input: {
    readonly runId: string;
    readonly executionOwnerId: string;
    readonly from: readonly PluginForegroundWorkState[];
    readonly to: PluginForegroundWorkState;
    readonly effectDepth: PluginForegroundWorkEffectDepth;
    readonly now: string;
    readonly failureSummary?: string;
  }): PluginForegroundRunTransition;
  /** Atomically derives effect depth from the current active state. */
  settleCancellation(input: {
    readonly runId: string;
    readonly executionOwnerId: string;
    readonly to: Extract<
      PluginForegroundWorkState,
      'cancelled' | 'indeterminate'
    >;
    readonly now: string;
    readonly failureSummary?: string;
  }): PluginForegroundRunTransition;
  read(runId: string): PluginForegroundRunRecord | null;
  list(): PluginForegroundRunRecord[];
  active(): PluginForegroundRunRecord[];
}

export type PluginForegroundAuthorizationOutcome =
  | { readonly kind: 'granted' }
  | { readonly kind: 'denied' }
  | { readonly kind: 'unavailable' };

export interface PluginForegroundWorkAuthorizer {
  authorize(input: {
    readonly owner: PluginForegroundWorkOwner;
    readonly declaration: PluginForegroundWorkDeclaration;
    readonly taskId?: string;
    readonly sessionId?: string;
  }):
    | PluginForegroundAuthorizationOutcome
    | Promise<PluginForegroundAuthorizationOutcome>;
}

export interface PluginForegroundCancellationAdapter {
  /** Return confirmed only after the exact worker/process has stopped. */
  cancel(input: {
    readonly runId: string;
    readonly executionOwner: PluginForegroundExecutionOwner;
  }): Promise<'confirmed' | 'refused' | 'unknown'>;
}

export interface PluginForegroundRunObserverHandle {
  update(run: PluginForegroundRun): Promise<void>;
}

export interface PluginForegroundRunObserver {
  begin(input: {
    readonly owner: PluginForegroundWorkOwner;
    readonly declaration: PluginForegroundWorkDeclaration;
    readonly run: PluginForegroundRun;
  }): Promise<PluginForegroundRunObserverHandle | undefined>;
}

export interface PluginForegroundRunReader {
  list(
    authority: SessionReadAuthority,
  ): Promise<
    | { readonly kind: 'available'; readonly runs: PluginForegroundRun[] }
    | { readonly kind: 'unavailable' }
  >;
  read(
    runId: string,
    authority: SessionReadAuthority,
  ): Promise<
    | { readonly kind: 'available'; readonly run: PluginForegroundRun | null }
    | { readonly kind: 'unavailable' }
  >;
}

export interface PluginForegroundRunClaim {
  beginEffect(now: string): Promise<PluginForegroundRunTransition>;
  completed(now: string): Promise<PluginForegroundRunTransition>;
  failedBeforeEffect(
    now: string,
    failureSummary: string,
  ): Promise<PluginForegroundRunTransition>;
  failedAfterEffect(
    now: string,
    failureSummary: string,
    effectDepth?: Extract<
      PluginForegroundWorkEffectDepth,
      'possible-effect' | 'confirmed-effect'
    >,
  ): Promise<PluginForegroundRunTransition>;
  indeterminate(
    now: string,
    failureSummary: string,
  ): Promise<PluginForegroundRunTransition>;
}

export type PluginForegroundRunStartResult =
  | {
      readonly kind: 'admitted';
      readonly run: PluginForegroundRun;
      readonly claim: PluginForegroundRunClaim;
    }
  | { readonly kind: 'existing'; readonly run: PluginForegroundRun }
  | {
      readonly kind: 'refused';
      readonly reason:
        | 'invalid'
        | 'undeclared'
        | 'unauthorized'
        | 'authorization-unavailable'
        | 'idempotency-equivocation'
        | 'run-authority-unavailable';
    };

export type PluginForegroundCancellationResult =
  | { readonly kind: 'confirmed'; readonly run: PluginForegroundRun }
  | { readonly kind: 'refused'; readonly run: PluginForegroundRun }
  | { readonly kind: 'unknown'; readonly run: PluginForegroundRun }
  | { readonly kind: 'not-found' }
  | { readonly kind: 'unauthorized' }
  | { readonly kind: 'unavailable' };

export interface PluginForegroundRuns extends PluginForegroundRunReader {
  start(
    owner: PluginForegroundWorkOwner,
    request: PluginForegroundWorkStartRequest,
  ): Promise<PluginForegroundRunStartResult>;
  cancel(
    owner: PluginForegroundWorkOwner,
    runId: string,
  ): Promise<PluginForegroundCancellationResult>;
  /** Startup-only reconciliation. It never replays plugin work. */
  reconcile(now: string): { readonly kind: 'available' | 'unavailable' };
  /** Releases only this composed execution owner's in-process lease. */
  releaseOwner(): void;
}

interface JsonBudget {
  nodes: number;
}

function canonicalJson(
  value: unknown,
  depth: number,
  budget: JsonBudget,
): PluginForegroundWorkJson | undefined {
  if (
    depth > PLUGIN_FOREGROUND_WORK_LIMITS.inputDepth ||
    ++budget.nodes > PLUGIN_FOREGROUND_WORK_LIMITS.inputNodes
  ) {
    return undefined;
  }
  if (
    value === null ||
    typeof value === 'boolean' ||
    typeof value === 'string'
  ) {
    return value;
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : undefined;
  }
  if (Array.isArray(value)) {
    try {
      if (
        value.length >
          PLUGIN_FOREGROUND_WORK_LIMITS.inputNodes - budget.nodes ||
        Object.getOwnPropertySymbols(value).length > 0
      ) {
        return undefined;
      }
      const descriptors = Object.getOwnPropertyDescriptors(value);
      const keys = Object.keys(descriptors).filter((key) => key !== 'length');
      if (
        keys.length !== value.length ||
        keys.some((key, index) => key !== String(index))
      ) {
        return undefined;
      }
      const output: PluginForegroundWorkJson[] = [];
      for (const key of keys) {
        const descriptor = descriptors[key];
        if (
          !descriptor ||
          !('value' in descriptor) ||
          descriptor.enumerable !== true
        ) {
          return undefined;
        }
        const projected = canonicalJson(descriptor.value, depth + 1, budget);
        if (projected === undefined) return undefined;
        output.push(projected);
      }
      return output;
    } catch {
      return undefined;
    }
  }
  if (value === null || typeof value !== 'object') return undefined;
  try {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return undefined;
    if (Object.getOwnPropertySymbols(value).length > 0) return undefined;
    const ownNames = Object.getOwnPropertyNames(value);
    const keys = Object.keys(value);
    if (ownNames.length !== keys.length) return undefined;
    const output: Record<string, PluginForegroundWorkJson> =
      Object.create(null);
    for (const key of keys.sort()) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !('value' in descriptor)) return undefined;
      const projected = canonicalJson(descriptor.value, depth + 1, budget);
      if (projected === undefined) return undefined;
      output[key] = projected;
    }
    return output;
  } catch {
    return undefined;
  }
}

function inputDigest(value: unknown): string | undefined {
  const projected = canonicalJson(value, 0, { nodes: 0 });
  if (projected === undefined) return undefined;
  const serialized = JSON.stringify(projected);
  if (
    Buffer.byteLength(serialized) > PLUGIN_FOREGROUND_WORK_LIMITS.inputBytes
  ) {
    return undefined;
  }
  return createHash('sha256').update(serialized).digest('hex');
}

function safeTimestamp(value: string): boolean {
  return (
    value.length > 0 && value.length <= 64 && Number.isFinite(Date.parse(value))
  );
}

function safePublicText(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= PUBLIC_TEXT_MAX &&
    value.trim() === value &&
    ![...value].some((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code <= 31 || code === 127;
    }) &&
    !/(?:token|secret|authorization|bearer|api[_-]?key)\s*[:=]/i.test(value) &&
    !/(?:^|[^\p{L}\p{N}])\/(?=\S)/u.test(value) &&
    !/[A-Za-z]:[\\/]/u.test(value) &&
    !/\\/.test(value) &&
    !/[?&][A-Za-z0-9_.-]+=/.test(value)
  );
}

function validOwner(owner: PluginForegroundWorkOwner): boolean {
  return (
    isCanonicalPluginId(owner.pluginId) &&
    HOST_ID.test(owner.installationKey) &&
    Number.isSafeInteger(owner.installationGeneration) &&
    owner.installationGeneration > 0 &&
    HOST_ID.test(owner.accountId) &&
    (owner.machineId === undefined || HOST_ID.test(owner.machineId))
  );
}

function validRequest(
  request: PluginForegroundWorkStartRequest,
): { inputDigest: string } | undefined {
  if (
    request.schemaVersion !== PLUGIN_FOREGROUND_WORK_SCHEMA_VERSION ||
    !JOB_KIND.test(request.kind) ||
    typeof request.idempotencyKey !== 'string' ||
    request.idempotencyKey.length === 0 ||
    Buffer.byteLength(request.idempotencyKey) >
      PLUGIN_FOREGROUND_WORK_LIMITS.idempotencyKeyBytes ||
    (request.taskId !== undefined && !HOST_ID.test(request.taskId)) ||
    (request.sessionId !== undefined && !HOST_ID.test(request.sessionId))
  ) {
    return undefined;
  }
  const digest = inputDigest(request.input);
  return digest ? { inputDigest: digest } : undefined;
}

function validDeclaration(
  declaration: PluginForegroundWorkDeclaration,
): boolean {
  return (
    JOB_KIND.test(declaration.kind) &&
    safePublicText(declaration.title) &&
    declaration.requiredCapabilities.length <=
      PLUGIN_FOREGROUND_WORK_LIMITS.requiredCapabilitiesPerDeclaration &&
    new Set(declaration.requiredCapabilities).size ===
      declaration.requiredCapabilities.length &&
    declaration.requiredCapabilities.every((capability) =>
      JOB_KIND.test(capability),
    ) &&
    (declaration.cancellation === 'supported' ||
      declaration.cancellation === 'unsupported')
  );
}

function publicRun(record: PluginForegroundRunRecord): PluginForegroundRun {
  return {
    schemaVersion: record.schemaVersion,
    runId: record.runId,
    pluginId: record.pluginId,
    installationGeneration: record.installationGeneration,
    kind: record.kind,
    state: record.state,
    effectDepth: record.effectDepth,
    startedAt: record.startedAt,
    updatedAt: record.updatedAt,
    ...(record.completedAt ? { completedAt: record.completedAt } : {}),
    ...(record.taskId ? { taskId: record.taskId } : {}),
    ...(record.sessionId ? { sessionId: record.sessionId } : {}),
    ...(record.failureSummary ? { failureSummary: record.failureSummary } : {}),
  };
}

/** Canonical `/runs` projection; private owner and idempotency facts stay out. */
export function projectPluginForegroundRun(
  run: PluginForegroundRun,
): RunSummary {
  const terminal = isTerminal(run.state);
  return {
    runId: run.runId,
    providerId: `plugin:${run.pluginId}`,
    source: 'plugin',
    sourceId: run.kind,
    status:
      run.state === 'admitted'
        ? 'queued'
        : run.state === 'running'
          ? 'running'
          : run.state === 'completed'
            ? 'completed'
            : run.state === 'cancelled'
              ? 'cancelled'
              : 'failed',
    startedAt: run.startedAt,
    updatedAt: run.updatedAt,
    ...(terminal && run.completedAt ? { completedAt: run.completedAt } : {}),
    ...(run.state === 'failed' || run.state === 'indeterminate'
      ? {
          failureKind: 'unknown' as const,
          ...(run.failureSummary ? { failureMessage: run.failureSummary } : {}),
        }
      : {}),
    retryEligible: false,
    attempt: 1,
    metadata: {
      pluginId: run.pluginId,
      installationGeneration: run.installationGeneration,
      jobKind: run.kind,
      pluginForegroundState: run.state,
      effectDepth: run.effectDepth,
      ...(run.taskId ? { taskId: run.taskId } : {}),
      ...(run.sessionId ? { sessionId: run.sessionId } : {}),
    },
  };
}

function sameAdmission(
  existing: PluginForegroundRunRecord,
  proposed: PluginForegroundRunRecord,
): boolean {
  return (
    existing.runId === proposed.runId &&
    existing.pluginId === proposed.pluginId &&
    existing.installationKey === proposed.installationKey &&
    existing.installationGeneration === proposed.installationGeneration &&
    existing.accountId === proposed.accountId &&
    existing.machineId === proposed.machineId &&
    existing.kind === proposed.kind &&
    existing.idempotencyDigest === proposed.idempotencyDigest &&
    existing.inputDigest === proposed.inputDigest &&
    existing.taskId === proposed.taskId &&
    existing.sessionId === proposed.sessionId
  );
}

function isTerminal(state: PluginForegroundWorkState): boolean {
  return (
    state === 'completed' ||
    state === 'failed' ||
    state === 'cancelled' ||
    state === 'indeterminate'
  );
}

function ownerIsLive(
  record: PluginForegroundRunRecord,
  identity: PluginForegroundProcessIdentity,
  currentOwner: PluginForegroundExecutionOwner,
  currentOwnerActive: boolean,
): boolean {
  if (
    record.executionOwnerId === currentOwner.id &&
    record.executionOwnerPid === currentOwner.pid &&
    record.executionOwnerIdentityKind === currentOwner.identityKind &&
    (currentOwner.identityKind === 'unverified' ||
      record.executionOwnerBirth === currentOwner.birth)
  ) {
    return currentOwnerActive;
  }
  const observed = identity.probe(record.executionOwnerPid);
  if (observed.state === 'dead') return false;
  if (observed.state === 'unavailable') return true;
  return (
    record.executionOwnerIdentityKind !== 'exact' ||
    !record.executionOwnerBirth ||
    observed.identity.start === record.executionOwnerBirth
  );
}

function stableRunIdentity(input: {
  owner: PluginForegroundWorkOwner;
  request: PluginForegroundWorkStartRequest;
}): { runId: string; idempotencyDigest: string } {
  const idempotencyDigest = createHash('sha256')
    .update(input.request.idempotencyKey)
    .digest('hex');
  const digest = createHash('sha256')
    .update(
      JSON.stringify([
        PLUGIN_FOREGROUND_WORK_SCHEMA_VERSION,
        input.owner.pluginId,
        input.owner.installationKey,
        input.owner.installationGeneration,
        input.owner.accountId,
        input.owner.machineId ?? null,
        input.request.kind,
        idempotencyDigest,
      ]),
    )
    .digest('hex');
  return { runId: `plugin:${digest}`, idempotencyDigest };
}

function transitionWithIntent(input: {
  coordinator: PluginForegroundRunCoordinator;
  runId: string;
  executionOwnerId: string;
  from: readonly PluginForegroundWorkState[];
  to: PluginForegroundWorkState;
  effectDepth: PluginForegroundWorkEffectDepth;
  now: string;
  failureSummary?: string;
}): PluginForegroundRunTransition {
  if (
    !safeTimestamp(input.now) ||
    (input.failureSummary !== undefined &&
      !safePublicText(input.failureSummary))
  ) {
    return { kind: 'stale' };
  }
  try {
    return input.coordinator.transition({
      runId: input.runId,
      executionOwnerId: input.executionOwnerId,
      from: input.from,
      to: input.to,
      effectDepth: input.effectDepth,
      now: input.now,
      ...(input.failureSummary ? { failureSummary: input.failureSummary } : {}),
    });
  } catch {
    return { kind: 'unavailable' };
  }
}

function executionOwner(
  record: PluginForegroundRunRecord,
): PluginForegroundExecutionOwner {
  return record.executionOwnerIdentityKind === 'exact' &&
    record.executionOwnerBirth
    ? {
        id: record.executionOwnerId,
        pid: record.executionOwnerPid,
        birth: record.executionOwnerBirth,
        identityKind: 'exact',
      }
    : {
        id: record.executionOwnerId,
        pid: record.executionOwnerPid,
        identityKind: 'unverified',
      };
}

interface PluginForegroundCancellationIntent {
  readonly executionOwner: PluginForegroundExecutionOwner;
  outcome?: 'confirmed' | 'unknown';
  settlementNow?: string;
  inFlight?: Promise<PluginForegroundCancellationResult>;
}

function sameExecutionOwner(
  left: PluginForegroundExecutionOwner,
  right: PluginForegroundExecutionOwner,
): boolean {
  return (
    left.id === right.id &&
    left.pid === right.pid &&
    left.identityKind === right.identityKind &&
    (left.identityKind === 'unverified' ||
      (right.identityKind === 'exact' && left.birth === right.birth))
  );
}

/**
 * Deep host adapter for foreground plugin work. The coordinator is the only
 * source of run truth; Action Operations are a best-effort public observer.
 */
export function createPluginForegroundRuns(options: {
  readonly declarations: readonly PluginForegroundWorkDeclaration[];
  readonly coordinator: PluginForegroundRunCoordinator;
  readonly authorizer: PluginForegroundWorkAuthorizer;
  readonly executionOwner: PluginForegroundExecutionOwner;
  readonly processIdentity: PluginForegroundProcessIdentity;
  readonly canRead: (
    record: PluginForegroundRunRecord,
    authority: SessionReadAuthority,
  ) => boolean | Promise<boolean>;
  readonly cancellationAdapter?: PluginForegroundCancellationAdapter;
  readonly observer?: PluginForegroundRunObserver;
  /** Internal test/host bound; observers never get an unbounded control wait. */
  readonly observerTimeoutMs?: number;
  readonly logger?: Pick<Logger, 'warn'>;
}): PluginForegroundRuns {
  const observerTimeoutMs =
    options.observerTimeoutMs ?? DEFAULT_OBSERVER_TIMEOUT_MS;
  if (
    options.declarations.length >
      PLUGIN_FOREGROUND_WORK_LIMITS.declarationsPerPlugin ||
    options.declarations.some(
      (declaration) => !validDeclaration(declaration),
    ) ||
    new Set(options.declarations.map((declaration) => declaration.kind))
      .size !== options.declarations.length ||
    !HOST_ID.test(options.executionOwner.id) ||
    !Number.isSafeInteger(options.executionOwner.pid) ||
    options.executionOwner.pid < 1 ||
    !Number.isSafeInteger(observerTimeoutMs) ||
    observerTimeoutMs < 1 ||
    observerTimeoutMs > MAX_OBSERVER_TIMEOUT_MS
  ) {
    throw new Error('Invalid plugin foreground work composition');
  }
  const declarations = new Map(
    options.declarations.map((declaration) => [
      declaration.kind,
      Object.freeze(structuredClone(declaration)),
    ]),
  );
  let executionOwnerActive = true;
  let executionOwnerEpoch = 0;
  const observerHandles = new Map<string, PluginForegroundRunObserverHandle>();
  const cancellationIntents = new Map<
    string,
    PluginForegroundCancellationIntent
  >();

  const ownerFenceIsCurrent = (epoch: number) =>
    executionOwnerActive && executionOwnerEpoch === epoch;

  const runObserver = async <T>(
    runId: string,
    work: () => Promise<T>,
    onLateCompleted?: (value: T) => Promise<void>,
  ): Promise<T | undefined> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const operation = Promise.resolve()
      .then(work)
      .then(
        (value) => ({ kind: 'completed' as const, value }),
        (error: unknown) => ({ kind: 'failed' as const, error }),
      );
    const timeout = new Promise<{ kind: 'timed-out' }>((resolve) => {
      timer = setTimeout(
        () => resolve({ kind: 'timed-out' }),
        observerTimeoutMs,
      );
    });
    const result = await Promise.race([operation, timeout]);
    if (timer) clearTimeout(timer);
    if (result.kind === 'completed') return result.value;
    options.logger?.warn('Plugin foreground run observation unavailable', {
      runId,
      error:
        result.kind === 'timed-out'
          ? 'observer timed out'
          : result.error instanceof Error
            ? result.error.message
            : String(result.error),
    });
    if (result.kind === 'timed-out' && onLateCompleted) {
      void operation.then(async (lateResult) => {
        if (lateResult.kind === 'completed') {
          try {
            await onLateCompleted(lateResult.value);
          } catch (error) {
            options.logger?.warn(
              'Plugin foreground run late observation unavailable',
              {
                runId,
                error: error instanceof Error ? error.message : String(error),
              },
            );
          }
        }
      });
    }
    return undefined;
  };

  const updateObserver = async (
    handle: PluginForegroundRunObserverHandle | undefined,
    run: PluginForegroundRun,
  ): Promise<void> => {
    if (!handle) return;
    await runObserver(run.runId, () => handle.update(run));
  };

  const attachObserver = async (
    runId: string,
    handle: PluginForegroundRunObserverHandle | undefined,
  ): Promise<void> => {
    if (!handle) return;
    // Publish the handle first so a concurrent terminal transition cannot miss it.
    observerHandles.set(runId, handle);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      let current: PluginForegroundRunRecord | null;
      try {
        current = options.coordinator.read(runId);
      } catch (error) {
        options.logger?.warn('Plugin foreground run observation unavailable', {
          runId,
          error: error instanceof Error ? error.message : String(error),
        });
        return;
      }
      if (!current) {
        observerHandles.delete(runId);
        return;
      }
      await updateObserver(handle, publicRun(current));
      if (isTerminal(current.state)) {
        observerHandles.delete(runId);
        return;
      }
      let latest: PluginForegroundRunRecord | null;
      try {
        latest = options.coordinator.read(runId);
      } catch {
        return;
      }
      if (!latest) {
        observerHandles.delete(runId);
        return;
      }
      if (
        latest.state === current.state &&
        latest.updatedAt === current.updatedAt
      ) {
        return;
      }
    }
  };

  const observeTransition = async (
    result: PluginForegroundRunTransition,
  ): Promise<PluginForegroundRunTransition> => {
    if (result.kind === 'applied') {
      await updateObserver(
        observerHandles.get(result.record.runId),
        publicRun(result.record),
      );
      if (isTerminal(result.record.state)) {
        observerHandles.delete(result.record.runId);
      }
    }
    return result;
  };

  const driveCancellation = (
    record: PluginForegroundRunRecord,
    intent: PluginForegroundCancellationIntent,
  ): Promise<PluginForegroundCancellationResult> => {
    if (intent.inFlight) return intent.inFlight;
    const operation =
      (async (): Promise<PluginForegroundCancellationResult> => {
        if (!intent.outcome) {
          let cancellation: 'confirmed' | 'refused' | 'unknown';
          try {
            cancellation = await options.cancellationAdapter!.cancel({
              runId: record.runId,
              executionOwner: intent.executionOwner,
            });
          } catch {
            cancellation = 'unknown';
          }
          if (cancellation === 'refused') {
            cancellationIntents.delete(record.runId);
            return { kind: 'refused', run: publicRun(record) };
          }
          intent.outcome = cancellation;
          intent.settlementNow = new Date().toISOString();
        }
        let transition: PluginForegroundRunTransition;
        try {
          transition = options.coordinator.settleCancellation({
            runId: record.runId,
            executionOwnerId: intent.executionOwner.id,
            to: intent.outcome === 'confirmed' ? 'cancelled' : 'indeterminate',
            now: intent.settlementNow!,
            ...(intent.outcome === 'unknown'
              ? { failureSummary: 'Cancellation could not be confirmed.' }
              : {}),
          });
        } catch {
          transition = { kind: 'unavailable' };
        }
        if (transition.kind === 'unavailable') {
          return { kind: 'unavailable' };
        }
        cancellationIntents.delete(record.runId);
        if (transition.kind !== 'applied') {
          return {
            kind: 'refused',
            run: publicRun(transition.record ?? record),
          };
        }
        await observeTransition(transition);
        return {
          kind: intent.outcome,
          run: publicRun(transition.record),
        };
      })();
    intent.inFlight = operation;
    const clearInFlight = () => {
      if (intent.inFlight === operation) intent.inFlight = undefined;
    };
    void operation.then(clearInFlight, clearInFlight);
    return operation;
  };

  const runs: PluginForegroundRuns = {
    async start(owner, request) {
      const admissionEpoch = executionOwnerEpoch;
      if (!ownerFenceIsCurrent(admissionEpoch)) {
        return { kind: 'refused', reason: 'run-authority-unavailable' };
      }
      const valid = validRequest(request);
      if (!validOwner(owner) || !valid) {
        return { kind: 'refused', reason: 'invalid' };
      }
      const declaration = declarations.get(request.kind);
      if (!declaration) return { kind: 'refused', reason: 'undeclared' };
      let authorization: PluginForegroundAuthorizationOutcome;
      try {
        authorization = await options.authorizer.authorize({
          owner: structuredClone(owner),
          declaration: structuredClone(declaration),
          ...(request.taskId ? { taskId: request.taskId } : {}),
          ...(request.sessionId ? { sessionId: request.sessionId } : {}),
        });
      } catch {
        authorization = { kind: 'unavailable' };
      }
      if (!ownerFenceIsCurrent(admissionEpoch)) {
        return { kind: 'refused', reason: 'run-authority-unavailable' };
      }
      if (authorization.kind !== 'granted') {
        return {
          kind: 'refused',
          reason:
            authorization.kind === 'denied'
              ? 'unauthorized'
              : 'authorization-unavailable',
        };
      }
      const identity = stableRunIdentity({ owner, request });
      const now = new Date().toISOString();
      const record: PluginForegroundRunRecord = {
        schemaVersion: PLUGIN_FOREGROUND_WORK_SCHEMA_VERSION,
        runId: identity.runId,
        pluginId: owner.pluginId,
        installationKey: owner.installationKey,
        installationGeneration: owner.installationGeneration,
        accountId: owner.accountId,
        ...(owner.machineId ? { machineId: owner.machineId } : {}),
        kind: request.kind,
        state: 'admitted',
        effectDepth: 'uninvoked',
        idempotencyDigest: identity.idempotencyDigest,
        inputDigest: valid.inputDigest,
        executionOwnerId: options.executionOwner.id,
        executionOwnerPid: options.executionOwner.pid,
        ...(options.executionOwner.identityKind === 'exact'
          ? { executionOwnerBirth: options.executionOwner.birth }
          : {}),
        executionOwnerIdentityKind: options.executionOwner.identityKind,
        startedAt: now,
        updatedAt: now,
        ...(request.taskId ? { taskId: request.taskId } : {}),
        ...(request.sessionId ? { sessionId: request.sessionId } : {}),
      };
      let admission: ReturnType<PluginForegroundRunCoordinator['admit']>;
      if (!ownerFenceIsCurrent(admissionEpoch)) {
        return { kind: 'refused', reason: 'run-authority-unavailable' };
      }
      try {
        admission = options.coordinator.admit(record);
      } catch {
        return { kind: 'refused', reason: 'run-authority-unavailable' };
      }
      if (admission.kind === 'unavailable') {
        return { kind: 'refused', reason: 'run-authority-unavailable' };
      }
      if (admission.kind === 'existing') {
        return sameAdmission(admission.record, record)
          ? { kind: 'existing', run: publicRun(admission.record) }
          : { kind: 'refused', reason: 'idempotency-equivocation' };
      }

      const observer = options.observer
        ? await runObserver(
            record.runId,
            () =>
              options.observer!.begin({
                owner: structuredClone(owner),
                declaration: structuredClone(declaration),
                run: publicRun(record),
              }),
            (lateObserver) => attachObserver(record.runId, lateObserver),
          )
        : undefined;
      await attachObserver(record.runId, observer);
      let beginIntent:
        | { now: string; authorization: PluginForegroundAuthorizationOutcome }
        | undefined;
      let terminalIntent:
        | {
            to: PluginForegroundWorkState;
            from: readonly PluginForegroundWorkState[];
            depth: PluginForegroundWorkEffectDepth;
            now: string;
            summary?: string;
          }
        | undefined;
      const settle = async (intent: NonNullable<typeof terminalIntent>) => {
        if (!ownerFenceIsCurrent(admissionEpoch)) {
          return { kind: 'stale' } as const;
        }
        if (
          terminalIntent &&
          JSON.stringify(terminalIntent) !== JSON.stringify(intent)
        ) {
          return { kind: 'stale' } as const;
        }
        terminalIntent ??= intent;
        const settledIntent = terminalIntent;
        const result = await observeTransition(
          transitionWithIntent({
            coordinator: options.coordinator,
            runId: record.runId,
            executionOwnerId: options.executionOwner.id,
            from: settledIntent.from,
            to: settledIntent.to,
            effectDepth: settledIntent.depth,
            now: settledIntent.now,
            ...(settledIntent.summary
              ? { failureSummary: settledIntent.summary }
              : {}),
          }),
        );
        // An unavailable transition may have committed, so retries must retain
        // exactly one intent. A definitely stale transition applied nothing
        // and must not poison a later intent appropriate to current state.
        if (result.kind === 'stale' && terminalIntent === settledIntent) {
          terminalIntent = undefined;
        }
        return result;
      };
      const claim: PluginForegroundRunClaim = Object.freeze({
        beginEffect: async (beginNow: string) => {
          if (!ownerFenceIsCurrent(admissionEpoch)) {
            return { kind: 'stale' } as const;
          }
          if (!beginIntent) {
            let currentAuthorization: PluginForegroundAuthorizationOutcome;
            try {
              currentAuthorization = await options.authorizer.authorize({
                owner: structuredClone(owner),
                declaration: structuredClone(declaration),
                ...(request.taskId ? { taskId: request.taskId } : {}),
                ...(request.sessionId ? { sessionId: request.sessionId } : {}),
              });
            } catch {
              currentAuthorization = { kind: 'unavailable' };
            }
            beginIntent = {
              now: beginNow,
              authorization: currentAuthorization,
            };
          } else if (beginIntent.now !== beginNow) {
            return { kind: 'stale' } as const;
          }
          if (beginIntent.authorization.kind === 'unavailable') {
            beginIntent = undefined;
            return { kind: 'unavailable' } as const;
          }
          if (!ownerFenceIsCurrent(admissionEpoch)) {
            return { kind: 'stale' } as const;
          }
          if (beginIntent.authorization.kind === 'denied') {
            return settle({
              to: 'failed',
              from: ['admitted'],
              depth: 'uninvoked',
              now: beginNow,
              summary: 'Permission changed before plugin work started.',
            });
          }
          return observeTransition(
            transitionWithIntent({
              coordinator: options.coordinator,
              runId: record.runId,
              executionOwnerId: options.executionOwner.id,
              from: ['admitted'],
              to: 'running',
              effectDepth: 'possible-effect',
              now: beginNow,
            }),
          );
        },
        completed: (terminalNow: string) =>
          settle({
            to: 'completed',
            from: ['running'],
            depth: 'confirmed-effect',
            now: terminalNow,
          }),
        failedBeforeEffect: (terminalNow: string, summary: string) =>
          settle({
            to: 'failed',
            from: ['admitted'],
            depth: 'uninvoked',
            now: terminalNow,
            summary,
          }),
        failedAfterEffect: (
          terminalNow: string,
          summary: string,
          depth: Extract<
            PluginForegroundWorkEffectDepth,
            'possible-effect' | 'confirmed-effect'
          > = 'possible-effect',
        ) =>
          settle({
            to: 'failed',
            from: ['running'],
            depth,
            now: terminalNow,
            summary,
          }),
        indeterminate: (terminalNow: string, summary: string) =>
          settle({
            to: 'indeterminate',
            from: ['running'],
            depth: 'possible-effect',
            now: terminalNow,
            summary,
          }),
      });
      return { kind: 'admitted', run: publicRun(record), claim };
    },

    async cancel(owner, runId) {
      if (!validOwner(owner) || !runId.startsWith('plugin:')) {
        return { kind: 'unauthorized' };
      }
      let record: PluginForegroundRunRecord | undefined;
      try {
        record = options.coordinator.read(runId) ?? undefined;
      } catch {
        return { kind: 'unavailable' };
      }
      if (!record) return { kind: 'not-found' };
      if (
        record.pluginId !== owner.pluginId ||
        record.installationKey !== owner.installationKey ||
        record.installationGeneration !== owner.installationGeneration ||
        record.accountId !== owner.accountId ||
        record.machineId !== owner.machineId
      ) {
        return { kind: 'unauthorized' };
      }
      if (
        isTerminal(record.state) ||
        declarations.get(record.kind)?.cancellation !== 'supported' ||
        !options.cancellationAdapter
      ) {
        cancellationIntents.delete(runId);
        return { kind: 'refused', run: publicRun(record) };
      }
      const recordedOwner = executionOwner(record);
      let intent = cancellationIntents.get(runId);
      if (intent && !sameExecutionOwner(intent.executionOwner, recordedOwner)) {
        return { kind: 'unavailable' };
      }
      if (!intent) {
        intent = { executionOwner: recordedOwner };
        cancellationIntents.set(runId, intent);
      }
      return driveCancellation(record, intent);
    },

    reconcile(now) {
      if (!safeTimestamp(now)) return { kind: 'unavailable' };
      try {
        for (const record of options.coordinator.active()) {
          if (
            ownerIsLive(
              record,
              options.processIdentity,
              options.executionOwner,
              executionOwnerActive,
            )
          )
            continue;
          const result = transitionWithIntent({
            coordinator: options.coordinator,
            runId: record.runId,
            executionOwnerId: record.executionOwnerId,
            from: [record.state],
            to: record.state === 'admitted' ? 'failed' : 'indeterminate',
            effectDepth:
              record.state === 'admitted' ? 'uninvoked' : 'possible-effect',
            now,
            failureSummary:
              record.state === 'admitted'
                ? 'Plugin work ended before it started.'
                : 'Plugin work may have continued before Station stopped.',
          });
          if (result.kind === 'unavailable') return { kind: 'unavailable' };
          if (result.kind === 'applied') void observeTransition(result);
        }
        return { kind: 'available' };
      } catch {
        return { kind: 'unavailable' };
      }
    },

    async list(authority) {
      let records: PluginForegroundRunRecord[];
      try {
        records = options.coordinator.list();
      } catch {
        return { kind: 'unavailable' };
      }
      try {
        const visible = await Promise.all(
          records.map(async (record) =>
            (await options.canRead(record, authority))
              ? publicRun(record)
              : undefined,
          ),
        );
        return {
          kind: 'available',
          runs: visible.filter(
            (run): run is PluginForegroundRun => run !== undefined,
          ),
        };
      } catch {
        return { kind: 'unavailable' };
      }
    },

    async read(runId, authority) {
      let record: PluginForegroundRunRecord | undefined;
      try {
        record = options.coordinator.read(runId) ?? undefined;
      } catch {
        return { kind: 'unavailable' };
      }
      if (!record) return { kind: 'available', run: null };
      try {
        return (await options.canRead(record, authority))
          ? { kind: 'available', run: publicRun(record) }
          : { kind: 'available', run: null };
      } catch {
        return { kind: 'unavailable' };
      }
    },

    releaseOwner() {
      executionOwnerActive = false;
      executionOwnerEpoch += 1;
    },
  };
  return Object.freeze(runs);
}

/** Action Operations mirror run state for Activity; they never own it. */
export function createPluginForegroundActionOperationObserver(options: {
  readonly service: ActionOperationTrackingService;
  readonly actorFor: (owner: PluginForegroundWorkOwner) => ActionOperationActor;
  readonly logger?: Pick<Logger, 'warn'>;
}): PluginForegroundRunObserver {
  return {
    async begin({ owner, declaration, run }) {
      const tracking = await beginActionOperationTracking({
        service: options.service,
        actor: options.actorFor(structuredClone(owner)),
        operation: {
          id: run.runId,
          scope: {
            accountId: owner.accountId,
            ...(owner.machineId ? { machineId: owner.machineId } : {}),
            ...(run.sessionId ? { sessionId: run.sessionId } : {}),
          },
          title: declaration.title,
          cancellation: 'unsupported',
          domain: { kind: 'platform-action', actionId: run.runId },
          reentry: run.sessionId
            ? { kind: 'session', sessionId: run.sessionId }
            : { kind: 'monitoring', routingReceiptId: run.runId },
        },
        logger: options.logger,
      });
      return tracking ? actionOperationObserverHandle(tracking) : undefined;
    },
  };
}

function actionOperationObserverHandle(
  tracking: ActionOperationTrackingHandle,
): PluginForegroundRunObserverHandle {
  return {
    async update(run) {
      if (run.state === 'running') {
        await tracking.update({ status: 'running' });
      } else if (run.state === 'completed') {
        await tracking.update({ status: 'succeeded' });
      } else if (run.state === 'failed') {
        await tracking.update({
          status: 'failed',
          errorSummary: run.failureSummary ?? 'Plugin work did not complete.',
        });
      } else if (run.state === 'cancelled') {
        await tracking.update({ status: 'cancelled' });
      } else if (run.state === 'indeterminate') {
        await tracking.update({
          status: 'running',
          progress: { kind: 'phase', code: 'reconciliation-required' },
        });
      }
    },
  };
}
