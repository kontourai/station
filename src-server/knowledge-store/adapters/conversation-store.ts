/**
 * `conversation-store` — a read-only K2 `KnowledgeStoreAdapter` projecting
 * Station's own conversation history (the orchestration session read-model
 * union the per-agent file memory store) into the `root:conversations` root,
 * so the K3 index and the `station knowledge search`/`search_knowledge`
 * surfaces cover past conversations exactly like any other knowledge root
 * (archive#1879).
 *
 * Unlike `default-store.ts`/`obsidian-store.ts`, this adapter never reads or
 * writes a Kit-format file tree at `options.storeRoot` — its canonical source
 * is two already-existing Station read seams, reached through the narrow
 * structural dependencies below rather than a filesystem path:
 *
 *   1. `ConversationSessionReader` — satisfied by `OrchestrationService`
 *      (`listSessionReadModel`/`SessionQueryModule`):
 *      native-SDK (Claude/Codex) and ACP-connected sessions, persisted in
 *      `{dataDir}/data/orchestration.sqlite`.
 *   2. `ConversationFileStoreReader` — satisfied by each registered
 *      `FileMemoryAdapter` (`getConversations`/`getMessages`): managed-runtime
 *      conversations persisted under `{dataDir}/agents/<slug>/memory/`.
 *
 * Both legs and their fold/dedupe precedence deliberately mirror the
 * authoritative precedent, `routes/chat/conversations.ts`'s global
 * `GET /api/conversations` route (`:497-560`): union both legs, dedupe by id
 * with the SESSION leg winning a collision. One deliberate divergence from
 * that route: enumeration here uses `listSessionReadModel` directly, never
 * `listAllSessionConversations`'s `CONVERSATION_HISTORY_MAX_ENTRIES`-capped
 * read — a knowledge index that silently dropped older conversations past an
 * arbitrary cap would be a much worse failure mode (an invisible recall gap)
 * than the cost of enumerating uncapped. Caching/incremental rebuild for that
 * uncapped walk is an explicit, disclosed non-goal (plan Stop-short risk R3),
 * not an oversight.
 *
 * Known cost multipliers on that same uncapped walk (review finding, disclosed
 * rather than silently absorbed; both bounded in exposure by reindex being
 * explicit-only):
 *   - Each session-leg record makes one full event-store read of its thread.
 *     `SessionQueryModule` derives the conversation projection and message body
 *     from that same ordered replay, so this adapter cannot drift from the
 *     native conversation projection or add an independent body replay.
 *   - `KitRecord.body` is the full joined message text with no truncation: a
 *     long-running thread (a 13k+-event thread exists in live dogfood homes)
 *     produces a proportionally large body, chunk count, and embed batch
 *     during `rebuildRoot`.
 *
 * Read-only, all the way down: every one of the eight mutation verbs throws
 * `ReadOnlyStoreError` (`READ_ONLY`, `../errors.js`) — this projection never
 * writes to the orchestration store, a file memory store, or anywhere else.
 * `knowledge-record-routes.ts`'s 405 mapping (W1) is what a caller reaching
 * this adapter through the generic record-routes HTTP surface observes.
 */
import type {
  ApplyEvidence,
  CreateInput,
  KitLink,
  KitRecord,
  KitRecordType,
  KitReverseLink,
  KnowledgeAdapterDescriptor,
  KnowledgeStoreAdapter,
  LinkEvidence,
  ProposeEvidence,
  RejectEvidence,
  RetireEvidence,
  SupersedeEvidence,
  UpdateEvidence,
  UpdateFields,
} from '@kontourai/station-contracts/knowledge-store';
import {
  type SessionReadAuthority,
  sessionReadAuthorityFromRequest,
} from '@kontourai/station-contracts/tenancy';
import { publicAgentIdFromRuntimeKey } from '../../routes/agents/runtime-agent-identity.js';
import type { SessionQueryModule } from '../../services/orchestration/session-query-module.js';
import { conversationStoreReadOps } from '../../telemetry/metrics.js';
import { ReadOnlyStoreError } from '../errors.js';

/** Adapter/root identifiers — `rename:inventory`-clean, station-only names. */
export const CONVERSATION_STORE_ADAPTER_ID = 'conversation-store';
export const CONVERSATION_ROOT_ID = 'root:conversations';

/** Every derived record lands under this single, flat category — conversations
 * have no natural subcategory hierarchy the way meeting-notes' `cooking.baking`
 * style categories do, so `listByCategory`'s `prefix` option is a no-op here. */
const CONVERSATION_CATEGORY = 'conversation';

/** `KitProvenance.agent` for every record this adapter derives — identifies the
 * derivation, not a real Station agent that "wrote" a knowledge record. */
