import { createHash, randomBytes } from 'node:crypto';
import {
  isStationBasisId,
  parseStationBasisProjection,
  parseStationTaskBasisCollection,
  type StationTaskBasisCollection,
} from '@kontourai/station-contracts/task-basis';
import {
  buildStationTaskBasisMcpPage,
  parseStationTaskBasisMcpPage,
  type StationTaskBasisMcpPageResult,
} from '@kontourai/station-contracts/task-basis-mcp';
import type { SessionReadAuthority } from '@kontourai/station-contracts/tenancy';

export const TASK_BASIS_APP_MAX_SESSIONS = 128;
export const TASK_BASIS_APP_MAX_PER_CALLER = 16;
// A valid collection can contain 64 answers, 64 outputs, and 100 published
// kept results. A byte-limited page may advance by one item.
export const TASK_BASIS_APP_MAX_PAGES = 64 + 64 + 100;
export const TASK_BASIS_APP_TTL_MS = 5 * 60_000;
export const TASK_BASIS_APP_MAX_RATE_CALLERS = 128;
const PAGE_BUDGET = 120 * 1024;
const RATE_WINDOW_MS = 60_000;
const MAX_CALLER_READS_PER_WINDOW = 64;

export interface TaskBasisAppReadModule {
  open(input: {
    taskId: string;
    callerBinding: string;
    authority: SessionReadAuthority;
    request?: Request;
  }): Promise<TaskBasisAppReadOutcome>;
  continue(input: {
    taskId: string;
    occurrenceId?: string;
    continuationToken: string;
    callerBinding: string;
    authority: SessionReadAuthority;
    request?: Request;
  }): Promise<TaskBasisAppReadOutcome>;
  revoke(taskId: string, callerBinding?: string, occurrenceId?: string): void;
}
export type TaskBasisAppReadOutcome =
  | {
      status: 'available';
      page: StationTaskBasisMcpPageResult;
      occurrenceId: string;
      continuationToken?: string;
    }
  | { status: 'unavailable' };

type State = {
  taskId: string;
  caller: string;
  authorityFingerprint: string;
  request?: Request;
  occurrenceId: string;
  digest?: string;
  answerOffset: number;
  unassociatedOffset: number;
  keptToolResultOffset: number;
  keptGateEvaluationOffset: number;
  pages: number;
  expiresAt: number;
  inFlight: boolean;
  revoked: boolean;
  token: string;
};

