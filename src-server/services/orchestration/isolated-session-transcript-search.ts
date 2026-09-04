/** Session-owned publication policy around fixed, read-only worker facts. */
import {
  isSessionReadAuthority,
  type SessionReadAuthority,
} from '@kontourai/station-contracts/tenancy';
import type {
  UnifiedSearchMessagePageOutcome,
  UnifiedSearchOpenResolution,
} from '@kontourai/station-contracts/unified-search';
import { publicAgentIdFromRuntimeKey } from '../../routes/agents/runtime-agent-identity.js';
import type { IsolatedTranscriptReads } from '../search/isolated-transcript-search.js';
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

  async function readAuthorized<T>(
    input: IsolatedSessionReadInput,
    read: (current: () => boolean, signal: AbortSignal) => Promise<T>,
  ): Promise<T | undefined> {
    if (
      closed ||
      busy ||
      input.signal?.aborted ||
      !isSessionReadAuthority(input.authority) ||
      (input.authority.mode === 'hosted' &&
        !input.authority.tenantExecutionContext)
    )
      return;
    const { signal, current: requestCurrent } = input;
    busy = true;
    const controller = new AbortController();
    active = controller;
    const deadline = performance.now() + 2000;
    const sameGeneration = authorization.captureReadCurrentness();
    const current = () => {
      try {
        return (
          runtimeCurrent() === true &&
          requestCurrent() === true &&
          !closed &&
          !controller.signal.aborted &&
          performance.now() < deadline &&
          sameGeneration()
        );
      } catch {
        return false;
      }
    };
    const abort = () => controller.abort();
    const timer = setTimeout(abort, 2000);
    signal?.addEventListener('abort', abort, { once: true });
    try {
      if (signal?.aborted || !current()) return;
      const result = await read(current, controller.signal);
      return current() ? result : undefined;
    } catch {
      return undefined;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      active = undefined;
      busy = false;
    }
  }

  return {
    inspect: source.inspect,
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
      return outcome ?? { state: 'unavailable' };
    },
    async search(
      input: IsolatedSessionReadInput & {
        query: string;
        projectId?: string;
        limit?: number;
      },
    ): Promise<
      | { state: 'available'; matches: TranscriptSearchMatch[] }
      | { state: 'unavailable' }
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
        return { state: 'unavailable' };
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
      return matches
        ? { state: 'available', matches }
        : { state: 'unavailable' };
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
      return outcome ?? { state: 'unavailable' };
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
      return outcome ?? { state: 'unavailable' };
    },
  };
}
