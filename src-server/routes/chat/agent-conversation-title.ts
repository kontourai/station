import type { SessionReadAuthority } from '@kontourai/station-contracts/tenancy';
import { isHostedSessionReadAuthority } from '@kontourai/station-contracts/tenancy';
import { Hono } from 'hono';
import { z } from 'zod/v3';
import type { FileMemoryAdapter } from '../../adapters/file/memory-adapter.js';
import type {
  StationControlDispatchScope,
  StationControlResolvedDispatchTarget,
} from '../../runtime/mcp/station-control-dispatch-scope.js';
import {
  isPrincipalScopedAgentRequest,
  stationControlRequestAuthority,
} from '../../security/station-control-request-authority.js';
import {
  CONVERSATION_TITLE_MAX_CODE_POINTS,
  hasUnsafeTitleCharacters,
} from '../../services/orchestration/conversation-title.js';
import {
  stationControlRefusal,
  stationControlRefusalBody,
  stationControlScopeRefusal,
} from '../../tools/station-control-policy.js';
import type { Logger } from '../../utils/logger.js';
import { errorMessage, getBody, validate } from '../schemas/schemas.js';

/** Refusal codes an agent can act on. The tool relays the body unchanged. */
const AGENT_TITLE_PERSON_TITLE_CODE = 'person_title';
const AGENT_TITLE_RUNTIME_UNSUPPORTED_CODE = 'runtime_title_unsupported';

const conversationId = z
  .string()
  .min(1)
  .max(256)
  .refine(
    (value) => value !== '.' && value !== '..' && !/[\\/]|\p{Cc}/u.test(value),
    'Invalid conversation identity',
  );

/**
 * A rejection, never a truncation: an over-long, empty or multi-line title is
 * refused so the agent learns the limit instead of storing a name it did not
 * write. The bound is the conversation title's own (`derivedConversationTitle`).
 */
const requestSchema = z
  .object({
    title: z
      .string()
      // Checked before the trim, so a separator or mark at either end is
      // refused rather than quietly dropped.
      .refine(
        (value) => !hasUnsafeTitleCharacters(value),
        'Title must be a single line of plain text',
      )
      .transform((value) => value.trim())
      .refine((value) => value.length > 0, 'Title must not be empty')
      .refine(
        (value) => [...value].length <= CONVERSATION_TITLE_MAX_CODE_POINTS,
        `Title must be at most ${CONVERSATION_TITLE_MAX_CODE_POINTS} characters`,
      ),
  })
  .strict();

interface StoredConversation {
  userId?: string;
  metadata?: unknown;
}

function metadataOf(conversation: StoredConversation): Record<string, unknown> {
  const { metadata } = conversation;
  return metadata && typeof metadata === 'object' && !Array.isArray(metadata)
    ? (metadata as Record<string, unknown>)
    : {};
}

/**
 * `POST /api/conversations/:id/agent-title`: the one route a station-control
 * agent renames a conversation through (`rename_session`). It is not the
 * person's `PATCH /agents/:slug/conversations/:id`, which stamps
 * `titleSource: 'user'`: an agent's title is stamped `'agent'`, and a title a
 * person set is never replaced.
 */
