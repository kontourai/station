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
    const output: PluginForegroundWorkJson[] = [];
    for (const entry of value) {
      const projected = canonicalJson(entry, depth + 1, budget);
      if (projected === undefined) return undefined;
      output.push(projected);
    }
    return output;
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

const activeOwners = new Set<string>();
const releasedOwners = new Set<string>();

/** Runtime shutdown releases the owner before a replacement reconciles. */
export function releasePluginForegroundRunOwner(ownerId: string): void {
  activeOwners.delete(ownerId);
  releasedOwners.add(ownerId);
}

function ownerIsLive(
  record: PluginForegroundRunRecord,
  identity: PluginForegroundProcessIdentity,
): boolean {
  if (releasedOwners.has(record.executionOwnerId)) return false;
  if (
    record.executionOwnerPid === process.pid &&
    activeOwners.has(record.executionOwnerId)
  ) {
    return true;
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
  readonly logger?: Pick<Logger, 'warn'>;
}): PluginForegroundRuns {
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
    options.executionOwner.pid < 1
  ) {
    throw new Error('Invalid plugin foreground work composition');
  }
  const declarations = new Map(
    options.declarations.map((declaration) => [
      declaration.kind,
      Object.freeze(structuredClone(declaration)),
    ]),
  );
  activeOwners.add(options.executionOwner.id);
  const observerHandles = new Map<string, PluginForegroundRunObserverHandle>();

  const updateObserver = async (
    handle: PluginForegroundRunObserverHandle | undefined,
    run: PluginForegroundRun,
  ): Promise<void> => {
    if (!handle) return;
    try {
      await handle.update(run);
    } catch (error) {
      options.logger?.warn('Plugin foreground run observation unavailable', {
        runId: run.runId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const runs: PluginForegroundRuns = {
    async start(owner, request) {
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

      let observer: PluginForegroundRunObserverHandle | undefined;
      try {
        observer = await options.observer?.begin({
          owner: structuredClone(owner),
          declaration: structuredClone(declaration),
          run: publicRun(record),
        });
        if (observer) observerHandles.set(record.runId, observer);
      } catch (error) {
        options.logger?.warn('Plugin foreground run observation unavailable', {
          runId: record.runId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      const observe = async (result: PluginForegroundRunTransition) => {
        if (result.kind === 'applied') {
          await updateObserver(observer, publicRun(result.record));
          if (isTerminal(result.record.state)) {
            observerHandles.delete(result.record.runId);
          }
        }
        return result;
      };
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
        if (
          terminalIntent &&
          JSON.stringify(terminalIntent) !== JSON.stringify(intent)
        ) {
          return { kind: 'stale' } as const;
        }
        terminalIntent ??= intent;
        return observe(
          transitionWithIntent({
            coordinator: options.coordinator,
            runId: record.runId,
            executionOwnerId: options.executionOwner.id,
            from: terminalIntent.from,
            to: terminalIntent.to,
            effectDepth: terminalIntent.depth,
            now: terminalIntent.now,
            ...(terminalIntent.summary
              ? { failureSummary: terminalIntent.summary }
              : {}),
          }),
        );
      };
      const claim: PluginForegroundRunClaim = Object.freeze({
        beginEffect: async (beginNow: string) => {
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
          if (beginIntent.authorization.kind === 'denied') {
            return settle({
              to: 'failed',
              from: ['admitted'],
              depth: 'uninvoked',
              now: beginNow,
              summary: 'Permission changed before plugin work started.',
            });
          }
          return observe(
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
        return { kind: 'refused', run: publicRun(record) };
      }
      let cancellation: 'confirmed' | 'refused' | 'unknown';
      try {
        cancellation = await options.cancellationAdapter.cancel({
          runId,
          executionOwner: executionOwner(record),
        });
      } catch {
        cancellation = 'unknown';
      }
      if (cancellation === 'refused') {
        return { kind: 'refused', run: publicRun(record) };
      }
      const transition = transitionWithIntent({
        coordinator: options.coordinator,
        runId,
        executionOwnerId: record.executionOwnerId,
        from: [record.state],
        to: cancellation === 'confirmed' ? 'cancelled' : 'indeterminate',
        effectDepth:
          record.state === 'admitted' ? 'uninvoked' : 'possible-effect',
        now: new Date().toISOString(),
        ...(cancellation === 'unknown'
          ? { failureSummary: 'Cancellation could not be confirmed.' }
          : {}),
      });
      if (transition.kind !== 'applied') {
        return transition.kind === 'unavailable'
          ? { kind: 'unavailable' }
          : { kind: 'refused', run: publicRun(transition.record ?? record) };
      }
      await updateObserver(
        observerHandles.get(runId),
        publicRun(transition.record),
      );
      observerHandles.delete(runId);
      return {
        kind: cancellation,
        run: publicRun(transition.record),
      };
    },

    reconcile(now) {
      if (!safeTimestamp(now)) return { kind: 'unavailable' };
      try {
        for (const record of options.coordinator.active()) {
          if (ownerIsLive(record, options.processIdentity)) continue;
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
