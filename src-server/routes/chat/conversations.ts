/**
 * Conversation Routes - conversation and message management
 */

import { createHash } from 'node:crypto';
import {
  exportThread,
  OUTPUT_FORMATS,
  type OutputFormat,
} from '@kontourai/ferry';
import { agentId } from '@kontourai/station-contracts/agent-identity';
import type { AppConfig } from '@kontourai/station-contracts/config';
import { CONVERSATION_INTENT_SUMMARY_MAX_ITEMS } from '@kontourai/station-contracts/conversation-intent-summary';
import type {
  ConversationListItem,
  ConversationOpenResolution,
} from '@kontourai/station-contracts/orchestration';
import { agentAvailableInProject } from '@kontourai/station-contracts/project-reference-integrity';
import { parseConversationStatsResponse } from '@kontourai/station-contracts/runtime';
import {
  isHostedSessionReadAuthority,
  type SessionReadAuthority,
  sessionReadAuthorityFromRequest,
} from '@kontourai/station-contracts/tenancy';
import type { ConversationMessage } from '@kontourai/station-shared/conversation-message';
import { projectRuntimeEventsToMessages } from '@kontourai/station-shared/runtime-event-projection';
import { conversationToThread } from '@kontourai/station-shared/thread-projection';
import type { SessionUsageAggregate } from '@kontourai/station-shared/usage-fold';
import { type Context, Hono } from 'hono';
import { z } from 'zod/v3';
import type { FileMemoryAdapter } from '../../adapters/file/memory-adapter.js';
import { ReservedAgentIdentityError } from '../../domain/agent-registry.js';
import type { ConfigLoader } from '../../domain/config-loader.js';
import type { ConversationRecord } from '../../domain/storage-adapter.js';
import type { BedrockModelCatalog } from '../../providers/llm/bedrock-models.js';
import {
  getTenantRequestContext,
  loadHostedTenantRegistryFromEnvironment,
} from '../../runtime/bootstrap/runtime-tenant-context.js';
import * as ConversationManager from '../../runtime/conversation/conversation-manager.js';
import { resolveConversationTranscriptSource } from '../../runtime/conversation/conversation-transcript-source.js';
import { sanitizeConversationMessagesUIBlockProvenance } from '../../runtime/conversation/ui-block-provenance.js';
import type { RuntimeContext } from '../../runtime/types.js';
import { actionOperationActorForRequest } from '../../services/operations/action-operation-authority.js';
import {
  type ActionOperationTrackingService,
  beginActionOperationTracking,
} from '../../services/operations/action-operation-tracker.js';
import type { ConversationAcknowledgementStore } from '../../services/orchestration/conversation-acknowledgement-store.js';
import {
  FORK_REPLAY_DISCLOSURE,
  renderForkTranscript,
  selectForkTranscriptSlice,
} from '../../services/orchestration/conversation-fork.js';
import type { ConversationForkProvenance } from '../../services/orchestration/event-store.js';
import type { SummaryRelatedEvidenceObservation } from '../../services/session-summary/conversation-intent-summary-source.js';
import { AuthoritativeConversationIntentSummarySource } from '../../services/session-summary/conversation-intent-summary-source.js';
import {
  FileSessionSummaryStore,
  type SessionSummaryCoordinate,
  SessionSummaryCoordinator,
  type StoredSessionSummary,
  type StoredSessionSummaryV1,
} from '../../services/session-summary/session-summary-store.js';
import {
  chatTitleRegenerated,
  conversationMessageSearches,
  conversationOps,
} from '../../telemetry/metrics.js';
import type { Logger } from '../../utils/logger.js';
import {
  publicAgentIdFromRuntimeKey,
  runtimeAgentKey,
} from '../agents/runtime-agent-identity.js';
import {
  contextActionSchema,
  conversationUpdateSchema,
  errorMessage,
  getBody,
  param,
  validate,
} from '../schemas/schemas.js';
import { getCachedUser } from '../system/auth.js';
import {
  createChatConversationId,
  ensureChatConversation,
} from './chat-persistence.js';
import { generateConversationTitle } from './chat-title-generation.js';
import {
  conversationIntentRevision,
  generateSessionSummary,
  isSessionSummaryFailure,
  redactIntentSummaryValue,
} from './session-summary-generation.js';

const forkConversationSchema = z
  .object({
    targetAgent: z.string().min(1),
    /** A completed assistant turn id; omitted means the latest completed turn. */
    branchPointTurnId: z.string().min(1).optional(),
    /** Explicitly choosing another workspace is a fork decision, never resume. */
    targetProjectSlug: z.string().min(1).optional(),
    /** Replaying a failed request with this key returns the same child. */
    idempotencyKey: z.string().min(1).max(128).optional(),
  })
  .strict();
const CONVERSATION_ID_MAX_LENGTH = 256;

function parseConversationIdSegment(value: string): string | null {
  if (
    value.length < 1 ||
    value.length > CONVERSATION_ID_MAX_LENGTH ||
    value === '.' ||
    value === '..' ||
    value.includes('/') ||
    value.includes('\\') ||
    [...value].some((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code < 32 || code === 127;
    })
  ) {
    return null;
  }
  return value;
}
const regenerateTitleSchema = z
  .object({ replaceManualTitle: z.boolean().optional() })
  .strict();

function conversationRouteFailure(
  c: Context,
  logger: Logger,
  message: string,
  error: unknown,
) {
  if (error instanceof ReservedAgentIdentityError) {
    return c.json(
      { success: false, code: error.code, error: error.message },
      400,
    );
  }
  logger.error(message, { error });
  return c.json({ success: false, error: errorMessage(error) }, 500);
}

function createRequestAuthorityResolver(
  getUserId: () => string,
): (request: Request) => SessionReadAuthority {
  // The registry is deployment configuration loaded while routes are built;
  // the only request input is the context previously installed by verified
  // ingress middleware. Wave 4 may inject the same resolver from its shared
  // runtime wiring, but this fallback is already fail-closed in hosted mode.
  const hostedTenantRegistry = loadHostedTenantRegistryFromEnvironment();
  return (request) =>
    sessionReadAuthorityFromRequest(
      getUserId(),
      getTenantRequestContext(request),
      hostedTenantRegistry,
    );
}

async function sanitizePublicConversationUpdate(
  body: Record<string, unknown>,
  adapter: FileMemoryAdapter,
  conversationId: string,
) {
  const sanitized = { ...body };
  if (
    'metadata' in sanitized &&
    (sanitized.metadata === null ||
      typeof sanitized.metadata !== 'object' ||
      Array.isArray(sanitized.metadata))
  ) {
    delete sanitized.metadata;
  }

  // archive#1566: a user-initiated rename always stamps `titleSource:
  // 'user'` into metadata, even when the PATCH body carries no `metadata`
  // field of its own — this is the durable signal
  // `generateAndPersistAutoTitle` (chat-lifecycle.ts) checks before ever
  // overwriting a title, so a human rename can never be clobbered by a
  // later (slower, async) auto-generated one.
  const isRename = typeof sanitized.title === 'string';
  const hasPublicMetadataUpdate =
    sanitized.metadata &&
    typeof sanitized.metadata === 'object' &&
    !Array.isArray(sanitized.metadata);

  if (hasPublicMetadataUpdate || isRename) {
    const conversation = await adapter.getConversation(conversationId);
    const existingMetadata =
      conversation?.metadata &&
      typeof conversation.metadata === 'object' &&
      !Array.isArray(conversation.metadata)
        ? (conversation.metadata as Record<string, unknown>)
        : {};
    const existingAcpSessionId = existingMetadata.acpSessionId;
    const publicMetadata = hasPublicMetadataUpdate
      ? (sanitized.metadata as
          | Record<string, unknown>
          | { acpSessionId?: unknown })
      : {};
    const { acpSessionId: _acpSessionId, ...metadata } = publicMetadata as
      | Record<string, unknown>
      | { acpSessionId?: unknown };
    sanitized.metadata = {
      ...existingMetadata,
      ...metadata,
      ...(existingAcpSessionId !== undefined
        ? { acpSessionId: existingAcpSessionId }
        : {}),
      ...(isRename ? { titleSource: 'user' } : {}),
    };
  }
  return sanitized;
}

/**
 * Narrow view of the orchestration service used only to refresh native-SDK
 * (Claude/Codex) chats: their turns persist as runtime events, not in the
 * memory store, so when the store has no messages we project the session's
 * events into the same conversation-message shape via the shared projection.
 */
interface SessionMessageReader {
  readSessionMessages(
    threadId: string,
    authority: SessionReadAuthority,
  ): ConversationMessage[];
  /**
   * Fold a native-SDK session's persisted events into engine-agnostic usage
   * totals (archive#1299) — the stats-route counterpart to
   * `readSessionMessages`'s messages-route compatibility path. Optional so a reader
   * that predates this method (e.g. an older test double) still type-checks;
   * the stats route treats its absence the same as an empty session.
   */
  readSessionUsage?(
    threadId: string,
    authority: SessionReadAuthority,
  ): SessionUsageAggregate;
  listConversationHistoryPage(
    authority: SessionReadAuthority,
    options: { limit: number; cursor?: string; agentSlug?: string },
  ): Promise<{
    items: ConversationListItem[];
    hasMore: boolean;
    nextCursor?: string;
  }>;
  readSessionConversation(
    threadId: string,
    authority: SessionReadAuthority,
  ): Promise<{
    id: string;
    agentSlug: string;
    projectSlug?: string;
    title: string;
    createdAt: string;
    updatedAt: string;
    messageCount: number;
    mutable: false;
  } | null>;
  /** Bounded, authority-checked runtime facts for derived-summary revision. */
  readConversationEventWindow?(
    conversationId: string,
    options: {
      cursor?: string;
      turnLimit: number;
      authority: SessionReadAuthority;
      signal?: AbortSignal;
    },
  ): Promise<{
    watermark: number | string;
    currentSessionId?: string;
    session?: { displayTitle?: string; projectSlug?: string };
    sessionLineage?: readonly { sessionId: string; agentSlug?: string }[];
    events?: readonly {
      sequence?: number | string;
      event: import('@kontourai/station-contracts/runtime-events').CanonicalRuntimeEvent;
    }[];
    hasMore?: boolean;
    nextCursor?: string;
    contextBoundaries?: readonly {
      boundaryId: string;
      successorSessionId: string;
      policy: 'continue-from-history' | 'empty-next-cold-start';
      priorTranscriptInjected: boolean;
    }[];
  } | null>;
  /** Indexed message-body search; results are already ACL-scoped. */
  searchSessionMessages?: (
    query: string,
    authority: SessionReadAuthority,
    limit?: number,
  ) => Array<{
    conversationId: string;
    messageId: string;
    role: 'user' | 'assistant';
    excerpt: string;
    projectSlug?: string;
    engine?: string;
    agentSlug?: string;
  }>;
}

