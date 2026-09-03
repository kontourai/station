import type { TaskRecord } from '@kontourai/station-contracts/task-graph';
import {
  UNIFIED_SEARCH_V1,
  type UnifiedSearchCandidate,
  type UnifiedSearchMatchedField,
  type UnifiedSearchOwner,
  type UnifiedSearchProvider,
  type UnifiedSearchProviderPage,
  type UnifiedSearchProviderRequest,
} from '@kontourai/station-contracts/unified-search';
import { UNIFIED_SEARCH_LIMITS } from './unified-search-service.js';

const TASK_SCAN_LIMIT = 1_000;

function truncateUtf8(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, 'utf8') <= maxBytes) return value;
  let result = '';
  let used = 0;
  for (const character of value) {
    const size = Buffer.byteLength(character, 'utf8');
    if (used + size > maxBytes) break;
    result += character;
    used += size;
  }
  return result;
}

export interface AuthorizedMessageSearchMatch {
  conversationId: string;
  messageId: string;
  role: 'user' | 'assistant';
  excerpt: string;
  projectSlug?: string;
  agentSlug?: string;
}

export interface StationMessageSearchSource {
  /** Existing SessionTranscriptReads search with request authority already bound. */
  searchAuthorizedMessages(request: {
    query: string;
    limit: number;
    projectId?: string;
  }): readonly AuthorizedMessageSearchMatch[];
}

export type StationMessageSearchAuthority =
  | { mode: 'personal'; stationId: string }
  | { mode: 'hosted'; stationId: string; tenantId: string };

export interface PersonalTaskSearchSource {
  /** Personal-mode TaskGraph list; hosted composition must not use this Adapter. */
  listAuthorizedTasks(): readonly TaskRecord[];
}

function stationOwner(stationId: string): UnifiedSearchOwner {
  return { kind: 'station', stationId };
}

function messageOwner(
  authority: StationMessageSearchAuthority,
): UnifiedSearchOwner {
  if (
    authority.mode === 'hosted' &&
    (typeof authority.tenantId !== 'string' || authority.tenantId.length === 0)
  ) {
    throw new TypeError('Hosted message search requires tenant authority');
  }
  return {
    kind: 'station',
    stationId: authority.stationId,
    ...(authority.mode === 'hosted' ? { tenantId: authority.tenantId } : {}),
  };
}

function queryMatchesFilter(
  request: UnifiedSearchProviderRequest,
  kind: 'task' | 'message',
): boolean {
  return !request.filters?.kinds || request.filters.kinds.includes(kind);
}

function current(now: () => string) {
  return { state: 'current' as const, observedAt: now() };
}

function taskCandidate(
  task: TaskRecord,
  query: string,
  now: () => string,
): UnifiedSearchCandidate | null {
  const normalized = query.toLowerCase();
  const fields: UnifiedSearchMatchedField[] = [];
  if (task.id.toLowerCase().includes(normalized)) fields.push('id');
  if (task.title.toLowerCase().includes(normalized)) fields.push('title');
  if (task.description.toLowerCase().includes(normalized)) {
    fields.push('description');
  }
  if (fields.length === 0) return null;
  const relevance = fields.includes('title')
    ? task.title.toLowerCase().startsWith(normalized)
      ? 1
      : 0.9
    : fields.includes('description')
      ? 0.7
      : 0.6;
  return {
    id: task.id,
    kind: 'task',
    scope: { projectId: task.projectId, taskId: task.id },
    title: truncateUtf8(task.title, UNIFIED_SEARCH_LIMITS.titleBytes),
    ...(task.description
      ? {
          snippet: truncateUtf8(
            task.description,
            UNIFIED_SEARCH_LIMITS.snippetBytes,
          ),
        }
      : {}),
    matchedFields: fields,
    currentness: current(now),
    relevance,
    openIntent: {
      kind: 'task',
      projectId: task.projectId,
      taskId: task.id,
    },
  };
}

