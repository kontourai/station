import { setImmediate as yieldToEventLoop } from 'node:timers/promises';
import type {
  ConversationListItem,
  ConversationTurnActivity,
} from '@kontourai/station-contracts/orchestration';
import type { SessionReadAuthority } from '@kontourai/station-contracts/tenancy';
import type { ProviderSession } from '../../providers/adapter-shape.js';
import { resolveHomeDir } from '../../utils/paths.js';
import { publicAgentIdFromRuntimeKey } from '../agents/runtime-agent-identity.js';
import { derivedConversationTitle } from './conversation-title.js';
import type { ConversationHistoryCursor, EventStore } from './event-store.js';
import { buildOrchestrationSessionSummary } from './orchestration-session-state.js';

const CONVERSATION_HISTORY_PAGE_MAX = 100;

export interface ConversationHistoryPage {
  items: ConversationListItem[];
  hasMore: boolean;
  nextCursor?: string;
}

interface ConversationHistoryRecordPage {
  records: ReturnType<EventStore['listConversationHistoryPage']>['records'];
  hasMore: boolean;
  nextCursor?: string;
}

function conversationProjectionKey(item: ConversationListItem): string {
  return JSON.stringify([item.environmentId ?? '', item.id]);
}

/** Keep the newest child Session for each Environment-owned conversation. */
export function deduplicateConversationItems(
  items: ConversationListItem[],
): ConversationListItem[] {
  const byConversation = new Map<string, ConversationListItem>();
  for (const item of items) {
    const key = conversationProjectionKey(item);
    const current = byConversation.get(key);
    if (!current || item.updatedAt > current.updatedAt) {
      byConversation.set(key, item);
    }
  }
  return [...byConversation.values()].sort((left, right) =>
    right.updatedAt.localeCompare(left.updatedAt),
  );
}

export class ConversationHistoryReadService {
  constructor(
    private readonly options: {
      readDurabilityProfile?: Parameters<
        typeof buildOrchestrationSessionSummary
      >[0]['readDurabilityProfile'];
      eventStore: EventStore;
      ownerUserIdsFor?: (authority: SessionReadAuthority) => readonly string[];
      canReadSession: (
        threadId: string,
        authority: SessionReadAuthority,
      ) => boolean;
      hydratePersistedSession: (
        threadId: string,
      ) => ProviderSession | undefined;
      loadedSessionForThread: (threadId: string) => ProviderSession | undefined;
      observeAnswerability: (
        threadId: string,
        provider: string | undefined,
        observedAt: string,
      ) => Parameters<
        typeof buildOrchestrationSessionSummary
      >[0]['answerability'];
      /**
       * #2309: the conversation activity projection. When it answers, the
       * item's `hasActiveTurn` is ITS open turn — a conversation-wide fold
       * over every committed event, not the 1,000-event tail below, which
       * reads a turn with more events than that as not running.
       */
      readConversationActivity?: (
        conversationId: string,
      ) => ConversationTurnActivity | undefined;
    },
  ) {}

  readPage(input: {
    authority: SessionReadAuthority;
    limit: number;
    cursor?: string;
    agentSlug?: string;
  }): ConversationHistoryRecordPage {
    if (input.limit < 1 || input.limit > CONVERSATION_HISTORY_PAGE_MAX) {
      throw new Error('Conversation history page limit is invalid');
    }
    const upgrade = this.options.eventStore.readConversationHistoryUpgrade();
    if (upgrade.status !== 'complete') {
      throw new Error('Conversation history upgrade is incomplete');
    }
    const tenantId =
      input.authority.mode === 'hosted'
        ? input.authority.tenantExecutionContext?.tenantId
        : undefined;
    if (input.authority.mode === 'hosted' && !tenantId) {
      return { records: [], hasMore: false };
    }
    const ownerUserIds =
      input.authority.mode === 'personal'
        ? this.options.ownerUserIdsFor?.(input.authority)
        : undefined;
    const page = this.options.eventStore.listConversationHistoryPage({
      ownerUserId: input.authority.userId,
      ...(ownerUserIds ? { ownerUserIds } : {}),
      ...(tenantId ? { tenantId } : {}),
      ...(input.agentSlug ? { agentSlug: input.agentSlug } : {}),
      ...(input.authority.mode === 'hosted' ? { requireBound: true } : {}),
      limit: input.limit,
      ...(input.cursor ? { cursor: decodeCursor(input.cursor) } : {}),
    });
    const records = page.records.filter((record) => {
      this.options.hydratePersistedSession(record.threadId);
      return this.options.canReadSession(record.threadId, input.authority);
    });
    return {
      records,
      hasMore: page.hasMore,
      ...(page.hasMore && page.nextCursor
        ? { nextCursor: encodeCursor(page.nextCursor) }
        : {}),
    };
  }