const FORK_WINDOW_MAX_PAGES = 16;
const FORK_WINDOW_MAX_EVENTS = 3_200;
const FORK_WINDOW_MAX_BYTES = 2 * 1024 * 1024;
const FORK_WINDOW_MAX_MS = 2_000;
const FORK_WINDOW_MAX_CURSOR_LENGTH = 512;
type ForkConversationWindow = NonNullable<
  Awaited<
    ReturnType<NonNullable<SessionMessageReader['readConversationEventWindow']>>
  >
>;

export async function readCompleteForkConversationWindow(
  reader: SessionMessageReader,
  conversationId: string,
  authority: SessionReadAuthority,
): Promise<
  | { status: 'not-found' }
  | { status: 'incomplete'; reason: string }
  | {
      status: 'complete';
      window: ForkConversationWindow;
    }
> {
  const startedAt = Date.now();
  const seenCursors = new Set<string>();
  let cursor: string | undefined;
  let firstWindow: ForkConversationWindow | null = null;
  const combinedEvents: Array<
    NonNullable<ForkConversationWindow['events']>[number]
  > = [];
  let eventCount = 0;
  let byteCount = 0;
  const readPage = async () => {
    const remaining = FORK_WINDOW_MAX_MS - (Date.now() - startedAt);
    if (remaining <= 0) throw new Error('conversation history read timed out');
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        reader.readConversationEventWindow?.(conversationId, {
          cursor,
          turnLimit: 200,
          authority,
          signal: controller.signal,
        }),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            controller.abort();
            reject(new Error('conversation history read timed out'));
          }, remaining);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  };
  for (let page = 0; page < FORK_WINDOW_MAX_PAGES; page += 1) {
    let window: ForkConversationWindow | null | undefined;
    try {
      window = await readPage();
    } catch (error) {
      return {
        status: 'incomplete',
        reason:
          error instanceof Error && error.message.includes('timed out')
            ? 'conversation history read timed out'
            : 'conversation page read failed',
      };
    }
    if (!window) {
      return page === 0
        ? { status: 'not-found' }
        : { status: 'incomplete', reason: 'conversation page unavailable' };
    }
    if (!Array.isArray(window.events))
      return { status: 'incomplete', reason: 'malformed conversation page' };
    eventCount += window.events.length;
    byteCount += Buffer.byteLength(JSON.stringify(window.events), 'utf8');
    if (
      eventCount > FORK_WINDOW_MAX_EVENTS ||
      byteCount > FORK_WINDOW_MAX_BYTES ||
      Date.now() - startedAt > FORK_WINDOW_MAX_MS
    )
      return {
        status: 'incomplete',
        reason: 'conversation history exceeds fork limits',
      };
    firstWindow ??= window;
    combinedEvents.push(...window.events);
    if (!window.hasMore) {
      const deduplicated = new Map<
        string,
        NonNullable<ForkConversationWindow['events']>[number]
      >();
      for (const item of combinedEvents) {
        if (!deduplicated.has(item.event.eventId))
          deduplicated.set(item.event.eventId, item);
      }
      const sequenceOwners = new Map<number, string>();
      for (const item of deduplicated.values()) {
        if (
          typeof item.sequence !== 'number' ||
          !Number.isSafeInteger(item.sequence)
        )
          return {
            status: 'incomplete',
            reason: 'conversation event sequence is malformed',
          };
        const owner = sequenceOwners.get(item.sequence);
        if (owner && owner !== item.event.eventId)
          return {
            status: 'incomplete',
            reason: 'conversation event sequence conflicts',
          };
        sequenceOwners.set(item.sequence, item.event.eventId);
      }
      const ordered = [...deduplicated.values()].sort(
        (left, right) => (left.sequence as number) - (right.sequence as number),
      );
      return {
        status: 'complete',
        window: { ...firstWindow, ...window, events: ordered },
      };
    }
    const nextCursor = (window as { nextCursor?: unknown }).nextCursor;
    if (
      typeof nextCursor !== 'string' ||
      nextCursor.length < 1 ||
      nextCursor.length > FORK_WINDOW_MAX_CURSOR_LENGTH ||
      seenCursors.has(nextCursor)
    )
      return { status: 'incomplete', reason: 'conversation cursor stalled' };
    seenCursors.add(nextCursor);
    cursor = nextCursor;
  }
  return { status: 'incomplete', reason: 'conversation page limit reached' };
}

const conversationHistoryPageQuerySchema = z.object({
  cursor: z.string().min(1).max(512).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(100),
});

const messageSearchQuerySchema = z.object({
  query: z.string().trim().min(2).max(256),
});

async function listPersonalFileConversationItems(
  memoryAdapters: Map<string, FileMemoryAdapter>,
  userId: string,
  limit: number,
): Promise<{ items: ConversationListItem[]; hasMore: boolean }> {
  const pages = await Promise.all(
    [...memoryAdapters].map(async ([slug, adapter]) => {
      const conversations = await adapter.queryConversations({
        userId,
        resourceId: slug,
        orderBy: 'updated_at',
        orderDirection: 'DESC',
        limit: limit + 1,
      });
      return {
        hasMore: conversations.length > limit,
        items: await Promise.all(
          conversations.slice(0, limit).map(async (conversation) => {
            const metadata =
              conversation.metadata &&
              typeof conversation.metadata === 'object' &&
              !Array.isArray(conversation.metadata)
                ? (conversation.metadata as Record<string, unknown>)
                : undefined;
            const projectSlug =
              typeof metadata?.projectSlug === 'string'
                ? metadata.projectSlug
                : undefined;
            const titleSource: ConversationListItem['titleSource'] =
              metadata?.titleSource === 'user' ||
              metadata?.titleSource === 'generated' ||
              metadata?.titleSource === 'provider' ||
              metadata?.titleSource === 'prompt'
                ? metadata.titleSource
                : undefined;
            const messages = await adapter.getMessages(
              conversation.userId,
              conversation.id,
            );
            return {
              id: conversation.id,
              source: 'store' as const,
              agentSlug: publicAgentIdFromRuntimeKey(
                conversation.resourceId || slug,
              ),
              ...(projectSlug ? { projectSlug } : {}),
              title: conversation.title,
              createdAt: conversation.createdAt,
              updatedAt: conversation.updatedAt,
              messageCount: messages.length,
              mutable: true,
              ...(titleSource ? { titleSource } : {}),
              answerability: { answerable: true as const },
            };
          }),
        ),
      };
    }),
  );
  return {
    items: pages.flatMap((page) => page.items),
    hasMore: pages.some((page) => page.hasMore),
  };
}

function compareConversationRecency(
  left: ConversationListItem,
  right: ConversationListItem,
): number {
  const leftTime = Date.parse(left.updatedAt);
  const rightTime = Date.parse(right.updatedAt);
  const byUpdatedAt =
    (Number.isNaN(rightTime) ? 0 : rightTime) -
    (Number.isNaN(leftTime) ? 0 : leftTime);
  return byUpdatedAt || right.id.localeCompare(left.id);
}