export function createAgentConversationTitleRoutes(deps: {
  memoryAdapters: Map<string, FileMemoryAdapter>;
  /** Native-SDK (Claude/Codex) sessions: their titles belong to the runtime. */
  sessionConversationReader?: {
    readSessionConversation(
      threadId: string,
      authority: SessionReadAuthority,
    ): Promise<unknown>;
  };
  authorityFor: (request: Request) => SessionReadAuthority;
  scope?: StationControlDispatchScope;
  logger: Logger;
}) {
  const app = new Hono();
  app.post(
    '/:id/agent-title',
    validate(requestSchema, { maxBodyBytes: 4 * 1024 }),
    async (c) => {
      try {
        // Only a station-control tool call with a verified caller names an
        // agent. A person renames through `PATCH`, and the provenance stamp
        // below must not be forgeable by any other client.
        const agent = stationControlRequestAuthority(c.req.raw);
        if (agent?.kind !== 'caller')
          return c.json(
            stationControlRefusalBody(
              stationControlRefusal('station_control_caller_required'),
            ),
            403,
          );
        const idParsed = conversationId.safeParse(c.req.param('id'));
        if (!idParsed.success)
          return c.json(
            { success: false, error: 'Invalid conversation identity' },
            400,
          );
        const id = idParsed.data;
        const authority = deps.authorityFor(c.req.raw);
        // File-memory conversations have no tenant binding.
        if (isHostedSessionReadAuthority(authority))
          return c.json(
            { success: false, error: 'Conversation not found' },
            404,
          );
        // The runtime owns a native-SDK conversation's title; the person's
        // `PATCH` refuses it the same way.
        if (
          await deps.sessionConversationReader?.readSessionConversation(
            id,
            authority,
          )
        )
          return c.json(
            {
              success: false,
              code: AGENT_TITLE_RUNTIME_UNSUPPORTED_CODE,
              error:
                'Runtime conversation titles are managed by the runtime and cannot be renamed.',
            },
            409,
          );

        let adapter: FileMemoryAdapter | undefined;
        let stored: StoredConversation | null = null;
        for (const candidate of deps.memoryAdapters.values()) {
          stored = await candidate.getConversation(id);
          if (stored) {
            adapter = candidate;
            break;
          }
        }
        // A bound operator caller is not scoped to one person's conversations
        // (the `delete_conversation` precedent); anyone else renames only a
        // conversation its session's owner owns, and one of anyone else's
        // reads as absent.
        if (
          !adapter ||
          !stored ||
          (isPrincipalScopedAgentRequest(c.req.raw) &&
            stored.userId !== authority.userId)
        )
          return c.json(
            { success: false, error: 'Conversation not found' },
            404,
          );
        // The same scope rule every station-control call that aims at a
        // session holds to: a caller that is not a bound operator stays in
        // its own session's Project (or the global space).
        const projectSlug = metadataOf(stored).projectSlug;
        const target: StationControlResolvedDispatchTarget | undefined =
          typeof projectSlug === 'string' && projectSlug.length > 0
            ? deps.scope?.target({
                kind: 'new',
                ownerId: stored.userId ?? '',
                projectSlug,
                remote: false,
              })
            : {
                ...(stored.userId ? { ownerId: stored.userId } : {}),
                scope: { kind: 'global' as const },
                host: false,
                remote: false,
              };
        const refusal = stationControlScopeRefusal(agent.caller, target);
        if (refusal) return c.json(stationControlRefusalBody(refusal), 403);

        // Compare-and-set inside the store's per-conversation write queue: the
        // updater reads the LATEST committed record, so a person's rename that
        // lands first is seen here and one that lands after wins by stamping
        // `'user'` over this write. A check outside the queue would let this
        // write overwrite a rename that landed between the read and the write.
        let personTitle = false;
        const { title } = getBody(c) as { title: string };
        const updated = await adapter.updateConversation(id, (current) => {
          const metadata = metadataOf(current);
          if (metadata.titleSource === 'user') {
            personTitle = true;
            return null;
          }
          return { title, metadata: { ...metadata, titleSource: 'agent' } };
        });
        if (personTitle)
          return c.json(
            {
              success: false,
              code: AGENT_TITLE_PERSON_TITLE_CODE,
              error:
                'A person set this conversation title, so Station will not replace it.',
            },
            409,
          );
        return c.json({
          success: true,
          data: {
            conversationId: id,
            title: updated.title,
            titleSource: 'agent' as const,
          },
        });
      } catch (error: unknown) {
        // The store throws when the conversation vanished between the lookup
        // and the write.
        if (error instanceof Error && /not found/i.test(error.message))
          return c.json(
            { success: false, error: 'Conversation not found' },
            404,
          );
        deps.logger.error('Failed to rename conversation for agent', { error });
        return c.json({ success: false, error: errorMessage(error) }, 500);
      }
    },
  );
  return app;
}