/** Adapter over the existing personal TaskGraph read authority. */
export function createPersonalTaskSearchProvider(input: {
  stationId: string;
  source: PersonalTaskSearchSource;
  now?: () => string;
}): UnifiedSearchProvider {
  const owner = stationOwner(input.stationId);
  const now = input.now ?? (() => new Date().toISOString());
  return {
    descriptor: {
      id: 'station.tasks',
      version: '1.0.0',
      owner,
      kinds: ['task'],
    },
    async search(request): Promise<UnifiedSearchProviderPage> {
      if (request.continuation) {
        return {
          version: UNIFIED_SEARCH_V1,
          state: 'unavailable',
          reason: 'continuation-invalid',
        };
      }
      if (!queryMatchesFilter(request, 'task')) {
        return { version: UNIFIED_SEARCH_V1, state: 'available', results: [] };
      }
      const all = input.source.listAuthorizedTasks();
      const scanned = all.slice(0, TASK_SCAN_LIMIT);
      const candidates = scanned
        .filter(
          (task) =>
            (!request.filters?.projectId ||
              task.projectId === request.filters.projectId) &&
            (!request.filters?.taskId || task.id === request.filters.taskId),
        )
        .map((task) => taskCandidate(task, request.query, now))
        .filter((candidate): candidate is UnifiedSearchCandidate => !!candidate)
        .sort((left, right) => right.relevance - left.relevance);
      const partial =
        all.length > TASK_SCAN_LIMIT || candidates.length > request.limit;
      return {
        version: UNIFIED_SEARCH_V1,
        state: partial ? 'partial' : 'available',
        results: candidates.slice(0, request.limit),
        ...(partial ? { reason: 'result-window' } : {}),
      };
    },
  };
}

/** Adapter over the existing authority-filtered message-search index. */
export function createStationMessageSearchProvider(input: {
  authority: StationMessageSearchAuthority;
  source: StationMessageSearchSource;
  now?: () => string;
}): UnifiedSearchProvider {
  const owner = messageOwner(input.authority);
  const now = input.now ?? (() => new Date().toISOString());
  return {
    descriptor: {
      id: 'station.messages',
      version: '1.0.0',
      owner,
      kinds: ['message'],
    },
    async search(request): Promise<UnifiedSearchProviderPage> {
      if (request.continuation) {
        return {
          version: UNIFIED_SEARCH_V1,
          state: 'unavailable',
          reason: 'continuation-invalid',
        };
      }
      if (!queryMatchesFilter(request, 'message')) {
        return { version: UNIFIED_SEARCH_V1, state: 'available', results: [] };
      }
      if (request.filters?.taskId) {
        return { version: UNIFIED_SEARCH_V1, state: 'available', results: [] };
      }
      const matches = input.source.searchAuthorizedMessages({
        query: request.query,
        limit: request.limit + 1,
        ...(request.filters?.projectId
          ? { projectId: request.filters.projectId }
          : {}),
      });
      if (
        request.filters?.projectId &&
        matches.some(
          (match) => match.projectSlug !== request.filters!.projectId,
        )
      ) {
        return {
          version: UNIFIED_SEARCH_V1,
          state: 'unavailable',
          reason: 'source-unavailable',
        };
      }
      const partial = matches.length > request.limit;
      const results = matches.slice(0, request.limit).map((match) => ({
        id: JSON.stringify([match.conversationId, match.messageId]),
        kind: 'message' as const,
        scope: {
          ...(match.projectSlug ? { projectId: match.projectSlug } : {}),
          sessionId: match.conversationId,
        },
        title: match.role === 'user' ? 'Your message' : 'Agent response',
        snippet: truncateUtf8(
          match.excerpt,
          UNIFIED_SEARCH_LIMITS.snippetBytes,
        ),
        matchedFields: ['snippet' as const],
        currentness: current(now),
        relevance: 0.8,
        openIntent: {
          kind: 'session-message' as const,
          sessionId: match.conversationId,
          messageId: match.messageId,
        },
      }));
      return {
        version: UNIFIED_SEARCH_V1,
        state: partial ? 'partial' : 'available',
        results,
        ...(partial ? { reason: 'result-window' } : {}),
      };
    },
  };
}
