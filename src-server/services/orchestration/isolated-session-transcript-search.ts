/** Session-owned publication policy around fixed, read-only worker facts. */
import {
  isSessionReadAuthority,
  type SessionReadAuthority,
} from '@kontourai/station-contracts/tenancy';
import type {
  UnifiedSearchMessagePageOutcome,
  UnifiedSearchOpenResolution,
} from '@kontourai/station-contracts/unified-search';
import { publicAgentIdFromRuntimeKey } from '../agents/runtime-agent-identity.js';
import type { IsolatedTranscriptReads } from '../search/isolated-transcript-search.js';
import {
  errorClassFields,
  type SearchReadRefusal,
  SearchReadRefusedError,
} from '../search/search-read-refusal.js';
import { boundedTaskText } from '../search/task-search-protocol.js';
import type { TranscriptSearchMatch } from '../search/transcript-search-protocol.js';
import type { SessionAuthorization } from './session-authorization.js';

export interface IsolatedSessionReadInput {
  authority: SessionReadAuthority;
  signal?: AbortSignal;
  /** Parent-owned principal/credential currentness, never sent to the worker. */
  current: () => boolean;
}

export function createIsolatedSessionTranscriptSearch(
  source: IsolatedTranscriptReads,
  authorization: SessionAuthorization,
  runtimeCurrent: () => boolean,
) {
  let closed = false;
  let busy = false;
  let active: AbortController | undefined;

  /**
   * #2460: every refusal records WHICH branch refused — admission, the
   * specific currentness component, or the read's own failure with the lower
   * layer's cause — so the runtime's provider log can name it. The caller's
   * response still says only `unavailable`.
   */
  async function readAuthorized<T>(
    input: IsolatedSessionReadInput,
    read: (current: () => boolean, signal: AbortSignal) => Promise<T>,
  ): Promise<
    | { ok: true; value: Exclude<T, undefined> }
    | { ok: false; refusal: SearchReadRefusal }
  > {
    const refuse = (refusal: SearchReadRefusal) =>
      ({ ok: false, refusal }) as const;
    if (closed) return refuse({ kind: 'closed', stage: 'admission' });
    if (busy) return refuse({ kind: 'busy', stage: 'admission' });
    if (input.signal?.aborted)
      return refuse({ kind: 'aborted', stage: 'admission' });
    if (
      !isSessionReadAuthority(input.authority) ||
      (input.authority.mode === 'hosted' &&
        !input.authority.tenantExecutionContext)
    )
      return refuse({ kind: 'authority-invalid', stage: 'admission' });
    const { signal, current: requestCurrent } = input;
    busy = true;
    const controller = new AbortController();
    active = controller;
    const deadline = performance.now() + 2000;
    const sameGeneration = authorization.captureReadCurrentness();
    /** The first false currentness component, or undefined when current. */
    const staleness = (): string | undefined => {
      try {
        if (runtimeCurrent() !== true) return 'runtime';
        if (requestCurrent() !== true) return 'request';
        if (closed) return 'closed';
        if (controller.signal.aborted) return 'aborted';
        if (performance.now() >= deadline) return 'deadline';
        if (!sameGeneration()) return 'generation';
        return undefined;
      } catch {
        return 'threw';
      }
    };
    const current = () => staleness() === undefined;
    const notCurrent = (stage: 'before-read' | 'during-read' | 'after-read') =>
      refuse({
        kind: 'not-current',
        stage,
        // A read that stopped on a transiently false component may find it
        // true again by the time this is asked.
        component: staleness() ?? 'transient',
      });
    const abort = () => controller.abort();
    const timer = setTimeout(abort, 2000);
    signal?.addEventListener('abort', abort, { once: true });
    try {
      if (signal?.aborted)
        return refuse({ kind: 'aborted', stage: 'before-read' });
      if (!current()) return notCurrent('before-read');
      const result = await read(current, controller.signal);
      // A read returns `undefined` only when it stopped on currentness.
      if (result === undefined) return notCurrent('during-read');
      if (!current()) return notCurrent('after-read');
      return { ok: true, value: result as Exclude<T, undefined> };
    } catch (error) {
      const component = staleness();
      return refuse({
        kind: 'read-failed',
        stage: 'during-read',
        ...(component ? { component } : {}),
        read:
          error instanceof SearchReadRefusedError
            ? error.refusal
            : { kind: 'threw', ...errorClassFields(error) },
      });
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      active = undefined;
      busy = false;
    }
  }

  return {
    inspect: source.inspect,
    /**
     * station#1707: readiness is a startup cost, not a read. Exposed so a
     * caller can wait for the worker OUTSIDE the budget that bounds the
     * query — never inside `readAuthorized`, whose deadline exists to bound
     * the read itself.
     */
    whenReady: source.whenReady,
    close() {
      closed = true;
      active?.abort();
      return source.close();
    },
    async readMessagePage(
      input: IsolatedSessionReadInput & {
        sessionId: string;
        matchedEventId: string;
        continuation?: string;
      },
    ): Promise<UnifiedSearchMessagePageOutcome> {
      const outcome = await readAuthorized<UnifiedSearchMessagePageOutcome>(
        input,
        async (current, signal) => {
          const page = await source.readMessagePage(
            {
              threadId: input.sessionId,
              matchedEventId: input.matchedEventId,
              ...authorization.transcriptOwnerConstraint(input.authority),
              ...(input.authority.mode === 'hosted'
                ? { tenantId: input.authority.tenantExecutionContext!.tenantId }
                : {}),
              ...(input.continuation !== undefined
                ? { continuation: input.continuation }
                : {}),
            },
            signal,
          );
          if (
            !current() ||
            !page ||
            !(await authorization.canReadSessionAsync(
              input.sessionId,
              input.authority,
              current,
              signal,
            ))
          )
            return { state: 'not-found' };
          const { agentSlug, ...textPage } = page;
          let assignedAgentId: string | undefined;
          if (agentSlug) {
            try {
              assignedAgentId = publicAgentIdFromRuntimeKey(agentSlug);
            } catch {
              /* Missing clean identity does not prevent a read-only view. */
            }
          }
          return {
            state: 'available',
            page: {
              ...textPage,
              ...(assignedAgentId ? { assignedAgentId } : {}),
            },
          };
        },
      );
      return outcome.ok ? outcome.value : { state: 'unavailable' };
    },
    async search(
      input: IsolatedSessionReadInput & {
        query: string;
        projectId?: string;
        limit?: number;
      },
    ): Promise<
      | { state: 'available'; matches: TranscriptSearchMatch[] }
      /** `cause` is log-only (#2460): the runtime provider names it, never a response. */
      | { state: 'unavailable'; cause: SearchReadRefusal }
    > {
      const { authority, query, projectId } = input;
      const limit = input.limit ?? 20;
      if (
        !boundedTaskText(query, 256) ||
        !Number.isInteger(limit) ||
        limit < 1 ||
        limit > 20 ||
        (projectId !== undefined && !boundedTaskText(projectId, 256))
      )
        return {
          state: 'unavailable',
          cause: { kind: 'request-invalid', stage: 'admission' },
        };
      const matches = await readAuthorized(input, async (current, signal) => {
        const rows = await source.search(
          {
            query,
            limit,
            ...authorization.transcriptOwnerConstraint(authority),
            ...(authority.mode === 'hosted'
              ? { tenantId: authority.tenantExecutionContext!.tenantId }
              : {}),
            ...(projectId !== undefined ? { projectId } : {}),
          },
          signal,
        );
        const permitted: TranscriptSearchMatch[] = [];
        for (const row of rows) {
          if (!current()) return;
          if (
            await authorization.canReadSessionAsync(
              row.conversationId,
              authority,
              current,
              signal,
            )
          )
            permitted.push(row);
          if (!current()) return;
        }
        return permitted;
      });
      return matches.ok
        ? { state: 'available', matches: matches.value }
        : { state: 'unavailable', cause: matches.refusal };
    },
    async openSession(
      input: IsolatedSessionReadInput & { sessionId: string },
    ): Promise<UnifiedSearchOpenResolution> {
      const { authority, sessionId } = input;
      if (!boundedTaskText(sessionId, 256)) return { state: 'not-found' };
      const outcome = await readAuthorized<UnifiedSearchOpenResolution>(
        input,
        async (current, signal) => {
          const target = await source.readSession(
            {
              threadId: sessionId,
              ...authorization.transcriptOwnerConstraint(authority),
              ...(authority.mode === 'hosted'
                ? { tenantId: authority.tenantExecutionContext!.tenantId }
                : {}),
            },
            signal,
          );
          if (
            !current() ||
            !target ||
            !(await authorization.canReadSessionAsync(
              sessionId,
              authority,
              current,
              signal,
            ))
          )
            return { state: 'not-found' };
          return {
            state: 'resolved',
            target: {
              kind: 'session',
              sessionId,
              ...(target.projectSlug ? { projectId: target.projectSlug } : {}),
            },
          };
        },
      );
      return outcome.ok ? outcome.value : { state: 'unavailable' };
    },
    async open(
      input: IsolatedSessionReadInput & {
        sessionId: string;
        matchedEventId: string;
      },
    ): Promise<UnifiedSearchOpenResolution> {
      const { authority, sessionId, matchedEventId } = input;
      if (
        !boundedTaskText(sessionId, 256) ||
        !boundedTaskText(matchedEventId, 256)
      )
        return { state: 'not-found' };
      const outcome = await readAuthorized<UnifiedSearchOpenResolution>(
        input,
        async (current, signal) => {
          const target = await source.readMessage(
            {
              threadId: sessionId,
              matchedEventId,
              ...authorization.transcriptOwnerConstraint(authority),
              ...(authority.mode === 'hosted'
                ? { tenantId: authority.tenantExecutionContext!.tenantId }
                : {}),
            },
            signal,
          );
          if (
            !current() ||
            !target ||
            !(await authorization.canReadSessionAsync(
              sessionId,
              authority,
              current,
              signal,
            ))
          )
            return { state: 'not-found' };
          return {
            state: 'resolved',
            target: {
              kind: 'session-message',
              sessionId,
              matchedEventId,
              navigationMessageId: target.messageId,
              ...(target.projectSlug ? { projectId: target.projectSlug } : {}),
            },
          };
        },
      );
      return outcome.ok ? outcome.value : { state: 'unavailable' };
    },
  };
}
