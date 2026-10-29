import { isHostedSessionReadAuthority } from '@kontourai/station-contracts/tenancy';
import { UNIFIED_SEARCH_V1 } from '@kontourai/station-contracts/unified-search';
import { Hono } from 'hono';
import { z } from 'zod/v3';
import type { FileMemoryAdapter } from '../../adapters/file/memory-adapter.js';
import { stationControlRequestAuthority } from '../../security/station-control-request-authority.js';
import { publicAgentIdFromRuntimeKey } from '../../services/agents/runtime-agent-identity.js';
import type { EventStore } from '../../services/orchestration/event-store.js';
import type { OrchestrationService } from '../../services/orchestration/orchestration-service.js';
import type { RuntimeSearch } from '../../services/search/runtime-search.js';
import {
  stationControlRefusal,
  stationControlRefusalBody,
} from '../../tools/station-control-policy.js';
import {
  ConversationLineageTooLongError,
  type ConversationMessageRead,
} from './conversation-message-reader.js';
import {
  type ConversationReferenceReadDeps,
  createConversationReadAdmission,
} from './conversation-reference-read.js';
import {
  WORK_DISCOVERY_DEFAULT_LIMIT,
  WORK_DISCOVERY_MAX_LIMIT,
} from './work-discovery-limits.js';

const schema = z
  .object({
    query: z.string().trim().min(2).max(256),
    projectSlug: z.string().min(1).max(256).optional(),
    agent: z.string().min(1).max(256).optional(),
    limit: z.coerce
      .number()
      .int()
      .min(1)
      .max(WORK_DISCOVERY_MAX_LIMIT)
      .default(WORK_DISCOVERY_DEFAULT_LIMIT),
  })
  .strict();

// Only admitted, filtered metadata consumes the scan budget. Indexed hits remain usable.
const MAX_CONVERSATIONS = 2_000;
const MAX_FILE_READS = 32;
const snippet = (value: string, query: string) => {
  const at = value.toLowerCase().indexOf(query.toLowerCase());
  return value
    .slice(Math.max(0, at - 60), Math.max(0, at - 60) + 240)
    .replace(/\s+/gu, ' ')
    .trim();
};
interface Candidate {
  conversationId: string;
  title: string | null;
  agent: string | null;
  projectSlug: string | null;
  updatedAt: string;
  stored: boolean;
}

