import { UNIFIED_SEARCH_V1 } from '@kontourai/station-contracts/unified-search';
import { z } from 'zod';

import {
  CONVERSATION_TITLE_MAX_CODE_POINTS,
  hasUnsafeTitleCharacters,
} from '../services/orchestration/conversation-title.js';
import type { StationControlToolRegistry } from './station-control-mcp-server.js';
import { api, jsonToolResult } from './station-control-shared.js';

/**
 * #176: the agent-facing half of session search and rename.
 *
 * Both tools are thin over Station's own routes, which decide everything:
 * `search_sessions` is `POST /api/search` (the unified search service behind
 * the workspace search palette, #1363) narrowed to session and message hits,
 * and answers as the calling session's owner; `rename_session` is its own
 * leaf (`POST /api/conversations/:id/agent-title`), never the person's
 * `PATCH`, because it must refuse to replace a title a person set.
 *
 * A bound is a refusal here too, not a truncation: the route validates the
 * same limits again, so a caller that skips this schema is refused there.
 */

const QUERY_MIN = 2;
const QUERY_MAX = 256;
/** Two provider tokens at the unified service's per-token cap, base64url. */
const CONTINUATION_MAX_CHARS = 11_000;

const continuationEntries = z
  .array(
    z
      .object({
        providerId: z.string().min(1).max(256),
        token: z.string().min(1).max(4096),
      })
      .strict(),
  )
  .min(1)
  .max(2);

function encodeContinuation(
  sources: readonly { providerId: string; continuation?: unknown }[],
): string | undefined {
  const entries = sources.flatMap((source) =>
    typeof source.continuation === 'string' && source.continuation.length > 0
      ? [{ providerId: source.providerId, token: source.continuation }]
      : [],
  );
  const parsed = continuationEntries.safeParse(entries);
  return parsed.success
    ? Buffer.from(JSON.stringify(parsed.data)).toString('base64url')
    : undefined;
}

function decodeContinuation(
  value: string,
): z.infer<typeof continuationEntries> | undefined {
  try {
    const parsed = continuationEntries.safeParse(
      JSON.parse(Buffer.from(value, 'base64url').toString('utf8')),
    );
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

const text = (value: unknown): string | undefined =>
  typeof value === 'string' && value.length > 0 ? value : undefined;

/**
 * What an agent needs from a unified-search response: where each hit is, what
 * it says and how to open it. The route's owner stamp and result keys are
 * Station-internal and stay out of the tool result.
 */
function sessionSearchResult(response: unknown) {
  const body = record(response);
  const results = Array.isArray(body.results) ? body.results : [];
  const sources = Array.isArray(body.sources) ? body.sources : [];
  const continuation = encodeContinuation(
    sources.map((source) => ({
      providerId: text(record(source).providerId) ?? '',
      continuation: record(source).continuation,
    })),
  );
  return {
    state: text(body.state) ?? 'unavailable',
    results: results.map((result) => {
      const hit = record(result);
      const scope = record(hit.scope);
      const open = record(hit.openIntent);
      return {
        kind: text(hit.kind),
        sessionId: text(scope.sessionId) ?? text(open.sessionId),
        projectId: text(scope.projectId),
        title: text(hit.title),
        snippet: text(hit.snippet),
        messageId: text(open.messageId),
        matchedEventId: text(open.matchedEventId),
        relevance: typeof hit.relevance === 'number' ? hit.relevance : 0,
      };
    }),
    // A source that could not answer in full is stated, never dropped: an
    // empty `results` is only an answer when every source was available.
    incompleteSources: sources.flatMap((source) => {
      const entry = record(source);
      return entry.state === 'available'
        ? []
        : [
            {
              source: text(entry.providerId),
              state: text(entry.state),
              reason: text(entry.reason),
            },
          ];
    }),
    ...(continuation ? { continuation } : {}),
  };
}

const titleSchema = z
  .string()
  .min(1)
  .refine((value) => [...value].length <= CONVERSATION_TITLE_MAX_CODE_POINTS, {
    message: `Title must be at most ${CONVERSATION_TITLE_MAX_CODE_POINTS} characters`,
  })
  .refine((value) => !hasUnsafeTitleCharacters(value), {
    message: 'Title must be a single line of plain text',
  });

export function registerSessionSearchTools(server: StationControlToolRegistry) {
  server.tool(
    'search_sessions',
    "Search the calling session owner's own conversation transcripts for a phrase. " +
      'Returns matching messages with the session each belongs to, a snippet and the ids that open it. ' +
      'Hits are mostly from native Claude and Codex session transcripts, whose titles `rename_session` cannot change. ' +
      'Results are limited to what the person this session acts for may read. ' +
      'A response with `incompleteSources` is partial, not empty; pass its `continuation` to read more when present.',
    {
      query: z
        .string()
        .min(QUERY_MIN)
        .max(QUERY_MAX)
        .describe(`Phrase to find (${QUERY_MIN}-${QUERY_MAX} characters)`),
      continuation: z
        .string()
        .min(1)
        .max(CONTINUATION_MAX_CHARS)
        .optional()
        .describe('The `continuation` a previous result returned'),
    },
    async ({ query, continuation }) => {
      const continuations =
        continuation === undefined
          ? undefined
          : decodeContinuation(continuation);
      if (continuation !== undefined && !continuations)
        return jsonToolResult({
          success: false,
          code: 'invalid_continuation',
          error:
            'continuation is not one search_sessions returned. Search again without it.',
        });
      const body = await api('/api/search', {
        method: 'POST',
        body: JSON.stringify({
          version: UNIFIED_SEARCH_V1,
          query,
          filters: { kinds: ['session', 'message'] },
          ...(continuations ? { continuations } : {}),
        }),
      });
      if (body?.success !== true)
        return jsonToolResult(
          body?.success === false
            ? body
            : { success: false, error: 'Search unavailable' },
        );
      return jsonToolResult({
        success: true,
        data: sessionSearchResult(body.data),
      });
    },
  );

  server.tool(
    'rename_session',
    'Rename a Station-stored conversation. A title a person set is never replaced (refused with `person_title`); ' +
      'a title this tool set earlier is. Native Claude and Codex sessions keep their runtime-managed titles ' +
      '(refused with `runtime_title_unsupported`), and `search_sessions` hits are mostly those, so a search result is not a conversation to rename. ' +
      'Only a conversation of the person this session acts for, unless the caller is a bound operator.',
    {
      conversationId: z.string().min(1).max(256),
      title: titleSchema.describe(
        `New title, one line, at most ${CONVERSATION_TITLE_MAX_CODE_POINTS} characters`,
      ),
    },
    async ({ conversationId, title }) =>
      jsonToolResult(
        await api(
          `/api/conversations/${encodeURIComponent(conversationId)}/agent-title`,
          { method: 'POST', body: JSON.stringify({ title }) },
        ),
      ),
  );
}