const CONVERSATION_PROVENANCE_AGENT = 'station.conversation-store';

/**
 * The narrow slice of `OrchestrationService` this adapter needs — satisfied
 * structurally, never imported directly, so this module stays decoupled from
 * the (much larger) orchestration service/contract surface. Return shapes are
 * copied field-for-field from the real methods
 * (`orchestration-service.ts`'s list read-model plus `SessionQueryModule`).
 */
export interface ConversationSessionReader {
  /** Uncapped by contract — see the module doc's R3 note. */
  listSessionReadModel(
    authority: SessionReadAuthority,
  ): Promise<Array<{ threadId: string; assignedAgentSlug?: string }>>;
  sessionQueries: SessionQueryModule;
}

/** One file-store conversation record — field-for-field the same shape
 * `@voltagent/core`'s `Conversation` type already carries (`memory-adapter.ts`). */
export interface ConversationFileStoreConversation {
  id: string;
  resourceId: string;
  userId: string;
  title: string;
  metadata?: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * The narrow slice of `FileMemoryAdapter` this adapter needs, one instance per
 * registered agent slug (mirrors `conversations.ts`'s `memoryAdapters: Map<string,
 * FileMemoryAdapter>` param exactly, `:497-543`). `getMessages` is intentionally
 * `unknown[]` — the real adapter's own return type is untyped (`any[]`, VoltAgent's
 * `UIMessage`-ish shape), so every message read here goes through defensive
 * extraction (`extractMessageText`) rather than trusting a shape.
 */
export interface ConversationFileStoreReader {
  getConversations(
    resourceId: string,
  ): Promise<ConversationFileStoreConversation[]>;
  getMessages(userId: string, conversationId: string): Promise<unknown[]>;
}

export interface ConversationStoreAdapterDeps {
  sessionReader: ConversationSessionReader;
  /** Keyed by agent slug, same map `station-runtime.ts` already owns as `this.memoryAdapters`. */
  fileStores: Map<string, ConversationFileStoreReader>;
  /** Mirrors `conversations.ts`'s own default (`() => getCachedUser().alias`) — a
   * getter, not a resolved value, so every read call sees the current caller. */
  getUserId: () => string | undefined;
  /** Request-scoped authority getter. Do not resolve this during adapter
   * construction: adapter descriptors are process singletons. */
  getReadAuthority?: () => SessionReadAuthority;
}

function readAuthority(
  deps: ConversationStoreAdapterDeps,
): SessionReadAuthority {
  return (
    deps.getReadAuthority?.() ??
    sessionReadAuthorityFromRequest(
      deps.getUserId() ?? '',
      undefined,
      undefined,
    )
  );
}

/** Defensive text extraction (mirrors `memory-adapter-prompt-view.ts`'s
 * `messageTextParts`): join every `type: 'text'` part's `text`, or fall back to a
 * bare string `content` field for a message shape without `parts` at all. Any
 * other shape — no `parts`, no string `content` — yields `''` and is skipped by
 * `conversationBody`, never thrown. */
function extractMessageText(message: unknown): string {
  const parts = (message as { parts?: unknown } | undefined)?.parts;
  if (Array.isArray(parts)) {
    const texts: string[] = [];
    for (const part of parts) {
      if (
        part &&
        typeof part === 'object' &&
        (part as { type?: unknown }).type === 'text' &&
        typeof (part as { text?: unknown }).text === 'string'
      ) {
        texts.push((part as { text: string }).text);
      }
    }
    return texts.join('\n\n').trim();
  }
  const content = (message as { content?: unknown } | undefined)?.content;
  return typeof content === 'string' ? content.trim() : '';
}

function messageRole(message: unknown): string | undefined {
  const role = (message as { role?: unknown } | undefined)?.role;
  return typeof role === 'string' ? role : undefined;
}

/** '### User' / '### <agentSlug>' per the plan — 'System' for the one other role
 * `ConversationMessage`/file-store rows carry. Heading boundaries line up with
 * `chunkKnowledgeText`'s markdown-heading-first split (`knowledge-storage.ts`), so
 * a long conversation chunks per-turn rather than mid-sentence. */
function roleHeading(role: string, agentSlug: string): string {
  if (role === 'user') return 'User';
  if (role === 'system') return 'System';
  return agentSlug;
}

function conversationBody(messages: unknown[], agentSlug: string): string {
  const sections: string[] = [];
  for (const message of messages) {
    const role = messageRole(message);
    if (!role) continue;
    const text = extractMessageText(message);
    if (!text) continue;
    sections.push(`### ${roleHeading(role, agentSlug)}\n\n${text}`);
  }
  return sections.join('\n\n');
}

function projectSlugFromMetadata(
  metadata: Record<string, unknown> | null | undefined,
): string | undefined {
  const value = metadata?.projectSlug;
  return typeof value === 'string' ? value : undefined;
}

