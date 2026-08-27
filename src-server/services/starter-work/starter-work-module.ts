import { readFile } from 'node:fs/promises';
import {
  isStarterWorkReference,
  STARTER_WORK_SCHEMA_VERSION,
  type StarterWorkBindInput,
  type StarterWorkBinding,
  type StarterWorkBindOutcome,
  type StarterWorkStatus,
  type StartTaskStarterLaunchResult,
} from '@kontourai/station-contracts';
import { mutateJsonFile } from '../../domain/file-storage-helpers.js';
import { starterWorkBindings } from '../../telemetry/metrics.js';

const MAX_STORE_BYTES = 64 * 1024;
const MAX_BINDINGS = 100;
const MAX_LAUNCHES = 100;
const MAX_ID_LENGTH = 160;
type StartedLaunch = Extract<
  StartTaskStarterLaunchResult,
  { state: 'started' }
>;
type LaunchRecord = {
  operationId: string;
  task: { kind: 'task'; id: string; projectId: string };
  binding: StarterWorkBinding;
  dispatch?: StartedLaunch['dispatch'];
  evidence?: StartedLaunch['evidence'];
};
type Store = {
  schemaVersion: typeof STARTER_WORK_SCHEMA_VERSION;
  bindings: StarterWorkBinding[];
  launches: LaunchRecord[];
};
export class StarterWorkUnavailableError extends Error {}
export class StarterWorkConflictError extends Error {
  constructor(readonly binding: StarterWorkBinding) {
    super('Starter Work binding conflicts with an existing operation.');
  }
}
const validIso = (value: unknown) =>
  typeof value === 'string' &&
  !Number.isNaN(Date.parse(value)) &&
  new Date(value).toISOString() === value;
const validText = (value: unknown) =>
  typeof value === 'string' &&
  value.length > 0 &&
  value.length <= MAX_ID_LENGTH;
const validBinding = (value: unknown): value is StarterWorkBinding => {
  if (!value || typeof value !== 'object') return false;
  const e = value as Record<string, unknown>;
  return (
    e.schemaVersion === STARTER_WORK_SCHEMA_VERSION &&
    [
      'start-task',
      'continue-session',
      'inspect-approval',
      'inspect-receipt',
      'run-scheduled-check',
    ].includes(e.starterId as string) &&
    typeof e.operationId === 'string' &&
    e.operationId.length > 0 &&
    e.operationId.length <= MAX_ID_LENGTH &&
    validIso(e.boundAt) &&
    isStarterWorkReference(e.targetRef) &&
    ((e.starterId === 'start-task' && e.targetRef.kind === 'task') ||
      (e.starterId === 'continue-session' && e.targetRef.kind === 'session') ||
      (e.starterId === 'inspect-approval' && e.targetRef.kind === 'approval') ||
      (e.starterId === 'inspect-receipt' && e.targetRef.kind === 'receipt') ||
      (e.starterId === 'run-scheduled-check' &&
        e.targetRef.kind === 'receipt' &&
        e.targetRef.owner === 'scheduler-run')) &&
    Object.keys(e).length === 5
  );
};
const validDispatch = (value: unknown): value is StartedLaunch['dispatch'] => {
  if (!value || typeof value !== 'object') return false;
  const dispatch = value as Record<string, unknown>;
  if (dispatch.state === 'dispatched') {
    const session = dispatch.session as Record<string, unknown> | undefined;
    return (
      Object.keys(dispatch).length === 2 &&
      !!session &&
      Object.keys(session).length === 2 &&
      session.kind === 'session' &&
      validText(session.id)
    );
  }
  if (
    dispatch.state !== 'failed' &&
    dispatch.state !== 'unavailable' &&
    dispatch.state !== 'aborted' &&
    dispatch.state !== 'indeterminate'
  )
    return false;
  return (
    Object.keys(dispatch).length === 3 &&
    validText(dispatch.reason) &&
    typeof dispatch.retrySafe === 'boolean' &&
    (dispatch.state !== 'indeterminate' || dispatch.retrySafe === false)
  );
};
const validEvidence = (value: unknown): value is StartedLaunch['evidence'] => {
  if (!value || typeof value !== 'object') return false;
  const evidence = value as Record<string, unknown>;
  return (
    Object.keys(evidence).length === 2 &&
    evidence.state === 'NOT_VERIFIED' &&
    validText(evidence.reason)
  );
};
const validLaunch = (value: unknown): value is LaunchRecord => {
  if (!value || typeof value !== 'object') return false;
  const launch = value as Record<string, unknown>;
  const keys = Object.keys(launch);
  if (
    !validText(launch.operationId) ||
    !isStarterWorkReference(launch.task) ||
    launch.task.kind !== 'task' ||
    !validBinding(launch.binding) ||
    launch.binding.starterId !== 'start-task' ||
    launch.binding.operationId !== launch.operationId ||
    JSON.stringify(launch.binding.targetRef) !== JSON.stringify(launch.task) ||
    !keys.every((key) =>
      ['operationId', 'task', 'binding', 'dispatch', 'evidence'].includes(key),
    ) ||
    keys.length < 3 ||
    keys.length > 5
  )
    return false;
  const hasDispatch = Object.hasOwn(launch, 'dispatch');
  const hasEvidence = Object.hasOwn(launch, 'evidence');
  return (
    hasDispatch === hasEvidence &&
    (!hasDispatch ||
      (validDispatch(launch.dispatch) && validEvidence(launch.evidence)))
  );
};
const validStore = (value: unknown): value is Store => {
  if (!value || typeof value !== 'object') return false;
  const store = value as Record<string, unknown>;
  return (
    store.schemaVersion === STARTER_WORK_SCHEMA_VERSION &&
    Array.isArray(store.bindings) &&
    Array.isArray(store.launches) &&
    store.bindings.length <= MAX_BINDINGS &&
    store.launches.length <= MAX_LAUNCHES &&
    store.bindings.every(validBinding) &&
    store.launches.every(validLaunch) &&
    new Set(store.bindings.map((x) => x.starterId)).size ===
      store.bindings.length &&
    new Set(store.launches.map((x) => x.operationId)).size ===
      store.launches.length &&
    Object.keys(store).length === 3
  );
};