export function createConversationRoutes(
  memoryAdapters: Map<string, FileMemoryAdapter>,
  logger: Logger,
  agentFixedTokens?: Map<
    string,
    { systemPromptTokens: number; mcpServerTokens: number }
  >,
  agentTools?: Map<string, unknown[]>,
  configLoader?: ConfigLoader,
  appConfig?: AppConfig,
  modelCatalog?: BedrockModelCatalog,
  createMemoryAdapter?: (slug: string) => FileMemoryAdapter,
  sessionMessageReader?: SessionMessageReader,
  getUserId: () => string = () => getCachedUser().alias,
  /** See `calculateContextWindowPercentage` (archive#1299 item 3a). */
  resolveContextWindowTokens?: (
    modelId: string,
  ) => number | undefined | Promise<number | undefined>,
  /**
   * Installed by runtime route wiring. This remains request-scoped: it must
   * mint authority from ingress state, never from a route payload or cache.
   */
  getSessionReadAuthority?: (request: Request) => SessionReadAuthority,
  /** Immutable provenance facts for file and native conversations alike. */
  eventStore?: {
    appendConversationFork(
      event: import('@kontourai/station-contracts/runtime-events').CanonicalRuntimeEvent,
    ): void;
    appendConversationForkIfAbsent?(
      event: import('@kontourai/station-contracts/runtime-events').CanonicalRuntimeEvent,
    ): boolean;
    readConversationForkProvenance(conversationId: string): {
      forkedFrom?: ConversationForkProvenance;
      forkedTo: ConversationForkProvenance[];
    };
    readConversationForkProvenanceBatch?(
      conversationIds: readonly string[],
    ): Map<
      string,
      {
        forkedFrom?: ConversationForkProvenance;
        forkedTo: ConversationForkProvenance[];
      }
    >;
  },
  /** Avoid treating a lazily creatable file adapter as proof an agent exists. */
  isKnownAgent?: (
    slug: string,
  ) =>
    | boolean
    | null
    | { project?: string }
    | Promise<boolean | null | { project?: string }>,
  /** Injectable only to prove a failed target creation cannot emit a fact. */
  createTargetConversation: typeof ensureChatConversation = ensureChatConversation,
  projectScope?: {
    getProject(slug: string): {
      agents?: readonly import('@kontourai/station-contracts/agent-identity').AgentId[];
    };
  },
  runtimeContext?: RuntimeContext,
  summaryStore?: Pick<FileSessionSummaryStore, 'read' | 'write' | 'dismiss'> &
    Partial<Pick<FileSessionSummaryStore, 'show' | 'delete'>>,
  /** Shared status envelope; omitted by older/narrow route compositions. */
  actionOperations?: ActionOperationTrackingService,
  summaryEvidenceCatalog?: {
    observe(input: {
      authority: SessionReadAuthority;
      events: readonly {
        event: {
          eventId: string;
          threadId: string;
          turnId?: string;
          method: string;
        };
      }[];
    }): Promise<SummaryRelatedEvidenceObservation[]>;
  },
  resolveForkReadAuthority?: (context: Context) => SessionReadAuthority,
) {
  const app = new Hono();
  const sessionSummaries =
    summaryStore ??
    new FileSessionSummaryStore(
      typeof configLoader?.getProjectHomeDir === 'function'
        ? configLoader.getProjectHomeDir()
        : '.station',
    );
  const summaryCoordinator = new SessionSummaryCoordinator();
  const summarySource = new AuthoritativeConversationIntentSummarySource();
  const sourceForSummary = (
    messages: ConversationMessage[],
    window?: {
      watermark: number | string;
      currentSessionId?: string;
      contextBoundaries?: readonly {
        boundaryId: string;
        successorSessionId: string;
        policy: 'continue-from-history' | 'empty-next-cold-start';
        priorTranscriptInjected: boolean;
      }[];
    } | null,
    relatedEvidenceObservations: readonly SummaryRelatedEvidenceObservation[] = [],
  ) =>
    summarySource.read({
      messages,
      ...(window ? { watermark: window.watermark } : {}),
      relatedEvidenceObservations,
      consumedBoundaries: (window?.contextBoundaries ?? [])
        .slice(0, CONVERSATION_INTENT_SUMMARY_MAX_ITEMS)
        .map((boundary) => ({
          boundaryId: boundary.boundaryId,
          policy: boundary.policy,
          priorTranscriptInjected: boundary.priorTranscriptInjected,
        })),
    });
  const readSummarySource = async (
    conversationId: string,
    messages: ConversationMessage[],
    authority: SessionReadAuthority,
  ) => {
    const window = await sessionMessageReader?.readConversationEventWindow?.(
      conversationId,
      { turnLimit: 20, authority },
    );
    const relatedEvidenceObservations =
      summaryEvidenceCatalog && window?.events
        ? await summaryEvidenceCatalog.observe({
            authority,
            events: window.events,
          })
        : [];
    return {
      source: sourceForSummary(messages, window, relatedEvidenceObservations),
      currentSessionId: window?.currentSessionId,
    };
  };
  const authorityFor =
    getSessionReadAuthority ?? createRequestAuthorityResolver(getUserId);
  const forkReservations = new Map<string, Promise<void>>();
  const reserveFork = async <T>(key: string, work: () => Promise<T>) => {
    const previous = forkReservations.get(key);
    let release!: () => void;
    const reservation = new Promise<void>((resolve) => {
      release = resolve;
    });
    forkReservations.set(key, reservation);
    await previous;
    try {
      return await work();
    } finally {
      release();
      if (forkReservations.get(key) === reservation) {
        forkReservations.delete(key);
      }
    }
  };

  /** Get or lazily create an adapter for a slug */
  const getAdapter = (slug: string): FileMemoryAdapter | null => {
    let adapter = memoryAdapters.get(slug);
    if (!adapter && createMemoryAdapter) {
      adapter = createMemoryAdapter(slug);
      memoryAdapters.set(slug, adapter);
    }
    return adapter || null;
  };

  app.post(
    '/:slug/conversations/:conversationId/fork',
    validate(forkConversationSchema),
    async (c) => {
      try {
        let sourceAgent: string;
        let targetAgent: string;
        try {
          sourceAgent = agentId(param(c, 'slug'));
          const rawTarget = getBody(c).targetAgent;
          if (typeof rawTarget !== 'string') throw new Error('invalid target');
          targetAgent = agentId(rawTarget);
        } catch {
          return c.json(
            { success: false, error: 'Invalid Agent identity' },
            400,
          );
        }
        const sourceConversationId = parseConversationIdSegment(
          param(c, 'conversationId'),
        );
        if (!sourceConversationId) {
          return c.json(
            { success: false, error: 'Invalid conversation identity' },
            400,
          );
        }
        const body = getBody(c);
        const requestedBranchPoint =
          typeof body.branchPointTurnId === 'string'
            ? body.branchPointTurnId
            : undefined;
        const requestedProjectSlug =
          typeof body.targetProjectSlug === 'string'
            ? body.targetProjectSlug
            : undefined;
        const idempotencyKey =
          typeof body.idempotencyKey === 'string'
            ? body.idempotencyKey
            : undefined;
        const resolvedSource = isKnownAgent
          ? await isKnownAgent(sourceAgent)
          : true;
        if (!resolvedSource) {
          return c.json(
            { success: false, error: 'Source agent not found' },
            404,
          );
        }
        const resolvedTarget = isKnownAgent
          ? await isKnownAgent(targetAgent)
          : true;
        if (!targetAgent || !eventStore || !resolvedTarget) {
          return c.json(
            { success: false, error: 'Target agent not found' },
            404,
          );
        }
        let authority: SessionReadAuthority;
        try {
          authority = resolveForkReadAuthority?.(c) ?? authorityFor(c.req.raw);
        } catch {
          return c.json(
            {
              success: false,
              error: 'Fork caller identity could not be resolved',
            },
            403,
          );
        }
        const actionOperationActor = actionOperationActorForRequest(
          c.req.raw,
          authority,
          async (sessionId) =>
            (await sessionMessageReader?.readSessionConversation(
              sessionId,
              authority,
            )) != null,
        );
        const sourceAdapter = isHostedSessionReadAuthority(authority)
          ? null
          : getAdapter(runtimeAgentKey(sourceAgent));
        const sourceRecord = sourceAdapter
          ? await sourceAdapter.getConversation(sourceConversationId)
          : null;
        const conversationWindowRead =
          sourceRecord || !sessionMessageReader?.readConversationEventWindow
            ? { status: 'not-found' as const }
            : await readCompleteForkConversationWindow(
                sessionMessageReader,
                sourceConversationId,
                authority,
              );
        if (conversationWindowRead.status === 'incomplete') {
          return c.json(
            {
              success: false,
              error: `Conversation history is incomplete: ${conversationWindowRead.reason}. Retry after history is available.`,
            },
            409,
          );
        }
        const conversationWindow =
          conversationWindowRead.status === 'complete'
            ? conversationWindowRead.window
            : null;
        const sourceSession =
          sourceRecord || conversationWindow
            ? null
            : await sessionMessageReader?.readSessionConversation(
                sourceConversationId,
                authority,
              );
        let recordedSourceAgent: string | undefined;
        const storedResourceId = (
          sourceRecord as {
            resourceId?: unknown;
          } | null
        )?.resourceId;
        if (typeof storedResourceId === 'string') {
          try {
            recordedSourceAgent = publicAgentIdFromRuntimeKey(storedResourceId);
          } catch {
            return c.json(
              {
                success: false,
                error: 'Source agent does not own conversation',
              },
              409,
            );
          }
        }
        if (recordedSourceAgent && recordedSourceAgent !== sourceAgent) {
          return c.json(
            { success: false, error: 'Source agent does not own conversation' },
            409,
          );
        }
        const messageRead = conversationWindow?.events
          ? {
              messages: projectRuntimeEventsToMessages(
                conversationWindow.events.map((item) => item.event),
                { stableIds: true },
              ),
              source: 'orchestration' as const,
            }
          : await readConversationMessages(
              c.req.raw,
              sourceAgent,
              sourceConversationId,
              authority,
            );
        const { messages, source: messageSource } = messageRead;
        if (
          (!sourceRecord && !conversationWindow && !sourceSession) ||
          messages.length === 0
        ) {
          return c.json(
            { success: false, error: 'Conversation not found' },
            404,
          );
        }
        const slice = selectForkTranscriptSlice(
          messages,
          requestedBranchPoint,
          {
            requirePositiveTerminalEvidence: messageSource === 'orchestration',
          },
        );
        if (!slice) {
          return c.json(
            {
              success: false,
              error:
                'Fork from a completed assistant turn. The selected turn is not complete.',
            },
            409,
          );
        }
        if (messageSource === 'orchestration') {
          if (!slice.sourceSessionId) {
            return c.json(
              { success: false, error: 'Selected turn Session is unavailable' },
              409,
            );
          }
          const selectedSession =
            await sessionMessageReader?.readSessionConversation(
              slice.sourceSessionId,
              authority,
            );
          if (
            !selectedSession?.agentSlug ||
            selectedSession.agentSlug !== sourceAgent
          ) {
            return c.json(
              {
                success: false,
                error: 'Source agent does not own selected turn',
              },
              409,
            );
          }
        }
        const sourceTitle =
          sourceRecord?.title ??
          conversationWindow?.session?.displayTitle ??
          sourceSession?.title ??
          'Previous conversation';
        const sourceProjectSlug =
          conversationWindow?.session?.projectSlug ??
          sourceSession?.projectSlug ??
          (typeof sourceRecord?.metadata?.projectSlug === 'string'
            ? sourceRecord.metadata.projectSlug
            : undefined);
        const targetProjectSlug = requestedProjectSlug ?? sourceProjectSlug;
        const ownedTargetProject =
          typeof resolvedTarget === 'object'
            ? resolvedTarget.project
            : undefined;
        if (ownedTargetProject && targetProjectSlug !== ownedTargetProject) {
          return c.json(
            { success: false, error: 'Target agent not found' },
            404,
          );
        }
        if (targetProjectSlug || ownedTargetProject) {
          try {
            const target =
              typeof resolvedTarget === 'object'
                ? resolvedTarget
                : await configLoader?.loadAgent(targetAgent);
            const project = projectScope?.getProject(targetProjectSlug);
            if (
              !target ||
              !project ||
              !agentAvailableInProject(targetProjectSlug, project.agents, {
                slug: agentId(targetAgent),
                project: target.project,
              })
            ) {
              return c.json(
                { success: false, error: 'Target agent not found' },
                404,
              );
            }
          } catch {
            return c.json(
              { success: false, error: 'Target agent not found' },
              404,
            );
          }
        }
        const targetAdapter = getAdapter(runtimeAgentKey(targetAgent));
        if (!targetAdapter) {
          return c.json(
            { success: false, error: 'Target agent not found' },
            404,
          );
        }
        const seed = renderForkTranscript({
          sourceTitle,
          sourceAgent,
          messages: slice.messages,
        });
        const targetConversationId = idempotencyKey
          ? `${getUserId()}:fork:${createHash('sha256')
              .update(
                `${sourceConversationId}\u0000${slice.branchPointTurnId ?? ''}\u0000${targetAgent}\u0000${targetProjectSlug ?? ''}\u0000${idempotencyKey}`,
              )
              .digest('hex')
              .slice(0, 24)}`
          : createChatConversationId(getUserId());
        const existingFork = eventStore
          .readConversationForkProvenance(sourceConversationId)
          .forkedTo.find(
            (fork) => fork.targetConversationId === targetConversationId,
          );
        if (existingFork) {
          return c.json({
            success: true,
            data: {
              conversationId: targetConversationId,
              seed,
              branchPointTurnId: slice.branchPointTurnId,
              sourceSessionId: slice.sourceSessionId,
              continuation: 'replay-seed' as const,
              disclosure: FORK_REPLAY_DISCLOSURE,
              idempotent: true,
            },
          });
        }
        const actionOperation = await beginActionOperationTracking({
          service: actionOperations,
          actor: actionOperationActor,
          logger,
          operation: {
            scope: { accountId: actionOperationActor.accountId },
            title: 'Fork conversation',
            cancellation: 'unsupported',
            domain: {
              kind: 'conversation-fork',
              sourceConversationId,
              targetConversationId,
            },
            reentry: {
              kind: 'conversation',
              agentId: targetAgent,
              conversationId: targetConversationId,
            },
          },
        });
        await actionOperation?.update({
          status: 'running',
          progress: { kind: 'phase', code: 'creating-continuation' },
        });

        try {
          const forkEventId = `conversation-fork:${createHash('sha256')
            .update(`${sourceConversationId}\u0000${targetConversationId}`)
            .digest('hex')}`;
          const idempotent = await reserveFork(
            targetConversationId,
            async () => {
              if (
                eventStore
                  .readConversationForkProvenance(sourceConversationId)
                  .forkedTo.some(
                    (fork) =>
                      fork.targetConversationId === targetConversationId,
                  )
              ) {
                return true;
              }
              // Create before appending: a created-but-unfacted target is an
              // acceptable checkpoint. On retry the deterministic child id and
              // source-message checkpoints prevent a second transcript copy.
              await createTargetConversation({
                conversationStorage: targetAdapter,
                conversationId: targetConversationId,
                userId: getUserId(),
                slug: runtimeAgentKey(targetAgent),
                input: seed,
                title: `Fork of ${sourceTitle}`,
                ...(targetProjectSlug
                  ? { projectSlug: targetProjectSlug }
                  : {}),
                ...(authority.tenantExecutionContext
                  ? {
                      metadata: {
                        tenantId: authority.tenantExecutionContext.tenantId,
                        parentConversationId: sourceConversationId,
                        branchPointTurnId: slice.branchPointTurnId,
                        sourceSessionId: slice.sourceSessionId,
                        continuation: 'replay-seed',
                        continuityDisclosure: FORK_REPLAY_DISCLOSURE,
                      },
                    }
                  : {
                      metadata: {
                        parentConversationId: sourceConversationId,
                        branchPointTurnId: slice.branchPointTurnId,
                        sourceSessionId: slice.sourceSessionId,
                        continuation: 'replay-seed',
                        continuityDisclosure: FORK_REPLAY_DISCLOSURE,
                      },
                    }),
              });
              const copiedSourceIds = new Set(
                (
                  await targetAdapter.getMessages(
                    getUserId(),
                    targetConversationId,
                  )
                )
                  .map(
                    (message) =>
                      (
                        message as {
                          metadata?: { forkSourceMessageId?: unknown };
                        }
                      ).metadata?.forkSourceMessageId,
                  )
                  .filter((id): id is string => typeof id === 'string'),
              );
              const missing = slice.messages.filter(
                (message) => !copiedSourceIds.has(message.id),
              );
              if (missing.length > 0) {
                await targetAdapter.addMessages(
                  missing.map((message) => ({
                    ...message,
                    id: createHash('sha256')
                      .update(`${forkEventId}\u0000${message.id}`)
                      .digest('hex'),
                    metadata: {
                      ...message.metadata,
                      forkSourceMessageId: message.id,
                    },
                  })) as unknown as Parameters<
                    typeof targetAdapter.addMessages
                  >[0],
                  getUserId(),
                  targetConversationId,
                );
              }
              const forkedAt = new Date().toISOString();
              let inserted: boolean;
              if (eventStore.appendConversationForkIfAbsent) {
                inserted = eventStore.appendConversationForkIfAbsent({
                  eventId: forkEventId,
                  provider: 'station',
                  threadId: sourceConversationId,
                  method: 'conversation.forked',
                  sourceConversationId,
                  targetConversationId,
                  targetAgent,
                  forkedAt,
                  branchPointTurnId: slice.branchPointTurnId,
                  sourceSessionId: slice.sourceSessionId,
                  continuation: 'replay-seed',
                  createdAt: forkedAt,
                });
              } else {
                eventStore.appendConversationFork({
                  eventId: forkEventId,
                  provider: 'station',
                  threadId: sourceConversationId,
                  method: 'conversation.forked',
                  sourceConversationId,
                  targetConversationId,
                  targetAgent,
                  forkedAt,
                  branchPointTurnId: slice.branchPointTurnId,
                  sourceSessionId: slice.sourceSessionId,
                  continuation: 'replay-seed',
                  createdAt: forkedAt,
                });
                inserted = true;
              }
              return !inserted;
            },
          );
          await actionOperation?.update({ status: 'succeeded' });
          return c.json({
            success: true,
            data: {
              conversationId: targetConversationId,
              seed,
              branchPointTurnId: slice.branchPointTurnId,
              sourceSessionId: slice.sourceSessionId,
              continuation: 'replay-seed' as const,
              disclosure: FORK_REPLAY_DISCLOSURE,
              idempotent,
            },
          });
        } catch (error) {
          await actionOperation?.update({
            status: 'failed',
            errorSummary: 'Conversation fork could not be completed.',
          });
          throw error;
        }
      } catch (error: unknown) {
        return conversationRouteFailure(
          c,
          logger,
          'Failed to fork conversation',
          error,
        );
      }
    },
  );

  // Get conversations for an agent
  app.get('/:slug/conversations', async (c) => {
    try {
      conversationOps.add(1, { operation: 'list' });
      const slug = param(c, 'slug');
      const runtimeSlug = runtimeAgentKey(slug);
      const authority = authorityFor(c.req.raw);
      const hosted = isHostedSessionReadAuthority(authority);
      const pageQuery = conversationHistoryPageQuerySchema.safeParse({
        cursor: c.req.query('cursor'),
        limit: c.req.query('limit'),
      });
      if (!pageQuery.success) {
        return c.json(
          { success: false, error: 'Invalid conversation history page' },
          400,
        );
      }
      if (!hosted && pageQuery.data.cursor) {
        return c.json(
          {
            success: false,
            error: 'Personal history uses one compatibility page',
          },
          400,
        );
      }
      const adapter = getAdapter(runtimeSlug);

      // File-store records carry projectSlug (if any) inside `metadata`
      // (stamped by `ensureChatConversation`) — project it to a top-level
      // field so it lines up with the session-projection leg below, whose
      // items already carry `projectSlug` at the top level.
      const storePage =
        adapter && !hosted
          ? await listPersonalFileConversationItems(
              new Map([[runtimeSlug, adapter]]),
              authority.userId,
              pageQuery.data.limit,
            )
          : { items: [], hasMore: false };
      const historyPage = sessionMessageReader
        ? await sessionMessageReader.listConversationHistoryPage(authority, {
            ...pageQuery.data,
            agentSlug: slug,
          })
        : { items: [], hasMore: false };
      conversationOps.add(1, {
        operation: 'history_list',
        source: 'orchestration',
        outcome: historyPage.items.length > 0 ? 'available' : 'empty',
      });
      const byId = new Map(
        [...storePage.items, ...historyPage.items].map((conversation) => [
          conversation.id,
          conversation,
        ]),
      );
      const items = [...byId.values()]
        .sort(compareConversationRecency)
        .slice(0, pageQuery.data.limit);
      return c.json({
        success: true,
        data: {
          items,
          hasMore:
            historyPage.hasMore ||
            storePage.hasMore ||
            byId.size > items.length,
          ...(hosted && historyPage.nextCursor
            ? { nextCursor: historyPage.nextCursor }
            : {}),
        },
      });
    } catch (error: unknown) {
      return conversationRouteFailure(
        c,
        logger,
        'Failed to load conversations',
        error,
      );
    }
  });

  // Update conversation (e.g., title)
  app.patch(
    '/:slug/conversations/:conversationId',
    validate(conversationUpdateSchema),
    async (c) => {
      try {
        conversationOps.add(1, {
          operation: 'update',
          agent: param(c, 'slug'),
        });
        const slug = param(c, 'slug');
        const conversationId = param(c, 'conversationId');
        const authority = authorityFor(c.req.raw);

        // File-memory conversations have no tenant binding. In hosted mode a
        // PATCH must not probe the adapter (or lazily create one) to discover
        // whether an unbound transcript exists.
        if (isHostedSessionReadAuthority(authority)) {
          return c.json(
            { success: false, error: 'Conversation not found' },
            404,
          );
        }
        const adapter = getAdapter(runtimeAgentKey(slug));

        if (!adapter) {
          return c.json({ success: false, error: 'Agent not found' }, 404);
        }
        if (
          await sessionMessageReader?.readSessionConversation(
            conversationId,
            authority,
          )
        ) {
          return c.json(
            {
              success: false,
              error: 'Runtime conversation titles are managed by the runtime.',
            },
            409,
          );
        }

        const body = await sanitizePublicConversationUpdate(
          getBody(c),
          adapter,
          conversationId,
        );
        const updated = await adapter.updateConversation(conversationId, body);

        return c.json({ success: true, data: updated });
      } catch (error: unknown) {
        return conversationRouteFailure(
          c,
          logger,
          'Failed to update conversation',
          error,
        );
      }
    },
  );

  app.post(
    '/:slug/conversations/:conversationId/regenerate-title',
    validate(regenerateTitleSchema),
    async (c) => {
      const slug = param(c, 'slug');
      const conversationId = param(c, 'conversationId');
      try {
        const authority = authorityFor(c.req.raw);
        if (isHostedSessionReadAuthority(authority)) {
          chatTitleRegenerated.add(1, { outcome: 'not_found' });
          return c.json(
            { success: false, error: 'Conversation not found' },
            404,
          );
        }
        const adapter = getAdapter(runtimeAgentKey(slug));
        const conversation = await adapter?.getConversation(conversationId);
        if (!adapter || !conversation) {
          chatTitleRegenerated.add(1, { outcome: 'not_found' });
          return c.json(
            { success: false, error: 'Conversation not found' },
            404,
          );
        }
        const titleSource =
          conversation.metadata &&
          typeof conversation.metadata === 'object' &&
          !Array.isArray(conversation.metadata)
            ? (conversation.metadata as { titleSource?: unknown }).titleSource
            : undefined;
        if (titleSource === 'user' && !getBody(c).replaceManualTitle) {
          chatTitleRegenerated.add(1, { outcome: 'confirmation_required' });
          return c.json(
            {
              success: false,
              error: 'Confirmation required to replace a manual title',
            },
            409,
          );
        }
        if (!runtimeContext) throw new Error('Title generation unavailable');
        const messages = await adapter.getMessages(getUserId(), conversationId);
        const textFor = (role: string) =>
          messages
            .filter((message) => message.role === role)
            .map((message) =>
              typeof message.content === 'string'
                ? message.content
                : Array.isArray(message.parts)
                  ? message.parts
                      .map((part: { text?: unknown }) =>
                        typeof part.text === 'string' ? part.text : '',
                      )
                      .join('\n')
                  : '',
            )
            .filter(Boolean)
            .join('\n\n');
        const firstUserText = textFor('user');
        const assistantText = textFor('assistant');
        if (!firstUserText && !assistantText) {
          // A real conversation with no usable text has nothing to title.
          // Sending empty strings to the model either mints a generic title
          // from nothing or fails opaquely — both dishonest (archive#2569
          // review finding).
          chatTitleRegenerated.add(1, { outcome: 'empty' });
          return c.json(
            { success: false, error: 'Conversation has no content to title' },
            409,
          );
        }
        const title = await generateConversationTitle({
          ctx: runtimeContext,
          firstUserText,
          assistantText,
        });
        if (!title) throw new Error('Title generation failed');
        // Re-read before writing: a manual rename can land while the model
        // is generating, and an unconditional write here would overwrite the
        // newer human title AND falsify its provenance to 'generated'. The
        // first-turn generator re-reads for exactly this reason; a
        // regeneration is not exempt (archive#2569 review finding — the
        // CAS-less read-modify-write class).
        const current = await adapter.getConversation(conversationId);
        const snapshotTitle =
          typeof conversation.title === 'string' ? conversation.title : null;
        const snapshotTitleSource = titleSource;
        const currentTitle =
          typeof current?.title === 'string' ? current.title : null;
        const currentTitleSource =
          current?.metadata &&
          typeof current.metadata === 'object' &&
          !Array.isArray(current.metadata)
            ? (current.metadata as { titleSource?: unknown }).titleSource
            : undefined;
        if (
          current &&
          (currentTitle !== snapshotTitle ||
            (currentTitleSource === 'user' && snapshotTitleSource !== 'user'))
        ) {
          chatTitleRegenerated.add(1, { outcome: 'stale' });
          return c.json(
            {
              success: false,
              error: 'Conversation title changed while regenerating',
            },
            409,
          );
        }
        const metadata =
          current?.metadata &&
          typeof current.metadata === 'object' &&
          !Array.isArray(current.metadata)
            ? current.metadata
            : {};
        const updated = await adapter.updateConversation(conversationId, {
          title,
          metadata: { ...metadata, titleSource: 'generated' },
        });
        chatTitleRegenerated.add(1, { outcome: 'success' });
        return c.json({ success: true, data: updated });
      } catch (error) {
        chatTitleRegenerated.add(1, { outcome: 'error' });
        return conversationRouteFailure(
          c,
          logger,
          'Failed to regenerate conversation title',
          error,
        );
      }
    },
  );

  // Delete conversation
  app.delete('/:slug/conversations/:conversationId', async (c) => {
    try {
      conversationOps.add(1, { operation: 'delete', agent: param(c, 'slug') });
      const slug = param(c, 'slug');
      const conversationId = param(c, 'conversationId');
      const authority = authorityFor(c.req.raw);

      // See the PATCH counterpart above. A delete is especially important to
      // fence before the adapter because the file store is process-global in a
      // hosted deployment.
      if (isHostedSessionReadAuthority(authority)) {
        return c.json({ success: false, error: 'Conversation not found' }, 404);
      }
      const adapter = getAdapter(runtimeAgentKey(slug));

      if (!adapter) {
        return c.json({ success: false, error: 'Agent not found' }, 404);
      }
      if (
        await sessionMessageReader?.readSessionConversation(
          conversationId,
          authority,
        )
      ) {
        return c.json(
          {
            success: false,
            error: 'Runtime conversation history is read-only.',
          },
          409,
        );
      }

      await adapter.deleteConversation(conversationId);
      // Derived summaries do not outlive their source conversation. Their
      // owner-scoped coordinate prevents an ID reused later from inheriting
      // this conversation's derived text.
      const summaryCoordinate = summaryCoordinateFor(
        authority,
        slug,
        conversationId,
      );
      summaryCoordinator.invalidate(summaryCoordinate);
      if (sessionSummaries.delete)
        await sessionSummaries.delete(summaryCoordinate);
      else await sessionSummaries.dismiss(summaryCoordinate);

      return c.json({ success: true });
    } catch (error: unknown) {
      return conversationRouteFailure(
        c,
        logger,
        'Failed to delete conversation',
        error,
      );
    }
  });

  // Get messages for a conversation
  /**
   * archive#1399 fix round 2, B2 (independent review) — the SERVE-boundary
   * sanitizer wrapper. `readConversationMessages` below is the one unified
   * read seam, so this is the one place that guarantees every caller (the
   * `/messages` route, `/export`, fork, summary) sees provenance the SERVER
   * has actually recomputed — never a `ConversationMessage[]` served
   * verbatim from the FileMemory store (`memory-adapter-messages.ts`'s
   * `readStoredMessages`, which serializes and reads back `parts` with no
   * equivalent write-time seam) nor a stale copy from before this fix
   * shipped. See `ui-block-provenance.ts`'s `sanitizeConversationMessagesUIBlockProvenance`
   * docblock for why serve-time sanitization (not only write-time) is
   * required here.
   */
  const sanitizeServedMessages = (
    messages: ConversationMessage[],
  ): ConversationMessage[] =>
    sanitizeConversationMessagesUIBlockProvenance(messages, (message, meta) =>
      logger.warn(message, meta),
    );

  /**
   * The one unified conversation read every engine family flows through:
   * memory store first (standard userId, then location scan), then the
   * runtime-event projection for native-SDK sessions. Shared by the
   * /messages and /export routes so an export always sees exactly what the
   * chat UI sees. `source` lets each caller record its own metrics.
   */
  const readConversationMessages = async (
    request: Request,
    slug: string,
    conversationId: string,
    resolvedAuthority?: SessionReadAuthority,
  ): Promise<{
    messages: ConversationMessage[];
    source: 'store' | 'orchestration' | 'empty';
    /**
     * Why an empty read was empty, for callers that answer the user with it.
     * Left unset when we did not determine it — either because the read
     * succeeded, or because nothing here looked (see the hosted branch
     * below). A caller must not read absent as "we asked and it does not
     * exist" (archive#3158).
     */
    absence?: 'not-found' | 'no-messages';
  }> => {
    const runtimeSlug = runtimeAgentKey(slug);
    const adapter = getAdapter(runtimeSlug);
    const authority = resolvedAuthority ?? authorityFor(request);
    const hosted = isHostedSessionReadAuthority(authority);

    // Hosted file conversations have no persisted tenant binding. Do not
    // scan them as a fallback: an empty result must not reveal whether an
    // unbound transcript exists. Runtime sessions remain available through
    // the authority-gated projection below.
    let messages: ConversationMessage[] = [];
    let absence: 'not-found' | 'no-messages' | undefined;
    if (adapter && !hosted) {
      // archive#4080 follow-up: the conventional-userId-then-
      // conversation-lookup fallback is the ONE shared definition of "which
      // store serves this conversation" — see
      // `conversation-transcript-source.ts`'s own doc.
      const source =
        await resolveConversationTranscriptSource<ConversationMessage>(
          adapter,
          `agent:${runtimeSlug}`,
          conversationId,
        );
      messages = source.messages;
      if (!source.occupied) {
        // The record is the distinction: a record not found means no
        // conversation by that id, a record whose reads stay empty means
        // one exists that nothing was ever said in.
        absence = source.conversationRecordFound ? 'no-messages' : 'not-found';
      }
    }
    if (messages.length > 0) {
      return { messages: sanitizeServedMessages(messages), source: 'store' };
    }

    // Native-SDK (Claude/Codex) turns persist as runtime events, not in the
    // memory store. When the store has nothing, project the session's events
    // (threadId === conversationId) into the same message shape so these chats
    // refresh through this one unified read path. Additive: only fires on an
    // empty store, so ACP/internal conversations are unaffected.
    if (sessionMessageReader) {
      const projected = sessionMessageReader.readSessionMessages(
        conversationId,
        authority,
      );
      if (projected.length > 0) {
        // Already write-sanitized by `publishCanonicalEvent`'s safe wrapper
        // — this is a deliberate, cheap, idempotent belt (B2's ruling),
        // not a second source of truth, and it is what protects a message
        // projected from an event persisted before this fix round shipped.
        return {
          messages: sanitizeServedMessages(projected),
          source: 'orchestration',
        };
      }
      // The memory store is NOT the store of record for native-SDK
      // conversations — their turns persist as runtime events. So a null
      // there means "not in that store", which is true of every Claude Code
      // and Codex conversation, and it must not be reported as "no such
      // conversation" once this projection has also been consulted.
      //
      // `readSessionMessages` returns [] for both "no such session" and
      // "the authority denied it", with no existence channel — so once it
      // has run and found nothing, which absence occurred is genuinely
      // undetermined. Say that rather than claim the stronger one
      // (archive#3158 review).
      if (absence === 'not-found') absence = undefined;
    }
    return { messages: [], source: 'empty', absence };
  };

  const summaryCoordinateFor = (
    authority: SessionReadAuthority,
    slug: string,
    conversationId: string,
  ): SessionSummaryCoordinate => ({
    // Hosted session identity is tenant-owned; personal identity remains tied
    // to the authenticated user rather than a process-global file path.
    ownerScope: isHostedSessionReadAuthority(authority)
      ? `tenant:${authority.tenantExecutionContext?.tenantId ?? 'unbound'}`
      : `user:${authority.userId}`,
    agentSlug: runtimeAgentKey(slug),
    conversationId,
  });

  /**
   * The sole authority seam for every summary verb. It proves the conversation
   * exists under the request authority before the derived-data store can be
   * read or mutated, and returns the owner-scoped durable coordinate.
   */
  const authorizeSessionSummaryConversation = async (
    request: Request,
    slug: string,
    conversationId: string,
  ): Promise<
    | {
        coordinate: SessionSummaryCoordinate;
        messages: ConversationMessage[];
        authority: SessionReadAuthority;
      }
    | undefined
  > => {
    const authority = authorityFor(request);
    if (
      isHostedSessionReadAuthority(authority) &&
      !authority.tenantExecutionContext
    ) {
      return undefined;
    }
    const adapter = isHostedSessionReadAuthority(authority)
      ? null
      : getAdapter(runtimeAgentKey(slug));
    const storedConversation = adapter
      ? await adapter.getConversation(conversationId)
      : null;
    const sessionConversation = storedConversation
      ? null
      : await sessionMessageReader?.readSessionConversation(
          conversationId,
          authority,
        );
    if (!storedConversation && !sessionConversation) return undefined;

    const { messages } = await readConversationMessages(
      request,
      slug,
      conversationId,
    );
    return {
      coordinate: summaryCoordinateFor(authority, slug, conversationId),
      messages,
      authority,
    };
  };

  /**
   * A summary is fresh only when its captured contiguous complete-message
   * extent still joins the current transcript and still reaches its end.
   * Partial tail input is deliberately not counted as a complete extent.
   */
  const summaryIsStale = (
    summary: StoredSessionSummary | StoredSessionSummaryV1,
    messages: ConversationMessage[],
    sourceRevision?: string,
  ): boolean => {
    if ('version' in summary)
      return (
        summary.sourceRevision !==
        (sourceRevision ?? conversationIntentRevision(messages))
      );
    const from = messages.findIndex(
      (message) => message.id === summary.summarizedFromMessageId,
    );
    const through = messages.findIndex(
      (message) => message.id === summary.summarizedThroughMessageId,
    );
    if (from < 0 || through < from || through !== messages.length - 1)
      return true;
    if (summary.partialMessageIncluded) {
      return (
        summary.summarizedMessageCount !== 0 ||
        summary.summarizedFromMessageId !== summary.summarizedThroughMessageId
      );
    }
    return through - from + 1 !== summary.summarizedMessageCount;
  };

  const projectSummary = (
    summary: StoredSessionSummary | StoredSessionSummaryV1,
    messages: ConversationMessage[],
    sourceRevision?: string,
  ) => {
    if ('version' in summary)
      return {
        ...summary,
        verificationRefs: summary.verificationRefs ?? [],
        stale: summaryIsStale(summary, messages, sourceRevision),
      };
    // v1 is readable but never gains new authority. Regeneration writes v2.
    return {
      version: 1 as const,
      ...summary,
      overview: summary.text,
      goals: [],
      constraints: [],
      progress: [],
      nextSteps: [],
      reportedCompletion: [],
      verificationRefs: [],
      contextBoundaryCount: 0,
      sourceRange: {
        fromMessageId: summary.summarizedFromMessageId,
        throughMessageId: summary.summarizedThroughMessageId,
        messageCount: summary.summarizedMessageCount,
      },
      sourceRevision: undefined,
      stale: summaryIsStale(summary, messages, sourceRevision),
    };
  };

  app.get('/:slug/conversations/:conversationId/messages', async (c) => {
    try {
      conversationOps.add(1, {
        operation: 'messages',
        agent: param(c, 'slug'),
      });
      const slug = param(c, 'slug');
      const conversationId = param(c, 'conversationId');
      const { messages, source } = await readConversationMessages(
        c.req.raw,
        slug,
        conversationId,
      );
      if (source !== 'store') {
        conversationOps.add(1, {
          operation: 'history_restore',
          source: 'orchestration',
          outcome: source === 'orchestration' ? 'restored' : 'empty',
        });
      }
      return c.json({ success: true, data: messages });
    } catch (error: unknown) {
      return conversationRouteFailure(
        c,
        logger,
        'Failed to load messages',
        error,
      );
    }
  });

  /**
   * Summary is a separately persisted, user-requested derived view. It is
   * intentionally not a context-management operation and never writes a
   * message: treating model output about a transcript as a transcript turn
   * would contaminate the thing it describes.
   */
  app.get('/:slug/conversations/:conversationId/summary', async (c) => {
    try {
      const slug = param(c, 'slug');
      const conversationId = param(c, 'conversationId');
      const authorized = await authorizeSessionSummaryConversation(
        c.req.raw,
        slug,
        conversationId,
      );
      if (!authorized)
        return c.json({ success: false, error: 'Conversation not found' }, 404);
      const summary = await sessionSummaries.read(authorized.coordinate);
      if (!summary || ('dismissedAt' in summary && summary.dismissedAt))
        return c.json({ success: true, data: null });
      // Preserve v1 reads without forcing their legacy payload through the v2
      // authoritative source extractor. Regeneration is the migration seam.
      if (!('version' in summary))
        return c.json({
          success: true,
          data: projectSummary(summary, authorized.messages),
        });
      const source = await readSummarySource(
        conversationId,
        authorized.messages,
        authorized.authority,
      );
      return c.json({
        success: true,
        data: projectSummary(
          summary,
          authorized.messages,
          source.source.revision,
        ),
      });
    } catch (error) {
      return conversationRouteFailure(
        c,
        logger,
        'Failed to load session summary',
        error,
      );
    }
  });

  app.post('/:slug/conversations/:conversationId/summary', async (c) => {
    let generationToken: { key: string; epoch: number } | null = null;
    try {
      const slug = param(c, 'slug');
      const conversationId = param(c, 'conversationId');
      if (!runtimeContext)
        throw new Error('Session summary generation unavailable');
      const authorized = await authorizeSessionSummaryConversation(
        c.req.raw,
        slug,
        conversationId,
      );
      if (!authorized)
        return c.json({ success: false, error: 'Conversation not found' }, 404);
      const { messages } = authorized;
      const sourceRead = await readSummarySource(
        conversationId,
        messages,
        authorized.authority,
      );
      const turnState = sessionMessageReader as
        | { hasActiveTurn?(conversationId: string): boolean }
        | undefined;
      // `conversationId` is a stable aggregate, not a runtime Session. A
      // successor can be running while its predecessor is idle, so quiescence
      // must ask the event window's current lineage member.
      if (
        sourceRead.currentSessionId &&
        turnState?.hasActiveTurn?.(sourceRead.currentSessionId)
      )
        return c.json(
          {
            success: false,
            code: 'summary_conversation_not_quiescent',
            error:
              'Wait for the current turn to settle before generating a summary.',
          },
          409,
        );
      const source = sourceRead.source;
      if (source.messages.length === 0) {
        return c.json(
          { success: false, error: 'Conversation has no content to summarize' },
          409,
        );
      }
      generationToken = summaryCoordinator.begin(authorized.coordinate);
      if (!generationToken)
        return c.json(
          {
            success: false,
            code: 'summary_generation_in_flight',
            error:
              'Summary generation is already in progress for this conversation.',
          },
          409,
        );
      const generated = await generateSessionSummary({
        ctx: runtimeContext,
        messages: source.messages,
        transcriptOverride: source.transcript,
      });
      if (isSessionSummaryFailure(generated)) {
        if (
          generated.kind === 'timeout' &&
          generated.settles &&
          generationToken
        ) {
          summaryCoordinator.finishWhenSettled(
            generationToken,
            generated.settles,
          );
          generationToken = null;
        }
        // archive#3026 named the reason; archive#3148 made the generator COMPUTE it. It
        // used to return a bare null from four distinct situations, and this
        // rendered all four as "no structure model is configured or the
        // transcript was empty" — two causes, neither computed, one of them
        // unreachable because the empty-conversation case already returned a
        // 409 twenty lines above. The generator now says which.
        throw new Error(
          `Session summary generation failed: ${generated.message}`,
        );
      }
      const afterGeneration = await authorizeSessionSummaryConversation(
        c.req.raw,
        slug,
        conversationId,
      );
      const generationRevision = source.revision;
      // A token, the conversation authority, and the canonical revision must
      // all still agree immediately before the atomic sidecar write.
      if (
        !afterGeneration ||
        !summaryCoordinator.current(generationToken) ||
        (
          await readSummarySource(
            conversationId,
            afterGeneration.messages,
            afterGeneration.authority,
          )
        ).source.revision !== generationRevision
      )
        return c.json(
          {
            success: false,
            code: 'summary_source_changed',
            error:
              'Conversation changed while generating; regenerate from the current transcript.',
          },
          409,
        );
      const summary = redactIntentSummaryValue({
        ...generated,
        sourceRevision: generationRevision,
        // Source selection owns every range. Model output is never allowed to
        // widen, join across, or substitute its provenance extent.
        sourceRanges: source.ranges,
        sourceRange: source.ranges.at(-1)!,
        summarizedFromMessageId: source.messages[0]!.id,
        summarizedThroughMessageId: source.messages.at(-1)!.id,
        summarizedMessageCount: source.messages.length,
        partialMessageIncluded: source.partialMessageIncluded,
        generationUsage: generated.generationUsage ?? { state: 'unknown' },
        contextBoundaryCount: source.contextBoundaryCount,
        contextBoundaries: source.contextBoundaries,
        relatedEvidenceRefs: source.relatedEvidenceRefs,
        // Task links are related investigation evidence, not verification.
        verificationRefs: source.verificationRefs,
        generatedAt: new Date().toISOString(),
      });
      await sessionSummaries.write(authorized.coordinate, summary);
      conversationOps.add(1, {
        operation: 'summary_generate',
        outcome: 'success',
      });
      return c.json({
        success: true,
        data: {
          ...summary,
          stale: summaryIsStale(
            summary,
            afterGeneration.messages,
            generationRevision,
          ),
        },
      });
    } catch (error) {
      conversationOps.add(1, {
        operation: 'summary_generate',
        outcome: 'error',
      });
      return conversationRouteFailure(
        c,
        logger,
        'Failed to generate session summary',
        error,
      );
    } finally {
      if (generationToken) summaryCoordinator.finish(generationToken);
    }
  });

  app.delete('/:slug/conversations/:conversationId/summary', async (c) => {
    try {
      const authorized = await authorizeSessionSummaryConversation(
        c.req.raw,
        param(c, 'slug'),
        param(c, 'conversationId'),
      );
      if (!authorized)
        return c.json({ success: false, error: 'Conversation not found' }, 404);
      summaryCoordinator.invalidate(authorized.coordinate);
      if (sessionSummaries.delete)
        await sessionSummaries.delete(authorized.coordinate);
      else await sessionSummaries.dismiss(authorized.coordinate);
      conversationOps.add(1, {
        operation: 'summary_dismiss',
        outcome: 'success',
      });
      return c.json({ success: true });
    } catch (error) {
      conversationOps.add(1, {
        operation: 'summary_dismiss',
        outcome: 'error',
      });
      return conversationRouteFailure(
        c,
        logger,
        'Failed to dismiss session summary',
        error,
      );
    }
  });

  app.post(
    '/:slug/conversations/:conversationId/summary/dismiss',
    async (c) => {
      const authorized = await authorizeSessionSummaryConversation(
        c.req.raw,
        param(c, 'slug'),
        param(c, 'conversationId'),
      );
      if (!authorized)
        return c.json({ success: false, error: 'Conversation not found' }, 404);
      summaryCoordinator.invalidate(authorized.coordinate);
      await sessionSummaries.dismiss(authorized.coordinate);
      return c.json({ success: true });
    },
  );

  app.post('/:slug/conversations/:conversationId/summary/show', async (c) => {
    const authorized = await authorizeSessionSummaryConversation(
      c.req.raw,
      param(c, 'slug'),
      param(c, 'conversationId'),
    );
    if (!authorized)
      return c.json({ success: false, error: 'Conversation not found' }, 404);
    if (sessionSummaries.show)
      await sessionSummaries.show(authorized.coordinate);
    return c.json({ success: true });
  });

  /**
   * archive#1999 S2: export a conversation as a portable @kontourai/thread
   * (or any ferry output format). Reads through the SAME unified path as
   * /messages, so every engine family — Station engine (VoltAgent/Strands),
   * Claude Code, Codex, ACP-connected apps — exports identically.
   */
  app.get('/:slug/conversations/:conversationId/export', async (c) => {
    try {
      const slug = param(c, 'slug');
      const conversationId = param(c, 'conversationId');
      const format = c.req.query('format') ?? 'thread';
      if (!(OUTPUT_FORMATS as readonly string[]).includes(format)) {
        return c.json(
          {
            success: false,
            error: `Unknown export format "${format}" (expected: ${OUTPUT_FORMATS.join(', ')})`,
          },
          400,
        );
      }
      conversationOps.add(1, {
        operation: 'export',
        agent: slug,
        format,
      });
      const { messages, source, absence } = await readConversationMessages(
        c.req.raw,
        slug,
        conversationId,
      );
      if (messages.length === 0) {
        // Three different answers, and the read already knows which one it
        // is. The undetermined case keeps the either/or wording on purpose:
        // a hosted read deliberately never looks the conversation up, so
        // naming either cause there would be a claim nothing computed.
        return c.json(
          {
            success: false,
            error:
              absence === 'not-found'
                ? 'Conversation not found'
                : absence === 'no-messages'
                  ? 'Conversation has no messages to export'
                  : 'Conversation not found or empty',
          },
          404,
        );
      }
      const runtimeSlug = runtimeAgentKey(slug);
      const adapter = getAdapter(runtimeSlug);
      const conversation =
        source === 'store' && adapter
          ? await adapter.getConversation(conversationId)
          : null;
      const title =
        typeof (conversation as { title?: unknown } | null)?.title === 'string'
          ? (conversation as { title: string }).title
          : undefined;
      const thread = conversationToThread(messages, {
        threadId: conversationId,
        title,
      });
      if (thread.messages.length === 0) {
        // Not the same failure as above: the conversation was found and it
        // had messages — none of them survived projection into a thread
        // (e.g. every part was empty). Saying "not found" here sends the
        // user to look for a conversation that is sitting right there.
        return c.json(
          {
            success: false,
            error: 'Conversation has no exportable messages',
          },
          404,
        );
      }
      const body = exportThread(thread, format as OutputFormat);
      return c.body(body, 200, {
        'Content-Type':
          format === 'markdown'
            ? 'text/markdown; charset=utf-8'
            : 'application/json; charset=utf-8',
      });
    } catch (error: unknown) {
      return conversationRouteFailure(
        c,
        logger,
        'Failed to export conversation',
        error,
      );
    }
  });

  // Manage conversation context (summarize, trim, etc.)
  app.post(
    '/:slug/conversations/:conversationId/context',
    validate(contextActionSchema),
    async (c) => {
      try {
        const slug = param(c, 'slug');
        const conversationId = param(c, 'conversationId');
        const authority = authorityFor(c.req.raw);
        // Context management mutates file-backed transcript state. It has no
        // session projection equivalent, so it is unavailable rather than
        // tenant-blind in hosted mode.
        if (isHostedSessionReadAuthority(authority)) {
          return c.json(
            { success: false, error: 'Conversation not found' },
            404,
          );
        }
        const { action, content } = getBody(c);
        const result = await ConversationManager.manageConversationContext(
          runtimeAgentKey(slug),
          conversationId,
          action,
          content,
          memoryAdapters,
        );
        return c.json(result);
      } catch (error: unknown) {
        return conversationRouteFailure(
          c,
          logger,
          'Failed to manage conversation context',
          error,
        );
      }
    },
  );

  // Get conversation token/stats
  app.get('/:slug/conversations/:conversationId/stats', async (c) => {
    try {
      const slug = param(c, 'slug');
      const conversationId = param(c, 'conversationId');
      const authority = authorityFor(c.req.raw);
      const data = await ConversationManager.getConversationStats(
        runtimeAgentKey(slug),
        conversationId,
        isHostedSessionReadAuthority(authority) ? new Map() : memoryAdapters,
        agentFixedTokens!,
        agentTools as any,
        configLoader as any,
        appConfig as any,
        modelCatalog,
        logger,
        sessionMessageReader
          ? (threadId: string) =>
              sessionMessageReader.readSessionUsage?.(threadId, authority)
          : undefined,
        resolveContextWindowTokens,
      );
      const response = parseConversationStatsResponse(data);
      if (!response) throw new Error('Conversation stats response was invalid');
      return c.json({ success: true, data: response });
    } catch (error: unknown) {
      return conversationRouteFailure(
        c,
        logger,
        'Failed to get conversation stats',
        error,
      );
    }
  });

  return app;
}

