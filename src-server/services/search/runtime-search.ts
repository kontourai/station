import {
  isSessionReadAuthority,
  type SessionReadAuthority,
} from '@kontourai/station-contracts/tenancy';
import {
  UNIFIED_SEARCH_V1,
  type UnifiedSearchOpenLocator,
  type UnifiedSearchOpenResolution,
  type UnifiedSearchOutcome,
  type UnifiedSearchProvider,
  type UnifiedSearchRequest,
} from '@kontourai/station-contracts/unified-search';
import type { OrchestrationService } from '../orchestration/orchestration-service.js';
import type { TaskGraphService } from '../projects/task-graph-service.js';
import { createStationMessageSearchProvider } from './station-search-providers.js';
import { UnifiedSearchService } from './unified-search-service.js';

export interface SearchReadContext {
  authority: SessionReadAuthority;
  current: () => boolean;
  signal?: AbortSignal;
}

/** One runtime owns the readers. Request adapters never allocate worker owners. */
export function createRuntimeSearch(input: {
  stationId: string;
  tasks: Pick<TaskGraphService, 'createPersonalSearchReader'>;
  transcripts: Pick<OrchestrationService, 'createIsolatedTranscriptSearch'>;
}) {
  const tasks = input.tasks.createPersonalSearchReader(input.stationId);
  const transcripts = input.transcripts.createIsolatedTranscriptSearch();
  let closed = false;
  const active = new Set<AbortController>();
  const current = (context: SearchReadContext) => {
    try {
      return (
        !closed &&
        !context.signal?.aborted &&
        isSessionReadAuthority(context.authority) &&
        context.current() === true
      );
    } catch {
      return false;
    }
  };
  async function run<T>(
    context: SearchReadContext,
    unavailable: T,
    read: (context: SearchReadContext) => Promise<T>,
  ): Promise<T> {
    if (!current(context)) return unavailable;
    const controller = new AbortController();
    active.add(controller);
    const abort = () => controller.abort();
    context.signal?.addEventListener('abort', abort, { once: true });
    try {
      const result = await read({
        ...context,
        signal: controller.signal,
        current: () => current(context),
      });
      return current(context) ? result : unavailable;
    } catch {
      return unavailable;
    } finally {
      active.delete(controller);
      context.signal?.removeEventListener('abort', abort);
    }
  }
  return {
    /** Synchronous admission fence precedes every asynchronous shutdown drain. */
    stop() {
      closed = true;
      for (const controller of active) controller.abort();
    },
    inspect: tasks.inspect,
    /** Retain the same Task owner on pending cleanup. Transcript custody belongs to Orchestration. */
    close() {
      this.stop();
      return tasks.close();
    },
    search(
      request: UnifiedSearchRequest,
      context: SearchReadContext,
    ): Promise<UnifiedSearchOutcome> {
      const unavailable: UnifiedSearchOutcome = {
        version: UNIFIED_SEARCH_V1,
        state: 'unavailable',
        results: [],
        sources: [],
      };
      return run(context, unavailable, async (bound) => {
        const authority = bound.authority;
        if (authority.mode === 'hosted' && !authority.tenantExecutionContext)
          return unavailable;
        const taskProvider: UnifiedSearchProvider =
          authority.mode === 'personal'
            ? tasks.provider
            : {
                descriptor: {
                  ...tasks.provider.descriptor,
                  owner: {
                    kind: 'station',
                    stationId: input.stationId,
                    tenantId: authority.tenantExecutionContext!.tenantId,
                  },
                },
                async search() {
                  return {
                    version: UNIFIED_SEARCH_V1,
                    state: 'restricted',
                    reason: 'authorization-restricted',
                  };
                },
              };
        const messages = createStationMessageSearchProvider({
          authority:
            authority.mode === 'personal'
              ? { mode: 'personal', stationId: input.stationId }
              : {
                  mode: 'hosted',
                  stationId: input.stationId,
                  tenantId: authority.tenantExecutionContext!.tenantId,
                },
          source: {
            async searchAuthorizedMessages(request, signal) {
              const result = await transcripts.search({
                ...bound,
                ...request,
                signal,
              });
              if (result.state !== 'available')
                throw new Error('Search unavailable');
              return result.matches;
            },
          },
        });
        return new UnifiedSearchService([taskProvider, messages]).search(
          request,
          bound.signal,
        );
      });
    },
    open(
      locator: UnifiedSearchOpenLocator,
      context: SearchReadContext,
    ): Promise<UnifiedSearchOpenResolution> {
      return run<UnifiedSearchOpenResolution>(
        context,
        { state: 'unavailable' },
        async (bound) => {
          if (locator.kind === 'task')
            return tasks.open({ ...bound, ...locator });
          if (locator.kind === 'session')
            return transcripts.openSession({
              ...bound,
              sessionId: locator.sessionId,
            });
          return transcripts.open({
            ...bound,
            sessionId: locator.sessionId,
            matchedEventId: locator.matchedEventId,
          });
        },
      );
    },
  };
}
export type RuntimeSearch = ReturnType<typeof createRuntimeSearch>;