/** Long-lived bounded control state only; protected owner pages are never cached. */
export function createTaskBasisAppReadModule(input: {
  read(input: {
    taskId: string;
    authority: SessionReadAuthority;
    request?: Request;
  }): Promise<
    | { status: 'found'; data: StationTaskBasisCollection }
    | { status: 'not-found' | 'unavailable' }
  >;
  isEnabled: () => boolean | Promise<boolean>;
  capturePublicationPolicy?: () => Promise<unknown | null>;
  isPublicationPolicyCurrent?: (snapshot: unknown) => boolean;
  now?: () => number;
  /** Test seam only; production retains the fixed 120 KiB page budget. */
  pageBudget?: number;
}): TaskBasisAppReadModule {
  const sessions = new Map<string, State>();
  const rates = new Map<string, { startedAt: number; count: number }>();
  const now = input.now ?? Date.now;
  const pageBudget = input.pageBudget ?? PAGE_BUDGET;
  if (
    !Number.isSafeInteger(pageBudget) ||
    pageBudget < 512 ||
    pageBudget > 128 * 1024
  )
    throw new TypeError('Task Basis App page budget must be bounded');
  const takeRate = (caller: string) => {
    const at = now();
    for (const [key, entry] of rates)
      if (at - entry.startedAt >= RATE_WINDOW_MS) rates.delete(key);
    if (!rates.has(caller) && rates.size >= TASK_BASIS_APP_MAX_RATE_CALLERS)
      rates.delete(rates.keys().next().value!);
    const previous = rates.get(caller);
    const next =
      !previous || at - previous.startedAt >= RATE_WINDOW_MS
        ? { startedAt: at, count: 1 }
        : { ...previous, count: previous.count + 1 };
    rates.set(caller, next);
    return next.count <= MAX_CALLER_READS_PER_WINDOW;
  };
  const unavailable = (): TaskBasisAppReadOutcome => ({
    status: 'unavailable',
  });
  const purge = () => {
    const at = now();
    for (const [token, state] of sessions)
      if (state.expiresAt <= at || state.revoked) {
        state.revoked = true;
        sessions.delete(token);
      }
  };
  const terminate = (state: State) => {
    state.revoked = true;
    sessions.delete(state.token);
  };
  const render = async (
    state: State,
    authority: SessionReadAuthority,
  ): Promise<TaskBasisAppReadOutcome> => {
    if (state.inFlight || state.revoked) return unavailable();
    state.inFlight = true;
    try {
      const enabledBeforeRead = await input.isEnabled();
      if (state.revoked || state.expiresAt <= now() || !enabledBeforeRead) {
        terminate(state);
        return unavailable();
      }
      const policy = input.capturePublicationPolicy
        ? await input.capturePublicationPolicy()
        : true;
      if (policy === null) {
        terminate(state);
        return unavailable();
      }
      const first = await input.read({
        taskId: state.taskId,
        authority,
        request: state.request,
      });
      const enabledBeforePublish = await input.isEnabled();
      if (
        state.revoked ||
        state.expiresAt <= now() ||
        !enabledBeforePublish ||
        first.status !== 'found'
      ) {
        terminate(state);
        return unavailable();
      }
      // The first owner result is provisional while policy I/O runs. Re-read
      // immediately before publication so owner membership, workspace, and
      // principal fences cover the whole response rather than one stream.
      const outcome = await input.read({
        taskId: state.taskId,
        authority,
        request: state.request,
      });
      if (
        state.revoked ||
        state.expiresAt <= now() ||
        outcome.status !== 'found' ||
        (input.isPublicationPolicyCurrent !== undefined &&
          !input.isPublicationPolicyCurrent(policy))
      ) {
        terminate(state);
        return unavailable();
      }
      const collection = validatedCollection(outcome.data);
      if (!collection || collection.taskId !== state.taskId) {
        terminate(state);
        return unavailable();
      }
      const digest = digestCollection(collection);
      if (state.digest !== undefined && state.digest !== digest) {
        state.revoked = true;
        sessions.delete(state.token);
        return unavailable();
      }
      state.digest = digest;
      if (state.pages >= TASK_BASIS_APP_MAX_PAGES) {
        state.revoked = true;
        sessions.delete(state.token);
        return unavailable();
      }
      const page = buildStationTaskBasisMcpPage(
        collection,
        {
          answerOffset: state.answerOffset,
          unassociatedOffset: state.unassociatedOffset,
          keptToolResultOffset: state.keptToolResultOffset,
          keptGateEvaluationOffset: state.keptGateEvaluationOffset,
        },
        { byteBudget: pageBudget },
      );
      if (
        !page ||
        !parseStationTaskBasisMcpPage(page) ||
        page.status !== 'available'
      ) {
        terminate(state);
        return unavailable();
      }
      state.pages += 1;
      state.expiresAt = now() + TASK_BASIS_APP_TTL_MS;
      const next = page.continuation?.offsets;
      sessions.delete(state.token);
      if (!next) {
        state.revoked = true;
        return { status: 'available', page, occurrenceId: state.occurrenceId };
      }
      state.answerOffset = next.answerOffset;
      state.unassociatedOffset = next.unassociatedOffset;
      state.keptToolResultOffset = next.keptToolResultOffset;
      state.keptGateEvaluationOffset = next.keptGateEvaluationOffset;
      state.token = mint();
      sessions.set(state.token, state);
      return {
        status: 'available',
        page,
        occurrenceId: state.occurrenceId,
        continuationToken: state.token,
      };
    } catch {
      terminate(state);
      return unavailable();
    } finally {
      state.inFlight = false;
    }
  };
  return {
    async open({ taskId, callerBinding, authority, request }) {
      purge();
      if (
        authority.mode === 'hosted' ||
        !isStationBasisId(taskId) ||
        !validBinding(callerBinding) ||
        !takeRate(callerBinding) ||
        sessions.size >= TASK_BASIS_APP_MAX_SESSIONS ||
        [...sessions.values()].filter((state) => state.caller === callerBinding)
          .length >= TASK_BASIS_APP_MAX_PER_CALLER
      )
        return unavailable();
      const token = mint();
      const state: State = {
        taskId,
        caller: callerBinding,
        authorityFingerprint: fingerprint(authority),
        request,
        occurrenceId: mint(),
        answerOffset: 0,
        unassociatedOffset: 0,
        keptToolResultOffset: 0,
        keptGateEvaluationOffset: 0,
        pages: 0,
        expiresAt: now() + TASK_BASIS_APP_TTL_MS,
        inFlight: false,
        revoked: false,
        token,
      };
      sessions.set(token, state); // reserve before owner I/O.
      return render(state, authority);
    },
    async continue({
      taskId,
      occurrenceId,
      continuationToken,
      callerBinding,
      authority,
      request: _request,
    }) {
      purge();
      const state = sessions.get(continuationToken);
      if (
        authority.mode === 'hosted' ||
        !isStationBasisId(taskId) ||
        !validBinding(callerBinding) ||
        !validToken(continuationToken) ||
        (occurrenceId !== undefined && !validToken(occurrenceId)) ||
        !takeRate(callerBinding) ||
        !state ||
        state.inFlight ||
        state.revoked ||
        state.taskId !== taskId ||
        (occurrenceId !== undefined && state.occurrenceId !== occurrenceId) ||
        state.caller !== callerBinding ||
        state.authorityFingerprint !== fingerprint(authority)
      )
        return unavailable();
      return render(state, authority);
    },
    revoke(taskId, callerBinding, occurrenceId) {
      for (const [token, state] of sessions)
        if (
          state.taskId === taskId &&
          (!callerBinding || state.caller === callerBinding) &&
          (!occurrenceId || state.occurrenceId === occurrenceId)
        ) {
          state.revoked = true;
          sessions.delete(token);
        }
    },
  };
}
function mint() {
  return randomBytes(24).toString('base64url');
}
function digestCollection(value: StationTaskBasisCollection) {
  // Flow stamps validityAsOf at owner-read time. It is observational transport
  // time, not the receipt's standing, identity, authorization, or review
  // timestamp; including it would make every authorized next page stale.
  // All semantic Flow fields remain fingerprinted and owner reads are still
  // repeated before each page, so revocation cannot be cached away.
  const fingerprintable = {
    ...value,
    keptGateEvaluations: value.keptGateEvaluations.map((entry) => {
      const evaluation = structuredClone(entry.evaluation) as unknown as Record<
        string,
        unknown
      >;
      delete evaluation.validityAsOf;
      return { ...entry, evaluation };
    }),
  };
  return createHash('sha256')
    .update(JSON.stringify(fingerprintable))
    .digest('base64url');
}
function validatedCollection(
  value: unknown,
): StationTaskBasisCollection | null {
  const collection = parseStationTaskBasisCollection(value);
  if (!collection) return null;
  const answers = collection.answers.map((answer) => {
    const projection = parseStationBasisProjection(answer.projection);
    return projection
      ? {
          answerReferenceId: answer.answerReferenceId,
          projection,
        }
      : null;
  });
  return answers.some((answer) => !answer)
    ? null
    : {
        version: collection.version,
        taskId: collection.taskId,
        answers: answers as StationTaskBasisCollection['answers'],
        unassociated: collection.unassociated.map((item) => ({ ...item })),
        keptToolResults: collection.keptToolResults.map((item) => ({
          ...item,
          ref: { ...item.ref },
          associatedAnswerReferenceIds: [...item.associatedAnswerReferenceIds],
        })),
        keptGateEvaluations: collection.keptGateEvaluations.map((item) => ({
          ...item,
          evaluation: structuredClone(item.evaluation),
        })),
        gaps: collection.gaps.map((gap) => ({ ...gap })),
      };
}
function validToken(value: string) {
  return /^[A-Za-z0-9_-]{24,128}$/.test(value);
}
function validBinding(value: string) {
  return /^[A-Za-z0-9_-]{20,128}$/.test(value);
}
function fingerprint(authority: SessionReadAuthority): string {
  return `${authority.mode}:${authority.userId}:${authority.tenantExecutionContext?.tenantId ?? ''}`;
}
