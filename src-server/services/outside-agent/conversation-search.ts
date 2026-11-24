import { sessionReadAuthorityFromRequest } from '@kontourai/station-contracts/tenancy';
import { ProtocolError } from '@modelcontextprotocol/server';
import { WORK_DISCOVERY_DEFAULT_LIMIT } from '../../routes/chat/work-discovery-limits.js';
import type { ConversationWorkSearchInput } from '../../tools/station-control-work-discovery-tools.js';
import { publicAgentIdFromRuntimeKey } from '../agents/runtime-agent-identity.js';
import type { EventStore } from '../orchestration/event-store.js';
import type { OrchestrationService } from '../orchestration/orchestration-service.js';
import { messageSearchExcerpt } from '../orchestration/transcript-search-queries.js';
import type { ProjectService } from '../projects/project-service.js';
import { MAX_SCOPED_TRANSCRIPT_THREADS } from '../search/transcript-search-protocol.js';
import type { OutsideAgentCaller } from './mcp-dispatch.js';
import {
  createOutsideWorkAdmission,
  type OutsideWorkAdmission,
  type OutsideWorkAdmissionDeps,
} from './work-admission.js';

const MAX_SCOPE_SCAN = 4_000;
const MESSAGE_WINDOW = 20;

export interface OutsideConversationSearchDeps
  extends OutsideWorkAdmissionDeps {
  eventStore: OutsideWorkAdmissionDeps['eventStore'] &
    Pick<EventStore, 'iterateOwnedActiveWorkCandidates' | 'conversationTitle'>;
  orchestrationService: OutsideWorkAdmissionDeps['orchestrationService'] &
    Pick<OrchestrationService, 'listSessionReadModel'>;
  transcripts: Pick<
    ReturnType<OrchestrationService['createIsolatedTranscriptSearch']>,
    'search'
  >;
}