/**
 * Global conversation lookup — resolves a conversation ID across all agents/projects.
 */
export function createGlobalConversationRoutes(
  memoryAdapters: Map<string, FileMemoryAdapter>,
  storageAdapter: { getConversation(id: string): ConversationRecord | null },
  logger: Logger,
  _createMemoryAdapter: ((slug: string) => FileMemoryAdapter) | undefined,
  sessionConversationReader: Pick<
    SessionMessageReader,
    'readSessionConversation' | 'searchSessionMessages'
  > & {
    listConversationHistoryPage(
      authority: SessionReadAuthority,
      options: { limit: number; cursor?: string },
    ): Promise<{
      items: ConversationListItem[];
      hasMore: boolean;
      nextCursor?: string;
    }>;
    conversationOpenResolver?: {
      resolve(input: {
        conversation: ConversationListItem;
        authority: SessionReadAuthority;
      }): Promise<ConversationOpenResolution>;
    };
  },
  getUserId: () => string = () => getCachedUser().alias,
  acknowledgementStore?: ConversationAcknowledgementStore,
  /** See `createConversationRoutes` for the request-scoped authority rule. */
  getSessionReadAuthority?: (request: Request) => SessionReadAuthority,
  eventStore?: {
    readConversationForkProvenance(conversationId: string): {
      forkedFrom?: ConversationForkProvenance;
      forkedTo: ConversationForkProvenance[];
    };
    readConversationForkProvenanceBatch?(
      conversationIds: readonly string[],
    ): Map<
      string,
      {
        forkedFrom?: ConversationForkProvenance;
        forkedTo: ConversationForkProvenance[];
      }
    >;
  },
  /** Remote peers report only their own server-authorized excerpts. */
  searchRemoteMessages?: (
    query: string,
    signal?: AbortSignal,
  ) => Promise<{
    matches: Array<{
      conversationId: string;
      messageId: string;
      sourceInstanceId?: string;
      sourceInstanceName?: string;
      role: 'user' | 'assistant';
      excerpt: string;
      projectSlug?: string;
      engine?: string;
      agentSlug?: string;
    }>;
    instances: Array<{
      instanceId: string;
      instanceName: string;
      status:
        | 'available'
        | 'empty'
        | 'authentication_required'
        | 'timed_out'
        | 'refused'
        | 'unreachable'
        | 'deferred';
    }>;
    deferredInstanceCount: number;
  }>,
) {
  const app = new Hono();
  const authorityFor =
    getSessionReadAuthority ?? createRequestAuthorityResolver(getUserId);

  app.get('/search', async (c) => {
    const parsed = messageSearchQuerySchema.safeParse({
      query: c.req.query('query'),
    });
    if (!parsed.success) {
      return c.json(
        {
          success: false,
          error: 'Search query must contain at least two characters',
        },
        400,
      );
    }
    const authority = authorityFor(c.req.raw);
    const localMatches =
      sessionConversationReader.searchSessionMessages?.(
        parsed.data.query,
        authority,
        20,
      ) ?? [];
    const remote = searchRemoteMessages
      ? await searchRemoteMessages(parsed.data.query, c.req.raw.signal)
      : { matches: [], instances: [], deferredInstanceCount: 0 };
    // The local index retains its established rank order. Remote rows are
    // independently capped before this final, cross-instance 20-hit cap.
    const matches = [...localMatches, ...remote.matches].slice(0, 20);
    const instances = [
      {
        instanceId: 'local',
        instanceName: 'This Station',
        status: localMatches.length > 0 ? 'available' : 'empty',
      },
      ...remote.instances,
    ];
    const partial = remote.instances.some(
      (instance) =>
        instance.status !== 'available' && instance.status !== 'empty',
    );
    conversationOps.add(1, {
      operation: 'message_search',
      outcome: partial ? 'partial' : matches.length > 0 ? 'available' : 'empty',
    });
    conversationMessageSearches.add(1, {
      outcome: partial ? 'partial' : matches.length > 0 ? 'available' : 'empty',
    });
    return c.json({
      success: true,
      data: matches.map((match) => ({
        ...match,
        ...(match.agentSlug
          ? { agentSlug: publicAgentIdFromRuntimeKey(match.agentSlug) }
          : {}),
      })),
      instances,
      deferredInstanceCount: remote.deferredInstanceCount,
    });
  });

  // Global conversation-inventory endpoint. Hosted requests read only the
  // cursor-paged, authority-scoped runtime index. Personal requests also
  // expose one bounded, stable compatibility page that combines local file
  // records with indexed runtime records; file stores have no shared cursor.
  app.get('/', async (c) => {
    try {
      const authority = authorityFor(c.req.raw);
      const userId = authority.userId;
      const hosted = isHostedSessionReadAuthority(authority);
      const pageQuery = conversationHistoryPageQuerySchema.safeParse({
        cursor: c.req.query('cursor'),
        limit: c.req.query('limit'),
      });
      if (!pageQuery.success) {
        return c.json(
          { success: false, error: 'Invalid conversation history page' },
          400,
        );
      }
      if (!hosted && pageQuery.data.cursor) {
        return c.json(
          {
            success: false,
            error: 'Personal history uses one compatibility page',
          },
          400,
        );
      }
      const historyPage =
        await sessionConversationReader.listConversationHistoryPage(
          authority,
          pageQuery.data,
        );
      conversationOps.add(1, {
        operation: 'history_page',
        outcome: historyPage.items.length > 0 ? 'available' : 'empty',
      });
      const sessionItems = historyPage.items.map((item) => ({
        ...item,
        agentSlug: publicAgentIdFromRuntimeKey(item.agentSlug),
      }));
      const storePage = hosted
        ? { items: [], hasMore: false }
        : await listPersonalFileConversationItems(
            memoryAdapters,
            userId,
            pageQuery.data.limit,
          );
      const byId = new Map(
        [...storePage.items, ...sessionItems].map((item) => [item.id, item]),
      );
      const combined = [...byId.values()]
        .sort(compareConversationRecency)
        .slice(0, pageQuery.data.limit);
      const provenanceById = eventStore?.readConversationForkProvenanceBatch?.(
        combined.map((item) => item.id),
      );
      const data = combined.map((item) => {
        const acknowledgedAt = acknowledgementStore?.get(userId, item.id);
        const forkProvenance =
          provenanceById?.get(item.id) ??
          eventStore?.readConversationForkProvenance(item.id);
        return {
          ...item,
          ...(acknowledgedAt ? { acknowledgedAt } : {}),
          ...(forkProvenance ? { forkProvenance } : {}),
        };
      });

      conversationOps.add(1, {
        operation: 'inventory_list',
        outcome: data.length > 0 ? 'available' : 'empty',
      });

      return c.json({
        success: true,
        data: {
          items: data,
          hasMore:
            historyPage.hasMore || storePage.hasMore || byId.size > data.length,
          ...(hosted && historyPage.nextCursor
            ? { nextCursor: historyPage.nextCursor }
            : {}),
        },
      });
    } catch (error: unknown) {
      return conversationRouteFailure(
        c,
        logger,
        'Failed to load conversation inventory',
        error,
      );
    }
  });

  // Store the exact inventory version that was rendered, rather than a
  // client-clock timestamp. A later provider turn is then unseen again
  // naturally (`updatedAt > acknowledgedAt`) across every surface/restart.
  app.post('/:id/acknowledgement', async (c) => {
    if (!acknowledgementStore) {
      return c.json(
        { success: false, error: 'Acknowledgements unavailable' },
        503,
      );
    }
    const conversationId = c.req.param('id');
    const authority = authorityFor(c.req.raw);

    // Acknowledgements are persisted state too. In hosted mode they are only
    // meaningful for a session the central policy admits; do that check before
    // parsing or writing an acknowledgement so a guessed file conversation
    // remains indistinguishable from one that does not exist.
    if (isHostedSessionReadAuthority(authority)) {
      const sessionConversation =
        authority.tenantExecutionContext && sessionConversationReader
          ? await sessionConversationReader.readSessionConversation(
              conversationId,
              authority,
            )
          : null;
      if (!sessionConversation) {
        return c.json({ success: false, error: 'Conversation not found' }, 404);
      }
    }
    const body = await c.req.json().catch(() => null);
    const updatedAt =
      body && typeof body === 'object' && typeof body.updatedAt === 'string'
        ? body.updatedAt
        : undefined;
    const parsedUpdatedAt = updatedAt ? Date.parse(updatedAt) : Number.NaN;
    if (
      !conversationId ||
      conversationId.length > 512 ||
      !updatedAt ||
      !Number.isFinite(parsedUpdatedAt)
    ) {
      return c.json(
        { success: false, error: 'A valid updatedAt is required' },
        400,
      );
    }
    acknowledgementStore.acknowledge({
      userId: getUserId(),
      conversationId,
      updatedAt: new Date(parsedUpdatedAt).toISOString(),
    });
    return c.json({ success: true });
  });

  // Resolve a picker row before a tab exists.  This keeps discovery,
  // lineage/current-child selection, transcript, and recovery under one
  // request-derived authority rather than producing an inventory success and
  // a later Session 404 that the client can accidentally make writable.
  app.get('/:id/open', async (c) => {
    try {
      const id = parseConversationIdSegment(param(c, 'id'));
      if (!id)
        return c.json(
          { success: false, error: 'Invalid conversation identity' },
          400,
        );
      const authority = authorityFor(c.req.raw);
      const runtimePage =
        await sessionConversationReader.listConversationHistoryPage(authority, {
          limit: 100,
        });
      const runtime = runtimePage.items.find((item) => item.id === id);
      if (runtime && sessionConversationReader.conversationOpenResolver) {
        return c.json({
          success: true,
          data: await sessionConversationReader.conversationOpenResolver.resolve(
            {
              conversation: runtime,
              authority,
            },
          ),
        });
      }
      if (!isHostedSessionReadAuthority(authority)) {
        for (const [slug, adapter] of memoryAdapters) {
          const record = await adapter.getConversation(id);
          if (!record) continue;
          const messages = await adapter.getMessages(record.userId, record.id);
          const metadata =
            record.metadata &&
            typeof record.metadata === 'object' &&
            !Array.isArray(record.metadata)
              ? (record.metadata as Record<string, unknown>)
              : undefined;
          const conversation: ConversationListItem = {
            id: record.id,
            source: 'store',
            agentSlug: publicAgentIdFromRuntimeKey(record.resourceId || slug),
            ...(typeof metadata?.projectSlug === 'string'
              ? { projectSlug: metadata.projectSlug }
              : {}),
            title: record.title,
            createdAt: record.createdAt,
            updatedAt: record.updatedAt,
            messageCount: messages.length,
            mutable: true,
            answerability: { answerable: true },
          };
          const resolution: ConversationOpenResolution = {
            status: 'transcript-only',
            conversation,
            transcript: { available: true, owner: 'store', messages },
            canContinue: false,
            answerability: conversation.answerability,
            recoveryActions: ['retry', 'start-new'],
          };
          return c.json({ success: true, data: resolution });
        }
      }
      return c.json({ success: false, error: 'Conversation not found' }, 404);
    } catch (error) {
      return conversationRouteFailure(
        c,
        logger,
        'Failed to resolve conversation open state',
        error,
      );
    }
  });

  app.get('/:id', async (c) => {
    try {
      const id = param(c, 'id');
      const authority = authorityFor(c.req.raw);
      const hosted = isHostedSessionReadAuthority(authority);

      // Try project storage first (has projectId/projectSlug)
      const projectRecord = hosted ? null : storageAdapter.getConversation(id);
      if (projectRecord) {
        return c.json({
          success: true,
          data: {
            ...projectRecord,
            agentSlug: publicAgentIdFromRuntimeKey(projectRecord.agentSlug),
            ...(eventStore
              ? {
                  forkProvenance: eventStore.readConversationForkProvenance(id),
                }
              : {}),
          },
        });
      }

      // Fall back to scanning memory adapters.
      //
      // archive#801: the map key names the adapter that answered, not the agent that
      // owns the conversation — an adapter resolves conversations stored under
      // any agent, so with more than one agent registered this reported
      // whichever adapter happened to be iterated first. The dock reopens a
      // cold conversation with the slug returned here, so a mis-attributed
      // lookup relabels the transcript under an agent that never produced it
      // and sends the next turn to that agent's model. The record's own
      // `resourceId` (written by `ensureChatConversation`) is the owner.
      for (const [slug, adapter] of hosted ? [] : memoryAdapters) {
        const conv = await adapter.getConversation(id);
        if (conv) {
          return c.json({
            success: true,
            data: {
              id: conv.id,
              agentSlug: publicAgentIdFromRuntimeKey(conv.resourceId || slug),
              title: conv.title,
              ...(eventStore
                ? {
                    forkProvenance:
                      eventStore.readConversationForkProvenance(id),
                  }
                : {}),
            },
          });
        }
      }

      const sessionConversation =
        await sessionConversationReader?.readSessionConversation(id, authority);
      if (sessionConversation) {
        conversationOps.add(1, {
          operation: 'history_lookup',
          source: 'orchestration',
          outcome: 'found',
        });
        return c.json({
          success: true,
          data: {
            ...sessionConversation,
            agentSlug: publicAgentIdFromRuntimeKey(
              sessionConversation.agentSlug,
            ),
            ...(eventStore
              ? {
                  forkProvenance: eventStore.readConversationForkProvenance(id),
                }
              : {}),
          },
        });
      }

      conversationOps.add(1, {
        operation: 'history_lookup',
        source: 'all',
        outcome: 'not_found',
      });
      return c.json({ success: false, error: 'Conversation not found' }, 404);
    } catch (error: unknown) {
      return conversationRouteFailure(
        c,
        logger,
        'Failed to lookup conversation',
        error,
      );
    }
  });

  return app;
}