  async list(input: {
    authority: SessionReadAuthority;
    limit: number;
    cursor?: string;
    agentSlug?: string;
  }): Promise<ConversationHistoryPage> {
    const page = this.readPage(input);
    const observedAt = new Date().toISOString();
    const ownedWorkByThread = this.options.eventStore.ownedSessionActivities(
      page.records.map((record) => record.threadId),
    );
    // One read for the page, not one per row.
    const executionProviders =
      this.options.eventStore.readConversationExecutionProviders(
        page.records.map((record) => record.conversationId),
      );
    // #5092: admit the runtime home once per request, and only if some row
    // asks; per row, each summary repeated the admission filesystem walk.
    // Never kept across requests (the #5050 reader pattern).
    let stationHome: string | undefined;
    const readStationHome = () => (stationHome ??= resolveHomeDir());
    const sessionItems: Array<{
      threadId: string;
      item: ConversationListItem;
    }> = [];
    for (const record of page.records) {
      // A page can contain many independently expensive synchronous event folds.
      await yieldToEventLoop();
      if (!this.options.canReadSession(record.threadId, input.authority))
        continue;
      const persisted = this.options.eventStore.readSessionByThread(
        record.threadId,
      );
      const loaded = this.options.loadedSessionForThread(record.threadId);
      if (!persisted && !loaded) continue;
      const events = this.options.eventStore.listRecentEventsByThread(
        record.threadId,
        1_000,
      );
      const summary = buildOrchestrationSessionSummary({
        readOwnedWork: (threadId) => ownedWorkByThread.get(threadId),
        readDurabilityProfile: this.options.readDurabilityProfile,
        persisted,
        loaded,
        events: events.map((event) => event.payload),
        eventCount: this.options.eventStore.countEventsByThread(
          record.threadId,
        ),
        readStationHome,
        answerability: this.options.observeAnswerability(
          record.threadId,
          (loaded ?? persisted)?.provider,
          observedAt,
        ),
      });
      const delegationTitle = derivedConversationTitle(
        summary.delegation?.title,
      );
      const item: ConversationListItem = {
        id: record.conversationId,
        source: 'runtime',
        // A personal pre-agent record is authorized before it reaches this
        // projection; Station is its explicit compatibility presentation.
        agentSlug: publicAgentIdFromRuntimeKey(record.agentSlug ?? 'station'),
        title: delegationTitle ?? record.title,
        // #4266: where the title came from, so a client can tell a
        // generated or start-supplied title from a prompt-derived one.
        ...(delegationTitle
          ? { titleSource: 'provider' as const }
          : record.titleSource
            ? { titleSource: record.titleSource }
            : {}),
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
        messageCount: record.messageCount,
        mutable: false,
        answerability: summary.answerability,
        controlMode: summary.controlMode,
        provider: summary.provider,
      };
      const model =
        summary.reportedModel ?? summary.effectiveModel ?? summary.model;
      if (model) item.model = model;
      const acceptedModel =
        this.options.eventStore.readLatestAcceptedConversationModel({
          conversationId: item.id,
          environmentId: record.environmentId,
        });
      if (acceptedModel) item.acceptedModel = acceptedModel;
      if (record.environmentId) item.environmentId = record.environmentId;
      if (summary.projectSlug) item.projectSlug = summary.projectSlug;
      if (summary.lifecycleState) item.lifecycleState = summary.lifecycleState;
      if (summary.lifecycleChangedAt)
        item.lifecycleChangedAt = summary.lifecycleChangedAt;
      const ran = executionProviders.get(record.conversationId);
      if (ran?.length) item.executionProviders = ran;
      if (summary.pendingReview !== undefined)
        item.pendingReview = summary.pendingReview;
      const activity = this.options.readConversationActivity?.(
        record.conversationId,
      );
      if (activity) {
        item.activity = activity;
        item.hasActiveTurn = activity.openTurn !== undefined;
      } else if (summary.hasActiveTurn !== undefined)
        item.hasActiveTurn = summary.hasActiveTurn;
      sessionItems.push({ threadId: record.threadId, item });
    }
    const items = deduplicateConversationItems(
      sessionItems
        .filter(({ threadId }) =>
          this.options.canReadSession(threadId, input.authority),
        )
        .map(({ item }) => item),
    );
    return {
      items,
      hasMore: page.hasMore,
      ...(page.hasMore && page.nextCursor
        ? { nextCursor: page.nextCursor }
        : {}),
    };
  }
}

function encodeCursor(cursor: ConversationHistoryCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

function decodeCursor(value: string): ConversationHistoryCursor {
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      typeof parsed.updatedAt !== 'string' ||
      typeof parsed.threadId !== 'string' ||
      Number.isNaN(Date.parse(parsed.updatedAt)) ||
      parsed.threadId.length === 0 ||
      parsed.threadId.length > 512
    ) {
      throw new Error('invalid');
    }
    return { updatedAt: parsed.updatedAt, threadId: parsed.threadId };
  } catch {
    throw new Error('Conversation history cursor is invalid');
  }
}