/** Discovery reuses palette message search, the owner read model and transcript admission. */
export function createConversationWorkSearchRoutes(deps: {
  read: ConversationReferenceReadDeps;
  sessions: Pick<OrchestrationService, 'listSessionReadModel'>;
  eventStore?: Pick<EventStore, 'conversationTitle'>;
  memory?: Pick<FileMemoryAdapter, 'getConversationsByUserId'>;
  search?: RuntimeSearch;
  current(request: Request): boolean;
}) {
  const app = new Hono();
  const admit = createConversationReadAdmission(deps.read);
  app.get('/work/search', async (c) => {
    c.header('Cache-Control', 'private, no-store');
    const authority = stationControlRequestAuthority(c.req.raw);
    if (authority?.kind !== 'caller')
      return c.json(
        stationControlRefusalBody(
          stationControlRefusal('station_control_caller_required'),
        ),
        403,
      );
    const parsed = schema.safeParse(c.req.query());
    if (!parsed.success)
      return c.json(
        {
          success: false,
          code: 'invalid_search_request',
          error: `query must be 2–256 characters and limit 1–${WORK_DISCOVERY_MAX_LIMIT}; unknown fields are refused.`,
        },
        400,
      );
    const caller = authority.caller;
    const { query, agent, limit } = parsed.data;
    const projectSlug = parsed.data.projectSlug ?? caller.projectSlug;
    const readAuthority = deps.read.authorityFor(c.req.raw);
    const current = () => deps.current(c.req.raw) && !c.req.raw.signal.aborted;
    if (!current())
      return c.json({ success: false, error: 'Search unavailable' }, 503);
    try {
      const sessions = await deps.sessions.listSessionReadModel(readAuthority);
      const candidates = new Map<string, Candidate>();
      for (const session of sessions) {
        const id =
          session.conversationId ??
          deps.read.conversationIdOf(session.threadId);
        const old = candidates.get(id);
        if (old && old.updatedAt > session.updatedAt) continue;
        candidates.set(id, {
          conversationId: id,
          title:
            deps.eventStore?.conversationTitle([id, session.threadId]) ??
            session.displayTitle ??
            null,
          agent: session.assignedAgentSlug
            ? publicAgentIdFromRuntimeKey(session.assignedAgentSlug)
            : null,
          projectSlug: session.projectSlug ?? null,
          updatedAt: session.updatedAt,
          stored: false,
        });
      }
      // File-backed conversations have no tenant binding and no content index.
      if (!isHostedSessionReadAuthority(readAuthority)) {
        // Every runtime memory adapter addresses the same Station home; list it once.
        for (const stored of (await deps.memory?.getConversationsByUserId(
          readAuthority.userId,
        )) ?? []) {
          const old = candidates.get(stored.id);
          const metadata = stored.metadata;
          candidates.set(stored.id, {
            conversationId: stored.id,
            title: stored.title ?? old?.title ?? null,
            agent: publicAgentIdFromRuntimeKey(stored.resourceId),
            projectSlug:
              typeof metadata?.projectSlug === 'string'
                ? metadata.projectSlug
                : (old?.projectSlug ?? null),
            updatedAt: new Date(stored.updatedAt).toISOString(),
            stored: true,
          });
        }
      }
      const native = await deps.search?.search(
        {
          version: UNIFIED_SEARCH_V1,
          query,
          filters: {
            kinds: ['message'],
            ...(projectSlug ? { projectId: projectSlug } : {}),
          },
        },
        { authority: readAuthority, current, signal: c.req.raw.signal },
      );
      if (native?.state === 'invalid')
        return c.json({ success: false, error: 'Invalid search request' }, 400);
      const messageHits = new Map<string, string>();
      for (const hit of native?.results ?? []) {
        const sessionId = hit.scope?.sessionId;
        if (!sessionId || !hit.snippet) continue;
        const id = deps.read.conversationIdOf(sessionId);
        if (!messageHits.has(id)) messageHits.set(id, hit.snippet);
      }
      const incompleteSources: Array<{
        source: string;
        state: string;
        reason?: string;
      }> =
        native?.sources
          .filter((source) => source.state !== 'available')
          .map((source) => ({
            source: source.providerId,
            state: source.state,
            reason: source.reason,
          })) ?? [];
      if (!native || native.state === 'unavailable')
        incompleteSources.push({
          source: 'station.messages',
          state: 'unavailable',
          reason: 'source-unavailable',
        });
      const markIncomplete = (source: string, reason: string) => {
        if (
          !incompleteSources.some(
            (entry) => entry.source === source && entry.reason === reason,
          )
        )
          incompleteSources.push({ source, state: 'partial', reason });
      };
      let scanned = 0;
      let fileReads = 0;
      const results = [];
      for (const candidate of [...candidates.values()].sort(
        (a, b) =>
          b.updatedAt.localeCompare(a.updatedAt) ||
          a.conversationId.localeCompare(b.conversationId),
      )) {
        if (!current())
          return c.json({ success: false, error: 'Search unavailable' }, 503);
        if (projectSlug !== undefined && candidate.projectSlug !== projectSlug)
          continue;
        if (agent !== undefined && candidate.agent !== agent) continue;
        if (admit(caller, candidate.conversationId).refusal) continue;
        if (candidate.stored || !messageHits.has(candidate.conversationId)) {
          if (scanned >= MAX_CONVERSATIONS) {
            markIncomplete('station.conversations', 'metadata-scan-limit');
            continue;
          }
          scanned += 1;
        }
        let matched = candidate.title
          ?.toLowerCase()
          .includes(query.toLowerCase())
          ? snippet(candidate.title, query)
          : messageHits.get(candidate.conversationId);
        if (candidate.stored) {
          if (fileReads >= MAX_FILE_READS) {
            markIncomplete('station.files', 'transcript-read-limit');
            continue;
          }
          fileReads += 1;
          // Even title hits need the owner-scoped read to establish that the file still reads.
          let read: ConversationMessageRead;
          try {
            read = await deps.read.readConversationMessages(
              c.req.raw,
              candidate.agent ?? 'station',
              candidate.conversationId,
            );
          } catch (error) {
            if (!(error instanceof ConversationLineageTooLongError))
              throw error;
            markIncomplete('station.files', 'conversation-lineage-too-long');
            continue;
          }
          if (read.source === 'empty' && read.absence !== 'no-messages')
            continue;
          if (!matched) {
            for (const message of read.messages) {
              const text = message.parts
                .filter((part) => part.type === 'text')
                .map((part) => part.text ?? '')
                .join('\n');
              if (text.toLowerCase().includes(query.toLowerCase())) {
                matched = snippet(text, query);
                break;
              }
            }
          }
        }
        if (matched) {
          const { stored: _stored, ...identity } = candidate;
          results.push({ ...identity, snippet: matched });
        }
        if (results.length > limit) break;
      }
      if (!current())
        return c.json({ success: false, error: 'Search unavailable' }, 503);
      const more = results.length > limit;
      return c.json({
        success: true,
        data: {
          state: more || incompleteSources.length ? 'partial' : 'available',
          results: results.slice(0, limit),
          limit,
          ...(more ? { resultWindow: true } : {}),
          incompleteSources,
        },
      });
    } catch (error) {
      deps.read.logger.warn('Failed to search conversations', {
        error: error instanceof Error ? error.message : String(error),
      });
      return c.json({ success: false, error: 'Search unavailable' }, 503);
    }
  });
  return app;
}