function toKitRecord(input: {
  id: string;
  agentSlug: string;
  projectSlug?: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messages: unknown[];
}): KitRecord {
  return {
    id: input.id,
    type: 'raw',
    title: input.title,
    body: conversationBody(input.messages, input.agentSlug),
    category: CONVERSATION_CATEGORY,
    ...(input.projectSlug ? { tags: [input.projectSlug] } : {}),
    provenance: {
      agent: CONVERSATION_PROVENANCE_AGENT,
      session_id: input.id,
    },
    created_at: input.createdAt,
    updated_at: input.updatedAt,
  };
}

async function sessionLegRecords(
  sessionReader: ConversationSessionReader,
  authority: SessionReadAuthority,
): Promise<KitRecord[]> {
  const summaries = await sessionReader.listSessionReadModel(authority);
  const records: KitRecord[] = [];
  for (const summary of summaries) {
    if (summary.assignedAgentSlug === undefined) continue;
    const outcome = await sessionReader.sessionQueries.read(
      { type: 'conversation', threadId: summary.threadId },
      authority,
    );
    if (outcome.status === 'not-found') continue;
    if (outcome.status === 'unavailable') {
      throw new Error('Conversation session query is unavailable.');
    }
    records.push(
      toKitRecord({
        id: outcome.conversation.id,
        agentSlug: publicAgentIdFromRuntimeKey(outcome.conversation.agentSlug),
        projectSlug: outcome.conversation.projectSlug,
        title: outcome.conversation.title,
        createdAt: outcome.conversation.createdAt,
        updatedAt: outcome.conversation.updatedAt,
        messages: [...outcome.messages],
      }),
    );
  }
  return records;
}

async function fileLegRecords(
  fileStores: Map<string, ConversationFileStoreReader>,
): Promise<KitRecord[]> {
  const records: KitRecord[] = [];
  for (const [slug, adapter] of fileStores) {
    const conversations = await adapter.getConversations(slug);
    for (const conversation of conversations) {
      const messages = await adapter.getMessages(
        conversation.userId,
        conversation.id,
      );
      records.push(
        toKitRecord({
          id: conversation.id,
          agentSlug: publicAgentIdFromRuntimeKey(
            conversation.resourceId || slug,
          ),
          projectSlug: projectSlugFromMetadata(conversation.metadata),
          title: conversation.title,
          createdAt: conversation.createdAt,
          updatedAt: conversation.updatedAt,
          messages,
        }),
      );
    }
  }
  return records;
}

/** Fold both legs, uncapped, deduped by id — SESSION leg wins a collision (same
 * precedence `conversations.ts:558-560` already applies: `[...storeItems,
 * ...sessionItems]` into a `Map`, later entries overwrite earlier ones). */
async function allConversationRecords(
  deps: ConversationStoreAdapterDeps,
): Promise<KitRecord[]> {
  const authority = readAuthority(deps);
  // File-memory conversations do not carry a trusted tenant binding. They
  // remain local-first data, but are never an implicit hosted authorization.
  const fileRecords =
    authority.mode === 'hosted' ? [] : await fileLegRecords(deps.fileStores);
  const sessionRecords = await sessionLegRecords(deps.sessionReader, authority);
  if (authority.mode !== 'hosted') {
    conversationStoreReadOps.add(1, { op: 'list', leg: 'file' });
  }
  conversationStoreReadOps.add(1, { op: 'list', leg: 'session' });
  const byId = new Map<string, KitRecord>();
  for (const record of fileRecords) byId.set(record.id, record);
  for (const record of sessionRecords) byId.set(record.id, record);
  return [...byId.values()];
}

/** Exact-id lookup only (no alias/prefix resolution — Addendum H is out of scope
 * here, same narrowing `knowledge-record-routes.ts`'s module doc already states
 * for its own `GET .../records/:id`). Session leg first (a cheap, ACL-checked,
 * direct-by-id query that makes absent and denied sessions indistinguishable),
 * file leg as fallback. */