/** Correlation-only durable ledger; owner facts always resolve outside it. */
export class StarterWorkModule {
  constructor(
    private readonly filePath: string,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}
  async status(starterId: string): Promise<StarterWorkStatus> {
    const store = await this.read();
    const binding = store.bindings.find((x) => x.starterId === starterId);
    return binding ? { state: 'bound', binding } : { state: 'unbound' };
  }
  async list(): Promise<StarterWorkStatus[]> {
    return (await this.read()).bindings.map((binding) => ({
      state: 'bound',
      binding,
    }));
  }
  async bind(input: StarterWorkBindInput): Promise<StarterWorkBindOutcome> {
    try {
      const candidate: StarterWorkBinding = {
        schemaVersion: STARTER_WORK_SCHEMA_VERSION,
        ...input,
        boundAt: this.now(),
      };
      if (!validBinding(candidate))
        throw new StarterWorkUnavailableError(
          'Starter Work binding is invalid.',
        );
      let outcome:
        | Extract<StarterWorkBindOutcome, { outcome: 'bound' }>
        | undefined;
      await mutateJsonFile<Store>(
        this.filePath,
        {
          schemaVersion: STARTER_WORK_SCHEMA_VERSION,
          bindings: [],
          launches: [],
        } satisfies Store,
        (store) => {
          if (!validStore(store))
            throw new StarterWorkUnavailableError(
              'Starter Work store is corrupt.',
            );
          const current = store.bindings.find(
            (x) => x.starterId === input.starterId,
          );
          if (current) {
            if (
              current.operationId === input.operationId &&
              JSON.stringify(current.targetRef) ===
                JSON.stringify(input.targetRef)
            ) {
              outcome = { outcome: 'bound', binding: current, replayed: true };
              return store;
            }
            throw new StarterWorkConflictError(current);
          }
          const binding = candidate;
          const next: Store = {
            schemaVersion: STARTER_WORK_SCHEMA_VERSION,
            bindings: [...store.bindings, binding],
            launches: store.launches,
          };
          if (!validStore(next))
            throw new StarterWorkUnavailableError(
              'Starter Work store is corrupt.',
            );
          outcome = { outcome: 'bound', binding, replayed: false };
          return next;
        },
        { maxBytes: MAX_STORE_BYTES, label: 'Starter Work store' },
      );
      if (!outcome)
        throw new StarterWorkUnavailableError(
          'Starter Work store cannot be persisted.',
        );
      // Metrics observe an already durable write. Their failure cannot turn a
      // committed binding into a retryable API outcome.
      try {
        starterWorkBindings.add(1, {
          outcome: outcome.replayed ? 'replayed' : 'bound',
        });
      } catch {}
      return outcome;
    } catch (error) {
      if (
        error instanceof StarterWorkConflictError ||
        error instanceof StarterWorkUnavailableError
      )
        throw error;
      throw new StarterWorkUnavailableError(
        'Starter Work store cannot be persisted.',
      );
    }
  }
  async clearBinding(starterId: string): Promise<StarterWorkStatus> {
    try {
      await mutateJsonFile<Store>(
        this.filePath,
        {
          schemaVersion: STARTER_WORK_SCHEMA_VERSION,
          bindings: [],
          launches: [],
        } satisfies Store,
        (store) => {
          if (!validStore(store))
            throw new StarterWorkUnavailableError(
              'Starter Work store is corrupt.',
            );
          return {
            schemaVersion: STARTER_WORK_SCHEMA_VERSION,
            bindings: store.bindings.filter((x) => x.starterId !== starterId),
            // A cleared correlation must never erase an admitted dispatch
            // fence: replaying its operationId must remain unable to start a
            // second Task or dispatch.
            launches: store.launches,
          };
        },
        { maxBytes: MAX_STORE_BYTES, label: 'Starter Work store' },
      );
      return { state: 'unbound' };
    } catch (error) {
      if (error instanceof StarterWorkUnavailableError) throw error;
      throw new StarterWorkUnavailableError(
        'Starter Work store cannot be persisted.',
      );
    }
  }
  /** Persist the exact Task/binding fence before a non-idempotent dispatch. */
  async beginLaunch(input: {
    operationId: string;
    task: { kind: 'task'; id: string; projectId: string };
    binding: StarterWorkBinding;
  }): Promise<{ record: LaunchRecord; replayed: boolean }> {
    try {
      let result: { record: LaunchRecord; replayed: boolean } | undefined;
      await mutateJsonFile<Store>(
        this.filePath,
        {
          schemaVersion: STARTER_WORK_SCHEMA_VERSION,
          bindings: [],
          launches: [],
        },
        (store) => {
          if (!validStore(store))
            throw new StarterWorkUnavailableError(
              'Starter Work store is corrupt.',
            );
          const existing = store.launches.find(
            (launch) => launch.operationId === input.operationId,
          );
          if (existing) {
            if (JSON.stringify(existing.task) !== JSON.stringify(input.task))
              throw new StarterWorkConflictError(existing.binding);
            result = { record: existing, replayed: true };
            return store;
          }
          if (store.launches.length >= MAX_LAUNCHES)
            throw new StarterWorkUnavailableError(
              'Starter dispatch history is at capacity; no new dispatch was admitted.',
            );
          const record: LaunchRecord = { ...input };
          result = { record, replayed: false };
          return { ...store, launches: [...store.launches, record] };
        },
        { maxBytes: MAX_STORE_BYTES, label: 'Starter Work store' },
      );
      if (!result)
        throw new StarterWorkUnavailableError(
          'Starter dispatch fence cannot be persisted.',
        );
      return result;
    } catch (error) {
      if (
        error instanceof StarterWorkConflictError ||
        error instanceof StarterWorkUnavailableError
      )
        throw error;
      throw new StarterWorkUnavailableError(
        'Starter dispatch fence cannot be persisted.',
      );
    }
  }
  async completeLaunch(
    operationId: string,
    dispatch: StartedLaunch['dispatch'],
    evidence: StartedLaunch['evidence'],
  ): Promise<LaunchRecord> {
    try {
      let completed: LaunchRecord | undefined;
      await mutateJsonFile<Store>(
        this.filePath,
        {
          schemaVersion: STARTER_WORK_SCHEMA_VERSION,
          bindings: [],
          launches: [],
        },
        (store) => {
          if (!validStore(store))
            throw new StarterWorkUnavailableError(
              'Starter Work store is corrupt.',
            );
          const current = store.launches.find(
            (launch) => launch.operationId === operationId,
          );
          if (!current)
            throw new StarterWorkUnavailableError(
              'Starter dispatch fence is missing.',
            );
          completed = { ...current, dispatch, evidence };
          return {
            ...store,
            launches: store.launches.map((launch) =>
              launch.operationId === operationId ? completed! : launch,
            ),
          };
        },
        { maxBytes: MAX_STORE_BYTES, label: 'Starter Work store' },
      );
      if (!completed)
        throw new StarterWorkUnavailableError(
          'Starter dispatch outcome cannot be persisted.',
        );
      return completed;
    } catch (error) {
      if (error instanceof StarterWorkUnavailableError) throw error;
      throw new StarterWorkUnavailableError(
        'Starter dispatch outcome cannot be persisted.',
      );
    }
  }
  private async read(): Promise<Store> {
    let source: string;
    try {
      source = await readFile(this.filePath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT')
        return {
          schemaVersion: STARTER_WORK_SCHEMA_VERSION,
          bindings: [],
          launches: [],
        };
      throw new StarterWorkUnavailableError(
        'Starter Work store is unavailable.',
      );
    }
    if (Buffer.byteLength(source) > MAX_STORE_BYTES)
      throw new StarterWorkUnavailableError('Starter Work store is corrupt.');
    try {
      const parsed: unknown = JSON.parse(source);
      if (!validStore(parsed)) throw new Error();
      return parsed;
    } catch {
      throw new StarterWorkUnavailableError('Starter Work store is corrupt.');
    }
  }
}