export function createOutsideConversationSearchReader(
  deps: OutsideConversationSearchDeps,
  projects: Pick<ProjectService, 'listProjects'>,
) {
  return async function searchConversations(
    caller: OutsideAgentCaller,
    input: ConversationWorkSearchInput,
    assertCurrent: () => void,
    signal: AbortSignal,
  ) {
    const { projectId, classify } = createOutsideWorkAdmission(deps, caller);
    const current = () => {
      signal.throwIfAborted();
      assertCurrent();
      return true;
    };
    current();
    const slug =
      projectId === undefined
        ? undefined
        : projects.listProjects().find((project) => project.id === projectId)
            ?.slug;
    if (
      (projectId !== undefined && slug === undefined) ||
      (input.projectSlug !== undefined && input.projectSlug !== slug)
    )
      throw new ProtocolError(-32602, 'Project not found');

    const authority = sessionReadAuthorityFromRequest(
      caller.delegatingPrincipalId,
      undefined,
      undefined,
    );
    let hostFiltered = 0;
    let candidateLimit = false;
    let scanLimit = false;
    let listable: (threadId: string) => boolean = () => false;
    const sessions = await deps.orchestrationService.listSessionReadModel(
      authority,
      {
        purpose: 'work-search',
        selectThreadIds(canList) {
          current();
          hostFiltered = 0;
          candidateLimit = false;
          scanLimit = false;
          listable = canList;
          const cache = new Map<string, OutsideWorkAdmission>();
          const ids: string[] = [];
          let scanned = 0;
          for (const threadId of deps.eventStore.iterateOwnedActiveWorkCandidates(
            caller.delegatingPrincipalId,
            projectId,
          )) {
            if (!canList(threadId)) continue;
            if (scanned++ === MAX_SCOPE_SCAN) {
              scanLimit = true;
              break;
            }
            const admission = classify(threadId, cache, canList);
            if (admission === 'host') hostFiltered++;
            if (admission !== 'readable') continue;
            if (
              ids.length >= MAX_SCOPED_TRANSCRIPT_THREADS ||
              Buffer.byteLength(threadId) > 256
            ) {
              candidateLimit = true;
              continue;
            }
            ids.push(threadId);
          }
          return ids;
        },
      },
    );
    current();
    const collectCandidates = () => {
      current();
      const cache = new Map<string, OutsideWorkAdmission>();
      return sessions.flatMap((session) => {
        if (classify(session.threadId, cache, listable) !== 'readable')
          return [];
        const agent = session.assignedAgentSlug
          ? publicAgentIdFromRuntimeKey(session.assignedAgentSlug)
          : null;
        if (input.agent !== undefined && input.agent !== agent) return [];
        const conversationId =
          deps.eventStore.conversationForSession(session.threadId)
            ?.conversationId ?? session.threadId;
        const title =
          deps.eventStore.conversationTitle([
            conversationId,
            session.threadId,
          ]) ??
          session.displayTitle ??
          null;
        return [
          {
            threadId: session.threadId,
            conversationId,
            title,
            agent,
            projectSlug: slug ?? null,
            updatedAt: session.updatedAt,
          },
        ];
      });
    };
    let selected: ReturnType<typeof collectCandidates> | undefined;
    const messages =
      sessions.length === 0
        ? { state: 'available' as const, matches: [] }
        : await deps.transcripts.search({
            authority,
            current,
            signal,
            query: input.query,
            limit: MESSAGE_WINDOW,
            selectThreadIds() {
              selected = collectCandidates();
              return selected.map(({ threadId }) => threadId);
            },
          });
    current();
    const candidates = selected ?? collectCandidates();
    const publication = new Map<string, OutsideWorkAdmission>();
    const readable = candidates.filter(
      ({ threadId }) =>
        classify(threadId, publication, listable) === 'readable',
    );
    const matchesCurrent = readable.length === candidates.length;
    const incompleteSources: Array<{
      source: string;
      state: 'partial' | 'unavailable';
      reason: string;
      filteredCount?: number;
      countIsLowerBound?: boolean;
    }> = [
      {
        source: 'station.files',
        state: 'unavailable',
        reason: 'outside-file-scope-unavailable',
      },
    ];
    if (hostFiltered > 0 || scanLimit)
      incompleteSources.push({
        source: 'station.work',
        state: 'partial',
        reason: 'host-execution-filtered',
        filteredCount: hostFiltered,
        ...(scanLimit ? { countIsLowerBound: true } : {}),
      });
    if (candidateLimit || scanLimit)
      incompleteSources.push({
        source: 'station.work',
        state: 'partial',
        reason: 'metadata-scan-limit',
      });
    if (messages.state === 'unavailable' || !matchesCurrent)
      incompleteSources.push({
        source: 'station.messages',
        state: 'unavailable',
        reason: 'source-unavailable',
      });
    else if (messages.matches.length >= MESSAGE_WINDOW)
      incompleteSources.push({
        source: 'station.messages',
        state: 'partial',
        reason: 'result-window',
      });

    const snippets = new Map<string, string>();
    for (const match of messages.state === 'available' && matchesCurrent
      ? messages.matches
      : [])
      if (!snippets.has(match.conversationId))
        snippets.set(match.conversationId, match.excerpt);
    const query = input.query.toLowerCase();
    const matches = new Map<
      string,
      Omit<(typeof candidates)[number], 'threadId'> & { snippet: string }
    >();
    for (const { threadId, ...candidate } of readable.sort(
      (a, b) =>
        b.updatedAt.localeCompare(a.updatedAt) ||
        a.threadId.localeCompare(b.threadId),
    )) {
      if (matches.has(candidate.conversationId)) continue;
      const snippet = candidate.title?.toLowerCase().includes(query)
        ? messageSearchExcerpt(candidate.title, input.query)
        : snippets.get(threadId);
      if (snippet)
        matches.set(candidate.conversationId, { ...candidate, snippet });
    }
    current();
    const results = [...matches.values()];
    const limit = input.limit ?? WORK_DISCOVERY_DEFAULT_LIMIT;
    return {
      success: true,
      data: {
        state: 'partial',
        results: results.slice(0, limit),
        limit,
        ...(results.length > limit ? { resultWindow: true } : {}),
        incompleteSources,
      },
    };
  };
}