async function getConversationRecord(
  deps: ConversationStoreAdapterDeps,
  id: string,
): Promise<KitRecord | null> {
  const authority = readAuthority(deps);

  const outcome = await deps.sessionReader.sessionQueries.read(
    { type: 'conversation', threadId: id },
    authority,
  );
  if (outcome.status === 'unavailable') {
    throw new Error('Conversation session query is unavailable.');
  }
  if (outcome.status === 'found') {
    conversationStoreReadOps.add(1, { op: 'get', leg: 'session' });
    return toKitRecord({
      id: outcome.conversation.id,
      agentSlug: publicAgentIdFromRuntimeKey(outcome.conversation.agentSlug),
      projectSlug: outcome.conversation.projectSlug,
      title: outcome.conversation.title,
      createdAt: outcome.conversation.createdAt,
      updatedAt: outcome.conversation.updatedAt,
      messages: [...outcome.messages],
    });
  }

  // A direct id must not probe an unbound file-memory conversation in hosted
  // mode. The session leg above already returns null non-enumeratingly.
  if (authority.mode === 'hosted') {
    conversationStoreReadOps.add(1, { op: 'get', leg: 'none' });
    return null;
  }

  for (const [slug, adapter] of deps.fileStores) {
    const conversations = await adapter.getConversations(slug);
    const conversation = conversations.find((c) => c.id === id);
    if (!conversation) continue;
    const messages = await adapter.getMessages(
      conversation.userId,
      conversation.id,
    );
    conversationStoreReadOps.add(1, { op: 'get', leg: 'file' });
    return toKitRecord({
      id: conversation.id,
      agentSlug: publicAgentIdFromRuntimeKey(conversation.resourceId || slug),
      projectSlug: projectSlugFromMetadata(conversation.metadata),
      title: conversation.title,
      createdAt: conversation.createdAt,
      updatedAt: conversation.updatedAt,
      messages,
    });
  }

  conversationStoreReadOps.add(1, { op: 'get', leg: 'none' });
  return null;
}

function rejectMutation(op: string): never {
  conversationStoreReadOps.add(1, { op, outcome: 'read_only_rejected' });
  throw new ReadOnlyStoreError(op);
}

class ConversationStoreAdapter implements KnowledgeStoreAdapter {
  constructor(private readonly deps: ConversationStoreAdapterDeps) {}

  async create(_record: CreateInput): Promise<string> {
    return rejectMutation('create');
  }

  async update(
    _id: string,
    _fields: UpdateFields,
    _evidence: UpdateEvidence,
  ): Promise<void> {
    rejectMutation('update');
  }

  async link(
    _sourceId: string,
    _links: KitLink[],
    _evidence: LinkEvidence,
  ): Promise<void> {
    rejectMutation('link');
  }

  async propose(
    _conceptId: string,
    _proposerId: string,
    _evidence: ProposeEvidence,
  ): Promise<void> {
    rejectMutation('propose');
  }

  async apply(
    _conceptId: string,
    _proposerId: string,
    _evidence: ApplyEvidence,
  ): Promise<void> {
    rejectMutation('apply');
  }

  async reject(
    _conceptId: string,
    _proposerId: string,
    _evidence: RejectEvidence,
  ): Promise<void> {
    rejectMutation('reject');
  }

  async supersede(
    _newId: string,
    _supersededIds: string[],
    _evidence: SupersedeEvidence,
  ): Promise<void> {
    rejectMutation('supersede');
  }

  async retire(
    _id: string,
    _targetStatus: 'implemented' | 'retired',
    _evidence: RetireEvidence,
  ): Promise<void> {
    rejectMutation('retire');
  }

  async get(idOrHandle: string): Promise<KitRecord | null> {
    return getConversationRecord(this.deps, idOrHandle);
  }

  async getLinks(
    _idOrHandle: string,
  ): Promise<{ forward: KitLink[]; reverse: KitReverseLink[] }> {
    // Conversations carry no wikilink/provenance graph of their own — every
    // record is a leaf. Constant, no OTel: this is a cheap, always-empty stub,
    // not a real read against either leg.
    return { forward: [], reverse: [] };
  }

  async listByCategory(
    category: string,
    _options?: { prefix?: boolean; includeRetired?: boolean },
  ): Promise<KitRecord[]> {
    if (category !== CONVERSATION_CATEGORY) return [];
    return allConversationRecords(this.deps);
  }

  async listByType(
    type: KitRecordType,
    _options?: { includeRetired?: boolean },
  ): Promise<KitRecord[]> {
    if (type !== 'raw') return [];
    return allConversationRecords(this.deps);
  }
}

/**
 * `options.storeRoot` is accepted for `KnowledgeAdapterDescriptor` contract
 * conformance but unused — see the module doc for why (this adapter's canonical
 * source is `deps`, never a filesystem tree). `conversation-root-bootstrap.ts`
 * still records a documentary `storeRoot` (the orchestration database path) on
 * the registered `KnowledgeStoreRoot` so `Settings`/CLI listings show a
 * meaningful location string, even though this `create` never reads it.
 */
export function createConversationStoreAdapterDescriptor(
  deps: ConversationStoreAdapterDeps,
): KnowledgeAdapterDescriptor {
  return {
    id: CONVERSATION_STORE_ADAPTER_ID,
    displayName: 'Conversation history',
    create: async () => new ConversationStoreAdapter(deps),
  };
}
