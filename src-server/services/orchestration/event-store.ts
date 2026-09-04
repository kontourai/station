import {
  createHash,
  createHmac,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { isSupportedAgentIconToken } from '@kontourai/station-contracts/agent';
import {
  CHAT_ATTACHMENT_MAX_BYTES,
  CHAT_ATTACHMENT_MAX_COUNT,
  CHAT_ATTACHMENT_MAX_DATA_URL_LENGTH,
  CHAT_ATTACHMENT_MAX_NAME_LENGTH,
  CHAT_ATTACHMENT_MAX_SESSION_ENCODED_BYTES,
  CHAT_ATTACHMENT_MAX_STORE_ENCODED_BYTES,
  CHAT_ATTACHMENT_MAX_TOTAL_BYTES,
  type PersistedChatAttachment,
  parseChatAttachmentDataUrl,
  validateChatAttachments,
  validatePersistedChatAttachmentDescriptor,
} from '@kontourai/station-contracts/chat-attachment';
import { isClientOrigin } from '@kontourai/station-contracts/client-origin';
import type {
  ConnectionRecoveryIntent,
  ConnectionRecoveryOutcome,
  ConnectionRecoveryProjection,
} from '@kontourai/station-contracts/connection-recovery';
import type {
  OrchestrationCommandReceipt,
  RuntimeEventElisionReason,
} from '@kontourai/station-contracts/orchestration';
import {
  type ProviderSession,
  SESSION_AGENT_DISPLAY_NAME_MAX_LENGTH,
  SESSION_AGENT_DISPLAY_NAME_METADATA_KEY,
  SESSION_AGENT_ICON_METADATA_KEY,
} from '@kontourai/station-contracts/provider';
import type { RunSummary } from '@kontourai/station-contracts/runs';
import type { CanonicalRuntimeEvent } from '@kontourai/station-contracts/runtime-events';
import {
  parseSessionWorkItemAssociation,
  type SessionWorkItemAssociation,
} from '@kontourai/station-contracts/session-work-item';
import { parseTenantExecutionContext } from '@kontourai/station-contracts/tenancy';
import type { TurnProvenanceEnvelope } from '@kontourai/station-contracts/turn-provenance';
import {
  exactProcessIdentity,
  probeExactProcessIdentity,
} from '@kontourai/station-shared/process-identity';
import {
  corruptionMarkerFromError,
  recordCorruptionObserved,
} from '@kontourai/station-shared/sqlite-corruption-marker';
import { watchForSqliteCorruption } from '@kontourai/station-shared/sqlite-corruption-watch';
import { explicitCorruption } from '@kontourai/station-shared/sqlite-integrity';
import { CHAT_INPUT_MAX_CHARS } from '../../../src-shared/chat-input-limits.js';
import {
  canonicalPersistedRequestId,
  ensureCredentialApplicationCommitPendingIndex,
  ensureNativeInvocationRunColumns,
  ensureOrchestrationAdoptionColumns,
  ensureOrchestrationEventStoreColumns,
  ensureOrchestrationRecoverySettlementColumns,
  ensureOrchestrationSessionStateColumns,
  ensureOrchestrationTurnDedupColumns,
  ensureVoiceTurnRunColumns,
  ORCHESTRATION_EVENT_STORE_MIGRATION,
} from '../../domain/migrations/003-orchestration-events.js';
import { OPERATIONAL_EVENT_OUTBOX_MIGRATION } from '../../domain/migrations/004-operational-events.js';
import { PROJECT_TASK_ROOM_RUNTIME_MIGRATION } from '../../domain/migrations/006-project-task-room-runtime.js';
import { REVISION_EVIDENCE_RECEIPTS_MIGRATION } from '../../domain/migrations/007-revision-evidence-receipts.js';
import { PROJECT_TASK_ROOM_REVISION_PUBLICATION_MIGRATION } from '../../domain/migrations/008-project-task-room-revision-publication.js';
import { ensureProjectTaskRoomRevisionAttributionColumn } from '../../domain/migrations/009-project-task-room-revision-attribution.js';
import { CONVERSATION_SESSION_LINEAGE_MIGRATION } from '../../domain/migrations/010-conversation-session-lineage.js';
import {
  CONVERSATION_HANDOFF_MIGRATION,
  ensureConversationHandoffMessageDigestColumn,
} from '../../domain/migrations/011-conversation-handoffs.js';
import {
  CONVERSATION_CONTEXT_BOUNDARY_MIGRATION,
  ensureConversationContextBoundaryColumns,
} from '../../domain/migrations/012-conversation-context-boundaries.js';
import { SESSION_WORK_ITEM_ASSOCIATIONS_MIGRATION } from '../../domain/migrations/013-session-work-items.js';
import {
  type CanonicalProposedChangeLookup,
  type RevisionAttributionAuthority,
  RevisionEvidenceModule,
} from '../../domain/revision-bound-evidence.js';
import { PROVIDER_PROVEN_FINISH_REASONS } from '../../providers/finish-reason-authority.js';
import type { NativeOutputTerminalAdmission } from '../../runtime/native-output-declaration.js';
import {
  attachmentBytesStripped,
  conversationSessionLineageMutations,
  orchestrationEventPersistDuration,
  orchestrationEventsPersisted,
  orchestrationEventWindowElisions,
  orchestrationStoreCorruptionObserved,
} from '../../telemetry/metrics.js';
import { applyWalJournalMode } from '../../utils/sqlite-wal.js';
import {
  type OperationalEventConsumer,
  type OperationalEventConsumerConfig,
  type OperationalEventConsumerOpenOutcome,
  openOperationalEventConsumer,
} from '../operational-events/operational-event-delivery.js';
import {
  createOperationalEventOutbox,
  type OperationalEventNotificationAdapter,
  type OperationalEventPublisher,
  type OperationalEventReader,
} from '../operational-events/operational-event-outbox.js';
import {
  createOperationalEventSubscriptionRegistry,
  type OperationalEventSubscriptionAuthorizer,
  type OperationalEventSubscriptionCloseOutcome,
  type OperationalEventSubscriptionRegistry,
} from '../operational-events/operational-event-subscriptions.js';
import { createSqliteOperationalEventDeliveryCoordinator } from '../operational-events/sqlite-operational-event-delivery.js';
import { createSqliteOperationalEventCoordinator } from '../operational-events/sqlite-operational-event-outbox.js';
import {
  createPackageMcpAdmissionJournal as composePackageMcpAdmissionJournal,
  PACKAGE_MCP_ADMISSION_SCHEMA,
  type PackageMcpAdmissionJournal,
} from '../plugins/package-mcp-admission.js';
import {
  awaitTurnResolution,
  type TurnIdempotencyPersistence,
  type TurnIdempotencyProcessIdentity,
  type TurnIdempotencyRecord,
  TurnIdempotencyStore,
} from '../turn-idempotency.js';
import {
  AdoptionCommitFailure,
  type AdoptionLedger,
  type AdoptionLedgerCoordinator,
  type AdoptionReservation,
  createAdoptionLedger,
} from './adoption-ledger.js';
import {
  AttachmentBlobStore,
  isAttachmentBlobRef,
} from './attachment-blob-store.js';
import {
  ConversationContextBoundaryConflictError,
  type ConversationContextBoundaryMarker,
  type ConversationContextBoundaryModule,
  createConversationContextBoundaryModule,
} from './conversation-context-boundary-module.js';
import {
  ConversationHandoffConflictError,
  type ConversationHandoffMarker,
  type ConversationHandoffModule,
  createConversationHandoffModule,
} from './conversation-handoff-module.js';
import {
  type ConversationSessionLineage,
  ConversationSessionLineageConflictError,
  type ConversationSessionLineageModule,
  ConversationSessionLineageStructureError,
  createConversationSessionLineageModule,
  isSameConversationSessionLineage,
} from './conversation-session-lineage.js';
import {
  type CredentialApplicationHandle,
  createCredentialApplicationFactory,
} from './credential-application-ledger.js';
import {
  createNativeInvocationRuns,
  type NativeInvocationRunReader,
  type NativeInvocationStarter,
  releaseNativeInvocationOwner,
} from './native-invocation-runs.js';
import {
  clientOriginIdentity,
  projectionFactKeysForEvent,
} from './orchestration-session-state.js';
import {
  createProjectTaskRoomHistory,
  type ProjectTaskRoomAgentGrantAuthority,
  type ProjectTaskRoomCapabilityAuthority,
  type ProjectTaskRoomHistory,
  type ProjectTaskRoomLinkAuthority,
} from './project-task-room-history.js';
import {
  createProjectTaskRoomWorkingState,
  type ProjectTaskRoomWorkingState,
} from './project-task-room-working-state.js';
import {
  createRecoveryLedger,
  type RecoveryIntentInput,
  type RecoveryLedger,
  type RecoveryLedgerProcessIdentity,
  type RecoveryOwner,
  type RecoveryTransition,
  releaseRecoveryLedgerOwner,
} from './recovery-ledger.js';
import type {
  SessionBasisTurnDescriptorEvent,
  SessionBasisTurnDescriptorWindow,
} from './session-query-module.js';
import {
  createSessionTurnBoundaryAuthority,
  releaseSessionTurnBoundaryOwner,
  SESSION_TURN_ACCEPTED_CAPACITY,
  type SessionTurnBoundaryAuthority,
  type SessionTurnBoundaryCoordinator,
  type SessionTurnBoundaryRecord,
} from './session-turn-boundary.js';
import {
  createSessionWorkItemAdmissionRegistry,
  type SessionWorkItemAdmissionClaim,
  type SessionWorkItemAdmissionRegistry,
} from './session-work-item-admission.js';
import type { SessionWorkItemCandidate } from './session-work-item-candidate.js';
import { createSqliteRevisionEvidencePersistence } from './sqlite-revision-evidence-persistence.js';
import {
  MAX_TOOL_RESULT_DESCRIPTOR_ID_BYTES,
  MAX_TOOL_RESULT_DESCRIPTOR_LABEL_BYTES,
  MAX_TOOL_RESULT_DESCRIPTOR_OUTPUT_BYTES,
} from './thread-tool-result-adapter.js';
import {
  createTurnDeduplicator,
  type TurnDeduplicator,
} from './turn-deduplicator.js';
import {
  createVoiceTurnRuns,
  releaseVoiceTurnOwner,
  type VoiceTurnRuns,
  type VoiceTurnRunsReader,
} from './voice-turn-runs.js';
import {
  SESSION_WORK_ITEM_READ_MAX_OBSERVATIONS,
  SESSION_WORK_ITEM_READ_MAX_SERIALIZED_BYTES,
} from './work-item-result-projector.js';

const require = createRequire(import.meta.url);
const SQLITE_BUSY_TIMEOUT_MS = 5_000;
/** Last-resort ingress ceiling; upstream adapters own useful projection. */
export const MAX_EVENT_STORE_INGRESS_BYTES = 64 * 1024;
/**
 * Structural limits make the last-resort byte ceiling cheap to enforce even
 * when a provider hands the store an object that is merely *typed* as a
 * canonical event. These are deliberately generous relative to canonical
 * runtime events; adapters, not this persistence backstop, own useful
 * projection of arbitrary provider output.
 */
const MAX_EVENT_STORE_INGRESS_DEPTH = 32;
const MAX_EVENT_STORE_INGRESS_PROPERTIES = 512;
const MAX_EVENT_STORE_INGRESS_ARRAY_ITEMS = 512;
const MAX_UNACKNOWLEDGED_CREDENTIAL_APPLICATIONS = 64;
const MAX_BASIS_DESCRIPTOR_ROWS = 1_000;
const MAX_BASIS_DESCRIPTOR_BYTES = 128 * 1_024;
const MAX_BASIS_FINISH_REASON_BYTES = 128;
const MAX_BASIS_PROMPT_BYTES = 16 * 1_024;
const MAX_BASIS_OUTPUT_TEXT_BYTES = 64 * 1_024;
const MAX_BASIS_ATTACHMENT_NAME_BYTES = CHAT_ATTACHMENT_MAX_NAME_LENGTH * 4;
const MAX_BASIS_ATTACHMENT_MIME_BYTES = 128;
const MAX_BASIS_STATUS_BYTES = 16;
const MAX_BASIS_INPUT_KIND_BYTES = 16;
const MAX_SESSION_WORK_ITEM_ASSOCIATION_ROW_BYTES = 8 * 1024;

/** Descriptor-only row for the Session Outputs owner. No event payload crosses it. */
export interface DeclaredOutputDescriptorRow {
  declarationId: string;
  eventId: string;
  threadId: string;
  turnId: string;
  toolCallId: string;
  declaredAt: string;
  label?: string;
  /** Parsed only by the Outputs owner, which can surface typed corruption. */
  descriptor: unknown;
  sequence: number;
}

export type DeclaredOutputDescriptorPage = {
  rows: readonly DeclaredOutputDescriptorRow[];
  /** The frozen event sequence that makes a cursor restart-safe. */
  highWater: number;
  hasMore: boolean;
};

/** Store-authenticated continuation state for the metadata-only outputs view. */
export type DeclaredOutputCursor = {
  sessionId: string;
  authority: string;
  highWater: number;
  sequence: number;
  declarationId: string;
};

/** Store-authenticated cursor for a folded Session-inventory group. */
export type SessionInventoryCursor = {
  version: 'station.session-inventory/v1' | 'station.session-inventory/v2';
  sessionId: string;
  authority: string;
  scope: 'whole-session' | 'current-answer' | 'kept-in-task';
  turnId?: string;
  taskId?: string;
  groupId: string;
  /** The exact event-store sequence observed when the rowset was folded. */
  highWater: number;
  /** SHA-256 of the complete descriptor rowset through `highWater`. */
  contentDigest: string;
  position: number;
  pageSize?: number;
  pageStartSequence?: number;
  pageStartEventId?: string;
  nextSequence?: number;
  nextEventId?: string;
};

/**
 * The complete, deliberately narrow event vocabulary available to the
 * metadata-only Whole Session inventory.  It is not a projection-state read:
 * each matching historical event is retained, in sequence order, so a
 * multi-turn session cannot silently lose its earlier inputs, terminal tool
 * calls, decisions, or usage observations.
 */
const SESSION_INVENTORY_EVENT_METHODS = [
  'turn.started',
  'tool.completed',
  'request.resolved',
  'session.configured',
  'token-usage.updated',
] as const;

export type SessionInventoryEventRead = {
  /** Metadata-only descriptors. Canonical payloads never cross this seam. */
  events: readonly SessionInventoryEventDescriptor[];
  /** Session-wide high water; rows appended after this value are excluded. */
  highWater: number;
  continuation?: SessionInventoryEventPageCursor;
};

export type SessionInventoryEventPageCursor = {
  sequence: number;
  eventId: string;
};
export type SessionInventoryEventGroup =
  | 'inputs'
  | 'execution'
  | 'decisions'
  | 'resources';

export type SessionInventoryEventDescriptor =
  | {
      id: string;
      sequence: number;
      method: 'turn.started';
      turnId: string;
      inputKind?: 'steer';
      attachments: readonly {
        name: string;
        mediaType: string;
        length: number;
      }[];
    }
  | {
      id: string;
      sequence: number;
      method: 'tool.completed';
      turnId: string;
      toolCallId: string;
      name: string;
      terminalStatus: 'succeeded' | 'failed' | 'cancelled';
    }
  | {
      id: string;
      sequence: number;
      method: 'request.resolved';
      requestId: string;
      status: 'accepted' | 'declined' | 'cancelled' | 'pending';
    }
  | {
      id: string;
      sequence: number;
      method: 'session.configured';
      model?: string;
      engine?: string;
    }
  | {
      id: string;
      sequence: number;
      method: 'token-usage.updated';
      inputTokens?: number;
      outputTokens?: number;
      cachedTokens?: number;
      costMicros?: number;
    };

const SESSION_INVENTORY_EVENT_PAGE_MAX = 20;
const SESSION_INVENTORY_GROUP_METHODS: Readonly<
  Record<SessionInventoryEventGroup, readonly string[]>
> = {
  inputs: ['turn.started'],
  execution: ['tool.completed'],
  decisions: ['request.resolved'],
  resources: ['session.configured', 'token-usage.updated'],
};

function hasBoundedDescriptorText(
  value: unknown,
  maximum: number,
): value is string {
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > maximum)
    return false;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return false;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false;
    }
  }
  return true;
}

/** The descriptor query never materializes a window aggregate just to count. */
function measuredBasisDescriptorBytes(
  rows: readonly Record<string, unknown>[],
): number {
  const bytes = (value: unknown) =>
    typeof value === 'string' ? Buffer.byteLength(value, 'utf8') : 0;
  const seen = new Set<string>();
  let total = 0;
  for (const row of rows) {
    const id = typeof row.id === 'string' ? row.id : undefined;
    if (!id) return Number.POSITIVE_INFINITY;
    if (!seen.has(id)) {
      seen.add(id);
      total +=
        bytes(row.id) +
        bytes(row.thread_id) +
        bytes(row.turn_id) +
        bytes(row.method) +
        bytes(row.finish_reason) +
        bytes(row.prompt) +
        bytes(row.input_kind ?? 'initial') +
        bytes(row.tool_call_id) +
        bytes(row.tool_name) +
        bytes(row.tool_status) +
        bytes(row.tool_output) +
        bytes(row.tool_error) +
        (typeof row.output_text_bytes === 'number'
          ? row.output_text_bytes
          : 0) +
        bytes(String(row.sequence)) +
        (row.denied_type === 'true' ? 4 : 0);
    }
    total +=
      bytes(row.attachment_kind) +
      bytes(row.attachment_name) +
      bytes(row.attachment_mime) +
      bytes(String(row.attachment_size ?? ''));
    if (total > MAX_BASIS_DESCRIPTOR_BYTES) return total;
  }
  return total;
}

type EventStoreIngressJson =
  | null
  | boolean
  | number
  | string
  | EventStoreIngressJson[]
  | { [key: string]: EventStoreIngressJson };

/**
 * A deliberately tiny path state, not a general path matcher. The only
 * in-memory bytes EventStore may receive above its ordinary event ceiling are
 * the request attachment bytes at this exact canonical event path.
 */
type EventStoreIngressLocation =
  | 'ordinary'
  | 'event-root'
  | 'canonical-attachments'
  | 'canonical-attachment'
  | 'canonical-attachment-data-url';

class EventStoreIngressError extends Error {
  constructor(reason: string) {
    super(`Runtime event cannot be safely persisted by EventStore: ${reason}.`);
    this.name = 'EventStoreIngressError';
  }
}

function eventStoreIngressCeilingError(): EventStoreIngressError {
  return new EventStoreIngressError(
    `it exceeds the ${MAX_EVENT_STORE_INGRESS_BYTES}-byte ingress ceiling`,
  );
}

/**
 * A deliberately small JSON projector used before EventStore serializes a
 * runtime event. It counts the exact compact-JSON UTF-8 byte shape as it
 * walks, while reading only own data descriptors. Consequently an oversized,
 * cyclic, getter-backed, or hostile Proxy value is refused before
 * `JSON.stringify` could allocate its complete payload or invoke user code.
 */
class BoundedEventStoreIngressProjector {
  private bytes = 0;
  private readonly ancestors = new Set<object>();
  private attachmentBytes = 0;

  project(
    value: unknown,
    options: { allowCanonicalAttachmentDataUrls?: boolean } = {},
  ): EventStoreIngressJson {
    const location =
      options.allowCanonicalAttachmentDataUrls &&
      this.isCanonicalTurnStartedEvent(value)
        ? 'event-root'
        : 'ordinary';
    const projected = this.projectValue(value, 0, false, location);
    if (projected === undefined) {
      throw new EventStoreIngressError('the event root is not JSON data');
    }
    return projected;
  }

  private addBytes(bytes: number): void {
    this.bytes += bytes;
    if (this.bytes > MAX_EVENT_STORE_INGRESS_BYTES) {
      throw eventStoreIngressCeilingError();
    }
  }

  private addAscii(value: string): void {
    this.addBytes(value.length);
  }

  /** Count exactly what JSON.stringify emits for a string, without copying it. */
  private addJsonString(value: string): void {
    this.addBytes(2); // quotes
    for (let index = 0; index < value.length; index += 1) {
      const code = value.charCodeAt(index);
      if (code === 0x22 || code === 0x5c) {
        this.addBytes(2);
      } else if (
        code === 0x08 ||
        code === 0x09 ||
        code === 0x0a ||
        code === 0x0c ||
        code === 0x0d
      ) {
        this.addBytes(2);
      } else if (code < 0x20) {
        this.addBytes(6);
      } else if (code >= 0xd800 && code <= 0xdbff) {
        const next = value.charCodeAt(index + 1);
        if (next >= 0xdc00 && next <= 0xdfff) {
          this.addBytes(4);
          index += 1;
        } else {
          // JSON.stringify's well-formed JSON behaviour escapes lone surrogates.
          this.addBytes(6);
        }
      } else if (code >= 0xdc00 && code <= 0xdfff) {
        this.addBytes(6);
      } else if (code < 0x80) {
        this.addBytes(1);
      } else if (code < 0x800) {
        this.addBytes(2);
      } else {
        this.addBytes(3);
      }
    }
  }

  /**
   * This is intentionally descriptor-only. It decides whether the root can
   * receive the narrow attachment allowance without invoking a getter or
   * proxy-provided value read; the full traversal still validates everything.
   */
  private isCanonicalTurnStartedEvent(value: unknown): boolean {
    if (!value || typeof value !== 'object') return false;
    const method = this.ownDescriptor(value, 'method');
    return (
      !!method &&
      method.enumerable === true &&
      'value' in method &&
      method.value === 'turn.started'
    );
  }

  private acceptCanonicalAttachmentDataUrl(value: string): void {
    // parseChatAttachmentDataUrl owns both the data-URL grammar and the
    // encoded-length ceiling. Keep the explicit length branch so this seam's
    // failure remains clear even if that helper is refactored later.
    if (value.length > CHAT_ATTACHMENT_MAX_DATA_URL_LENGTH) {
      throw new EventStoreIngressError(
        `an attachment exceeds the ${CHAT_ATTACHMENT_MAX_BYTES}-byte limit`,
      );
    }
    const parsed = parseChatAttachmentDataUrl(value);
    if (!parsed || parsed.decodedBytes < 1) {
      throw new EventStoreIngressError('an attachment data URL is invalid');
    }
    if (parsed.decodedBytes > CHAT_ATTACHMENT_MAX_BYTES) {
      throw new EventStoreIngressError(
        `an attachment exceeds the ${CHAT_ATTACHMENT_MAX_BYTES}-byte limit`,
      );
    }
    this.attachmentBytes += parsed.decodedBytes;
    if (this.attachmentBytes > CHAT_ATTACHMENT_MAX_TOTAL_BYTES) {
      throw new EventStoreIngressError(
        `attachments exceed the ${CHAT_ATTACHMENT_MAX_TOTAL_BYTES}-byte combined limit`,
      );
    }
  }

  private projectValue(
    value: unknown,
    depth: number,
    inArray: boolean,
    location: EventStoreIngressLocation,
  ): EventStoreIngressJson | undefined {
    if (value === null) {
      this.addAscii('null');
      return null;
    }
    switch (typeof value) {
      case 'string':
        if (location === 'canonical-attachment-data-url') {
          this.acceptCanonicalAttachmentDataUrl(value);
        } else {
          this.addJsonString(value);
        }
        return value;
      case 'boolean':
        this.addAscii(value ? 'true' : 'false');
        return value;
      case 'number': {
        if (!Number.isFinite(value)) {
          this.addAscii('null');
          return null;
        }
        this.addAscii(String(value));
        return value;
      }
      case 'undefined':
      case 'function':
      case 'symbol':
        if (inArray) {
          this.addAscii('null');
          return null;
        }
        return undefined;
      case 'bigint':
        throw new EventStoreIngressError('it contains a bigint');
      case 'object':
        break;
      default:
        throw new EventStoreIngressError('it contains unsupported data');
    }

    if (depth >= MAX_EVENT_STORE_INGRESS_DEPTH) {
      throw new EventStoreIngressError('it exceeds the structural depth limit');
    }
    const object = value as object;
    if (this.ancestors.has(object)) {
      throw new EventStoreIngressError('it contains a cycle');
    }
    this.ancestors.add(object);
    try {
      let isArray: boolean;
      try {
        isArray = Array.isArray(object);
      } catch {
        throw new EventStoreIngressError('its array shape cannot be inspected');
      }
      return isArray
        ? this.projectArray(object, depth, location)
        : this.projectObject(object, depth, location);
    } finally {
      this.ancestors.delete(object);
    }
  }

  private ownDescriptor(
    object: object,
    key: string,
  ): PropertyDescriptor | undefined {
    try {
      return Object.getOwnPropertyDescriptor(object, key);
    } catch {
      throw new EventStoreIngressError(
        `its ${JSON.stringify(key)} property descriptor cannot be inspected`,
      );
    }
  }

  private projectArray(
    object: object,
    depth: number,
    location: EventStoreIngressLocation,
  ): EventStoreIngressJson[] {
    const lengthDescriptor = this.ownDescriptor(object, 'length');
    if (
      !lengthDescriptor ||
      !('value' in lengthDescriptor) ||
      !Number.isSafeInteger(lengthDescriptor.value) ||
      lengthDescriptor.value < 0
    ) {
      throw new EventStoreIngressError(
        'its array length is not safe JSON data',
      );
    }
    const length = lengthDescriptor.value;
    if (length > MAX_EVENT_STORE_INGRESS_ARRAY_ITEMS) {
      throw new EventStoreIngressError('it exceeds the structural array limit');
    }
    if (
      location === 'canonical-attachments' &&
      length > CHAT_ATTACHMENT_MAX_COUNT
    ) {
      throw new EventStoreIngressError(
        `it has more than ${CHAT_ATTACHMENT_MAX_COUNT} attachments`,
      );
    }
    const projected: EventStoreIngressJson[] = [];
    this.addAscii('[');
    for (let index = 0; index < length; index += 1) {
      if (index > 0) this.addAscii(',');
      const descriptor = this.ownDescriptor(object, String(index));
      if (descriptor && !('value' in descriptor)) {
        throw new EventStoreIngressError(
          `its ${JSON.stringify(String(index))} array item is an accessor`,
        );
      }
      projected.push(
        this.projectValue(
          descriptor?.value,
          depth + 1,
          true,
          location === 'canonical-attachments'
            ? 'canonical-attachment'
            : 'ordinary',
        ) ?? null,
      );
    }
    this.addAscii(']');
    return projected;
  }

  private projectObject(
    object: object,
    depth: number,
    location: EventStoreIngressLocation,
  ): { [key: string]: EventStoreIngressJson } {
    let keys: readonly PropertyKey[];
    try {
      keys = Reflect.ownKeys(object);
    } catch {
      throw new EventStoreIngressError('its own keys cannot be inspected');
    }
    if (keys.length > MAX_EVENT_STORE_INGRESS_PROPERTIES) {
      throw new EventStoreIngressError(
        'it exceeds the structural property limit',
      );
    }
    const projected: { [key: string]: EventStoreIngressJson } = {};
    let properties = 0;
    this.addAscii('{');
    for (const key of keys) {
      if (typeof key !== 'string') continue;
      const descriptor = this.ownDescriptor(object, key);
      if (!descriptor?.enumerable) continue;
      if (!('value' in descriptor)) {
        throw new EventStoreIngressError(
          `its ${JSON.stringify(key)} property is an accessor`,
        );
      }
      const value = descriptor.value;
      if (
        value === undefined ||
        typeof value === 'function' ||
        typeof value === 'symbol'
      ) {
        continue;
      }
      properties += 1;
      if (properties > MAX_EVENT_STORE_INGRESS_PROPERTIES) {
        throw new EventStoreIngressError(
          'it exceeds the structural property limit',
        );
      }
      if (properties > 1) this.addAscii(',');
      this.addJsonString(key);
      this.addAscii(':');
      const childLocation: EventStoreIngressLocation =
        location === 'event-root' && key === 'attachments'
          ? 'canonical-attachments'
          : location === 'canonical-attachment' && key === 'dataUrl'
            ? 'canonical-attachment-data-url'
            : 'ordinary';
      const child = this.projectValue(value, depth + 1, false, childLocation);
      // The primitive omission cases above were handled before writing the key.
      if (child === undefined) {
        throw new EventStoreIngressError('it contains unsupported object data');
      }
      // Assignment to `__proto__` would mutate this projector's prototype
      // instead of preserving the JSON own property.
      Object.defineProperty(projected, key, {
        configurable: true,
        enumerable: true,
        value: child,
        writable: true,
      });
    }
    this.addAscii('}');
    return projected;
  }
}
const { DatabaseSync } = require('node:sqlite') as {
  DatabaseSync: new (
    path: string,
    options?: { timeout?: number; readOnly?: boolean },
  ) => {
    exec(sql: string): void;
    prepare(sql: string): {
      run: (...args: unknown[]) => unknown;
      get: (...args: unknown[]) => unknown;
      all: (...args: unknown[]) => unknown[];
    };
    close(): void;
  };
};

export interface PersistedRuntimeEvent {
  id: string;
  provider: string;
  threadId: string;
  turnId?: string;
  method: string;
  payload: CanonicalRuntimeEvent;
  createdAt: string;
  /** Station ingestion time; absent on rows written before archive#4135. */
  observedAt?: string;
  /** Monotonic within `threadId` only — see {@link PersistedRuntimeEvent.globalSequence}. */
  sequence: number;
  /**
   * Monotonic across every thread (archive#1092). The resume cursor for the
   * `/api/orchestration/events` SSE stream: it is what the route sets as the
   * frame's `id:` and what a reconnecting client sends back as
   * `Last-Event-ID`, so ordering must hold across sessions, not just within
   * one.
   */
  globalSequence: number;
  /**
   * Set only by a BOUNDED read whose budget withheld part of the stored
   * payload (archive#3386) — never persisted, and never set by a full read.
   * Its absence is therefore a fact about this read, not a default.
   */
  elided?: RuntimeEventElisionReason;
}

/** Exact turn.started row stripped to the only safe user-input read fields. */
export interface UserInputEventDescriptor {
  eventId: string;
  threadId: string;
  turnId?: string;
  method: string;
  prompt?: string;
  attachments: ReadonlyArray<{ name: string; mimeType: string; size: number }>;
}

export interface PersistedRuntimeEventPage {
  events: PersistedRuntimeEvent[];
  hasMore: boolean;
  nextSequence: number;
}
export interface PersistedRuntimeEventReplayDescriptor {
  threadId: string;
  globalSequence: number;
  /** Exact UTF-8 bytes of the JSON data field emitted for this replay frame. */
  serializedFrameBytes: number;
}

export interface PersistedRuntimeEventWindow {
  events: PersistedRuntimeEvent[];
  hasMore: boolean;
  nextCursor?: string;
  /** Highest stream sequence for this thread at the same read boundary. */
  watermark: number;
}

export interface ConversationForkProvenance {
  sourceConversationId: string;
  targetConversationId: string;
  targetAgent: string;
  forkedAt: string;
  branchPointTurnId?: string;
  sourceSessionId?: string;
  continuation?: 'native' | 'replay-seed';
}

const LIFECYCLE_METHODS = [
  'request.resolved',
  'runtime.error',
  'session.exited',
  'session.state-changed',
  'turn.aborted',
  'turn.completed',
  'turn.started',
] as const;

// archive#4466 review remediation: the exact set of methods
// `listSessionProjectionEventsForThreads` ranks — every method any slot in
// `listSessionProjectionEvents`'s fold looks up by name (`LIFECYCLE_METHODS`
// plus `flow.run-attached`/`policy.hooks-attached`/`session.started`/
// `session.configured`). Deliberately NOT "every method" — the whole point
// of ranking by `(thread_id, method)` instead of `(thread_id)` alone is that
// a thread's un-listed methods (`content.text-delta`, tool events, ...) are
// never read, so a 50,000-delta transcript costs the same as a two-event
// thread.
const PROJECTION_FOLD_METHODS = [
  'flow.run-attached',
  'policy.hooks-attached',
  'session.started',
  'session.configured',
  'turn.started',
  'request.resolved',
  'runtime.error',
  'session.exited',
  'session.state-changed',
  'turn.aborted',
  'turn.completed',
] as const;

// archive#4466: SQLite's bound-parameter ceiling (SQLITE_MAX_VARIABLE_NUMBER,
// commonly 32766) bounds how many `?` placeholders one statement can hold.
// Chunking every `thread_id IN (...)` batch at this size keeps the ceiling
// structurally unreachable regardless of how many threads a caller requests
// — tested directly (archive#4466 review remediation) rather than trusted.
const EVENT_STORE_BATCH_CHUNK_SIZE = 500;

/** The latest and/or first row for one `(threadId, method)` pair. */
interface RankedMethodFact {
  latest?: PersistedRuntimeEvent;
  first?: PersistedRuntimeEvent;
}

/**
 * A stable composite key for a `(threadId, turnId)` pair, joined on a NUL
 * byte rather than a printable separator so a threadId/turnId that happened
 * to contain the separator could never manufacture a collision.
 */
function pairKey(threadId: string, turnId: string): string {
  return `${threadId}\u0000${turnId}`;
}

const SESSION_STATE_FACT_METHODS = [
  'request.opened',
  'request.resolved',
  'runtime.error',
  'session.exited',
  'session.stop-settled',
  'session.state-changed',
  'turn.aborted',
  'turn.completed',
  'turn.started',
] as const;

const SESSION_EVENT_WINDOW_MAX_EVENTS = 150;
/**
 * How many bound threads the blob route will put through the session-read
 * predicate. Small on purpose: one owner needs one readable thread to pass,
 * and the cap is what keeps an authorized read off O(bindings).
 */
const ATTACHMENT_CANDIDATE_THREAD_LIMIT = 4;
const SNAPSHOT_TOOL_OUTPUT_MAX_CHARS = 84;
const SNAPSHOT_EVENT_MAX_SERIALIZED_BYTES = 4_096;
const SESSION_EVENT_WINDOW_MAX_SERIALIZED_BYTES = 56_000;
/** Hard complete JSON response budget for one authenticated event window. */
export const SESSION_EVENT_WINDOW_MAX_RESPONSE_BYTES = 64_000;

function persistedRequestId(event: CanonicalRuntimeEvent): string | null {
  if (
    event.method !== 'request.opened' &&
    event.method !== 'request.resolved'
  ) {
    return null;
  }
  try {
    return canonicalPersistedRequestId(event.requestId);
  } catch {
    throw new Error(
      `Cannot persist ${event.method} without a non-empty request identity`,
    );
  }
}

interface EventWindowCursor {
  createdAt: string;
  turnId: string;
  eventSequence?: number;
  newestCreatedAt?: string;
  newestTurnId?: string;
}

/** Opaque global-sequence cursor for an ordered conversation lineage window. */
interface ConversationEventWindowCursor {
  threadIds: string[];
  beforeGlobalSequence: number;
  watermark: number;
  rangeStartGlobalSequence?: number;
  rangeEndExclusive?: number;
  afterGlobalSequence?: number;
  olderTurnsRemain?: boolean;
}

function encodeConversationEventWindowCursor(
  cursor: ConversationEventWindowCursor,
): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

function decodeConversationEventWindowCursor(
  value: string | undefined,
  threadIds: readonly string[],
): ConversationEventWindowCursor | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      !Array.isArray(parsed.threadIds) ||
      parsed.threadIds.length === 0 ||
      !parsed.threadIds.every((id: unknown) => typeof id === 'string') ||
      !Number.isSafeInteger(parsed.beforeGlobalSequence) ||
      !Number.isSafeInteger(parsed.watermark) ||
      parsed.beforeGlobalSequence < 1 ||
      parsed.watermark < parsed.beforeGlobalSequence ||
      parsed.threadIds.length > threadIds.length ||
      parsed.threadIds.some(
        (id: string, index: number) => id !== threadIds[index],
      ) ||
      (parsed.olderTurnsRemain !== undefined &&
        typeof parsed.olderTurnsRemain !== 'boolean') ||
      !validConversationRangeCursor(parsed)
    ) {
      throw new Error('invalid');
    }
    return parsed as ConversationEventWindowCursor;
  } catch {
    throw new Error('Conversation event window cursor is invalid');
  }
}

function validConversationRangeCursor(value: Record<string, unknown>): boolean {
  const present = [
    value.rangeStartGlobalSequence,
    value.rangeEndExclusive,
    value.afterGlobalSequence,
  ].filter((item) => item !== undefined);
  if (present.length === 0) return true;
  if (present.length !== 3 || !present.every(Number.isSafeInteger))
    return false;
  return (
    (value.rangeStartGlobalSequence as number) >= 1 &&
    (value.afterGlobalSequence as number) >=
      (value.rangeStartGlobalSequence as number) &&
    (value.afterGlobalSequence as number) <
      (value.rangeEndExclusive as number) &&
    (value.rangeEndExclusive as number) <= (value.watermark as number) + 1
  );
}

function encodeEventWindowCursor(
  threadId: string,
  cursor: EventWindowCursor,
): string {
  return Buffer.from(JSON.stringify({ threadId, ...cursor })).toString(
    'base64url',
  );
}

function decodeEventWindowCursor(
  value: string | undefined,
  threadId: string,
): EventWindowCursor | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(
      Buffer.from(value, 'base64url').toString('utf8'),
    ) as Record<string, unknown>;
    const hasContinuation =
      parsed.eventSequence === undefined &&
      parsed.newestCreatedAt === undefined &&
      parsed.newestTurnId === undefined
        ? true
        : Number.isInteger(parsed.eventSequence) &&
          (parsed.eventSequence as number) >= 0 &&
          typeof parsed.newestCreatedAt === 'string' &&
          typeof parsed.newestTurnId === 'string';
    return parsed.threadId === threadId &&
      typeof parsed.createdAt === 'string' &&
      typeof parsed.turnId === 'string' &&
      hasContinuation
      ? {
          createdAt: parsed.createdAt,
          turnId: parsed.turnId,
          ...(parsed.eventSequence === undefined
            ? {}
            : {
                eventSequence: parsed.eventSequence as number,
                newestCreatedAt: parsed.newestCreatedAt as string,
                newestTurnId: parsed.newestTurnId as string,
              }),
        }
      : undefined;
  } catch {
    return undefined;
  }
}

/** Cuts one snapshot text field to its ceiling and reports whether it cut. */
function sliceSnapshotText(value: unknown): { text: string; cut: boolean } {
  const text = String(value);
  return {
    text: text.slice(0, SNAPSHOT_TOOL_OUTPUT_MAX_CHARS),
    cut: text.length > SNAPSHOT_TOOL_OUTPUT_MAX_CHARS,
  };
}

/**
 * Bounds one event for a window read, and — archive#3386 — SAYS SO when it
 * bounded it. Both budgets here used to be silent: a `tool.completed` came
 * back cut to 84 characters with no mark, and any payload over the 4 KB
 * ceiling came back as identity fields alone, which is how a pasted image
 * over ~3 KB lost both its prompt and its chip on restore (archive#3374).
 * From the client, a stripped payload and a payload that never had those
 * fields are the same bytes.
 */
function snapshotEvent(event: PersistedRuntimeEvent): PersistedRuntimeEvent {
  const payload = event.payload as unknown as Record<string, unknown>;
  let outputCut = false;
  let snapshotPayload = payload;
  if (event.method === 'tool.completed') {
    // archive#3427: an empty-string error is a tool that failed with no
    // message — a fact about the run, not the absence of one — so it is
    // preserved the same way an empty-string output already was; a
    // truthiness guard on `error` alone used to drop it from the snapshot.
    //
    // `error` and `output` are still NOT handled identically below, and this
    // reads persisted JSON as `Record<string, unknown>`, not the contract
    // type, so both can genuinely be `null`/`0`/`false`/structured on disk —
    // that's what makes both cases reachable. Both now agree on `null`:
    // rather than let `sliceSnapshotText`'s `String(value)` fabricate the
    // four-character string `"null"`, a `null` value is left exactly as
    // sent, via the `...payload` spread below (no override is produced for
    // it). `null` here is a value the producer SENT — it says nothing about
    // intent (this function does not know whether "the tool returned JSON
    // null" and "the tool returned nothing" are different facts to whoever
    // produced the event); "nothing was sent at all" is the separate
    // `payload.output === undefined` half of the same check below, not this
    // one. Where `error` and `output` diverge is *why* each is narrowed: `error` is
    // contract-typed `string | undefined`, so any other shape on disk is
    // unexpected data, and is left completely untouched (not just `null`) —
    // narrowed to `typeof === 'string'`, nothing else is transformed.
    // `output` is contract-typed `unknown`, and real producers legitimately
    // emit structured values (e.g. `claude-transcript-session-source.ts`'s
    // `output: raw.content`), so a non-null, non-string `output` is
    // JSON-serialised rather than left alone — archive#3462 — preserving a
    // structured tool result instead of reading it back as the fixed string
    // `"[object Object]"`. A string `output` passes through without
    // JSON-quoting it (no double-encoding: a string result must not come
    // back wrapped in extra `"`s) — it is still sliced at the same 84-char
    // ceiling below, same as every other shape, so "unchanged" would
    // overstate it.
    //
    // The per-field ceiling itself (84 chars) is unchanged for either field.
    // What changed is which values reach it: the old `String(value)` gave a
    // non-string `output` a small, roughly fixed size — `"[object Object]"`
    // is 15 chars for any object, which never hit the ceiling, though
    // `String([...])`'s comma-joined list could. The JSON-serialised form is
    // usually longer and hits it far more often, so a window of
    // `tool.completed` events carrying structured output is now measurably
    // larger than before — up to +69 chars each (84 vs. 15), and more bytes
    // than that for non-ASCII, since `JSON.stringify` does not escape it and
    // the budgets below are counted in UTF-8 bytes — against both
    // `SNAPSHOT_EVENT_MAX_SERIALIZED_BYTES` (this function's own 4 KB
    // per-event ceiling, below) and `SESSION_EVENT_WINDOW_MAX_SERIALIZED_BYTES`
    // (the caller's window-wide budget). That can make a window read hit its
    // byte budget and paginate sooner than it used to for the same events —
    // not silent data loss: `listEventWindowByTurn` already reports that as
    // `hasMore`/`nextCursor`, same as it does for any other byte-budget
    // crossing.
    const error =
      typeof payload.error === 'string'
        ? sliceSnapshotText(payload.error)
        : undefined;
    const output =
      payload.output === undefined || payload.output === null
        ? undefined
        : sliceSnapshotText(
            typeof payload.output === 'string'
              ? payload.output
              : JSON.stringify(payload.output),
          );
    outputCut = Boolean(error?.cut) || Boolean(output?.cut);
    snapshotPayload = {
      ...payload,
      ...(error ? { error: error.text } : {}),
      ...(output ? { output: output.text } : {}),
    };
  }
  if (
    Buffer.byteLength(JSON.stringify(snapshotPayload)) <=
    SNAPSHOT_EVENT_MAX_SERIALIZED_BYTES
  ) {
    return {
      ...event,
      payload: snapshotPayload as unknown as CanonicalRuntimeEvent,
      ...(outputCut ? { elided: 'output_limit' as const } : {}),
    };
  }
  return {
    ...event,
    payload: {
      eventId: event.payload.eventId,
      provider: event.payload.provider,
      threadId: event.payload.threadId,
      turnId: event.payload.turnId,
      createdAt: event.payload.createdAt,
      method: event.payload.method,
    } as CanonicalRuntimeEvent,
    // `byte_limit` supersedes a same-event `output_limit`: the cut fields are
    // gone with the rest of the payload, so naming the narrower budget would
    // understate what this read withheld.
    elided: 'byte_limit',
  };
}

/**
 * archive#3433 round 2: moving the persist instruments outside the savepoint
 * try (archive#3386's shape) stopped a throwing instrument from masking a
 * committed insert as a rollback — but a throwing instrument here still
 * propagated out of `appendEvent`/`appendEventIfAbsent` themselves, to
 * callers that do not catch (`runtime-initialize.ts`,
 * `orchestration-service.ts` (two call sites), `orchestration-session-
 * state.ts`, `attached-session-follow-service.ts` — none of them wrap the
 * call). A committed, successful append must not fail its
 * caller because an OTel exporter is unreachable — the same rule
 * `attachment-blob-store.ts`'s `count()` already enforces for this file's
 * sibling persistence path: "Telemetry observes persistence; it never
 * decides it."
 *
 * The instruments are passed as thunks, not values, for the same reason
 * `count()`'s are: a partial test double of the metrics module that omits
 * this export makes the property access itself throw, and that access must
 * happen inside the try below to be caught, not at the call site.
 */
function observeEventPersisted(
  counter: () => {
    add: (value: number, attributes?: Record<string, string>) => void;
  },
  duration: () => {
    record: (value: number, attributes?: Record<string, string>) => void;
  },
  durationMs: number,
  attributes: Record<string, string>,
): void {
  try {
    counter().add(1, attributes);
  } catch {
    // Observation only.
  }
  try {
    duration().record(durationMs, attributes);
  } catch {
    // Observation only.
  }
}

export interface ConversationHistoryCursor {
  updatedAt: string;
  threadId: string;
}

export interface ConversationHistoryRecord {
  threadId: string;
  conversationId: string;
  environmentId?: string;
  ownerUserId?: string;
  tenantId?: string;
  agentSlug?: string;
  title: string;
  messageCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface ConversationHistoryPage {
  records: ConversationHistoryRecord[];
  hasMore: boolean;
  nextCursor?: ConversationHistoryCursor;
}

export interface ConversationHistoryUpgrade {
  status: 'complete';
  quarantinedCount: number;
}

export interface ConversationHistoryQuarantineRecord {
  threadId: string;
  reason: 'unbound';
  recordedAt: string;
}

/**
 * Bound on retained turn-dedup rows. Exported so the `/chat` facade and this
 * store share ONE constant rather than each hardcoding 2000 — they did, in
 * two files, which is a drift waiting to happen.
 */
export const TURN_DEDUP_MAX_ENTRIES = 2000;
const NATIVE_INVOCATION_TERMINAL_RETENTION = 1000;
const VOICE_TURN_TERMINAL_RETENTION = 1000;
const NATIVE_INVOCATION_STARTUP_ATTEMPTS = 8;
/**
 * Legacy message projection work per event-loop task. This caps both the
 * read and the write transaction, so a large pre-search home cannot wedge
 * startup by replaying its complete event ledger at once.
 */
export const MESSAGE_SEARCH_BACKFILL_EVENT_BATCH_SIZE = 500;
/**
 * One year adds 0.000000365 to FTS5's ascending score: enough to settle an
 * equal textual match by recency, but too small to displace material BM25
 * relevance. Keep this explicit so ranking does not drift by accident.
 */
export const MESSAGE_SEARCH_RECENCY_SCORE_PER_DAY = 0.000000001;

type MessageSearchProjection = {
  table: string;
  projectionTable: string;
  backfillTable: string;
  cjkAware: boolean;
};

const MESSAGE_SEARCH_PROJECTIONS: readonly MessageSearchProjection[] = [
  {
    table: 'orchestration_message_search_v3',
    projectionTable: 'orchestration_message_search_projection_v3',
    backfillTable: 'orchestration_message_search_backfill_v3',
    cjkAware: true,
  },
  {
    table: 'orchestration_message_search_v2',
    projectionTable: 'orchestration_message_search_projection',
    backfillTable: 'orchestration_message_search_backfill',
    cjkAware: false,
  },
];
const nativeInvocationStartupBackoff = new Int32Array(
  new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT),
);

export class NativeInvocationStartupUnavailableError extends Error {
  constructor() {
    super('Native invocation run recovery is temporarily unavailable.');
    this.name = 'NativeInvocationStartupUnavailableError';
  }
}

export class VoiceTurnStartupUnavailableError extends Error {
  constructor() {
    super('Voice turn run recovery is temporarily unavailable.');
    this.name = 'VoiceTurnStartupUnavailableError';
  }
}

/**
 * The reactive path's typed corruption failure (archive#3219). There is no
 * per-boot `PRAGMA quick_check` any more — that check cost O(database size)
 * on every start and could not see damage arriving after boot. Corruption is
 * now classified where SQLite itself raises it (`explicitCorruption`), and a
 * constructor whose migration dies on a corrupt store translates that verdict
 * into this error, with the raw SQLite failure as `cause`.
 */
export class EventStoreIntegrityError extends Error {
  readonly code = 'STATION_EVENT_STORE_CORRUPT';

  constructor(options?: { cause?: unknown }) {
    super(
      'Station orchestration data failed integrity validation. Stop every Station using this home, then restore a validated backup with `station home restore --from=<backup-dir> --confirm`.',
      options,
    );
    this.name = 'EventStoreIntegrityError';
  }
}

/**
 * archive#4075 stage 2: thrown by {@link EventStore.appendEvent} /
 * {@link EventStore.appendEventIfAbsent} when an ownership-shaped event
 * (`session.started`/`session.configured`) carrying a `metadata.userId`
 * disagrees with the thread's already-established owner
 * ({@link EventStore.findSessionOwnerUserId}). Attribution is immutable once
 * recorded — see the append-time guard for the full argument.
 */
export class SessionOwnershipConflictError extends Error {
  constructor(
    readonly threadId: string,
    readonly existingOwnerUserId: string,
    readonly attemptedOwnerUserId: string,
  ) {
    super(
      `Session ${threadId} is already owned by ${JSON.stringify(existingOwnerUserId)}; refusing to append an ownership-shaped event attributing it to ${JSON.stringify(attemptedOwnerUserId)}`,
    );
    this.name = 'SessionOwnershipConflictError';
  }
}

/** A malformed immutable work-item row is never projected to a caller. */
export class SessionWorkItemObservationCorruptionError extends Error {
  constructor() {
    super('Session work-item observations are corrupt.');
    this.name = 'SessionWorkItemObservationCorruptionError';
  }
}

type SessionWorkItemTerminalAdmission =
  | {
      kind: 'association';
      claim: SessionWorkItemAdmissionClaim;
      association: SessionWorkItemAssociation;
    }
  | { kind: 'closed'; claim: SessionWorkItemAdmissionClaim };

type SessionWorkItemAssociationMetadataRow = Record<string, unknown>;

export class EventStore {
  /** Kept private: room history receives a separate connection, never this DB. */
  private readonly databasePath: string;
  private readonly db: InstanceType<typeof DatabaseSync>;
  /** Persisted with this store so issued cursors survive a Station restart. */
  private readonly declaredOutputCursorKey: Buffer;
  private readonly sessionInventoryCursorKey: Buffer;
  /**
   * Attachment bytes live beside the database, not inside it (archive#3374).
   * Derived from `dbPath` rather than injected: the blobs are as much this
   * store's own state as its SQLite file is, and a dependency a caller can
   * forget to pass is one that silently reverts to writing megabytes of base64
   * into every `turn.started` row.
   */
  private readonly attachmentBlobs: AttachmentBlobStore;
  private readonly turnIdempotence: TurnIdempotencyStore;
  private readonly turnDedupMaxEntries: number;
  private readonly recoveryLedgerOwner: RecoveryOwner;
  private readonly recoveryProcessIdentity: RecoveryLedgerProcessIdentity;
  private readonly nativeInvocationRuns: ReturnType<
    typeof createNativeInvocationRuns
  >;
  private readonly nativeInvocationStarterAdapter: NativeInvocationStarter;
  private readonly nativeInvocationRunReaderAdapter: NativeInvocationRunReader;
  private readonly voiceTurnRuns: VoiceTurnRuns;
  private readonly sessionTurnBoundaries: SessionTurnBoundaryAuthority;
  /** Process-local candidates; durable association truth remains SQLite-owned. */
  private readonly sessionWorkItemAdmissions: SessionWorkItemAdmissionRegistry =
    createSessionWorkItemAdmissionRegistry();
  /**
   * archive#4080: the dead-owner `accepted`/`indeterminate` findings
   * from this process's OWN boot-time `initializeSessionTurnBoundaries()`
   * reconcile pass — each one "a turn was in flight when its owning process
   * died". Drained exactly once by `takeInterruptedTurnBoundaries()`; a
   * caller that never drains it simply never banners (fails closed, not
   * open — no invented completion, no invented failure).
   */
  private pendingInterruptedTurnBoundaries: SessionTurnBoundaryRecord[] = [];
  private readonly conversationSessionLineage: ConversationSessionLineageModule;
  private readonly conversationHandoffs: ConversationHandoffModule;
  private readonly conversationContextBoundaries: ConversationContextBoundaryModule;
  private readonly operationalEventConsumers =
    new Set<OperationalEventConsumer>();
  private readonly operationalEventSubscriptionRegistries =
    new Set<OperationalEventSubscriptionRegistry>();
  private readonly projectTaskRoomHistories = new Set<ProjectTaskRoomHistory>();
  private readonly revisionEvidenceModules = new Set<RevisionEvidenceModule>();
  private nativeInvocationRunsReady = false;
  private messageSearchBackfillClosed = false;
  private packageMcpAdmissionJournal?: PackageMcpAdmissionJournal;

  constructor(
    dbPath: string,
    turnDedupMaxEntries = TURN_DEDUP_MAX_ENTRIES,
    turnProcessIdentity?: TurnIdempotencyProcessIdentity,
    /** Private fault seam: proves post-write recovery readback, not production policy. */
    private readonly recoveryTransitionFault?: () => void,
    /** Private fault seam for native direct-invocation terminal readback. */
    private readonly nativeInvocationTransitionFault?: () => void,
    /** Private fault seam for startup-gate retry proof. */
    private readonly nativeInvocationStartupFault?: () => void,
    /** Private fault seam for voice terminal post-write readback proof. */
    private readonly voiceTurnTransitionFault?: () => void,
    /** Private fault seam proving work-item terminal settlement shares the event savepoint. */
    private readonly sessionWorkItemAdmissionFault?: () => void,
    /** Private fault seam proving no admission is taken before SAVEPOINT opens. */
    private readonly sessionWorkItemSavepointOpenFault?: () => void,
    /** Private fault seam for unknown package-admission commit acknowledgement. */
    private readonly packageMcpCommitFault?: () => void,
  ) {
    this.databasePath = dbPath;
    this.turnDedupMaxEntries = turnDedupMaxEntries;
    this.recoveryProcessIdentity = turnProcessIdentity ?? {
      exact: (pid) => {
        const identity = exactProcessIdentity(pid);
        return identity;
      },
      probe: probeExactProcessIdentity,
    };
    const identity = this.recoveryProcessIdentity.exact(process.pid);
    this.recoveryLedgerOwner = identity
      ? {
          id: randomUUID(),
          pid: process.pid,
          birth: identity.start,
          identityKind: 'exact',
        }
      : { id: randomUUID(), pid: process.pid, identityKind: 'unverified' };
    mkdirSync(dirname(dbPath), { recursive: true });
    this.attachmentBlobs = new AttachmentBlobStore({
      rootDir: join(dirname(dbPath), 'attachments'),
    });
    // Wrap the handle, not the call sites. Corruption can surface from any of
    // the ~180 prepared statements in this file, so a per-site change is one
    // somebody forgets to make at the next site; the connection is the single
    // place every one of them passes through. The watch observes and rethrows,
    // so no query's behaviour changes — only what Station knows afterwards
    // (archive#3215).
    this.db = watchForSqliteCorruption(
      new DatabaseSync(dbPath, { timeout: SQLITE_BUSY_TIMEOUT_MS }),
      {
        onCorruptionObserved: (error) => {
          // The shared mapping (archive#3220's extraction — two copies of it are two
          // chances to record different truths about one error) with main's
          // MARKER-FIRST ordering: the watch swallows observer failures
          // whole, so anything thrown before the marker write kills the
          // diagnosis, and a counter is exactly the kind of dependency that
          // fails in surprising contexts (a test mock missing the new
          // instrument did precisely this, silently). The durable evidence
          // outranks the telemetry about it.
          //
          // archive#3433 class sweep: this callback is NOT structurally
          // outside a rollback-catch — `wrapStatement` (sqlite-corruption-
          // watch.ts) fires it from inside the catch of whatever statement
          // failed, which is dynamically inside this constructor's own
          // SAVEPOINT tries elsewhere in the file whenever that statement is
          // transactional. It is exempt from the archive#3433 fix for a different,
          // already-independent reason: `watchForSqliteCorruption`'s own
          // `report()` wraps `onCorruptionObserved(error)` in try/catch and
          // unconditionally rethrows the ORIGINAL `error` afterward — so a
          // throwing marker write or counter here can never become the value
          // a savepoint catch sees, and can never turn a released savepoint
          // into a rollback of one already gone.
          const marker = corruptionMarkerFromError(dbPath, error);
          recordCorruptionObserved(marker);
          orchestrationStoreCorruptionObserved.add(1, {
            errcode: marker.errcode ?? 'unknown',
            // Both detection paths carry `source` so the counter can answer
            // which one found it. A dimension only one site sets is one the
            // other silently aggregates into "unset" (archive#3218).
            source: 'query',
          });
        },
      },
    );
    // Set the PRAGMA too, not only the constructor option.
    //
    // scheduler-ledger.ts already carries this lesson at its own open: Node's
    // SQLite constructor timeout "does not consistently govern explicit
    // BEGIN IMMEDIATE statements across supported builds", so it sets both.
    // This seam relied on the option alone, which is how a peer's write lock
    // could return SQLITE_BUSY here with no wait at all.
    //
    // Distinct from SQLITE_SCHEMA contention (archive#3200) — that one was never
    // BUSY, and its known trigger, the per-boot quick_check, was itself
    // removed by archive#3219 — but the same shape of gap, with one seam
    // already knowing what the other did not (archive#3188 review).
    try {
      this.db.exec(`PRAGMA busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS}`);
    } catch {
      // Best-effort. An unreadable database fails the migration below with a
      // truthful, corruption-classified verdict, which is the actionable
      // failure.
    }
    // WAL before the first write (archive#2895). A STATION_HOME can legitimately be
    // open by more than one runtime — a desktop bundle and a managed service
    // share one home — and in the default `delete` journal mode a writer takes
    // an exclusive lock that blocks every other connection. Worse, when a
    // connection has to upgrade a held shared lock while another writer holds
    // RESERVED, SQLite returns SQLITE_BUSY *immediately* to avoid deadlock,
    // without ever consulting the busy handler — so the `timeout` above does
    // not cover the case that actually fails. That is how the migration below
    // died with a bare `database is locked` and took the whole boot with it.
    //
    // The scheduler ledger has always opened WAL (`scheduler-ledger.ts`), and
    // on a host where both runtimes ran, its database survived the same boot
    // race this one failed. WAL lets readers and one writer proceed together
    // and makes writer/writer contention honor the busy timeout.
    //
    // Best-effort, and deliberately so: switching journal mode is itself a
    // write that needs a lock no other connection holds, so making it fatal
    // would fail precisely in the contended boot this exists to survive (it
    // broke this file's own writer-contention tests when written that way).
    // The mode is persistent in the database header, so the first uncontended
    // open converts the file for good and every later open is a no-op that
    // succeeds even under contention.
    // archive#3661: retried, because the CONVERSION on a never-WAL file is
    // refused instantly rather than waiting out `busy_timeout` — a bare
    // swallow left a brand-new home in rollback-journal mode for the whole
    // boot that raced. Still advisory: the migration below has its own
    // contention handling and the header persists the mode either way.
    applyWalJournalMode(this.db, { store: 'orchestration event store' });
    try {
      this.db.exec(ORCHESTRATION_EVENT_STORE_MIGRATION);
      this.db.exec(PACKAGE_MCP_ADMISSION_SCHEMA);
      this.db
        .prepare(
          'INSERT OR IGNORE INTO package_mcp_admission_journal(singleton, journal_id, state_json) VALUES (1, ?, ?)',
        )
        .run(randomUUID(), JSON.stringify({ version: 1, generations: [] }));
      this.ensureObservedAtColumn();
      this.ensureUsageReceiptIndex();
      this.db.exec(CONVERSATION_SESSION_LINEAGE_MIGRATION);
      this.db.exec(CONVERSATION_HANDOFF_MIGRATION);
      ensureConversationHandoffMessageDigestColumn(this.db);
      this.db.exec(CONVERSATION_CONTEXT_BOUNDARY_MIGRATION);
      ensureConversationContextBoundaryColumns(this.db);
      this.db.exec(SESSION_WORK_ITEM_ASSOCIATIONS_MIGRATION);
      this.db.exec(OPERATIONAL_EVENT_OUTBOX_MIGRATION);
      this.db.exec(PROJECT_TASK_ROOM_RUNTIME_MIGRATION);
      this.db.exec(REVISION_EVIDENCE_RECEIPTS_MIGRATION);
      this.db.exec(PROJECT_TASK_ROOM_REVISION_PUBLICATION_MIGRATION);
      ensureProjectTaskRoomRevisionAttributionColumn(this.db);
      this.db.exec(`
      CREATE TABLE IF NOT EXISTS orchestration_attachment_quota (
        thread_id TEXT PRIMARY KEY,
        encoded_bytes INTEGER NOT NULL CHECK (encoded_bytes >= 0)
      )
    `);
      // Which threads reference which blob (archive#3385 review).
      //
      // The blob store is content-addressed and deduped across every thread
      // and every user, so a reference on its own authorizes nobody: a digest
      // is a function of the CONTENT, and anyone holding the same bytes can
      // compute it offline. Without this table the blob route would be a
      // cross-user existence-and-content oracle. It is what lets the route ask
      // the ordinary question — can this caller read a session that references
      // these bytes — instead of trusting the reference itself.
      //
      // Composite key, not one row per blob: dedup means one blob legitimately
      // belongs to several threads, and each owner must pass through their own.
      this.db.exec(`
      CREATE TABLE IF NOT EXISTS orchestration_attachment_refs (
        blob_ref TEXT NOT NULL,
        thread_id TEXT NOT NULL,
        PRIMARY KEY (blob_ref, thread_id)
      )
    `);
      this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_attachment_refs_thread
        ON orchestration_attachment_refs(thread_id)
    `);
      this.declaredOutputCursorKey = this.ensureDeclaredOutputCursorKey();
      this.sessionInventoryCursorKey = this.ensureCursorKey(
        'session-inventory/v1',
      );
      // Client-turn claims are shared by orchestration and direct /chat.
      // SQLite-backed half of the ONE shared algorithm in
      // `../turn-idempotency.ts` (the `/chat` route shares the same algorithm
      // against a JSON-file-backed adapter, `routes/chat/chat-turn-dedup.ts`).
      // `value` is NULL while the claiming request's `adapter.sendTurn` call is
      // still in flight, and set once it resolves.
      ensureOrchestrationTurnDedupColumns(this.db);
      this.turnIdempotence = new TurnIdempotencyStore(
        new SqliteTurnIdempotencyPersistence(this.db, this.turnDedupMaxEntries),
        turnProcessIdentity,
      );
      ensureOrchestrationSessionStateColumns(this.db);
      ensureNativeInvocationRunColumns(this.db);
      ensureVoiceTurnRunColumns(this.db);
      ensureOrchestrationRecoverySettlementColumns(this.db);
      ensureCredentialApplicationCommitPendingIndex(this.db);
      ensureOrchestrationEventStoreColumns(this.db);
      ensureOrchestrationAdoptionColumns(this.db);
      this.ensureConversationHistoryProjectSlugColumn();
      // Repair the bounded pre-existing history projection before the full
      // upgrade creates new rows. Fresh rows already derive project_slug from
      // their selected metadata, so this ordering prevents the repair from
      // preparing a duplicate payload read without carrying an unbounded
      // exclusion set into SQLite.
      this.backfillConversationHistoryProjectSlugs();
      this.ensureConversationHistoryUpgrade();
      this.conversationSessionLineage =
        this.composeConversationSessionLineage();
      this.conversationSessionLineage.backfillLegacySessions();
      this.conversationHandoffs = this.composeConversationHandoffs();
      this.conversationContextBoundaries =
        this.composeConversationContextBoundaries();
      this.conversationContextBoundaries.reconcileAtBoot();
      if (this.backfillNextMessageSearchProjection()) {
        this.scheduleMessageSearchBackfill();
      }
      this.nativeInvocationRuns = this.composeNativeInvocationRuns();
      this.initializeNativeInvocationRuns();
      this.voiceTurnRuns = this.composeVoiceTurnRuns();
      this.initializeVoiceTurnRuns();
      this.sessionTurnBoundaries = this.composeSessionTurnBoundaries();
      this.initializeSessionTurnBoundaries();
      this.nativeInvocationStarterAdapter = Object.freeze({
        begin: (input: Parameters<NativeInvocationStarter['begin']>[0]) =>
          this.nativeInvocationRunsReady
            ? this.nativeInvocationRuns.begin(input)
            : ({ kind: 'unavailable' } as const),
      });
      this.nativeInvocationRunReaderAdapter = Object.freeze({
        list: () =>
          this.nativeInvocationRunsReady
            ? this.nativeInvocationRuns.list()
            : ({ kind: 'unavailable' } as const),
        read: (runId: Parameters<NativeInvocationRunReader['read']>[0]) =>
          this.nativeInvocationRunsReady
            ? this.nativeInvocationRuns.read(runId)
            : ({ kind: 'unavailable' } as const),
      });
    } catch (error) {
      // A constructor failure leaves no usable EventStore instance. Close the
      // native handle before propagating the diagnostic so Windows can remove
      // or replace the just-upgraded database immediately.
      //
      // Corruption is classified here rather than re-checked: `this.db` is
      // the watched connection, so by the time this catch runs the watch has
      // already recorded the corruption marker (marker first, counter second,
      // `source: 'query'`) for any exec/prepare failure above — including a
      // header-read failure on the very first `CREATE TABLE IF NOT EXISTS`
      // of a `not a sqlite database` file (errcode 26). This block's own job
      // is only what the observer cannot do: preserve the hot WAL through
      // the close, and surface the typed error the boot path acts on.
      const corrupt = explicitCorruption(error);
      // DISCLOSED LIMIT of the preservation below (archive#3219 review): the
      // reactive ordering commits migration frames BEFORE a read can find
      // damage (~7 frames measured), and on a hot WAL already near SQLite's
      // auto-checkpoint threshold (~1000 pages) those commits can complete a
      // checkpoint that folds the pre-existing frames into the DAMAGED main
      // file and restarts the WAL — something the deleted check-before-write
      // ordering made impossible. Not data loss (a checkpoint only resets
      // after frames are durable in main), but salvage (archive#3251) then receives
      // frames interleaved into a damaged tree rather than a clean WAL. The
      // holder below protects the frames from the CLOSE; nothing here
      // protects them from the boot's own writes.
      //
      // Closing a read-write connection to a corrupt WAL-mode store deletes
      // the hot WAL outright — measured (archive#3217 review): wal 206032 ->
      // GONE, main byte-identical, because the close takes an exclusive lock
      // and unlinks the WAL after its checkpoint fails on the damage. Those
      // frames are the user's last committed events, they exist in no other
      // file, and the quarantine/salvage path (archive#3217/#3251) is about to try
      // to preserve them.
      //
      // The guard is a read-only holder that has PERFORMED A READ. A
      // merely-open connection is not enough — probed three ways: a holder
      // that never read, wal GONE; one autocommit SELECT, wal intact through
      // both closes; a held BEGIN likewise. Reading is what registers the
      // holder with the WAL, and a registered reader is what makes the
      // closing writer skip the unlink. The BEGIN below pins the snapshot for
      // the whole window rather than relying on the residue of a completed
      // statement — the injection that removed only the BEGIN stayed green,
      // so the transaction is belt-and-braces, not the load-bearing part.
      let walHolder: InstanceType<typeof DatabaseSync> | undefined;
      if (corrupt) {
        try {
          walHolder = new DatabaseSync(dbPath, { readOnly: true });
          walHolder.exec('BEGIN');
          // Page 1 is intact whenever this path is reached (the header
          // opened), so this read acquires the lock without touching damaged
          // pages.
          walHolder.prepare('SELECT 1 FROM sqlite_schema LIMIT 1').all();
        } catch {
          // Unopenable (e.g. NOTADB): there is no WAL to protect.
        }
      }
      try {
        this.db.close();
      } catch {
        // The initialization error is the actionable failure; a best-effort
        // cleanup failure must not erase it.
      }
      try {
        walHolder?.close();
      } catch {
        // Best-effort by construction.
      }
      throw corrupt ? new EventStoreIntegrityError({ cause: error }) : error;
    }
  }

  private ensureDeclaredOutputCursorKey(): Buffer {
    return this.ensureCursorKey('declared-output/v1');
  }

  private ensureCursorKey(name: string): Buffer {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS orchestration_cursor_keys (
        name TEXT PRIMARY KEY,
        secret BLOB NOT NULL
      )
    `);
    const existing = this.db
      .prepare('SELECT secret FROM orchestration_cursor_keys WHERE name = ?')
      .get(name) as { secret?: unknown } | undefined;
    if (existing?.secret instanceof Uint8Array && existing.secret.length >= 32)
      return Buffer.from(existing.secret);
    const secret = randomBytes(32);
    this.db
      .prepare(
        'INSERT OR IGNORE INTO orchestration_cursor_keys (name, secret) VALUES (?, ?)',
      )
      .run(name, secret);
    const inserted = this.db
      .prepare('SELECT secret FROM orchestration_cursor_keys WHERE name = ?')
      .get(name) as { secret?: unknown } | undefined;
    if (
      !(inserted?.secret instanceof Uint8Array) ||
      inserted.secret.length < 32
    )
      throw new Error('Cursor key is unavailable.');
    return Buffer.from(inserted.secret);
  }

  /**
   * Cursor authentication belongs beside the store snapshot it resumes. The
   * payload remains opaque to callers and is bound to the module's exact
   * session and request authority projection before a query can use it.
   */
  issueDeclaredOutputCursor(value: DeclaredOutputCursor): string {
    const payload = Buffer.from(JSON.stringify(value), 'utf8').toString(
      'base64url',
    );
    const signature = createHmac('sha256', this.declaredOutputCursorKey)
      .update(payload)
      .digest('base64url');
    return `station-output-cursor:v1:${payload}.${signature}`;
  }

  readDeclaredOutputCursor(value: string): DeclaredOutputCursor | undefined {
    const prefix = 'station-output-cursor:v1:';
    if (!value.startsWith(prefix)) return undefined;
    const encoded = value.slice(prefix.length);
    const separator = encoded.lastIndexOf('.');
    if (separator < 1 || separator === encoded.length - 1) return undefined;
    const payload = encoded.slice(0, separator);
    const supplied = encoded.slice(separator + 1);
    const expected = createHmac('sha256', this.declaredOutputCursorKey)
      .update(payload)
      .digest();
    let actual: Buffer;
    try {
      actual = Buffer.from(supplied, 'base64url');
    } catch {
      return undefined;
    }
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected))
      return undefined;
    try {
      const parsed: unknown = JSON.parse(
        Buffer.from(payload, 'base64url').toString('utf8'),
      );
      if (
        !parsed ||
        typeof parsed !== 'object' ||
        Array.isArray(parsed) ||
        Object.keys(parsed).length !== 5 ||
        !Object.keys(parsed).every((key) =>
          [
            'sessionId',
            'authority',
            'highWater',
            'sequence',
            'declarationId',
          ].includes(key),
        )
      )
        return undefined;
      const cursor = parsed as Record<string, unknown>;
      return typeof cursor.sessionId === 'string' &&
        typeof cursor.authority === 'string' &&
        Number.isSafeInteger(cursor.highWater) &&
        (cursor.highWater as number) >= 0 &&
        Number.isSafeInteger(cursor.sequence) &&
        (cursor.sequence as number) >= 0 &&
        typeof cursor.declarationId === 'string'
        ? {
            sessionId: cursor.sessionId,
            authority: cursor.authority,
            highWater: cursor.highWater as number,
            sequence: cursor.sequence as number,
            declarationId: cursor.declarationId,
          }
        : undefined;
    } catch {
      return undefined;
    }
  }

  issueSessionInventoryCursor(value: SessionInventoryCursor): string {
    const payload = Buffer.from(JSON.stringify(value), 'utf8').toString(
      'base64url',
    );
    const signature = createHmac('sha256', this.sessionInventoryCursorKey)
      .update(payload)
      .digest('base64url');
    return `station-inventory-cursor:v1:${payload}.${signature}`;
  }

  readSessionInventoryCursor(
    value: string,
  ): SessionInventoryCursor | undefined {
    const prefix = 'station-inventory-cursor:v1:';
    if (!value.startsWith(prefix)) return undefined;
    const encoded = value.slice(prefix.length);
    const separator = encoded.lastIndexOf('.');
    if (separator < 1 || separator === encoded.length - 1) return undefined;
    const payload = encoded.slice(0, separator);
    let actual: Buffer;
    try {
      actual = Buffer.from(encoded.slice(separator + 1), 'base64url');
    } catch {
      return undefined;
    }
    const expected = createHmac('sha256', this.sessionInventoryCursorKey)
      .update(payload)
      .digest();
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected))
      return undefined;
    try {
      const parsed: unknown = JSON.parse(
        Buffer.from(payload, 'base64url').toString('utf8'),
      );
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
        return undefined;
      const cursor = parsed as Record<string, unknown>;
      const keys = Object.keys(cursor);
      if (
        !keys.every((key) =>
          [
            'version',
            'sessionId',
            'authority',
            'scope',
            'turnId',
            'taskId',
            'groupId',
            'highWater',
            'contentDigest',
            'position',
            'pageSize',
            'pageStartSequence',
            'pageStartEventId',
            'nextSequence',
            'nextEventId',
          ].includes(key),
        ) ||
        keys.length < 8 ||
        (cursor.version !== 'station.session-inventory/v1' &&
          cursor.version !== 'station.session-inventory/v2') ||
        typeof cursor.sessionId !== 'string' ||
        typeof cursor.authority !== 'string' ||
        (cursor.scope !== 'whole-session' &&
          cursor.scope !== 'current-answer' &&
          cursor.scope !== 'kept-in-task') ||
        (cursor.turnId !== undefined && typeof cursor.turnId !== 'string') ||
        (cursor.taskId !== undefined && typeof cursor.taskId !== 'string') ||
        typeof cursor.groupId !== 'string' ||
        !Number.isSafeInteger(cursor.highWater) ||
        (cursor.highWater as number) < 0 ||
        typeof cursor.contentDigest !== 'string' ||
        !/^[a-f0-9]{64}$/.test(cursor.contentDigest) ||
        !Number.isSafeInteger(cursor.position) ||
        (cursor.position as number) < 0 ||
        (cursor.pageSize !== undefined &&
          (!Number.isSafeInteger(cursor.pageSize) ||
            (cursor.pageSize as number) < 1 ||
            (cursor.pageSize as number) > 20)) ||
        (cursor.pageStartSequence === undefined) !==
          (cursor.pageStartEventId === undefined) ||
        (cursor.nextSequence === undefined) !==
          (cursor.nextEventId === undefined) ||
        (cursor.pageStartSequence !== undefined &&
          (!Number.isSafeInteger(cursor.pageStartSequence) ||
            (cursor.pageStartSequence as number) < 0)) ||
        (cursor.nextSequence !== undefined &&
          (!Number.isSafeInteger(cursor.nextSequence) ||
            (cursor.nextSequence as number) < 0)) ||
        (cursor.pageStartEventId !== undefined &&
          typeof cursor.pageStartEventId !== 'string') ||
        (cursor.nextEventId !== undefined &&
          typeof cursor.nextEventId !== 'string')
      )
        return undefined;
      if (
        (cursor.scope === 'whole-session' &&
          (cursor.turnId !== undefined || cursor.taskId !== undefined)) ||
        (cursor.scope === 'current-answer' &&
          (typeof cursor.turnId !== 'string' || cursor.taskId !== undefined)) ||
        (cursor.scope === 'kept-in-task' &&
          (cursor.turnId !== undefined || typeof cursor.taskId !== 'string'))
      )
        return undefined;
      return cursor as SessionInventoryCursor;
    } catch {
      return undefined;
    }
  }

  /**
   * Complete typed input for the Whole Session inventory. The query is bound
   * to one exact thread and a closed method set; it selects no payload-bearing
   * vocabulary such as text/reasoning deltas, tool arguments/output, errors,
   * or metadata-only events. Consumers must still project descriptors rather
   * than return these canonical payloads directly.
   */
  listSessionInventoryEvents(
    threadId: string,
    input: {
      frozenHighWater?: number;
      continuation?: SessionInventoryEventPageCursor;
      group?: SessionInventoryEventGroup;
      limit?: number;
    } = {},
  ): SessionInventoryEventRead {
    const currentHighWater = this.readSessionInventoryHighWater(threadId);
    // A continuation owns its earlier watermark. Later appends belong to a
    // fresh inventory read; a deletion/mutation below the watermark is caught
    // by the descriptor digest at the caller, rather than shifted forward.
    const highWater = input.frozenHighWater ?? currentHighWater;
    const limit = Math.min(
      SESSION_INVENTORY_EVENT_PAGE_MAX + 1,
      Math.max(1, input.limit ?? SESSION_INVENTORY_EVENT_PAGE_MAX),
    );
    const methods = input.group
      ? SESSION_INVENTORY_GROUP_METHODS[input.group]
      : SESSION_INVENTORY_EVENT_METHODS;
    const placeholders = methods.map(() => '?').join(', ');
    const rows = (
      this.db
        .prepare(
          `SELECT id, provider, turn_id, method, sequence,
             json_extract(payload, '$.turnId') AS event_turn_id,
             json_extract(payload, '$.inputKind') AS input_kind,
             json_extract(payload, '$.toolCallId') AS tool_call_id,
             json_extract(payload, '$.toolName') AS tool_name,
             json_extract(payload, '$.status') AS status,
             json_extract(payload, '$.requestId') AS request_id,
             json_extract(payload, '$.model') AS model,
             json_extract(payload, '$.promptTokens') AS prompt_tokens,
             json_extract(payload, '$.completionTokens') AS completion_tokens,
             json_extract(payload, '$.cacheReadTokens') AS cache_read_tokens,
             json_extract(payload, '$.reportedCostUsd') AS reported_cost_usd,
             CASE WHEN method = 'turn.started' THEN (
               SELECT json_group_array(json_object(
                 'name', json_extract(value, '$.name'),
                 'mediaType', json_extract(value, '$.mimeType'),
                 'length', json_extract(value, '$.size')
               )) FROM json_each(json_extract(payload, '$.attachments'))
             ) ELSE '[]' END AS attachments
           FROM orchestration_events
           WHERE thread_id = ?
             AND sequence <= ?
             AND method IN (${placeholders})
             AND (
               ? IS NULL
               OR sequence > ?
               OR (sequence = ? AND id > ?)
             )
           ORDER BY sequence ASC, id ASC
           LIMIT ?`,
        )
        .all(
          threadId,
          highWater,
          ...methods,
          input.continuation?.sequence ?? null,
          input.continuation?.sequence ?? 0,
          input.continuation?.sequence ?? 0,
          input.continuation?.eventId ?? '',
          limit + 1,
        ) as any[]
    ).map((row: any) => this.projectSessionInventoryEventRow(row));
    const events = rows.slice(0, limit);
    const last = events.at(-1);
    return {
      events,
      highWater,
      ...(rows.length > limit && last
        ? { continuation: { sequence: last.sequence, eventId: last.id } }
        : {}),
    };
  }

  private projectSessionInventoryEventRow(
    row: Record<string, unknown>,
  ): SessionInventoryEventDescriptor {
    const id = row.id as string;
    const sequence = row.sequence as number;
    switch (row.method) {
      case 'turn.started':
        return {
          id,
          sequence,
          method: 'turn.started',
          turnId: (row.event_turn_id ?? row.turn_id) as string,
          ...(row.input_kind === 'steer'
            ? { inputKind: 'steer' as const }
            : {}),
          attachments: JSON.parse((row.attachments as string) || '[]') as {
            name: string;
            mediaType: string;
            length: number;
          }[],
        };
      case 'tool.completed':
        return {
          id,
          sequence,
          method: 'tool.completed',
          turnId: (row.event_turn_id ?? row.turn_id ?? '') as string,
          toolCallId: row.tool_call_id as string,
          name: row.tool_name as string,
          terminalStatus:
            row.status === 'success'
              ? 'succeeded'
              : row.status === 'error'
                ? 'failed'
                : 'cancelled',
        };
      case 'request.resolved':
        return {
          id,
          sequence,
          method: 'request.resolved',
          requestId: row.request_id as string,
          status:
            row.status === 'approved'
              ? 'accepted'
              : row.status === 'denied'
                ? 'declined'
                : row.status === 'cancelled'
                  ? 'cancelled'
                  : 'pending',
        };
      case 'session.configured':
        return {
          id,
          sequence,
          method: 'session.configured',
          ...(typeof row.model === 'string' ? { model: row.model } : {}),
          ...(typeof row.provider === 'string' ? { engine: row.provider } : {}),
        };
      case 'token-usage.updated':
        return {
          id,
          sequence,
          method: 'token-usage.updated',
          ...(typeof row.prompt_tokens === 'number'
            ? { inputTokens: row.prompt_tokens }
            : {}),
          ...(typeof row.completion_tokens === 'number'
            ? { outputTokens: row.completion_tokens }
            : {}),
          ...(typeof row.cache_read_tokens === 'number'
            ? { cachedTokens: row.cache_read_tokens }
            : {}),
          ...(typeof row.reported_cost_usd === 'number'
            ? { costMicros: Math.round(row.reported_cost_usd * 1_000_000) }
            : {}),
        };
      default:
        throw new Error('Unsupported Session inventory event');
    }
  }

  readSessionInventoryHighWater(threadId: string): number {
    return (
      (
        this.db
          .prepare(
            `SELECT COALESCE(MAX(sequence), 0) AS high_water
           FROM orchestration_events WHERE thread_id = ?`,
          )
          .get(threadId) as { high_water?: number } | undefined
      )?.high_water ?? 0
    );
  }

  /**
   * Compose the operational-event authority without exposing SQLite or a
   * generic table API. Runtime wiring supplies only its notification Adapter.
   */
  createOperationalEventPublisher(
    notification?: OperationalEventNotificationAdapter,
  ): OperationalEventPublisher {
    const outbox = this.composeOperationalEventOutbox(notification);
    return Object.freeze({ append: (value: unknown) => outbox.append(value) });
  }

  /**
   * Deliberate composition seam for durable Project/Task rooms.  The caller
   * provides server-owned identity and authority adapters; it never receives
   * SQLite, a table name, an event-store append API, or a channel selection.
   */
  createProjectTaskRoomHistory(input: {
    capabilities: ProjectTaskRoomCapabilityAuthority;
    links?: ProjectTaskRoomLinkAuthority;
    agents?: ProjectTaskRoomAgentGrantAuthority;
    /** Test-only response-loss seam for sequential-instance recovery proof. */
    unavailableAfterCommitOnce?: boolean;
  }): ProjectTaskRoomHistory {
    const history = createProjectTaskRoomHistory({
      databasePath: this.databasePath,
      ...input,
    });
    this.projectTaskRoomHistories.add(history);
    return history;
  }

  /** Private working-state worker over this exact orchestration SQLite file. */
  createProjectTaskRoomWorkingState(input?: {
    maxRetainedOperations?: number;
    maxWorkingSnapshotBytes?: number;
    responseTimeoutMs?: number;
  }): ProjectTaskRoomWorkingState {
    return createProjectTaskRoomWorkingState(this.databasePath, input);
  }

  /**
   * Compose immutable revision/evidence receipts over this exact EventStore.
   * The returned archive#2891 Module and its scope-bound reader never expose SQLite,
   * storage paths, rows, or a generic CRUD surface.
   */
  createRevisionEvidenceModule(input: {
    attribution: RevisionAttributionAuthority;
    proposedChanges?: CanonicalProposedChangeLookup;
    maxRevisions?: number;
    maxImportEntries?: number;
    maxImportBytes?: number;
    maxSnapshotBytes?: number;
    maxTextBytes?: number;
    maxRecordBytes?: number;
    /** Test-only receipt-loss seam after SQLite commits. */
    unavailableAfterCommitOnce?: () => boolean;
    /** Test-only peer barrier after restore and before the write transaction. */
    beforePersistOnce?: () => void;
    /** Test-only lifecycle re-entry after COMMIT and before adapter return. */
    afterPersistCommitOnce?: () => void;
  }): RevisionEvidenceModule {
    const {
      unavailableAfterCommitOnce,
      beforePersistOnce,
      afterPersistCommitOnce,
      ...moduleOptions
    } = input;
    const module = new RevisionEvidenceModule({
      ...moduleOptions,
      deferPersistenceRestore: true,
      persistence: createSqliteRevisionEvidencePersistence(this.db, {
        unavailableAfterCommitOnce,
        beforePersistOnce,
        afterPersistCommitOnce,
      }),
    });
    this.revisionEvidenceModules.add(module);
    module.initializePersistence();
    return module;
  }

  operationalEventReader(): OperationalEventReader {
    const outbox = this.composeOperationalEventOutbox();
    return Object.freeze({
      readAfter: (input: Parameters<OperationalEventReader['readAfter']>[0]) =>
        outbox.readAfter(input),
    });
  }

  openOperationalEventConsumer(
    config: OperationalEventConsumerConfig,
  ): OperationalEventConsumerOpenOutcome {
    const opened = openOperationalEventConsumer({
      coordinator: createSqliteOperationalEventDeliveryCoordinator({
        database: this.db,
      }),
      config,
      processIdentity: this.recoveryProcessIdentity,
    });
    if (opened.kind !== 'opened') return opened;
    const inner = opened.consumer;
    let closed = false;
    const consumer = Object.freeze<OperationalEventConsumer>({
      claim: () => inner.claim(),
      deadLetters: () => inner.deadLetters(),
      close: () => {
        if (closed) return;
        closed = true;
        inner.close();
        this.operationalEventConsumers.delete(consumer);
      },
    });
    this.operationalEventConsumers.add(consumer);
    return { kind: 'opened', consumer };
  }

  createOperationalEventSubscriptionRegistry(
    authorizer: OperationalEventSubscriptionAuthorizer,
  ): OperationalEventSubscriptionRegistry {
    const inner = createOperationalEventSubscriptionRegistry({
      authorizer,
      openConsumer: (config) => this.openOperationalEventConsumer(config),
    });
    const registry = Object.freeze<OperationalEventSubscriptionRegistry>({
      open: (input) => inner.open(input),
      close: () => {
        const outcome = inner.close();
        if (outcome.kind === 'closed')
          this.operationalEventSubscriptionRegistries.delete(registry);
        return outcome;
      },
    });
    this.operationalEventSubscriptionRegistries.add(registry);
    return registry;
  }

  private composeOperationalEventOutbox(
    notification?: OperationalEventNotificationAdapter,
  ) {
    const coordinator = createSqliteOperationalEventCoordinator({
      database: this.db,
    });
    return createOperationalEventOutbox({ coordinator, notification });
  }

  /**
   * The persisted form of an event: identical, except that a `turn.started`'s
   * attachment bytes are replaced by a content-addressed reference
   * (archive#3374).
   *
   * This projection is also used for the live event bus. A blob write failure
   * therefore rejects the turn event before it can persist or reach SSE; raw
   * attachment bytes are never an acceptable fallback projection.
   */
  private persistedForm(event: CanonicalRuntimeEvent): {
    payload: CanonicalRuntimeEvent;
    blobRefs: string[];
  } {
    if (event.method !== 'turn.started' || !event.attachments?.length) {
      return { payload: event, blobRefs: [] };
    }
    if (
      event.attachments.some((attachment) => attachment.dataUrl !== undefined)
    ) {
      // The ingress projector has already checked the exact byte-bearing path
      // without invoking caller code. This shared validator completes the
      // canonical descriptor/type/declared-size contract before any blob is
      // written, and deliberately rejects mixed raw/reference input.
      const attachmentError = validateChatAttachments(
        event.attachments as Parameters<typeof validateChatAttachments>[0],
      );
      if (attachmentError) throw new EventStoreIngressError(attachmentError);
    }
    const blobRefs: string[] = [];
    let stripped = 0;
    const attachments = event.attachments.map(
      (attachment): PersistedChatAttachment => {
        if (attachment.dataUrl === undefined) {
          if (isAttachmentBlobRef(attachment.blobRef))
            blobRefs.push(attachment.blobRef);
          return attachment;
        }
        const parsed = parseChatAttachmentDataUrl(attachment.dataUrl);
        if (!parsed)
          throw new Error(
            'Attachment projection rejected an invalid data URL.',
          );
        const ref = this.attachmentBlobs.write(parsed.base64);
        if (!ref)
          throw new Error(
            'Attachment projection could not store attachment bytes.',
          );
        blobRefs.push(ref);
        stripped += attachment.dataUrl.length;
        const { dataUrl: _bytes, ...metadata } = attachment;
        return { ...metadata, blobRef: ref };
      },
    );
    if (stripped === 0) return { payload: event, blobRefs };
    try {
      // Guarded, and the reference is inside the try: a partial test double of
      // the metrics module makes the NAME throw on access, not the `.add`.
      // Telemetry observes persistence; it never decides it.
      attachmentBytesStripped.add(stripped, { provider: event.provider });
    } catch {
      // Observation only.
    }
    return { payload: { ...event, attachments }, blobRefs };
  }

  /**
   * One ingress seam for every runtime-event insert. The bounded projector
   * makes a data-only copy before any attachment write or database work; the
   * following stringify therefore cannot invoke a caller's getter/proxy or
   * allocate an unbounded JSON payload.
   */
  private prepareEventIngress(event: CanonicalRuntimeEvent): {
    event: CanonicalRuntimeEvent;
    requestId: ReturnType<typeof persistedRequestId>;
    persisted: { payload: CanonicalRuntimeEvent; blobRefs: string[] };
    serializedPayload: string;
  } {
    const projectedEvent = new BoundedEventStoreIngressProjector().project(
      event,
      { allowCanonicalAttachmentDataUrls: true },
    ) as unknown as CanonicalRuntimeEvent;
    this.assertOwnershipImmutable(projectedEvent);
    const persisted = this.persistedForm(projectedEvent);
    // Attachment projection can replace a very small inline data URL with a
    // longer digest reference, so measure its persisted shape independently.
    // It is now a plain projected value, not caller-controlled structure.
    const persistedPayload = new BoundedEventStoreIngressProjector().project(
      persisted.payload,
    );
    return {
      event: projectedEvent,
      requestId: persistedRequestId(projectedEvent),
      persisted,
      serializedPayload: JSON.stringify(persistedPayload),
    };
  }

  /**
   * The only event shape allowed to leave a provider-facing server seam. It
   * writes the server-only blob before any live or persisted projection and
   * throws rather than falling back to a data URL.
   */
  projectLiveEvent(event: CanonicalRuntimeEvent): CanonicalRuntimeEvent {
    return this.prepareEventIngress(event).persisted.payload;
  }

  /**
   * Bind blobs to the thread that referenced them, inside the caller's
   * savepoint so the binding cannot outlive or precede its event.
   */
  private recordAttachmentRefs(threadId: string, blobRefs: string[]): void {
    if (blobRefs.length === 0) return;
    const insert = this.db.prepare(
      `INSERT OR IGNORE INTO orchestration_attachment_refs (blob_ref, thread_id)
       VALUES (?, ?)`,
    );
    for (const ref of blobRefs) insert.run(ref, threadId);
  }

  /**
   * Every thread bound to `ref`, unnarrowed. Diagnostics and tests only — the
   * blob route must use {@link listAttachmentCandidateThreads}, whose cost and
   * timing do not depend on how many threads reference the blob.
   */
  listAttachmentThreads(ref: string): string[] {
    if (!isAttachmentBlobRef(ref)) return [];
    return (
      this.db
        .prepare(
          `SELECT thread_id FROM orchestration_attachment_refs WHERE blob_ref = ?`,
        )
        .all(ref) as Array<{ thread_id: string }>
    ).map((row) => row.thread_id);
  }

  /**
   * Threads bound to `ref` that `ownerUserId` could plausibly read, bounded.
   *
   * This is a NARROWING, never an authorization: it can only ever return
   * fewer candidates than are bound, and the caller still puts every one
   * through the real session-read predicate. A false negative here refuses a
   * read; a false positive cannot grant one.
   *
   * It exists because "check every bound thread" leaked through the clock
   * (archive#3385 review). An unbound digest cost zero predicate calls while a
   * digest bound to N unreadable threads cost N — and the owner fold behind
   * that predicate deliberately never caches a negative, at ~4.4ms of
   * synchronous work each. Response time therefore answered the exact question
   * the 404 refuses to: does anyone on this Station hold these bytes. Filtering
   * by owner in SQL collapses "bound to threads you cannot read" onto "not
   * bound at all" — both return zero rows and cost zero predicate calls — and
   * `LIMIT` keeps the authorized path off N as well.
   *
   * `owner_user_id` comes from the conversation-history projection, which
   * materializes the same `metadata.userId` the owner fold reads, written on
   * this same append path. Rows with no owner stay candidates: an ownerless
   * session is the `single-user-compat` case, which only the real predicate
   * may decide, and a Station with one user has no cross-user disclosure to
   * make.
   */
  listAttachmentCandidateThreads(
    ref: string,
    ownerUserId: string | undefined,
    limit = ATTACHMENT_CANDIDATE_THREAD_LIMIT,
  ): string[] {
    if (!isAttachmentBlobRef(ref)) return [];
    return (
      this.db
        .prepare(
          `SELECT r.thread_id
             FROM orchestration_attachment_refs r
             LEFT JOIN orchestration_conversation_history h
               ON h.thread_id = r.thread_id
            WHERE r.blob_ref = ?
              AND (h.owner_user_id IS NULL OR h.owner_user_id = ?)
            LIMIT ?`,
        )
        .all(ref, ownerUserId ?? null, limit) as Array<{ thread_id: string }>
    ).map((row) => row.thread_id);
  }

  /**
   * Put the bytes back, where they are still there. An attachment whose blob
   * retention has reclaimed keeps its `blobRef` and gains no `dataUrl` — the
   * transcript projection renders it as a chip without a preview rather than
   * dropping it, so a reclaimed attachment stays visible as something the turn
   * carried instead of becoming a hole.
   *
   * Rows written before the blob store existed already carry `dataUrl` and are
   * returned untouched; there is no migration, only a read that handles both.
   */
  private hydrateAttachments(
    event: PersistedRuntimeEvent,
  ): PersistedRuntimeEvent {
    const payload = event.payload;
    if (payload.method !== 'turn.started' || !payload.attachments?.length) {
      return event;
    }
    let changed = false;
    const attachments = payload.attachments.map(
      (attachment): PersistedChatAttachment => {
        if (attachment.dataUrl !== undefined) return attachment;
        if (!isAttachmentBlobRef(attachment.blobRef)) return attachment;
        const base64 = this.attachmentBlobs.read(attachment.blobRef);
        if (base64 === undefined) return attachment;
        changed = true;
        return {
          ...attachment,
          dataUrl: `data:${attachment.mimeType};base64,${base64}`,
        };
      },
    );
    return changed ? { ...event, payload: { ...payload, attachments } } : event;
  }

  /**
   * Row mapper for every read that owes its caller the complete turn — the
   * transcript projection and, critically, recovery's re-dispatch of a
   * recorded turn.
   *
   * Three reads deliberately use the plain mapper instead and hand on the
   * reference, because inflating megabytes of image into them is the thing
   * this design exists to prevent:
   * - `listEventWindowByTurn` — byte-budgeted; hydrating pushes `turn.started`
   *   past `snapshotEvent`'s ceiling, which strips the payload entirely.
   * - `listEventsAfterGlobalSequence` — the SSE replay, whose frame budget is
   *   computed from the STORED payload length.
   * - `listEventPage` — bounded by an event COUNT, not by bytes, so hydrating
   *   it would make one page's response the sum of its attachments with
   *   nothing to cap it.
   *
   * Their consumers render the reference through the transcript projection's
   * chip, and `GET /api/attachments/:ref` fetches the bytes on demand.
   */
  private mapEventRow(row: any): PersistedRuntimeEvent {
    return this.hydrateAttachments(mapPersistedEventRow(row));
  }

  appendEvent(
    event: CanonicalRuntimeEvent,
    declaredOutputs: readonly NativeOutputTerminalAdmission[] = [],
  ): number {
    if (
      declaredOutputs.length > 0 &&
      (event.method !== 'turn.completed' || !event.turnId)
    ) {
      throw new Error(
        'Declared output admission requires a durable completed turn.',
      );
    }
    const ingress = this.prepareEventIngress(event);
    event = ingress.event;
    const startedAt = performance.now();
    const { requestId, persisted, serializedPayload } = ingress;
    // Blob writes happen here, before the savepoint: they are filesystem work
    // that must not run inside a SQLite transaction, and a failed write
    // rejects the append rather than falling back to inline bytes.
    //
    // A rollback below — or `appendEventIfAbsent` skipping a duplicate — can
    // therefore leave bytes on disk that no binding references. They are
    // unreachable (the route authorizes through bindings, and there are none)
    // and bounded by retention, so they are wasted space rather than exposure.
    let workItemAdmission: SessionWorkItemTerminalAdmission | undefined;
    // An opening failure is intentionally outside the try: no candidate has
    // been taken yet, so there is no process-local claim to settle.
    this.openAppendEventSavepoint();
    let nextSequence: number;
    try {
      // Persisted event time is the sole replay authority. A new terminal gets
      // exactly one host observation time, shared by its event and association.
      const observedAt =
        this.readPersistedEventObservedAt(event.eventId) ??
        new Date().toISOString();
      workItemAdmission = this.takeSessionWorkItemAdmission(event, observedAt);
      nextSequence = this.nextSequence(event.threadId);
      const insert = this.db
        .prepare(
          `${declaredOutputs.length || event.method === 'tool.completed' ? 'INSERT OR IGNORE' : 'INSERT'} INTO orchestration_events
          (id, provider, thread_id, turn_id, method, request_id, session_state, payload, created_at, observed_at, sequence, global_sequence)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          event.eventId,
          event.provider,
          event.threadId,
          event.turnId ?? null,
          event.method,
          requestId,
          event.sessionState ?? null,
          serializedPayload,
          event.createdAt,
          observedAt,
          nextSequence,
          this.nextGlobalSequence(),
        ) as { changes: number };
      if (insert.changes === 0) {
        // Exact terminal event replay is idempotent only when every opaque
        // handle was already consumed by that same event. A different event
        // never gets to redeem it.
        const existing = this.db
          .prepare(
            `SELECT sequence, provider, thread_id, turn_id, method, payload, created_at, observed_at
             FROM orchestration_events WHERE id = ?`,
          )
          .get(event.eventId) as
          | {
              sequence?: number;
              provider?: string;
              thread_id?: string;
              turn_id?: string | null;
              method?: string;
              payload?: string;
              created_at?: string;
              observed_at?: string | null;
            }
          | undefined;
        const uses = this.db.prepare(
          'SELECT event_id FROM orchestration_declared_output_handle_uses WHERE handle = ?',
        );
        const storedDeclarations = this.db
          .prepare(
            `SELECT declaration_id, thread_id, turn_id, tool_call_id, declared_at, label, descriptor
           FROM orchestration_declared_outputs WHERE event_id = ? ORDER BY declaration_id`,
          )
          .all(event.eventId) as Array<{
          declaration_id: string;
          thread_id: string;
          turn_id: string;
          tool_call_id: string;
          declared_at: string;
          label: string | null;
          descriptor: string;
        }>;
        const expectedDeclarations = [...declaredOutputs]
          .map((admission) => admission.declaration)
          .sort((a, b) => a.declarationId.localeCompare(b.declarationId));
        const storedAssociation = this.readStoredSessionWorkItemAssociation(
          event.eventId,
        );
        if (
          !existing ||
          existing.provider !== event.provider ||
          existing.thread_id !== event.threadId ||
          existing.turn_id !== (event.turnId ?? null) ||
          existing.method !== event.method ||
          existing.created_at !== event.createdAt ||
          existing.payload !== serializedPayload ||
          storedDeclarations.length !== expectedDeclarations.length ||
          declaredOutputs.some(
            (admission) =>
              (uses.get(admission.handle) as { event_id?: string } | undefined)
                ?.event_id !== event.eventId,
          ) ||
          storedDeclarations.some((stored, index) => {
            const expected = expectedDeclarations[index];
            return (
              !expected ||
              stored.declaration_id !== expected.declarationId ||
              stored.thread_id !== expected.sessionId ||
              stored.turn_id !== expected.turnId ||
              stored.tool_call_id !== expected.toolCallId ||
              stored.declared_at !== expected.declaredAt ||
              stored.label !== (expected.label ?? null) ||
              stored.descriptor !== JSON.stringify(expected.descriptor)
            );
          }) ||
          !this.matchesWorkItemReplay(
            event,
            workItemAdmission,
            storedAssociation,
            existing?.observed_at,
          )
        ) {
          throw new Error(
            'Declared output admission replay does not match its original terminal event.',
          );
        }
        this.db.exec('RELEASE SAVEPOINT append_event_history');
        this.commitSessionWorkItemAdmission(workItemAdmission);
        return Number(existing.sequence);
      }
      this.recordAttachmentRefs(event.threadId, persisted.blobRefs);
      this.projectConversationHistoryEvent(event);
      this.projectMessageSearchEvent(event);
      this.projectRequestState(event, requestId, nextSequence);
      this.projectSessionProjectionFacts(event);
      this.recordDeclaredOutputs(event, declaredOutputs);
      if (workItemAdmission) this.sessionWorkItemAdmissionFault?.();
      if (workItemAdmission?.kind === 'association')
        this.recordSessionWorkItemAssociation(
          event,
          workItemAdmission.association,
        );
      this.db.exec('RELEASE SAVEPOINT append_event_history');
      this.commitSessionWorkItemAdmission(workItemAdmission);
    } catch (error) {
      try {
        this.db.exec(
          'ROLLBACK TO SAVEPOINT append_event_history; RELEASE SAVEPOINT append_event_history',
        );
      } finally {
        // A SQLite rollback error cannot strand a claim; its candidate must be
        // retryable unless the savepoint release above already committed it.
        this.rollbackSessionWorkItemAdmission(workItemAdmission);
      }
      throw error;
    }
    // archive#3433: deliberately OUTSIDE the transaction's error boundary
    // (a throwing instrument here must not be caught as a store failure and
    // answered with a ROLLBACK against a transaction that has already
    // committed), and guarded so it cannot fail THIS call either — see
    // {@link observeEventPersisted}. The row is already committed; a caller
    // must see this append succeed, not fail because an exporter is down.
    observeEventPersisted(
      () => orchestrationEventsPersisted,
      () => orchestrationEventPersistDuration,
      performance.now() - startedAt,
      { provider: event.provider, method: event.method },
    );
    return nextSequence;
  }

  /** Stages a reviewed, pre-terminal candidate without exposing the registry. */
  stageSessionWorkItemCandidate(input: {
    candidate: SessionWorkItemCandidate;
    current: () => boolean;
  }) {
    return this.sessionWorkItemAdmissions.stage(input);
  }

  private openAppendEventSavepoint(): void {
    this.sessionWorkItemSavepointOpenFault?.();
    this.db.exec('SAVEPOINT append_event_history');
  }

  private readPersistedEventObservedAt(eventId: string): string | undefined {
    const row = this.db
      .prepare(
        `SELECT observed_at, typeof(observed_at) AS observed_at_type
           FROM orchestration_events WHERE id = ?`,
      )
      .get(eventId) as
      | { observed_at?: unknown; observed_at_type?: unknown }
      | undefined;
    if (!row) return undefined;
    if (
      row.observed_at_type !== 'text' ||
      typeof row.observed_at !== 'string' ||
      row.observed_at.length === 0
    )
      throw new SessionWorkItemObservationCorruptionError();
    return row.observed_at;
  }

  /** Descriptor-only internal read; callers must project its closed contract. */
  listSessionWorkItemObservations(input: {
    sessionId: string;
    conversationId: string;
  }): readonly unknown[] {
    const rows = this.db
      .prepare(
        `SELECT rowid AS row_id, association_id, session_id, conversation_id,
                event_id, turn_id, tool_call_id, observed_at,
                typeof(association_json) AS association_json_type,
                LENGTH(CAST(association_json AS BLOB)) AS association_json_bytes
          FROM orchestration_session_work_item_associations
          WHERE session_id = ? AND conversation_id = ?
          ORDER BY observed_at ASC, association_id ASC
          LIMIT ?`,
      )
      .all(
        input.sessionId,
        input.conversationId,
        SESSION_WORK_ITEM_READ_MAX_OBSERVATIONS + 1,
      ) as SessionWorkItemAssociationMetadataRow[];
    try {
      let totalBytes = 0;
      for (const row of rows) {
        this.assertSessionWorkItemAssociationMetadata(row);
        totalBytes += row.association_json_bytes as number;
        if (totalBytes > SESSION_WORK_ITEM_READ_MAX_SERIALIZED_BYTES)
          throw new SessionWorkItemObservationCorruptionError();
      }
      return rows.map((row) => this.readSessionWorkItemAssociationContent(row));
    } catch (error) {
      if (error instanceof SessionWorkItemObservationCorruptionError)
        throw error;
      throw new SessionWorkItemObservationCorruptionError();
    }
  }

  private takeSessionWorkItemAdmission(
    event: CanonicalRuntimeEvent,
    observedAt: string,
  ): SessionWorkItemTerminalAdmission | undefined {
    if (event.method !== 'tool.completed' || !event.turnId || !event.toolCallId)
      return undefined;
    const conversationId = this.conversationSessionLineage.sessionForExecution(
      event.threadId,
    )?.conversationId;
    if (!conversationId) return undefined;
    const taken = this.sessionWorkItemAdmissions.take({
      eventId: event.eventId,
      threadId: event.threadId,
      conversationId,
      turnId: event.turnId,
      toolCallId: event.toolCallId,
      method: event.method,
      status: event.status,
      observedAt,
    });
    if (taken.kind === 'taken')
      return {
        kind: 'association',
        claim: taken.claim,
        association: taken.association,
      };
    return taken.kind === 'closed'
      ? { kind: 'closed', claim: taken.claim }
      : undefined;
  }

  private commitSessionWorkItemAdmission(
    admission: SessionWorkItemTerminalAdmission | undefined,
  ): void {
    if (!admission) return;
    // This can only reject if EventStore itself double-settles a private claim.
    // Do not throw after RELEASE: persistence is already authoritative.
    this.sessionWorkItemAdmissions.commit(admission.claim);
  }

  private rollbackSessionWorkItemAdmission(
    admission: SessionWorkItemTerminalAdmission | undefined,
  ): void {
    if (!admission) return;
    this.sessionWorkItemAdmissions.rollback(admission.claim);
  }

  private recordSessionWorkItemAssociation(
    event: CanonicalRuntimeEvent,
    association: SessionWorkItemAssociation,
  ): void {
    if (
      event.method !== 'tool.completed' ||
      association.sessionId !== event.threadId ||
      association.eventId !== event.eventId ||
      association.turnId !== event.turnId ||
      association.toolCallId !== event.toolCallId
    )
      throw new Error('Invalid Session work-item admission.');
    this.db
      .prepare(
        `INSERT INTO orchestration_session_work_item_associations
         (association_id, session_id, conversation_id, event_id, turn_id, tool_call_id, observed_at, association_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        association.associationId,
        association.sessionId,
        association.conversationId,
        association.eventId,
        association.turnId,
        association.toolCallId,
        association.observedAt,
        JSON.stringify(association),
      );
  }

  private readStoredSessionWorkItemAssociation(
    eventId: string,
  ): SessionWorkItemAssociation | undefined {
    const rows = this.db
      .prepare(
        `SELECT rowid AS row_id, association_id, session_id, conversation_id,
                event_id, turn_id, tool_call_id, observed_at,
                typeof(association_json) AS association_json_type,
                LENGTH(CAST(association_json AS BLOB)) AS association_json_bytes
           FROM orchestration_session_work_item_associations
          WHERE event_id = ?
          ORDER BY association_id ASC
          LIMIT 2`,
      )
      .all(eventId) as Array<Record<string, unknown>>;
    if (rows.length === 0) return undefined;
    let totalBytes = 0;
    for (const row of rows) {
      this.assertSessionWorkItemAssociationMetadata(row);
      totalBytes += row.association_json_bytes as number;
      if (totalBytes > SESSION_WORK_ITEM_READ_MAX_SERIALIZED_BYTES)
        throw new SessionWorkItemObservationCorruptionError();
    }
    if (rows.length !== 1)
      throw new SessionWorkItemObservationCorruptionError();
    try {
      return this.readSessionWorkItemAssociationContent(rows[0]!);
    } catch (error) {
      if (error instanceof SessionWorkItemObservationCorruptionError)
        throw error;
      throw new SessionWorkItemObservationCorruptionError();
    }
  }

  private matchesWorkItemReplay(
    event: CanonicalRuntimeEvent,
    admission: SessionWorkItemTerminalAdmission | undefined,
    stored: SessionWorkItemAssociation | undefined,
    eventObservedAt: unknown,
  ): boolean {
    if (stored) {
      if (
        event.method !== 'tool.completed' ||
        stored.sessionId !== event.threadId ||
        stored.eventId !== event.eventId ||
        stored.turnId !== event.turnId ||
        stored.toolCallId !== event.toolCallId ||
        stored.observedAt !== eventObservedAt
      )
        return false;
    }
    if (admission?.kind === 'association')
      return JSON.stringify(admission.association) === JSON.stringify(stored);
    return admission?.kind !== 'closed' || !stored;
  }

  /**
   * Second pass after metadata admission. CASE guarantees an oversized value
   * reaches the adapter as NULL, and repeated metadata closes the mutation
   * window between the two reads.
   */
  private readSessionWorkItemAssociationContent(
    metadata: SessionWorkItemAssociationMetadataRow,
  ): SessionWorkItemAssociation {
    this.assertSessionWorkItemAssociationMetadata(metadata);
    const row = this.db
      .prepare(
        `SELECT rowid AS row_id, association_id, session_id, conversation_id,
                event_id, turn_id, tool_call_id, observed_at,
                typeof(association_json) AS association_json_type,
                LENGTH(CAST(association_json AS BLOB)) AS association_json_bytes,
                CASE
                  WHEN typeof(association_json) = 'text'
                   AND LENGTH(CAST(association_json AS BLOB)) BETWEEN 1 AND ?
                  THEN association_json
                  ELSE NULL
                END AS association_json
           FROM orchestration_session_work_item_associations
          WHERE rowid = ?`,
      )
      .get(MAX_SESSION_WORK_ITEM_ASSOCIATION_ROW_BYTES, metadata.row_id) as
      | Record<string, unknown>
      | undefined;
    if (!row) throw new SessionWorkItemObservationCorruptionError();
    this.assertSessionWorkItemAssociationMetadata(row);
    if (
      typeof row.association_json !== 'string' ||
      row.row_id !== metadata.row_id ||
      row.association_id !== metadata.association_id ||
      row.session_id !== metadata.session_id ||
      row.conversation_id !== metadata.conversation_id ||
      row.event_id !== metadata.event_id ||
      row.turn_id !== metadata.turn_id ||
      row.tool_call_id !== metadata.tool_call_id ||
      row.observed_at !== metadata.observed_at ||
      row.association_json_type !== metadata.association_json_type ||
      row.association_json_bytes !== metadata.association_json_bytes
    )
      throw new SessionWorkItemObservationCorruptionError();
    const parsed = parseSessionWorkItemAssociation(
      JSON.parse(row.association_json) as unknown,
    );
    if (
      !parsed ||
      parsed.associationId !== row.association_id ||
      parsed.sessionId !== row.session_id ||
      parsed.conversationId !== row.conversation_id ||
      parsed.eventId !== row.event_id ||
      parsed.turnId !== row.turn_id ||
      parsed.toolCallId !== row.tool_call_id ||
      parsed.observedAt !== row.observed_at
    )
      throw new SessionWorkItemObservationCorruptionError();
    return parsed;
  }

  private assertSessionWorkItemAssociationMetadata(
    row: Record<string, unknown>,
  ): asserts row is Record<string, string | number> {
    if (
      !Number.isSafeInteger(row.row_id) ||
      (row.row_id as number) < 1 ||
      row.association_json_type !== 'text' ||
      !Number.isSafeInteger(row.association_json_bytes) ||
      (row.association_json_bytes as number) < 1 ||
      (row.association_json_bytes as number) >
        MAX_SESSION_WORK_ITEM_ASSOCIATION_ROW_BYTES
    )
      throw new SessionWorkItemObservationCorruptionError();
    for (const key of [
      'association_id',
      'session_id',
      'conversation_id',
      'event_id',
      'turn_id',
      'tool_call_id',
      'observed_at',
    ])
      if (typeof row[key] !== 'string')
        throw new SessionWorkItemObservationCorruptionError();
  }

  /** Called inside appendEvent's savepoint after the terminal row exists. */
  private recordDeclaredOutputs(
    event: CanonicalRuntimeEvent,
    admissions: readonly NativeOutputTerminalAdmission[],
  ): void {
    if (admissions.length === 0) return;
    const use = this.db.prepare(
      'INSERT INTO orchestration_declared_output_handle_uses (handle, event_id) VALUES (?, ?)',
    );
    const output = this.db.prepare(
      `INSERT INTO orchestration_declared_outputs
       (event_id, declaration_id, thread_id, turn_id, tool_call_id, declared_at, label, descriptor)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const admission of admissions) {
      const declaration = admission.declaration;
      if (
        declaration.sessionId !== event.threadId ||
        declaration.eventId !== event.eventId ||
        declaration.turnId !== event.turnId ||
        declaration.version !== 'declared-output/v1' ||
        JSON.stringify(declaration.descriptor).length > 16 * 1024
      ) {
        throw new Error('Invalid declared output admission.');
      }
      use.run(admission.handle, event.eventId);
      output.run(
        event.eventId,
        declaration.declarationId,
        declaration.sessionId,
        declaration.turnId,
        declaration.toolCallId,
        declaration.declaredAt,
        declaration.label ?? null,
        JSON.stringify(declaration.descriptor),
      );
    }
  }

  /** Additive migration: a NULL legacy value is an explicit coverage gap. */
  private ensureObservedAtColumn(): void {
    try {
      this.db.exec(
        'ALTER TABLE orchestration_events ADD COLUMN observed_at TEXT',
      );
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !error.message.includes('duplicate column name')
      ) {
        throw error;
      }
    }
  }

  /** Additive index for the bounded owner/window receipt reader on old DBs. */
  private ensureUsageReceiptIndex(): void {
    this.db.exec(
      `CREATE INDEX IF NOT EXISTS idx_events_usage_observed
       ON orchestration_events(method, observed_at, id, thread_id)`,
    );
  }

  /**
   * The bytes behind a persisted attachment reference, or `undefined` when
   * they are no longer stored (archive#3385).
   *
   * Exposed as a read rather than as the blob store itself: the caller is an
   * HTTP route, and what it needs is one attachment's bytes, not the authority
   * to write or reclaim them.
   */
  readAttachmentBlob(ref: string): Buffer | undefined {
    return this.attachmentBlobs.readBytes(ref);
  }

  /**
   * Pure fold over immutable `conversation.forked` rows.  Do not route this
   * through any projection ensure/rehydrate path: detail reads must never
   * mutate the event store.
   */
  readConversationForkProvenance(conversationId: string): {
    forkedFrom?: ConversationForkProvenance;
    forkedTo: ConversationForkProvenance[];
  } {
    return this.readConversationForkProvenanceBatch([conversationId]).get(
      conversationId,
    )!;
  }

  /** Fold fork facts for an inventory page in one indexed-method query. */
  readConversationForkProvenanceBatch(conversationIds: readonly string[]): Map<
    string,
    {
      forkedFrom?: ConversationForkProvenance;
      forkedTo: ConversationForkProvenance[];
    }
  > {
    const ids = [...new Set(conversationIds)];
    const provenance = new Map<
      string,
      {
        forkedFrom?: ConversationForkProvenance;
        forkedTo: ConversationForkProvenance[];
      }
    >(ids.map((id) => [id, { forkedTo: [] }]));
    if (ids.length === 0) return provenance;
    const placeholders = ids.map(() => '?').join(', ');
    const rows = this.db
      .prepare(
        `SELECT payload FROM orchestration_events
         WHERE method = 'conversation.forked'
           AND (json_extract(payload, '$.sourceConversationId') IN (${placeholders})
             OR json_extract(payload, '$.targetConversationId') IN (${placeholders}))
         ORDER BY global_sequence ASC`,
      )
      .all(...ids, ...ids) as Array<{ payload: string }>;
    const facts = rows.flatMap((row) => {
      try {
        const event = JSON.parse(row.payload) as Record<string, unknown>;
        const continuation: ConversationForkProvenance['continuation'] =
          event.continuation === 'native' ||
          event.continuation === 'replay-seed'
            ? (event.continuation as ConversationForkProvenance['continuation'])
            : undefined;
        return typeof event.sourceConversationId === 'string' &&
          typeof event.targetConversationId === 'string' &&
          typeof event.targetAgent === 'string' &&
          typeof event.forkedAt === 'string'
          ? [
              {
                sourceConversationId: event.sourceConversationId,
                targetConversationId: event.targetConversationId,
                targetAgent: event.targetAgent,
                forkedAt: event.forkedAt,
                ...(typeof event.branchPointTurnId === 'string'
                  ? { branchPointTurnId: event.branchPointTurnId }
                  : {}),
                ...(typeof event.sourceSessionId === 'string'
                  ? { sourceSessionId: event.sourceSessionId }
                  : {}),
                ...(continuation ? { continuation } : {}),
              },
            ]
          : [];
      } catch {
        return [];
      }
    });
    for (const fact of facts) {
      const target = provenance.get(fact.targetConversationId);
      if (target && !target.forkedFrom) target.forkedFrom = fact;
      const source = provenance.get(fact.sourceConversationId);
      if (source) source.forkedTo.push(fact);
    }
    return provenance;
  }

  reserveAttachmentCapacity(
    threadId: string,
    incomingEncodedBytes: number,
  ): void {
    if (incomingEncodedBytes <= 0) return;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const session = this.db
        .prepare(
          `SELECT encoded_bytes AS bytes
           FROM orchestration_attachment_quota
           WHERE thread_id = ?`,
        )
        .get(threadId) as { bytes?: number } | undefined;
      const total = this.db
        .prepare(
          `SELECT COALESCE(SUM(encoded_bytes), 0) AS bytes
           FROM orchestration_attachment_quota`,
        )
        .get() as { bytes?: number } | undefined;
      const sessionBytes = Number(session?.bytes ?? 0);
      const storeBytes = Number(total?.bytes ?? 0);
      if (
        sessionBytes + incomingEncodedBytes >
        CHAT_ATTACHMENT_MAX_SESSION_ENCODED_BYTES
      ) {
        throw new Error(
          'This chat has reached its attachment history limit. Start a new chat to attach more files.',
        );
      }
      if (
        storeBytes + incomingEncodedBytes >
        CHAT_ATTACHMENT_MAX_STORE_ENCODED_BYTES
      ) {
        throw new Error(
          'Station attachment storage is full. Remove old chat history before attaching more files.',
        );
      }
      this.db
        .prepare(
          `INSERT INTO orchestration_attachment_quota (thread_id, encoded_bytes)
           VALUES (?, ?)
           ON CONFLICT(thread_id) DO UPDATE SET
             encoded_bytes = encoded_bytes + excluded.encoded_bytes`,
        )
        .run(threadId, incomingEncodedBytes);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  releaseAttachmentCapacity(threadId: string, encodedBytes: number): void {
    if (encodedBytes <= 0) return;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db
        .prepare(
          `UPDATE orchestration_attachment_quota
           SET encoded_bytes = MAX(encoded_bytes - ?, 0)
           WHERE thread_id = ?`,
        )
        .run(encodedBytes, threadId);
      this.db
        .prepare(
          `DELETE FROM orchestration_attachment_quota
           WHERE thread_id = ? AND encoded_bytes = 0`,
        )
        .run(threadId);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  appendEventIfAbsent(event: CanonicalRuntimeEvent): number | undefined {
    const ingress = this.prepareEventIngress(event);
    event = ingress.event;
    const startedAt = performance.now();
    const { requestId, persisted, serializedPayload } = ingress;
    this.db.exec('SAVEPOINT append_event_if_absent_history');
    let nextSequence: number;
    let absent: boolean;
    try {
      nextSequence = this.nextSequence(event.threadId);
      const result = this.db
        .prepare(
          `INSERT OR IGNORE INTO orchestration_events
          (id, provider, thread_id, turn_id, method, request_id, session_state, payload, created_at, observed_at, sequence, global_sequence)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          event.eventId,
          event.provider,
          event.threadId,
          event.turnId ?? null,
          event.method,
          requestId,
          event.sessionState ?? null,
          serializedPayload,
          event.createdAt,
          new Date().toISOString(),
          nextSequence,
          this.nextGlobalSequence(),
        ) as { changes: number };
      absent = result.changes === 0;
      if (!absent) {
        this.recordAttachmentRefs(event.threadId, persisted.blobRefs);
        this.projectConversationHistoryEvent(event);
        this.projectMessageSearchEvent(event);
        this.projectRequestState(event, requestId, nextSequence);
        this.projectSessionProjectionFacts(event);
      }
      this.db.exec('RELEASE SAVEPOINT append_event_if_absent_history');
    } catch (error) {
      this.db.exec(
        'ROLLBACK TO SAVEPOINT append_event_if_absent_history; RELEASE SAVEPOINT append_event_if_absent_history',
      );
      throw error;
    }
    if (absent) return undefined;
    // archive#3433: deliberately OUTSIDE the transaction's error boundary
    // (a throwing instrument here must not be caught as a store failure and
    // answered with a ROLLBACK against a transaction that has already
    // committed), and guarded so it cannot fail THIS call either — see
    // {@link observeEventPersisted}. The row is already committed; a caller
    // must see this append succeed, not fail because an exporter is down.
    observeEventPersisted(
      () => orchestrationEventsPersisted,
      () => orchestrationEventPersistDuration,
      performance.now() - startedAt,
      { provider: event.provider, method: event.method },
    );
    return nextSequence;
  }

  /**
   * Fixed-width, index-backed message search. Owner and hosted-tenant scope
   * are indexed FTS terms, so SQLite intersects that caller's opaque scope
   * posting before it expands body matches. The ordinary history predicates
   * remain a defence-in-depth response boundary.
   */
  searchConversationMessages(options: {
    query: string;
    ownerUserId: string;
    tenantId?: string;
    limit: number;
  }): Array<{
    threadId: string;
    eventId: string;
    turnId?: string;
    role: 'user' | 'assistant';
    content: string;
    createdAt: string;
    agentSlug?: string;
    projectSlug?: string;
    engine?: string;
    turnAnchorId?: string;
  }> {
    const contentTerms = nonCjkSearchTerms(options.query);
    const cjkTerms = cjkSearchTerms(options.query);
    // A punctuation-only query must not degrade into an owner-wide match.
    if (!contentTerms && !cjkTerms) return [];
    const matchTerms = [
      ftsColumnPhrase(
        'owner_scope_key',
        messageOwnerScopeKey(options.ownerUserId),
      ),
    ];
    if (options.tenantId) {
      matchTerms.splice(
        1,
        0,
        ftsColumnPhrase(
          'tenant_scope_key',
          messageTenantScopeKey(options.tenantId),
        ),
      );
    }
    if (contentTerms) {
      matchTerms.push(ftsColumnPhrase('content', contentTerms));
    }
    if (cjkTerms) {
      matchTerms.push(ftsColumnPhrase('cjk_terms', cjkTerms));
    }
    const rows = this.db
      .prepare(
        `SELECT s.thread_id, s.event_id, s.turn_id, s.role, s.content,
                s.created_at, h.agent_slug, h.project_slug, p.provider,
                (SELECT e.id FROM orchestration_events e
                  WHERE e.thread_id = s.thread_id AND e.turn_id = s.turn_id
                    AND e.method = 'turn.started' LIMIT 1) AS turn_anchor_id
           FROM orchestration_message_search_v3 s
           INNER JOIN orchestration_conversation_history h
             ON h.thread_id = s.thread_id
           LEFT JOIN provider_session_state p
             ON p.thread_id = s.thread_id
          WHERE orchestration_message_search_v3 MATCH ?
            AND h.owner_user_id = ?
            AND (? IS NULL OR h.tenant_id = ?)
          ORDER BY bm25(orchestration_message_search_v3) +
                     ((julianday('now') - julianday(s.created_at)) * ?) ASC,
                   s.created_at DESC,
                   s.event_id ASC
          LIMIT ?`,
      )
      .all(
        matchTerms.join(' AND '),
        options.ownerUserId,
        options.tenantId ?? null,
        options.tenantId ?? null,
        MESSAGE_SEARCH_RECENCY_SCORE_PER_DAY,
        options.limit,
      ) as Array<{
      thread_id: string;
      event_id: string;
      turn_id: string | null;
      role: 'user' | 'assistant';
      content: string;
      created_at: string;
      agent_slug: string | null;
      project_slug: string | null;
      provider: string | null;
      turn_anchor_id: string | null;
    }>;
    return rows.map((row) => ({
      threadId: row.thread_id,
      eventId: row.event_id,
      ...(row.turn_id ? { turnId: row.turn_id } : {}),
      role: row.role,
      content: row.content,
      createdAt: row.created_at,
      ...(row.agent_slug ? { agentSlug: row.agent_slug } : {}),
      ...(row.project_slug ? { projectSlug: row.project_slug } : {}),
      ...(row.provider ? { engine: row.provider } : {}),
      ...(row.turn_anchor_id ? { turnAnchorId: row.turn_anchor_id } : {}),
    }));
  }

  /**
   * Return the subset of event ids that are already durable.
   *
   * Attached transcript sources intentionally keep their filesystem cursor in
   * memory, so a server restart replays a bounded window from every source.
   * Sending every replayed row through {@link appendEventIfAbsent} is
   * functionally correct but needlessly enters a write savepoint and computes
   * thread/global sequence values before `INSERT OR IGNORE` discovers the
   * duplicate. On a dogfood store with 23k attached events that cold replay
   * saturated the main thread with synchronous SQLite for minutes (archive#1997).
   *
   * Query in conservative chunks rather than depending on a host SQLite's
   * parameter ceiling. The insert remains the final idempotence boundary for
   * a genuinely new row; this is only the cheap replay fast path.
   */
  existingEventIds(eventIds: readonly string[]): Set<string> {
    const existing = new Set<string>();
    const unique = [...new Set(eventIds)];
    const chunkSize = 500;
    for (let offset = 0; offset < unique.length; offset += chunkSize) {
      const chunk = unique.slice(offset, offset + chunkSize);
      if (chunk.length === 0) continue;
      const placeholders = chunk.map(() => '?').join(', ');
      const rows = this.db
        .prepare(
          `SELECT id FROM orchestration_events WHERE id IN (${placeholders})`,
        )
        .all(...chunk) as Array<{ id: string }>;
      for (const row of rows) existing.add(row.id);
    }
    return existing;
  }

  private projectRequestState(
    event: CanonicalRuntimeEvent,
    requestId: string | null,
    sequence: number,
  ): void {
    if (!requestId) return;
    this.db
      .prepare(
        `INSERT INTO orchestration_request_state
          (thread_id, request_id, event_id, method, sequence)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(thread_id, request_id) DO UPDATE SET
           event_id = excluded.event_id,
           method = excluded.method,
           sequence = excluded.sequence
         WHERE excluded.sequence > orchestration_request_state.sequence`,
      )
      .run(event.threadId, requestId, event.eventId, event.method, sequence);
  }

  private projectSessionProjectionFacts(event: CanonicalRuntimeEvent): void {
    for (const fact of projectionFactKeysForEvent(event)) {
      this.db
        .prepare(
          fact.first
            ? `INSERT OR IGNORE INTO orchestration_session_projection_facts
                (thread_id, fact_key, event_id) VALUES (?, ?, ?)`
            : `INSERT INTO orchestration_session_projection_facts
                (thread_id, fact_key, event_id) VALUES (?, ?, ?)
               ON CONFLICT(thread_id, fact_key) DO UPDATE SET
                 event_id = excluded.event_id`,
        )
        .run(event.threadId, fact.key, event.eventId);
    }
    if (
      event.method !== 'turn.started' ||
      !isClientOrigin(event.clientOrigin)
    ) {
      return;
    }
    const first = this.db
      .prepare(
        `SELECT origin.payload
         FROM orchestration_session_projection_facts AS fact
         INNER JOIN orchestration_events AS origin ON origin.id = fact.event_id
         WHERE fact.thread_id = ? AND fact.fact_key = 'turn-origin:first'`,
      )
      .get(event.threadId) as { payload?: unknown } | undefined;
    if (!first) return;
    let firstEvent: CanonicalRuntimeEvent;
    try {
      firstEvent = JSON.parse(String(first.payload)) as CanonicalRuntimeEvent;
    } catch {
      return;
    }
    if (
      !isClientOrigin(firstEvent.clientOrigin) ||
      clientOriginIdentity(firstEvent.clientOrigin) ===
        clientOriginIdentity(event.clientOrigin)
    ) {
      return;
    }
    this.db
      .prepare(
        `INSERT OR IGNORE INTO orchestration_session_projection_facts
          (thread_id, fact_key, event_id) VALUES (?, 'turn-origin:other', ?)`,
      )
      .run(event.threadId, event.eventId);
  }

  listEvents(threadId?: string): PersistedRuntimeEvent[] {
    const rows = threadId
      ? this.db
          .prepare(
            `SELECT id, provider, thread_id, turn_id, method, payload, created_at, observed_at, sequence, global_sequence
             FROM orchestration_events
             WHERE thread_id = ?
             ORDER BY sequence ASC`,
          )
          .all(threadId)
      : this.db
          .prepare(
            `SELECT id, provider, thread_id, turn_id, method, payload, created_at, observed_at, sequence, global_sequence
             FROM orchestration_events
             ORDER BY created_at ASC, sequence ASC`,
          )
          .all();

    return rows.map((row: any) => this.mapEventRow(row));
  }

  /**
   * Bounded, payload-free declared-output inventory.  The caller supplies a
   * frozen high-water mark and exclusive position; SQLite supplies ordering so
   * a restart cannot invent future rows or duplicate an already delivered one.
   */
  listDeclaredOutputDescriptors(input: {
    threadId: string;
    highWater?: number;
    after?: { sequence: number; declarationId: string };
    limit: number;
  }): DeclaredOutputDescriptorPage {
    if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 50)
      throw new Error('Declared output page limit must be between 1 and 50.');
    const currentHighWater = Number(
      (
        this.db
          .prepare(
            `SELECT COALESCE(MAX(e.sequence), 0) AS high_water
             FROM orchestration_declared_outputs o
             INNER JOIN orchestration_events e ON e.id = o.event_id
             WHERE o.thread_id = ?`,
          )
          .get(input.threadId) as { high_water?: number } | undefined
      )?.high_water ?? 0,
    );
    const highWater = input.highWater ?? currentHighWater;
    if (
      !Number.isSafeInteger(highWater) ||
      highWater < 0 ||
      highWater > currentHighWater
    )
      throw new Error('Declared output high-water is invalid.');
    if (input.after) {
      if (
        !Number.isSafeInteger(input.after.sequence) ||
        input.after.sequence < 1 ||
        input.after.sequence > highWater ||
        !input.after.declarationId
      )
        throw new Error('Declared output cursor position is invalid.');
      const position = this.db
        .prepare(
          `SELECT 1
             FROM orchestration_declared_outputs o
             INNER JOIN orchestration_events e ON e.id = o.event_id
            WHERE o.thread_id = ? AND e.sequence = ?
              AND o.declaration_id = ? AND e.sequence <= ?
            LIMIT 1`,
        )
        .get(
          input.threadId,
          input.after.sequence,
          input.after.declarationId,
          highWater,
        );
      if (!position)
        throw new Error('Declared output cursor position is invalid.');
    }
    const rows = this.db
      .prepare(
        `SELECT o.event_id, o.thread_id, o.turn_id, o.tool_call_id,
                o.declared_at, o.label, o.descriptor, o.declaration_id,
                e.sequence
           FROM orchestration_declared_outputs o
           INNER JOIN orchestration_events e ON e.id = o.event_id
          WHERE o.thread_id = ? AND e.sequence <= ?
            AND (? IS NULL OR e.sequence > ?
              OR (e.sequence = ? AND o.declaration_id > ?))
          ORDER BY e.sequence ASC, o.declaration_id ASC
          LIMIT ?`,
      )
      .all(
        input.threadId,
        highWater,
        input.after?.sequence ?? null,
        input.after?.sequence ?? null,
        input.after?.sequence ?? null,
        input.after?.declarationId ?? null,
        input.limit + 1,
      ) as Array<Record<string, unknown>>;
    const visible = rows.slice(0, input.limit).map((row) => ({
      declarationId: row.declaration_id as string,
      eventId: row.event_id as string,
      threadId: row.thread_id as string,
      turnId: row.turn_id as string,
      toolCallId: row.tool_call_id as string,
      declaredAt: row.declared_at as string,
      ...(typeof row.label === 'string' ? { label: row.label } : {}),
      descriptor: (() => {
        try {
          return JSON.parse(String(row.descriptor));
        } catch {
          return undefined;
        }
      })(),
      sequence: Number(row.sequence),
    }));
    return { rows: visible, highWater, hasMore: rows.length > input.limit };
  }

  /** Exact candidate lookup: no event/transcript replay and no descriptor scan. */
  readDeclaredOutputDescriptor(
    threadId: string,
    eventId: string,
  ): DeclaredOutputDescriptorRow | undefined {
    const row = this.db
      .prepare(
        `SELECT o.event_id, o.thread_id, o.turn_id, o.tool_call_id,
                o.declared_at, o.label, o.descriptor, e.sequence
           FROM orchestration_declared_outputs o
           INNER JOIN orchestration_events e ON e.id = o.event_id
          WHERE o.thread_id = ? AND o.event_id = ?
          LIMIT 2`,
      )
      .all(threadId, eventId) as Array<Record<string, unknown>>;
    if (row.length !== 1) return undefined;
    const value = row[0]!;
    let descriptor: unknown;
    try {
      descriptor = JSON.parse(String(value.descriptor));
    } catch {
      descriptor = undefined;
    }
    return {
      declarationId: value.declaration_id as string,
      eventId: value.event_id as string,
      threadId: value.thread_id as string,
      turnId: value.turn_id as string,
      toolCallId: value.tool_call_id as string,
      declaredAt: value.declared_at as string,
      ...(typeof value.label === 'string' ? { label: value.label } : {}),
      descriptor,
      sequence: Number(value.sequence),
    };
  }

  /**
   * Bounded authoritative usage observations.  This is intentionally an
   * event query, rather than a `readSessions()` loop followed by transcript
   * hydration: owner/tenant, method, observation window and continuation all
   * belong to SQLite's indexed selection boundary.
   */
  listUsageReceiptEvents(options: {
    ownerUserId: string;
    tenantId?: string;
    from: string;
    to: string;
    after?: { observedAt: string; eventId: string };
    limit: number;
  }): Array<{
    event: PersistedRuntimeEvent;
    conversationId: string;
    taskId?: string;
    model?: string;
    processEpoch: number;
  }> {
    const rows = this.db
      .prepare(
        `SELECT e.id, e.provider, e.thread_id, e.turn_id, e.method, e.payload,
                e.created_at, e.observed_at, e.sequence, e.global_sequence,
                COALESCE(cs.conversation_id, h.thread_id) AS conversation_id,
                (SELECT json_extract(config.payload, '$.metadata.taskId')
                   FROM orchestration_events config
                  WHERE config.thread_id = e.thread_id
                    AND config.sequence <= e.sequence
                    AND config.method IN ('session.started', 'session.configured')
                    AND json_valid(config.payload)
                    AND json_type(config.payload, '$.metadata.taskId') = 'text'
                  ORDER BY config.sequence DESC LIMIT 1) AS task_id,
                (SELECT COALESCE(json_extract(config.payload, '$.metadata.effectiveModel'), json_extract(config.payload, '$.model'))
                   FROM orchestration_events config
                  WHERE config.thread_id = e.thread_id
                    AND config.sequence <= e.sequence
                    AND config.method = 'session.configured'
                    AND json_valid(config.payload)
                    AND (json_type(config.payload, '$.metadata.effectiveModel') = 'text'
                      OR json_type(config.payload, '$.model') = 'text')
                  ORDER BY config.sequence DESC LIMIT 1) AS model,
                (SELECT COUNT(*) FROM orchestration_events epoch
                  WHERE epoch.thread_id = e.thread_id
                    AND epoch.method = 'session.started'
                    AND epoch.sequence <= e.sequence) AS process_epoch
           FROM orchestration_events e
           INNER JOIN orchestration_conversation_history h ON h.thread_id = e.thread_id
           LEFT JOIN orchestration_conversation_sessions cs ON cs.session_id = e.thread_id
          WHERE e.method = 'token-usage.updated'
            AND e.observed_at >= ? AND e.observed_at <= ?
            AND h.owner_user_id = ?
            AND (? IS NULL OR h.tenant_id = ?)
            AND (? IS NULL OR e.observed_at > ? OR (e.observed_at = ? AND e.id > ?))
          ORDER BY e.observed_at ASC, e.id ASC
          LIMIT ?`,
      )
      .all(
        `${options.from}T00:00:00.000Z`,
        `${options.to}T23:59:59.999Z`,
        options.ownerUserId,
        options.tenantId ?? null,
        options.tenantId ?? null,
        options.after?.observedAt ?? null,
        options.after?.observedAt ?? null,
        options.after?.observedAt ?? null,
        options.after?.eventId ?? null,
        options.limit + 1,
      ) as any[];
    return rows.map((row) => ({
      event: this.mapEventRow(row),
      conversationId: row.conversation_id,
      ...(typeof row.task_id === 'string' ? { taskId: row.task_id } : {}),
      ...(typeof row.model === 'string' ? { model: row.model } : {}),
      processEpoch: Number(row.process_epoch),
    }));
  }

  /**
   * Coverage evidence is selected by the same owner/tenant/window predicate
   * as receipt rows.  Do not discover it by replaying all session logs: that
   * would make an analytics read unbounded and could cross a hosted tenant.
   */
  listUsageCoverageEvents(options: {
    ownerUserId: string;
    tenantId?: string;
    from: string;
    to: string;
  }): PersistedRuntimeEvent[] {
    const rows = this.db
      .prepare(
        `SELECT e.id, e.provider, e.thread_id, e.turn_id, e.method, e.payload,
                e.created_at, e.observed_at, e.sequence, e.global_sequence
           FROM orchestration_events e
           INNER JOIN orchestration_conversation_history h ON h.thread_id = e.thread_id
          WHERE e.method IN ('turn.completed', 'turn.aborted', 'token-usage.updated', 'session.configured')
            AND e.observed_at >= ? AND e.observed_at <= ?
            AND h.owner_user_id = ?
            AND (? IS NULL OR h.tenant_id = ?)
          ORDER BY e.observed_at ASC, e.id ASC
          LIMIT 1001`,
      )
      .all(
        `${options.from}T00:00:00.000Z`,
        `${options.to}T23:59:59.999Z`,
        options.ownerUserId,
        options.tenantId ?? null,
        options.tenantId ?? null,
      ) as any[];
    return rows.map((row) => this.mapEventRow(row));
  }

  /** Live-only fold input. Replay must use `readTurnProvenance` instead. */
  listEventsForTurn(
    threadId: string,
    turnId: string,
    limit?: number,
  ): PersistedRuntimeEvent[] {
    if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) {
      throw new Error('turn event limit must be a positive integer');
    }
    return (
      this.db
        .prepare(
          `SELECT id, provider, thread_id, turn_id, method, payload, created_at, sequence, global_sequence
         FROM orchestration_events WHERE thread_id = ? AND turn_id = ?
         ORDER BY sequence ASC${limit === undefined ? '' : ' LIMIT ?'}`,
        )
        .all(threadId, turnId, ...(limit === undefined ? [] : [limit])) as any[]
    ).map((row: any) => this.mapEventRow(row));
  }

  /**
   * Exact Basis turn window.  This is deliberately a different read from the
   * live fold: it never selects `payload`, never invokes mapEventRow, and has
   * no attachment-blob path.  The `(thread_id, turn_id, sequence)` index
   * (`idx_events_thread_turn_sequence`) supplies both predicate and order.
   */
  listBasisEventsForTurn(
    threadId: string,
    turnId: string,
  ): SessionBasisTurnDescriptorWindow {
    if (
      !hasBoundedDescriptorText(
        threadId,
        MAX_TOOL_RESULT_DESCRIPTOR_ID_BYTES,
      ) ||
      !hasBoundedDescriptorText(turnId, MAX_TOOL_RESULT_DESCRIPTOR_ID_BYTES)
    )
      return { status: 'corrupt' };
    const preflight = this.db
      .prepare(
        `SELECT id
           FROM orchestration_events INDEXED BY idx_events_thread_turn_sequence
          WHERE thread_id = ? AND turn_id = ?
          ORDER BY sequence ASC
          LIMIT ?`,
      )
      .all(threadId, turnId, MAX_BASIS_DESCRIPTOR_ROWS + 1) as any[];
    if (preflight.length > MAX_BASIS_DESCRIPTOR_ROWS)
      return { status: 'over-budget' };
    const rows = this.db
      .prepare(
        `WITH candidate AS (
         SELECT e.id, e.thread_id, e.turn_id, e.method, e.sequence, e.created_at, e.payload
           FROM orchestration_events e INDEXED BY idx_events_thread_turn_sequence
          WHERE e.thread_id = ? AND e.turn_id = ?
          ORDER BY e.sequence ASC
          LIMIT ?
       ), facts AS (
         SELECT c.id, c.thread_id, c.turn_id, c.method, c.sequence, c.created_at,
                json_valid(payload) AS valid_json,
                CASE WHEN json_valid(payload) THEN json_type(payload, '$.finishReason') END AS finish_type,
                CASE WHEN json_valid(payload) AND json_type(payload, '$.finishReason') = 'text'
                       AND length(CAST(json_extract(payload, '$.finishReason') AS BLOB)) <= ?
                     THEN json_extract(payload, '$.finishReason') END AS finish_reason,
                CASE WHEN json_valid(payload) THEN json_type(payload, '$.delta') END AS delta_type,
                CASE WHEN c.method = 'content.text-delta' AND json_valid(payload) AND json_type(payload, '$.delta') = 'text'
                       AND length(CAST(json_extract(payload, '$.delta') AS BLOB)) BETWEEN 1 AND ? THEN 1 ELSE 0 END AS text_delta,
                CASE WHEN c.method = 'turn.completed' AND json_valid(payload) THEN json_type(payload, '$.outputText') END AS output_text_type,
                CASE WHEN c.method = 'turn.completed' AND json_valid(payload) AND json_type(payload, '$.outputText') = 'text'
                       AND length(CAST(json_extract(payload, '$.outputText') AS BLOB)) BETWEEN 1 AND ? THEN 1 ELSE 0 END AS output_text,
                CASE WHEN c.method = 'turn.completed' AND json_valid(payload) AND json_type(payload, '$.outputText') = 'text'
                       THEN length(CAST(json_extract(payload, '$.outputText') AS BLOB)) ELSE 0 END AS output_text_bytes,
                CASE WHEN json_valid(payload) THEN json_type(payload, '$.prompt') END AS prompt_type,
                CASE WHEN json_valid(payload) AND json_type(payload, '$.prompt') = 'text'
                       AND length(CAST(json_extract(payload, '$.prompt') AS BLOB)) <= ?
                     THEN json_extract(payload, '$.prompt') END AS prompt,
                CASE WHEN json_valid(payload) THEN json_type(payload, '$.inputKind') END AS input_kind_type,
                CASE WHEN json_valid(payload) AND json_type(payload, '$.inputKind') = 'text'
                       AND length(CAST(json_extract(payload, '$.inputKind') AS BLOB)) <= ?
                     THEN json_extract(payload, '$.inputKind') END AS input_kind,
                CASE WHEN json_valid(payload) THEN json_type(payload, '$.attachments') END AS attachments_type,
                a.key AS attachment_key,
                CASE WHEN a.key IS NULL THEN NULL ELSE json_type(a.value) END AS attachment_type,
                CASE WHEN a.key IS NULL THEN NULL ELSE json_extract(a.value, '$.kind') END AS attachment_kind,
                CASE WHEN a.key IS NULL THEN NULL WHEN json_type(a.value, '$.name') = 'text'
                       AND length(CAST(json_extract(a.value, '$.name') AS BLOB)) <= ? THEN json_extract(a.value, '$.name') END AS attachment_name,
                CASE WHEN a.key IS NULL THEN NULL WHEN json_type(a.value, '$.mimeType') = 'text'
                       AND length(CAST(json_extract(a.value, '$.mimeType') AS BLOB)) <= ? THEN json_extract(a.value, '$.mimeType') END AS attachment_mime,
                CASE WHEN a.key IS NULL THEN NULL ELSE json_extract(a.value, '$.size') END AS attachment_size,
                CASE WHEN json_valid(payload) THEN json_type(payload, '$.toolCallId') END AS tool_call_type,
                CASE WHEN json_valid(payload) AND json_type(payload, '$.toolCallId') = 'text'
                       AND length(CAST(json_extract(payload, '$.toolCallId') AS BLOB)) <= ? THEN json_extract(payload, '$.toolCallId') END AS tool_call_id,
                CASE WHEN json_valid(payload) THEN json_type(payload, '$.toolName') END AS tool_name_type,
                CASE WHEN json_valid(payload) AND json_type(payload, '$.toolName') = 'text'
                       AND length(CAST(json_extract(payload, '$.toolName') AS BLOB)) <= ? THEN json_extract(payload, '$.toolName') END AS tool_name,
                CASE WHEN json_valid(payload) THEN json_type(payload, '$.status') END AS tool_status_type,
                CASE WHEN json_valid(payload) AND json_type(payload, '$.status') = 'text'
                       AND length(CAST(json_extract(payload, '$.status') AS BLOB)) <= ? THEN json_extract(payload, '$.status') END AS tool_status,
                CASE WHEN json_valid(payload) THEN json_type(payload, '$.output') END AS output_type,
                CASE WHEN json_valid(payload) AND json_type(payload, '$.output') = 'text'
                       AND length(CAST(json_extract(payload, '$.output') AS BLOB)) <= ?
                     THEN json_extract(payload, '$.output') END AS tool_output,
                CASE WHEN json_valid(payload) THEN json_type(payload, '$.error') END AS error_type,
                CASE WHEN json_valid(payload) AND json_type(payload, '$.error') = 'text'
                       AND length(CAST(json_extract(payload, '$.error') AS BLOB)) <= ?
                     THEN json_extract(payload, '$.error') END AS tool_error,
                CASE WHEN json_valid(payload) THEN json_type(payload, '$.policyDenied') END AS denied_type,
                CASE WHEN json_valid(payload) THEN json_extract(payload, '$.policyDenied') END AS denied
           FROM candidate c
           LEFT JOIN json_each(CASE WHEN json_valid(c.payload) THEN c.payload ELSE '[]' END, '$.attachments') a
             ON c.method = 'turn.started' AND CAST(a.key AS INTEGER) <= ?
       )
       SELECT * FROM facts`,
      )
      .all(
        threadId,
        turnId,
        MAX_BASIS_DESCRIPTOR_ROWS,
        MAX_BASIS_FINISH_REASON_BYTES,
        MAX_BASIS_PROMPT_BYTES,
        MAX_BASIS_OUTPUT_TEXT_BYTES,
        MAX_BASIS_PROMPT_BYTES,
        MAX_BASIS_INPUT_KIND_BYTES,
        MAX_BASIS_ATTACHMENT_NAME_BYTES,
        MAX_BASIS_ATTACHMENT_MIME_BYTES,
        MAX_TOOL_RESULT_DESCRIPTOR_ID_BYTES,
        MAX_TOOL_RESULT_DESCRIPTOR_LABEL_BYTES,
        MAX_BASIS_STATUS_BYTES,
        MAX_TOOL_RESULT_DESCRIPTOR_OUTPUT_BYTES,
        MAX_TOOL_RESULT_DESCRIPTOR_OUTPUT_BYTES,
        CHAT_ATTACHMENT_MAX_COUNT,
      ) as any[];
    if (measuredBasisDescriptorBytes(rows) > MAX_BASIS_DESCRIPTOR_BYTES)
      return { status: 'over-budget' };
    if (rows.some((row) => row.valid_json !== 1)) return { status: 'corrupt' };
    const events = new Map<string, SessionBasisTurnDescriptorEvent>();
    for (const row of rows) {
      if (
        typeof row.id !== 'string' ||
        !hasBoundedDescriptorText(
          row.id,
          MAX_TOOL_RESULT_DESCRIPTOR_ID_BYTES,
        ) ||
        row.thread_id !== threadId ||
        row.turn_id !== turnId ||
        typeof row.method !== 'string' ||
        !Number.isSafeInteger(row.sequence)
      )
        return { status: 'corrupt' };
      let event = events.get(row.id);
      if (!event) {
        event = {
          eventId: row.id,
          threadId,
          turnId,
          method: row.method,
          sequence: row.sequence,
          observedAt: row.created_at,
        };
        if (
          row.finish_type !== null &&
          (row.finish_type !== 'text' || typeof row.finish_reason !== 'string')
        )
          return { status: 'corrupt' };
        if (typeof row.finish_reason === 'string')
          event.finishReason = row.finish_reason;
        if (row.method === 'content.text-delta') {
          if (row.delta_type !== 'text' || row.text_delta !== 1)
            return { status: 'corrupt' };
          event.textDelta = true;
        }
        if (row.method === 'turn.completed') {
          if (
            row.output_text_type !== null &&
            (row.output_text_type !== 'text' || row.output_text !== 1)
          )
            return { status: 'corrupt' };
          if (row.output_text === 1) event.outputText = true;
        }
        if (row.method === 'turn.started') {
          if (row.attachments_type !== null && row.attachments_type !== 'array')
            return { status: 'corrupt' };
          if (row.prompt_type !== null && row.prompt_type !== 'text')
            return { status: 'corrupt' };
          if (row.prompt_type === 'text' && typeof row.prompt !== 'string')
            return { status: 'corrupt' };
          if (
            row.input_kind_type !== null &&
            (row.input_kind_type !== 'text' || row.input_kind !== 'steer')
          )
            return { status: 'corrupt' };
          event.input = {
            kind: row.input_kind === 'steer' ? 'steer' : 'initial',
            prompt: typeof row.prompt === 'string' ? row.prompt : '',
            attachments: [],
          };
        }
        if (row.method === 'tool.completed') {
          if (
            row.tool_call_type !== 'text' ||
            typeof row.tool_call_id !== 'string' ||
            row.tool_name_type !== 'text' ||
            typeof row.tool_name !== 'string' ||
            row.tool_status_type !== 'text' ||
            typeof row.tool_status !== 'string' ||
            !['success', 'error', 'cancelled'].includes(row.tool_status)
          )
            return { status: 'corrupt' };
          if (
            (row.output_type === 'text' &&
              typeof row.tool_output !== 'string') ||
            (row.error_type !== null && row.error_type !== 'text') ||
            (row.error_type === 'text' && typeof row.tool_error !== 'string') ||
            ![null, 'true', 'false'].includes(row.denied_type)
          )
            return { status: 'corrupt' };
          event.tool = {
            eventId: row.id,
            threadId,
            turnId,
            method: row.method,
            toolCallId: row.tool_call_id,
            toolName: row.tool_name,
            status: row.tool_status,
            ...(typeof row.tool_output === 'string'
              ? { output: row.tool_output }
              : {}),
            ...(typeof row.tool_error === 'string'
              ? { error: row.tool_error }
              : {}),
            ...(row.denied_type === 'true' ? { policyDenied: true } : {}),
          };
        }
        events.set(row.id, event);
      }
      if (event.input && row.attachment_key !== null) {
        if (
          !Number.isSafeInteger(row.attachment_key) ||
          row.attachment_key < 0 ||
          row.attachment_key >= CHAT_ATTACHMENT_MAX_COUNT ||
          event.input.attachments.length >= CHAT_ATTACHMENT_MAX_COUNT ||
          row.attachment_type !== 'object' ||
          typeof row.attachment_kind !== 'string' ||
          typeof row.attachment_name !== 'string' ||
          typeof row.attachment_mime !== 'string' ||
          !Number.isSafeInteger(row.attachment_size) ||
          row.attachment_size < 0
        )
          return { status: 'corrupt' };
        if (
          validatePersistedChatAttachmentDescriptor({
            kind: row.attachment_kind as PersistedChatAttachment['kind'],
            name: row.attachment_name,
            mimeType:
              row.attachment_mime as PersistedChatAttachment['mimeType'],
            size: row.attachment_size,
          })
        )
          return { status: 'corrupt' };
        (
          event.input.attachments as Array<{
            name: string;
            mediaType: string;
            size: number;
          }>
        ).push({
          name: row.attachment_name,
          mediaType: row.attachment_mime,
          size: row.attachment_size,
        });
      }
    }
    for (const event of events.values())
      if (
        event.input &&
        !event.input.prompt.trim() &&
        event.input.attachments.length === 0
      )
        return { status: 'corrupt' };
    return {
      status: 'found',
      events: [...events.values()].sort((a, b) => a.sequence - b.sequence),
    };
  }

  /**
   * One exact event fact, newest-first.  Callers that only need a durable
   * binding or lifecycle marker must not materialize a thread's transcript in
   * order to rediscover it.
   */
  latestEventByMethod(
    threadId: string,
    method: string,
  ): PersistedRuntimeEvent | undefined {
    const row = this.db
      .prepare(
        `SELECT id, provider, thread_id, turn_id, method, payload, created_at, observed_at, sequence, global_sequence
         FROM orchestration_events
         WHERE thread_id = ? AND method = ?
         ORDER BY sequence DESC
         LIMIT 1`,
      )
      .get(threadId, method) as any;
    return row ? this.mapEventRow(row) : undefined;
  }

  firstEventByMethod(
    threadId: string,
    method: string,
  ): PersistedRuntimeEvent | undefined {
    const row = this.db
      .prepare(
        `SELECT id, provider, thread_id, turn_id, method, payload, created_at, observed_at, sequence, global_sequence
         FROM orchestration_events
         WHERE thread_id = ? AND method = ?
         ORDER BY sequence ASC
         LIMIT 1`,
      )
      .get(threadId, method) as any;
    return row ? this.mapEventRow(row) : undefined;
  }

  latestEvent(threadId: string): PersistedRuntimeEvent | undefined {
    const row = this.db
      .prepare(
        `SELECT id, provider, thread_id, turn_id, method, payload, created_at, sequence, global_sequence
         FROM orchestration_events
         WHERE thread_id = ?
         ORDER BY sequence DESC
         LIMIT 1`,
      )
      .get(threadId) as any;
    return row ? this.mapEventRow(row) : undefined;
  }

  latestEventByMethods(
    threadId: string,
    methods: readonly string[],
  ): PersistedRuntimeEvent | undefined {
    if (methods.length === 0) {
      throw new Error('An event-method query requires at least one method');
    }
    let latest: PersistedRuntimeEvent | undefined;
    for (const method of methods) {
      const row = this.db
        .prepare(
          `SELECT id, provider, thread_id, turn_id, method, payload, created_at, sequence, global_sequence
           FROM orchestration_events
           WHERE thread_id = ? AND method = ?
           ORDER BY sequence DESC
           LIMIT 1`,
        )
        .get(threadId, method) as any;
      const event = row ? this.mapEventRow(row) : undefined;
      if (event && (!latest || event.sequence > latest.sequence)) {
        latest = event;
      }
    }
    return latest;
  }

  firstTurnStartedWithPrompt(
    threadId: string,
  ): PersistedRuntimeEvent | undefined {
    const row = this.db
      .prepare(
        `SELECT id, provider, thread_id, turn_id, method, payload, created_at, sequence, global_sequence
         FROM orchestration_events
         WHERE thread_id = ? AND method = 'turn.started'
           AND typeof(json_extract(payload, '$.prompt')) = 'text'
           AND trim(json_extract(payload, '$.prompt')) != ''
         ORDER BY sequence ASC
         LIMIT 1`,
      )
      .get(threadId) as any;
    return row ? this.mapEventRow(row) : undefined;
  }

  latestEventForSessionState(
    threadId: string,
    sessionState: string,
  ): PersistedRuntimeEvent | undefined {
    const facts = SESSION_STATE_FACT_METHODS.map((method) => {
      const row = this.db
        .prepare(
          `SELECT id, provider, thread_id, turn_id, method, payload, created_at, sequence, global_sequence
           FROM orchestration_events
           WHERE thread_id = ? AND method = ? AND session_state = ?
           ORDER BY sequence DESC
           LIMIT 1`,
        )
        .get(threadId, method, sessionState) as any;
      return row ? this.mapEventRow(row) : undefined;
    });
    return facts.reduce<PersistedRuntimeEvent | undefined>(
      (latest, event) =>
        !event || (latest && latest.sequence > event.sequence) ? latest : event,
      undefined,
    );
  }

  latestCwdConfiguredEvent(
    threadId: string,
  ): PersistedRuntimeEvent | undefined {
    const row = this.db
      .prepare(
        `SELECT id, provider, thread_id, turn_id, method, payload, created_at, sequence, global_sequence
         FROM orchestration_events
         WHERE thread_id = ? AND method = 'session.configured'
           AND typeof(json_extract(payload, '$.cwd')) = 'text'
           AND trim(json_extract(payload, '$.cwd')) != ''
         ORDER BY sequence DESC
         LIMIT 1`,
      )
      .get(threadId) as any;
    return row ? this.mapEventRow(row) : undefined;
  }

  /**
   * Replay only the two event kinds that can determine one approval's state.
   * Request identity is a normalized, indexed column: filtering after
   * `listEvents()` or a correlated JSON expression would still revisit
   * unrelated payloads on the main thread.
   */
  listEventsForRequest(
    threadId: string,
    requestId: string,
  ): PersistedRuntimeEvent[] {
    return (
      this.db
        .prepare(
          `SELECT id, provider, thread_id, turn_id, method, payload, created_at, sequence, global_sequence
           FROM orchestration_events
           WHERE thread_id = ?
             AND request_id = ?
           ORDER BY sequence ASC`,
        )
        .all(threadId, requestId) as any[]
    ).map((row: any) => this.mapEventRow(row));
  }

  /**
   * The currently unresolved approval/input requests for one thread. This is
   * an indexed request-id current-row join in SQLite rather than a full event
   * replay followed by an in-memory Set or a correlated history scan. A large
   * completed-request history therefore never reparses unrelated payloads.
   */
  listUnresolvedRequestEvents(threadId: string): PersistedRuntimeEvent[] {
    return (
      this.db
        .prepare(
          `SELECT event.id, event.provider, event.thread_id, event.turn_id, event.method, event.payload, event.created_at, event.sequence, event.global_sequence
           FROM orchestration_request_state AS current
           INNER JOIN orchestration_events AS event
             ON event.id = current.event_id
           WHERE current.thread_id = ?
             AND current.method = 'request.opened'
           ORDER BY current.sequence ASC`,
        )
        .all(threadId) as any[]
    ).map((row: any) => this.mapEventRow(row));
  }

  /**
   * Bounded authoritative facts for the session fold. This is intentionally
   * not a recent tail: a Flow or policy binding written before tens of
   * thousands of streaming deltas remains load-bearing. Each fact is an
   * indexed first/latest/current lookup (plus current unresolved requests),
   * so growing state-bearing history cannot become a projection-all-history
   * read.
   */
  listSessionProjectionEvents(threadId: string): PersistedRuntimeEvent[] {
    // archive#3557/#3558 fix-round review BLOCK 1: computed once and shared
    // between the `turn.started` slot below and the turn-scoped terminal
    // slot it anchors — see `latestTerminalEventForTurn`'s docblock for why
    // the terminal slot must be scoped to THIS turn's id, not the thread's
    // latest terminal.
    const latestTurnStarted = this.latestEventByMethod(
      threadId,
      'turn.started',
    );
    const facts = [
      this.latestEvent(threadId),
      this.latestEventByMethod(threadId, 'flow.run-attached'),
      this.latestEventByMethod(threadId, 'policy.hooks-attached'),
      this.latestEventByMethod(threadId, 'session.started'),
      // The first accepted configuration carries the immutable launch-plan
      // receipt; later configuration events can restate runtime state.
      this.firstEventByMethod(threadId, 'session.configured'),
      this.latestEventByMethod(threadId, 'session.configured'),
      this.firstTurnStartedWithPrompt(threadId),
      // archive#3524: the CURRENT turn's own announcement. Neither existing
      // slot guarantees this fact stays visible — `firstTurnStartedWithPrompt`
      // is pinned to the session's first turn WITH A NON-EMPTY PROMPT
      // (`ORDER BY sequence ASC` filtered on `$.prompt`; a promptless turn 1
      // is skipped in favor of the next turn that has one), and
      // `latestEventByMethods(LIFECYCLE_METHODS)` retains exactly ONE event
      // across all seven lifecycle methods, so any later lifecycle event on
      // the SAME turn — most ordinarily its own outcome (`runtime.error`,
      // `session.state-changed`), but also an unrelated `request.resolved`
      // mid-turn — wins that single slot and evicts the turn's own start.
      //
      // This lookup is unconditional, so it is never EVICTED by the race
      // above — it has its own dedicated slot, independent of whatever wins
      // `latestEventByMethods(LIFECYCLE_METHODS)`. Separately (`turn.started`
      // being one of the `LIFECYCLE_METHODS` supports THIS, not eviction
      // safety): `seq(latestEventByMethods(LIFECYCLE_METHODS)) >= seq(this
      // row)` always holds, so this row is never the HIGHEST-sequence row in
      // the set — either it is the same row as that slot (the ordinary case,
      // deduped below to a genuine no-op) or a strictly later lifecycle row
      // is also present. It therefore cannot make a stale turn look like the
      // newest fact. It DOES change a forward fold's (`activeTurnIdForEvents`,
      // `interruptibleTurnIdForEvents`) terminal answer, by design, whenever
      // the current turn's own start had been evicted and every OTHER
      // lifecycle-relevant event between that start and the read is itself a
      // fold no-op (e.g. `request.resolved`, `session.state-changed` alone) —
      // see the "orphan terminal" test below for one such change, pinned
      // rather than left implicit.
      latestTurnStarted,
      // archive#3557: the counterweight the block above already forecasts.
      // `firstTurnStartedWithPrompt`/`latestEventByMethod('turn.started')`
      // now guarantee the CURRENT turn's start survives, but its COMPLETION
      // has no dedicated slot — bedrock and ollama publish
      // `session.state-changed -> idle` immediately after `turn.completed`
      // (bedrock-adapter.ts's `publishCompletion`, same shape in
      // ollama-adapter.ts; codex reaches idle via a separate
      // `thread/status/changed` notification, claude via
      // `claude-adapter-events.ts`, station-agent via its own relay — station
      // fix-round review NIT: an earlier version of this comment claimed
      // EVERY adapter does this inline, which `session-lifecycle-service.ts`'s
      // own `bedrock/ollama`-scoped comment already contradicted), so on
      // those two providers that trailing state change wins the single
      // `LIFECYCLE_METHODS` slot and evicts the completion while the start
      // survives. A fold that sees `turn.started(turn-N)` with no matching
      // terminal for turn-N reads `hasActiveTurn: true` for a session with
      // nothing running.
      //
      // archive#3557/#3558 fix-round review BLOCK 1: scoped to the turn
      // `latestTurnStarted` names, not the thread's latest terminal — see
      // {@link EventStore.latestTerminalEventForTurn}'s docblock for why.
      latestTurnStarted?.turnId
        ? this.latestTerminalEventForTurn(threadId, latestTurnStarted.turnId)
        : undefined,
      this.latestEventByMethods(threadId, LIFECYCLE_METHODS),
      this.latestCurrentTurnRuntimeErrorEvent(threadId),
      ...this.listSessionProjectionFactEvents(threadId),
      ...this.listUnresolvedRequestEvents(threadId),
    ].filter((event): event is PersistedRuntimeEvent => Boolean(event));
    return [...new Map(facts.map((event) => [event.id, event])).values()].sort(
      (left, right) => left.sequence - right.sequence,
    );
  }

  /**
   * The latest `runtime.error` that still describes the session NOW.
   *
   * archive#3442: this fact set retains exactly ONE lifecycle event (the
   * highest-sequence row across {@link LIFECYCLE_METHODS}), and every adapter
   * publishes `session.state-changed -> idle` immediately after
   * `turn.completed`, so a later successful `turn.completed` always loses that
   * single slot. Force-retaining the latest `runtime.error` unconditionally
   * therefore made `failed` one-way: a usage-limit failure on turn 1 survived
   * a successful turn 2 and pinned the session (and its `blockedReason`)
   * failed forever, with no way back through the contract's
   * `failed -> queued | running` retry path.
   *
   * A `runtime.error` that names a turn is a fact about THAT TURN. Once a
   * different turn is the current one, the error describes work the session
   * has moved past and must not be replayed as the session's present state.
   *
   * An error that names NO turn is session-scoped — a transport or process
   * failure, a fact about the session itself, which is exactly why the
   * turn-identity rule below cannot reach it. "A different turn is current"
   * proves nothing about it: announcing a turn costs nothing, and a dead
   * transport may well still describe the session when the next turn is
   * merely announced. What DOES prove recovery is a strictly later PROVEN
   * `turn.completed` — an engine ran a whole turn end-to-end through the
   * transport the error indicted (archive#3485; feasible since archive#3557
   * made the completion fact durably observable). "Proven" is
   * {@link PROVIDER_PROVEN_FINISH_REASONS} — the same allowlist, and
   * deliberately the same single decision point, as auth-health clearing
   * (archive#3509 rejected the exclusion-list shape for this exact question
   * as fail-open). So `'cancelled'` (a Stop confirmation — codex publishes
   * one via `mapTurnFinishReason('interrupted')`), `'other'` ("we do not
   * know", per archive#3545), and an ABSENT `finishReason` all fail closed:
   * the error stays until a completion positively proves the session works.
   * `turn.aborted` likewise proves only that a stop was processed. The
   * accepted cost of failing closed: a session whose only post-error
   * completions are `'other'`-mapped (e.g. an ACP refusal) keeps its stale
   * `failed` badge until a proven completion arrives.
   *
   * The recovering completion is deliberately NOT required to name a turn:
   * the session-scoped question is "did ANY whole turn complete since",
   * not "did THIS turn complete" — turn identity has no role to play, so
   * demanding one would only re-pin errors against legacy rows that predate
   * universal turn ids.
   *
   * The check ({@link hasProvenTurnCompletionAfter}) queries the store
   * directly rather than reading the bounded fact set, so it does not
   * depend on — or race — which event holds the single lifecycle slot; and
   * the batched fold (`listSessionProjectionEventsForThreads`) consults the
   * SAME helper for its mirror of this rule, so the two folds cannot drift
   * on this question.
   *
   * Dropping requires PROOF of supersession, never mere inequality with the
   * latest `turn.started`. An adapter can allocate a turn id and publish a
   * failure against it before that turn is ever announced:
   * `claude-adapter.ts` sets `record.activeTurnId` at the top of `sendTurn`
   * and publishes `turn.started` ~165 lines later, and its terminal-result
   * branch (`claude-adapter-events.ts`) stamps that id onto `runtime.error`
   * with no dispatched-turn guard. Such an error names a turn that has no
   * `turn.started` row at all — "not the latest turn" but not superseded by
   * anything. Discarding it deletes the only record of WHY the session
   * failed: `blockedReason` disappears, `findTerminalFailureEvent` finds
   * nothing, `failureKind` is undefined, and the fold reports
   * `retryEligible: false` — a session marked failed with no reason and no
   * retry affordance, which is archive#3442's own complaint recreated.
   *
   * So: resolve the error's OWN turn first, and when it was never started,
   * fall back to the error's own position — retain it while no turn has been
   * announced since, drop it once one has. Both `session-recovery-coordinator`'s
   * `findSourceTurn` and this share that first step (resolve the error's own
   * turn), but their absence-handling is the opposite: `findSourceTurn`
   * returns undefined for a never-started turn and `armForRuntimeError` then
   * arms nothing, whereas this keeps the error rather than lose the only
   * account of the failure.
   *
   * The never-started branch must still ask whether the session moved on, or
   * it recreates archive#3442 from the other side: nothing else can drop a ghost
   * error, so a fully successful retry (whose `turn.completed` never reaches
   * this fact set — the trailing idle takes the single lifecycle slot) would
   * leave it the last word forever, still driving `blockedReason`,
   * `failureKind` and `retryEligible: false`.
   *
   * Deliberately NOT solved by also retaining `turn.completed` as a
   * counterweight: that leaves two racing facts in one slot, which is the
   * shape that produced this defect.
   */
  private latestCurrentTurnRuntimeErrorEvent(
    threadId: string,
  ): PersistedRuntimeEvent | undefined {
    const event = this.latestEventByMethod(threadId, 'runtime.error');
    if (!event) return undefined;
    if (!event.turnId) {
      // Session-scoped (archive#3485): retained until a strictly later
      // PROVEN completion shows the session recovered — see the docblock
      // for the allowlist decision and what deliberately does not count.
      return this.hasProvenTurnCompletionAfter(threadId, event.sequence)
        ? undefined
        : event;
    }
    const latestTurn = this.latestEventByMethod(threadId, 'turn.started');
    if (!latestTurn) return event;
    // Supersession is a question about turn IDENTITY, not about sequence. One
    // turn can be announced more than once — `claude-adapter.ts`'s steer path
    // publishes a second `turn.started` with the SAME turn id mid-turn — so a
    // later `turn.started` is only proof the session moved on when it names a
    // DIFFERENT turn.
    if (latestTurn.turnId === event.turnId) return event;
    const ownTurnStart = this.turnStartedEvent(threadId, event.turnId);
    // A turn that was never announced has no `turn.started` to compare, so
    // supersession is measured from the error itself: a turn announced AFTER
    // the failure is the session moving past it.
    if (!ownTurnStart) {
      return latestTurn.sequence > event.sequence ? undefined : event;
    }
    // `latestTurn` is the highest-sequence `turn.started` on the thread and
    // names another turn, so every announcement of this one precedes it.
    return undefined;
  }

  /**
   * The FIRST `turn.started` row announcing one turn, if that turn ever
   * started. A turn can be announced more than once (a steer re-announces the
   * same id), so the caller must not read this as "the turn's latest
   * announcement" — the only question it answers is whether the turn was ever
   * announced, and when it first was.
   *
   * `ORDER BY sequence ASC` is load-bearing, not style. `method` is a residual
   * filter over `idx_events_thread_turn_sequence(thread_id, turn_id,
   * sequence)`, and `turn.started` is the turn's FIRST row — so walking the
   * turn newest-first visits every streamed delta (each with a payload
   * lookup) before reaching the answer. Measured on a 20,001-event turn:
   * 2.28 ms descending vs 0.0016 ms ascending, on a read that runs once per
   * thread in the sessions/runs list and twice per consumed adapter event.
   * Ascending also matches how the rest of the store resolves a turn's anchor
   * (`turn_anchor_id` in the message-search join takes the turn's `LIMIT 1`
   * `turn.started` with no ordering at all).
   */
  /**
   * Whether a `turn.completed` that PROVES recovery exists strictly after
   * `sequence` on this thread — `finishReason` in
   * {@link PROVIDER_PROVEN_FINISH_REASONS} (allowlist; an absent or
   * unlisted reason proves nothing — fail closed). Backs the session-scoped
   * `runtime.error` supersession rule for BOTH folds:
   * {@link latestCurrentTurnRuntimeErrorEvent} and the batched mirror in
   * {@link listSessionProjectionEventsForThreads} — one implementation so
   * the single-thread and batched projections cannot disagree (archive#3485
   * review BLOCK 1: the first version fixed only the single-thread path,
   * and the Activity list kept reporting `failed` for a session the detail
   * view showed recovered).
   *
   * Cost: one `LIMIT 1` probe over
   * `idx_events_history_projection(thread_id, method, sequence)`, with the
   * JSON residual applied only to rows already matching
   * `(thread_id, 'turn.completed', > sequence)`. It runs only for a thread
   * whose LATEST `runtime.error` is session-scoped — including indefinitely
   * after recovery, since that row stays the thread's latest error forever;
   * that steady state is one indexed probe per projection read, accepted
   * rather than cached because caching a verdict here would be a second
   * place the answer could go stale.
   */
  private hasProvenTurnCompletionAfter(
    threadId: string,
    sequence: number,
  ): boolean {
    const reasons = [...PROVIDER_PROVEN_FINISH_REASONS];
    const placeholders = reasons.map(() => '?').join(', ');
    const row = this.db
      .prepare(
        `SELECT 1
         FROM orchestration_events
         WHERE thread_id = ? AND method = 'turn.completed'
           AND sequence > ?
           AND json_extract(payload, '$.finishReason') IN (${placeholders})
         LIMIT 1`,
      )
      .get(threadId, sequence, ...reasons);
    return Boolean(row);
  }

  private turnStartedEvent(
    threadId: string,
    turnId: string,
  ): PersistedRuntimeEvent | undefined {
    const row = this.db
      .prepare(
        `SELECT id, provider, thread_id, turn_id, method, payload, created_at, sequence, global_sequence
         FROM orchestration_events
         WHERE thread_id = ? AND turn_id = ? AND method = 'turn.started'
         ORDER BY sequence ASC
         LIMIT 1`,
      )
      .get(threadId, turnId) as any;
    return row ? this.mapEventRow(row) : undefined;
  }

  /**
   * The latest `turn.completed`/`turn.aborted` for ONE SPECIFIC turn —
   * archive#3557/#3558 fix-round review BLOCK 1. See the call site in
   * {@link listSessionProjectionEvents} for the full defect this replaced
   * (`latestEventByMethods(threadId, ['turn.completed', 'turn.aborted'])`,
   * unscoped to any turn) and why "cannot be the newest fact in the bounded
   * set" was not the same guarantee as "cannot be a STALE fact in the bounded
   * set".
   *
   * Scoping alone does not resolve every terminal for the SAME turn to one
   * ground truth: a user Stop can leave both a `turn.aborted` (published
   * synchronously by `interruptTurn`) and a later `turn.completed` (codex's
   * own async confirmation, `finishReason: 'cancelled'` via
   * `mapTurnFinishReason('interrupted')`) on one turn id, and this query's
   * `ORDER BY sequence DESC` picks the later one either way. That is
   * deliberately left to the fold layer, not resolved here:
   * `deriveLifecycleTransition`/`deriveAgentRunStatus` read
   * `event.finishReason === 'cancelled'` on a `turn.completed` and treat it
   * as a cancellation, so the answer is correct regardless of which of the
   * two physical rows this slot (or the separate, unscoped
   * `latestEventByMethods(LIFECYCLE_METHODS)` slot, which is NOT turn-scoped
   * and will independently surface whichever of the two is the thread's
   * overall latest lifecycle-method row) happens to hand the fold — see
   * archive#3557/#3558 review BLOCK 3.
   */
  private latestTerminalEventForTurn(
    threadId: string,
    turnId: string,
  ): PersistedRuntimeEvent | undefined {
    const row = this.db
      .prepare(
        `SELECT id, provider, thread_id, turn_id, method, payload, created_at, sequence, global_sequence
         FROM orchestration_events
         WHERE thread_id = ? AND turn_id = ?
           AND method IN ('turn.completed', 'turn.aborted')
         ORDER BY sequence DESC
         LIMIT 1`,
      )
      .get(threadId, turnId) as any;
    return row ? this.mapEventRow(row) : undefined;
  }

  private listSessionProjectionFactEvents(
    threadId: string,
  ): PersistedRuntimeEvent[] {
    return (
      this.db
        .prepare(
          `SELECT event.id, event.provider, event.thread_id, event.turn_id, event.method, event.payload, event.created_at, event.sequence, event.global_sequence
           FROM orchestration_session_projection_facts AS fact
           INNER JOIN orchestration_events AS event ON event.id = fact.event_id
           WHERE fact.thread_id = ?
           ORDER BY event.sequence ASC`,
        )
        .all(threadId) as any[]
    ).map((row: any) => this.mapEventRow(row));
  }

  /**
   * The batched counterpart of {@link listSessionProjectionEvents}
   * (archive#4466, review-remediated) — used ONLY by the list-many-sessions
   * read paths (`listSessionReadModel`, `listAgentRuns`). Every other,
   * single-thread caller (including `listSessionProjectionEvents` itself)
   * keeps the flat indexed per-thread reads above, UNCHANGED: an earlier
   * version of this method made `listSessionProjectionEvents` delegate here,
   * which put an unbounded per-batch read behind `consumeAdapterEvents`'s
   * per-streamed-event hot path (independent review, archive#4466 — the
   * exact archive#1867 wedge class) and every other single-thread caller.
   * That inversion is reverted; this method's blast radius is the two named
   * callers only.
   *
   * BOUNDEDNESS is the whole design constraint the first version of this
   * method violated: it fetched `SELECT * FROM orchestration_events WHERE
   * thread_id IN (...)` with no method filter and no row cap — every event
   * on every requested thread, hydrating attachments and materializing
   * payloads for rows the fold never reads. Measured on a real 51k-event/43-
   * thread store: 12.6ms -> 409ms and +212MB heap for identical output.
   *
   * The fix: rank by `(thread_id, method)`, not `(thread_id)` alone, over
   * ONLY {@link PROJECTION_FOLD_METHODS} — the finite set of methods any slot
   * in the fold actually names. A thread's un-listed methods
   * (`content.text-delta`, tool events, streamed deltas, ...) are never
   * fetched, so a 50,000-delta thread costs the same as a two-event one.
   * Ranking is done in a two-phase read: an inner CTE selects only `thread_id
   * `/`method`/`sequence` (plus the implicit `rowid`) to compute
   * `ROW_NUMBER()` per partition — a covering-index scan over
   * `idx_events_history_projection(thread_id, method, sequence)` that never
   * touches the `payload` column — and an outer join fetches the FULL row
   * (payload included) only for the rows that survive `rn_desc = 1 OR
   * rn_asc = 1`: at most two rows per (thread, method) requested. The
   * "latest event of any method" companion query below uses the same
   * two-phase shape over `idx_events_thread(thread_id, sequence)`.
   *
   * `firstTurnStartedWithPrompt`'s JSON predicate genuinely cannot skip
   * reading `payload` (it must inspect the prompt to test it), so that
   * companion query is a plain per-row CTE scoped to `method = 'turn.started'`
   * — the same cost the retired single-thread `firstTurnStartedWithPrompt`
   * already paid, just batched over threads via `IN (...)`. The
   * already-bounded projection-facts and unresolved-request joins are
   * unchanged from before.
   *
   * `id` lists are chunked at {@link EVENT_STORE_BATCH_CHUNK_SIZE} in every
   * query below, so `SQLITE_MAX_VARIABLE_NUMBER` (commonly 32766) can never
   * be reached regardless of how many threads are requested.
   */
  listSessionProjectionEventsForThreads(
    threadIds: readonly string[],
  ): Map<string, PersistedRuntimeEvent[]> {
    const uniqueThreadIds = [...new Set(threadIds)];
    const result = new Map<string, PersistedRuntimeEvent[]>();
    if (uniqueThreadIds.length === 0) return result;

    const rankedMethodFacts = this.fetchRankedMethodFacts(uniqueThreadIds);
    const latestAnyEventByThread = this.fetchLatestAnyEvent(uniqueThreadIds);
    const firstPromptedTurnByThread =
      this.fetchFirstTurnStartedWithPrompt(uniqueThreadIds);
    const projectionFactsByThread = this.groupMappedEventRowsByThread(
      this.fetchInChunks(
        uniqueThreadIds,
        (chunk, placeholders) =>
          this.db
            .prepare(
              `SELECT event.id, event.provider, event.thread_id, event.turn_id, event.method, event.payload, event.created_at, event.sequence, event.global_sequence
             FROM orchestration_session_projection_facts AS fact
             INNER JOIN orchestration_events AS event ON event.id = fact.event_id
             WHERE fact.thread_id IN (${placeholders})
             ORDER BY fact.thread_id ASC, event.sequence ASC`,
            )
            .all(...chunk) as any[],
      ),
    );
    const unresolvedRequestsByThread = this.groupMappedEventRowsByThread(
      this.fetchInChunks(
        uniqueThreadIds,
        (chunk, placeholders) =>
          this.db
            .prepare(
              `SELECT event.id, event.provider, event.thread_id, event.turn_id, event.method, event.payload, event.created_at, event.sequence, event.global_sequence
             FROM orchestration_request_state AS current
             INNER JOIN orchestration_events AS event ON event.id = current.event_id
             WHERE current.thread_id IN (${placeholders}) AND current.method = 'request.opened'
             ORDER BY current.thread_id ASC, current.sequence ASC`,
            )
            .all(...chunk) as any[],
      ),
    );

    // The two data-dependent companion lookups: which (threadId, turnId)
    // pairs need a turn-scoped terminal, and which need the runtime-error's
    // own turn-started row. Both depend on facts the ranked-method query
    // above already resolved, so they run as a SECOND small round of
    // queries rather than growing the first one's shape.
    const terminalPairs: Array<{ threadId: string; turnId: string }> = [];
    const ownTurnStartPairs: Array<{ threadId: string; turnId: string }> = [];
    for (const threadId of uniqueThreadIds) {
      const methodFacts = rankedMethodFacts.get(threadId);
      const latestTurnStarted = methodFacts?.get('turn.started')?.latest;
      if (latestTurnStarted?.turnId) {
        terminalPairs.push({ threadId, turnId: latestTurnStarted.turnId });
      }
      const runtimeError = methodFacts?.get('runtime.error')?.latest;
      if (
        runtimeError?.turnId &&
        latestTurnStarted &&
        latestTurnStarted.turnId !== runtimeError.turnId
      ) {
        ownTurnStartPairs.push({ threadId, turnId: runtimeError.turnId });
      }
    }
    const terminalByPair = this.fetchTurnScopedEvent(
      terminalPairs,
      "method IN ('turn.completed', 'turn.aborted')",
      'DESC',
    );
    const ownTurnStartByPair = this.fetchTurnScopedEvent(
      ownTurnStartPairs,
      "method = 'turn.started'",
      'ASC',
    );

    for (const threadId of uniqueThreadIds) {
      const methodFacts = rankedMethodFacts.get(threadId);
      const latestTurnStarted = methodFacts?.get('turn.started')?.latest;
      const latestRuntimeError = methodFacts?.get('runtime.error')?.latest;
      // Mirrors `latestCurrentTurnRuntimeErrorEvent` exactly (archive#3442):
      // see that method's docblock above for the full reasoning. The
      // session-scoped branch (archive#3485) calls the SAME
      // `hasProvenTurnCompletionAfter` helper the single-thread path uses —
      // one indexed probe, only for threads whose latest error is
      // session-scoped — because review BLOCK 1 on that change caught this
      // mirror still carrying the pre-#3485 unconditional retention while
      // the single-thread fold had been fixed: the Activity list said
      // `failed` for a session whose detail view said recovered.
      const latestCurrentTurnRuntimeError = (() => {
        if (!latestRuntimeError) return latestRuntimeError;
        if (!latestRuntimeError.turnId) {
          return this.hasProvenTurnCompletionAfter(
            threadId,
            latestRuntimeError.sequence,
          )
            ? undefined
            : latestRuntimeError;
        }
        if (!latestTurnStarted) return latestRuntimeError;
        if (latestTurnStarted.turnId === latestRuntimeError.turnId) {
          return latestRuntimeError;
        }
        const ownTurnStart = ownTurnStartByPair.get(
          pairKey(threadId, latestRuntimeError.turnId),
        );
        if (!ownTurnStart) {
          return latestTurnStarted.sequence > latestRuntimeError.sequence
            ? undefined
            : latestRuntimeError;
        }
        return undefined;
      })();
      // Mirrors `latestEventByMethods(LIFECYCLE_METHODS)`: the single
      // highest-sequence row among the latest row of each lifecycle method —
      // equivalent to "the overall latest row whose method is in the set",
      // computed here from the same per-method `latest` facts already
      // fetched rather than a second query.
      const latestLifecycleEvent = LIFECYCLE_METHODS.reduce<
        PersistedRuntimeEvent | undefined
      >((latest, method) => {
        const candidate = methodFacts?.get(method)?.latest;
        return candidate && (!latest || candidate.sequence > latest.sequence)
          ? candidate
          : latest;
      }, undefined);

      const facts = [
        latestAnyEventByThread.get(threadId),
        methodFacts?.get('flow.run-attached')?.latest,
        methodFacts?.get('policy.hooks-attached')?.latest,
        methodFacts?.get('session.started')?.latest,
        methodFacts?.get('session.configured')?.first,
        methodFacts?.get('session.configured')?.latest,
        firstPromptedTurnByThread.get(threadId),
        latestTurnStarted,
        latestTurnStarted?.turnId
          ? terminalByPair.get(pairKey(threadId, latestTurnStarted.turnId))
          : undefined,
        latestLifecycleEvent,
        latestCurrentTurnRuntimeError,
        ...(projectionFactsByThread.get(threadId) ?? []),
        ...(unresolvedRequestsByThread.get(threadId) ?? []),
      ].filter((event): event is PersistedRuntimeEvent => Boolean(event));
      result.set(
        threadId,
        [...new Map(facts.map((event) => [event.id, event])).values()].sort(
          (left, right) => left.sequence - right.sequence,
        ),
      );
    }
    return result;
  }

  /**
   * Latest and first row per `(threadId, method)`, for every method in
   * {@link PROJECTION_FOLD_METHODS} — the two-phase, payload-deferred ranking
   * this method's docblock describes.
   */
  private fetchRankedMethodFacts(
    threadIds: readonly string[],
  ): Map<string, Map<string, RankedMethodFact>> {
    const result = new Map<string, Map<string, RankedMethodFact>>();
    const methodPlaceholders = PROJECTION_FOLD_METHODS.map(() => '?').join(
      ', ',
    );
    for (const chunk of this.chunkArray(
      threadIds,
      EVENT_STORE_BATCH_CHUNK_SIZE,
    )) {
      const threadPlaceholders = chunk.map(() => '?').join(', ');
      const rows = this.db
        .prepare(
          `WITH ranked AS (
             SELECT rowid AS rid, thread_id, method,
               ROW_NUMBER() OVER (PARTITION BY thread_id, method ORDER BY sequence DESC) AS rn_desc,
               ROW_NUMBER() OVER (PARTITION BY thread_id, method ORDER BY sequence ASC) AS rn_asc
             FROM orchestration_events
             WHERE thread_id IN (${threadPlaceholders}) AND method IN (${methodPlaceholders})
           )
           SELECT event.id, event.provider, event.thread_id, event.turn_id, event.method, event.payload, event.created_at, event.observed_at, event.sequence, event.global_sequence, ranked.rn_desc, ranked.rn_asc
           FROM ranked
           INNER JOIN orchestration_events AS event ON event.rowid = ranked.rid
           WHERE ranked.rn_desc = 1 OR ranked.rn_asc = 1`,
        )
        .all(...chunk, ...PROJECTION_FOLD_METHODS) as any[];
      for (const row of rows) {
        const event = this.mapEventRow(row);
        let byMethod = result.get(event.threadId);
        if (!byMethod) {
          byMethod = new Map<string, RankedMethodFact>();
          result.set(event.threadId, byMethod);
        }
        let slot = byMethod.get(event.method);
        if (!slot) {
          slot = {};
          byMethod.set(event.method, slot);
        }
        if (row.rn_desc === 1) slot.latest = event;
        if (row.rn_asc === 1) slot.first = event;
      }
    }
    return result;
  }

  /**
   * Latest event of ANY method per thread — mirrors {@link latestEvent},
   * batched. Same two-phase, payload-deferred shape over
   * `idx_events_thread(thread_id, sequence)`.
   */
  private fetchLatestAnyEvent(
    threadIds: readonly string[],
  ): Map<string, PersistedRuntimeEvent> {
    const result = new Map<string, PersistedRuntimeEvent>();
    for (const chunk of this.chunkArray(
      threadIds,
      EVENT_STORE_BATCH_CHUNK_SIZE,
    )) {
      const placeholders = chunk.map(() => '?').join(', ');
      const rows = this.db
        .prepare(
          `WITH ranked AS (
             SELECT rowid AS rid,
               ROW_NUMBER() OVER (PARTITION BY thread_id ORDER BY sequence DESC) AS rn
             FROM orchestration_events
             WHERE thread_id IN (${placeholders})
           )
           SELECT event.id, event.provider, event.thread_id, event.turn_id, event.method, event.payload, event.created_at, event.observed_at, event.sequence, event.global_sequence
           FROM ranked
           INNER JOIN orchestration_events AS event ON event.rowid = ranked.rid
           WHERE ranked.rn = 1`,
        )
        .all(...chunk) as any[];
      for (const row of rows) {
        result.set(row.thread_id, this.mapEventRow(row));
      }
    }
    return result;
  }

  /**
   * Mirrors {@link firstTurnStartedWithPrompt}, batched. The JSON prompt
   * predicate must read `payload` for every `turn.started` row to evaluate
   * it, so this stays a plain per-row CTE (not two-phase) scoped to
   * `method = 'turn.started'` — the same cost the single-thread version
   * already paid per thread, just issued once via `thread_id IN (...)`.
   */
  private fetchFirstTurnStartedWithPrompt(
    threadIds: readonly string[],
  ): Map<string, PersistedRuntimeEvent> {
    const result = new Map<string, PersistedRuntimeEvent>();
    for (const chunk of this.chunkArray(
      threadIds,
      EVENT_STORE_BATCH_CHUNK_SIZE,
    )) {
      const placeholders = chunk.map(() => '?').join(', ');
      const rows = this.db
        .prepare(
          `WITH ranked AS (
             SELECT id, provider, thread_id, turn_id, method, payload, created_at, observed_at, sequence, global_sequence,
               ROW_NUMBER() OVER (PARTITION BY thread_id ORDER BY sequence ASC) AS rn
             FROM orchestration_events
             WHERE thread_id IN (${placeholders}) AND method = 'turn.started'
               AND typeof(json_extract(payload, '$.prompt')) = 'text'
               AND trim(json_extract(payload, '$.prompt')) != ''
           )
           SELECT * FROM ranked WHERE rn = 1`,
        )
        .all(...chunk) as any[];
      for (const row of rows) {
        result.set(row.thread_id, this.mapEventRow(row));
      }
    }
    return result;
  }

  /**
   * The latest (`order === 'DESC'`) or first (`'ASC'`) row matching
   * `methodFilter` for each requested `(threadId, turnId)` pair — mirrors
   * {@link latestTerminalEventForTurn} and {@link turnStartedEvent}, batched
   * via a `(thread_id, turn_id) IN (VALUES (?,?), ...)` row-value list,
   * chunked at {@link EVENT_STORE_BATCH_CHUNK_SIZE} pairs. Two-phase and
   * payload-deferred like the method-ranked query. (The planner satisfies it
   * via `idx_events_history_projection (thread_id, method)` plus bloom
   * filters rather than the turn-sequence index — measured, not assumed; no
   * `INDEXED BY` binds it.) Skips
   * the query entirely when `pairs` is empty (the ordinary case: most reads
   * request no turn-scoped facts at all).
   */
  private fetchTurnScopedEvent(
    pairs: ReadonlyArray<{ threadId: string; turnId: string }>,
    methodFilter: string,
    order: 'ASC' | 'DESC',
  ): Map<string, PersistedRuntimeEvent> {
    const result = new Map<string, PersistedRuntimeEvent>();
    if (pairs.length === 0) return result;
    for (const chunk of this.chunkArray(pairs, EVENT_STORE_BATCH_CHUNK_SIZE)) {
      const valuesPlaceholders = chunk.map(() => '(?, ?)').join(', ');
      const values = chunk.flatMap((pair) => [pair.threadId, pair.turnId]);
      const rows = this.db
        .prepare(
          `WITH ranked AS (
             SELECT rowid AS rid, thread_id, turn_id,
               ROW_NUMBER() OVER (PARTITION BY thread_id, turn_id ORDER BY sequence ${order}) AS rn
             FROM orchestration_events
             WHERE (thread_id, turn_id) IN (VALUES ${valuesPlaceholders})
               AND ${methodFilter}
           )
           SELECT event.id, event.provider, event.thread_id, event.turn_id, event.method, event.payload, event.created_at, event.observed_at, event.sequence, event.global_sequence
           FROM ranked
           INNER JOIN orchestration_events AS event ON event.rowid = ranked.rid
           WHERE ranked.rn = 1`,
        )
        .all(...values) as any[];
      for (const row of rows) {
        result.set(pairKey(row.thread_id, row.turn_id), this.mapEventRow(row));
      }
    }
    return result;
  }

  /** Splits `items` into `size`-bounded groups, preserving order. */
  private chunkArray<T>(items: readonly T[], size: number): T[][] {
    const chunks: T[][] = [];
    for (let index = 0; index < items.length; index += size) {
      chunks.push(items.slice(index, index + size));
    }
    return chunks;
  }

  /**
   * Runs `query` once per {@link EVENT_STORE_BATCH_CHUNK_SIZE}-sized chunk
   * of `threadIds` and concatenates the rows. Shared by the two
   * already-bounded join queries (projection facts, unresolved requests).
   */
  private fetchInChunks(
    threadIds: readonly string[],
    query: (chunk: readonly string[], placeholders: string) => any[],
  ): any[] {
    const rows: any[] = [];
    for (const chunk of this.chunkArray(
      threadIds,
      EVENT_STORE_BATCH_CHUNK_SIZE,
    )) {
      rows.push(...query(chunk, chunk.map(() => '?').join(', ')));
    }
    return rows;
  }

  /** Row-mapped batch results, grouped by each mapped row's own thread id. */
  private groupMappedEventRowsByThread(
    rows: any[],
  ): Map<string, PersistedRuntimeEvent[]> {
    const grouped = new Map<string, PersistedRuntimeEvent[]>();
    for (const row of rows) {
      const event = this.mapEventRow(row);
      const existing = grouped.get(event.threadId);
      if (existing) existing.push(event);
      else grouped.set(event.threadId, [event]);
    }
    return grouped;
  }

  /**
   * Complete history for a finite, caller-owned set of canonical methods.
   * This is intentionally a method allowlist rather than a row limit: a
   * Console emission or other durable fact written before a large transcript
   * remains observable. An empty method set is a caller bug, not an empty
   * result, because accepting it would make a missing classification look
   * like an honestly eventless thread.
   */
  listEventsByMethods(
    threadId: string,
    methods: readonly string[],
  ): PersistedRuntimeEvent[] {
    if (methods.length === 0) {
      throw new Error('An event-method query requires at least one method');
    }
    const placeholders = methods.map(() => '?').join(', ');
    return (
      this.db
        .prepare(
          `SELECT id, provider, thread_id, turn_id, method, payload, created_at, sequence, global_sequence
           FROM orchestration_events
           WHERE thread_id = ? AND method IN (${placeholders})
           ORDER BY sequence ASC`,
        )
        .all(threadId, ...methods) as any[]
    ).map((row: any) => this.mapEventRow(row));
  }

  listEventsByMethodsAfterSequence(
    threadId: string,
    methods: readonly string[],
    afterSequence: number,
    limit = 250,
  ): PersistedRuntimeEvent[] {
    if (methods.length === 0) {
      throw new Error('An event-method query requires at least one method');
    }
    if (!Number.isInteger(afterSequence) || afterSequence < 0) {
      throw new Error('An event-method cursor must be a non-negative integer');
    }
    if (!Number.isInteger(limit) || limit < 1 || limit > 1_000) {
      throw new Error('An event-method page limit must be between 1 and 1000');
    }
    const placeholders = methods.map(() => '?').join(', ');
    return (
      this.db
        .prepare(
          `SELECT id, provider, thread_id, turn_id, method, payload, created_at, sequence, global_sequence
           FROM orchestration_events
           WHERE thread_id = ? AND method IN (${placeholders}) AND sequence > ?
           ORDER BY sequence ASC
           LIMIT ?`,
        )
        .all(threadId, ...methods, afterSequence, limit) as any[]
    ).map((row: any) => this.mapEventRow(row));
  }

  readConsoleDeliveryProgress(threadId: string, scopeId: string): number {
    const row = this.db
      .prepare(
        `SELECT delivered_through
         FROM orchestration_console_delivery_progress
         WHERE thread_id = ? AND scope_id = ?`,
      )
      .get(threadId, scopeId) as { delivered_through?: number } | undefined;
    return Number(row?.delivered_through ?? 0);
  }

  writeConsoleDeliveryProgress(
    threadId: string,
    scopeId: string,
    deliveredThrough: number,
  ): void {
    if (!Number.isInteger(deliveredThrough) || deliveredThrough < 0) {
      throw new Error(
        'Console delivery progress must be a non-negative integer',
      );
    }
    this.db
      .prepare(
        `INSERT INTO orchestration_console_delivery_progress
          (thread_id, scope_id, delivered_through)
         VALUES (?, ?, ?)
         ON CONFLICT(thread_id, scope_id) DO UPDATE SET
           delivered_through = MAX(
             orchestration_console_delivery_progress.delivered_through,
             excluded.delivered_through
           )`,
      )
      .run(threadId, scopeId, deliveredThrough);
  }

  /**
   * The source event named by a recovery intent.  The persisted event id is
   * already unique, so a thread-scoped point lookup is both complete and
   * bounded.
   */
  eventById(
    threadId: string,
    eventId: string,
  ): PersistedRuntimeEvent | undefined {
    const row = this.db
      .prepare(
        `SELECT id, provider, thread_id, turn_id, method, payload, created_at, sequence, global_sequence
         FROM orchestration_events
         WHERE thread_id = ? AND id = ?
         LIMIT 1`,
      )
      .get(threadId, eventId) as any;
    return row ? this.mapEventRow(row) : undefined;
  }

  /**
   * Descriptor-only point lookup for a pinned authored input. Event ids are
   * globally unique (`orchestration_events.id` is the primary key); threadId
   * remains in the result for authorization and lineage validation. This SQL
   * never selects payload or attachment bytes and never hydrates blobs.
   */
  userInputEventById(eventId: string): UserInputEventDescriptor | undefined {
    if (!hasBoundedDescriptorText(eventId, MAX_TOOL_RESULT_DESCRIPTOR_ID_BYTES))
      return undefined;
    const rows = this.db
      .prepare(
        `SELECT e.id, e.thread_id, e.turn_id, e.method,
                json_valid(e.payload) AS valid_json,
                CASE WHEN json_valid(e.payload) THEN json_extract(e.payload, '$.prompt') END AS prompt,
                CASE WHEN json_valid(e.payload) THEN json_type(e.payload, '$.inputKind') END AS input_kind_type,
                CASE WHEN json_valid(e.payload) THEN json_extract(e.payload, '$.inputKind') END AS input_kind,
                CASE WHEN json_valid(e.payload) THEN json_type(e.payload, '$.attachments') END AS attachments_type,
                a.key AS attachment_key,
                json_type(a.value) AS attachment_type,
                json_extract(a.value, '$.kind') AS attachment_kind,
                json_extract(a.value, '$.name') AS attachment_name,
                json_extract(a.value, '$.mimeType') AS attachment_mime_type,
                json_extract(a.value, '$.size') AS attachment_size
           FROM orchestration_events e
           LEFT JOIN json_each(CASE WHEN json_valid(e.payload) THEN e.payload ELSE '[]' END, '$.attachments') a
             ON true
          WHERE e.id = ?
          LIMIT ?`,
      )
      .all(eventId, CHAT_ATTACHMENT_MAX_COUNT + 1) as Array<{
      id: string;
      thread_id: string;
      turn_id: string | null;
      method: string;
      valid_json: unknown;
      prompt: unknown;
      input_kind_type: unknown;
      input_kind: unknown;
      attachments_type: unknown;
      attachment_key: unknown;
      attachment_type: unknown;
      attachment_kind: unknown;
      attachment_name: unknown;
      attachment_mime_type: unknown;
      attachment_size: unknown;
    }>;
    const first = rows[0];
    if (!first) return undefined;
    if (
      rows.length > CHAT_ATTACHMENT_MAX_COUNT ||
      first.valid_json !== 1 ||
      !hasBoundedDescriptorText(
        first.id,
        MAX_TOOL_RESULT_DESCRIPTOR_ID_BYTES,
      ) ||
      !hasBoundedDescriptorText(
        first.thread_id,
        MAX_TOOL_RESULT_DESCRIPTOR_ID_BYTES,
      ) ||
      (first.turn_id !== null &&
        !hasBoundedDescriptorText(
          first.turn_id,
          MAX_TOOL_RESULT_DESCRIPTOR_ID_BYTES,
        )) ||
      (first.attachments_type !== null && first.attachments_type !== 'array') ||
      (first.input_kind_type !== null &&
        (first.input_kind_type !== 'text' || first.input_kind !== 'steer')) ||
      (first.prompt !== null && typeof first.prompt !== 'string') ||
      (typeof first.prompt === 'string' &&
        first.prompt.length > CHAT_INPUT_MAX_CHARS)
    )
      throw new Error('Invalid user-input event descriptor');
    const attachments = [] as Array<{
      name: string;
      mimeType: string;
      size: number;
    }>;
    for (const row of rows) {
      // A `LEFT JOIN` emits one key-less row only for an empty/missing array.
      if (row.attachment_key === null) continue;
      if (
        row.attachment_type !== 'object' ||
        typeof row.attachment_kind !== 'string' ||
        typeof row.attachment_name !== 'string' ||
        typeof row.attachment_mime_type !== 'string' ||
        typeof row.attachment_size !== 'number'
      )
        throw new Error('Invalid user-input attachment descriptor');
      const descriptor = {
        kind: row.attachment_kind as PersistedChatAttachment['kind'],
        name: row.attachment_name,
        mimeType:
          row.attachment_mime_type as PersistedChatAttachment['mimeType'],
        size: row.attachment_size,
      };
      if (validatePersistedChatAttachmentDescriptor(descriptor))
        throw new Error('Invalid user-input attachment descriptor');
      attachments.push({
        name: descriptor.name,
        mimeType: descriptor.mimeType,
        size: descriptor.size,
      });
    }
    if (
      !(typeof first.prompt === 'string' && first.prompt.trim()) &&
      attachments.length === 0
    )
      throw new Error('Invalid user-input event descriptor');
    return {
      eventId: first.id,
      threadId: first.thread_id,
      ...(first.turn_id ? { turnId: first.turn_id } : {}),
      method: first.method,
      ...(first.input_kind_type === null
        ? { inputKind: 'initial' as const }
        : first.input_kind_type === 'text' && first.input_kind === 'steer'
          ? { inputKind: 'steer' as const }
          : {}),
      ...(typeof first.prompt === 'string' ? { prompt: first.prompt } : {}),
      attachments,
    };
  }

  /**
   * Descriptor-only point lookup for one owner-issued terminal tool result.
   * This intentionally selects the exact fields the Thread adapter owns; it
   * does not replay a Session, hydrate attachments, or expose call arguments.
   */
  toolCompletedEventById(
    threadId: string,
    eventId: string,
  ):
    | {
        eventId: string;
        threadId: string;
        turnId?: string;
        method: string;
        toolCallId?: string;
        toolName?: string;
        status?: string;
        output?: unknown;
        error?: string;
        policyDenied?: boolean;
      }
    | undefined {
    const row = this.db
      .prepare(
        `SELECT id, thread_id, turn_id, method,
                json_type(payload, '$.toolCallId') AS tool_call_id_type,
                CASE WHEN json_type(payload, '$.toolCallId') = 'text'
                   AND length(CAST(json_extract(payload, '$.toolCallId') AS BLOB)) <= ?
                  THEN json_extract(payload, '$.toolCallId') ELSE NULL END AS tool_call_id,
                CASE WHEN json_type(payload, '$.toolCallId') = 'text'
                   AND length(CAST(json_extract(payload, '$.toolCallId') AS BLOB)) > ?
                  THEN 1 ELSE 0 END AS tool_call_id_over_limit,
                json_type(payload, '$.toolName') AS tool_name_type,
                CASE WHEN json_type(payload, '$.toolName') = 'text'
                   AND length(CAST(json_extract(payload, '$.toolName') AS BLOB)) <= ?
                  THEN json_extract(payload, '$.toolName') ELSE NULL END AS tool_name,
                CASE WHEN json_type(payload, '$.toolName') = 'text'
                   AND length(CAST(json_extract(payload, '$.toolName') AS BLOB)) > ?
                  THEN 1 ELSE 0 END AS tool_name_over_limit,
                json_extract(payload, '$.status') AS status,
                json_type(payload, '$.output') AS output_type,
                CASE
                  WHEN json_type(payload, '$.output') = 'text'
                   AND length(CAST(json_extract(payload, '$.output') AS BLOB)) <= ?
                    THEN json_extract(payload, '$.output')
                  ELSE NULL
                END AS output,
                CASE
                  WHEN json_type(payload, '$.output') = 'text'
                   AND length(CAST(json_extract(payload, '$.output') AS BLOB)) > ?
                    THEN 1
                  ELSE 0
                END AS output_over_limit,
                json_type(payload, '$.error') AS error_type,
                CASE WHEN json_type(payload, '$.error') = 'text'
                   AND length(CAST(json_extract(payload, '$.error') AS BLOB)) <= ?
                    THEN json_extract(payload, '$.error') ELSE NULL END AS error,
                CASE WHEN json_type(payload, '$.error') = 'text'
                   AND length(CAST(json_extract(payload, '$.error') AS BLOB)) > ?
                    THEN 1 ELSE 0 END AS error_over_limit,
                json_type(payload, '$.policyDenied') AS policy_denied_type,
                json_extract(payload, '$.policyDenied') AS policy_denied
           FROM orchestration_events
          WHERE thread_id = ? AND id = ? AND json_valid(payload)
          LIMIT 1`,
      )
      .get(
        MAX_TOOL_RESULT_DESCRIPTOR_ID_BYTES,
        MAX_TOOL_RESULT_DESCRIPTOR_ID_BYTES,
        MAX_TOOL_RESULT_DESCRIPTOR_LABEL_BYTES,
        MAX_TOOL_RESULT_DESCRIPTOR_LABEL_BYTES,
        MAX_TOOL_RESULT_DESCRIPTOR_OUTPUT_BYTES,
        MAX_TOOL_RESULT_DESCRIPTOR_OUTPUT_BYTES,
        MAX_TOOL_RESULT_DESCRIPTOR_OUTPUT_BYTES,
        MAX_TOOL_RESULT_DESCRIPTOR_OUTPUT_BYTES,
        threadId,
        eventId,
      ) as
      | {
          id: unknown;
          thread_id: unknown;
          turn_id: unknown;
          method: unknown;
          tool_call_id_type: unknown;
          tool_call_id: unknown;
          tool_call_id_over_limit: unknown;
          tool_name_type: unknown;
          tool_name: unknown;
          tool_name_over_limit: unknown;
          status: unknown;
          output_type: unknown;
          output: unknown;
          output_over_limit: unknown;
          error_type: unknown;
          error: unknown;
          error_over_limit: unknown;
          policy_denied_type: unknown;
          policy_denied: unknown;
        }
      | undefined;
    if (!row) return undefined;
    if (
      typeof row.id !== 'string' ||
      typeof row.thread_id !== 'string' ||
      typeof row.method !== 'string' ||
      (row.turn_id !== null && typeof row.turn_id !== 'string') ||
      row.tool_call_id_type !== 'text' ||
      (row.tool_call_id !== null && typeof row.tool_call_id !== 'string') ||
      (row.tool_call_id_over_limit !== 0 &&
        row.tool_call_id_over_limit !== 1) ||
      row.tool_name_type !== 'text' ||
      (row.tool_name !== null && typeof row.tool_name !== 'string') ||
      (row.tool_name_over_limit !== 0 && row.tool_name_over_limit !== 1) ||
      (row.status !== null && typeof row.status !== 'string') ||
      (row.error_type !== null && row.error_type !== 'text') ||
      (row.error !== null && typeof row.error !== 'string') ||
      (row.output_type !== null && typeof row.output_type !== 'string') ||
      (row.output_over_limit !== 0 && row.output_over_limit !== 1) ||
      (row.error_over_limit !== 0 && row.error_over_limit !== 1) ||
      (row.policy_denied_type !== null &&
        row.policy_denied_type !== 'true' &&
        row.policy_denied_type !== 'false') ||
      (row.policy_denied_type === 'true' && row.policy_denied !== 1) ||
      (row.policy_denied_type === 'false' && row.policy_denied !== 0)
    )
      return undefined;
    if (
      row.tool_call_id_over_limit === 1 ||
      row.tool_name_over_limit === 1 ||
      row.output_over_limit === 1 ||
      row.error_over_limit === 1
    )
      return undefined;
    // Source structured values never cross this descriptor.
    const output = row.output_type === 'text' ? row.output : undefined;
    return {
      eventId: row.id,
      threadId: row.thread_id,
      ...(typeof row.turn_id === 'string' ? { turnId: row.turn_id } : {}),
      method: row.method,
      ...(typeof row.tool_call_id === 'string'
        ? { toolCallId: row.tool_call_id }
        : {}),
      ...(typeof row.tool_name === 'string' ? { toolName: row.tool_name } : {}),
      ...(typeof row.status === 'string' ? { status: row.status } : {}),
      ...(output === undefined ? {} : { output }),
      ...(typeof row.error === 'string' ? { error: row.error } : {}),
      ...(row.policy_denied_type === 'true' ? { policyDenied: true } : {}),
    };
  }

  /**
   * Persist the exact envelope the live fold produced. The conflict update
   * makes duplicate terminal delivery harmless while keeping the latest
   * complete fold available after a restart.
   */
  upsertTurnProvenance(envelope: TurnProvenanceEnvelope): void {
    const serialized = JSON.stringify(envelope);
    this.db
      .prepare(
        `INSERT INTO orchestration_turn_provenance
          (thread_id, turn_id, envelope, envelope_bytes)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(thread_id, turn_id) DO UPDATE SET
           envelope = excluded.envelope,
           envelope_bytes = excluded.envelope_bytes`,
      )
      .run(
        envelope.sessionId,
        envelope.turnId,
        serialized,
        Buffer.byteLength(serialized),
      );
  }

  /** Narrow persisted lookup for replay/preflight. Undefined discloses rows written before this projection existed. */
  readTurnProvenance(
    threadId: string,
    turnId: string,
  ): TurnProvenanceEnvelope | undefined {
    const row = this.db
      .prepare(
        `SELECT envelope FROM orchestration_turn_provenance
         WHERE thread_id = ? AND turn_id = ?`,
      )
      .get(threadId, turnId) as { envelope?: string } | undefined;
    return row?.envelope
      ? (JSON.parse(row.envelope) as TurnProvenanceEnvelope)
      : undefined;
  }

  listConversationHistoryPage(options: {
    ownerUserId: string;
    tenantId?: string;
    agentSlug?: string;
    requireBound?: boolean;
    includeOwnerless?: boolean;
    limit: number;
    cursor?: ConversationHistoryCursor;
  }): ConversationHistoryPage {
    type HistoryRow = {
      thread_id: string;
      conversation_id: string;
      environment_id: string | null;
      owner_user_id: string | null;
      tenant_id: string | null;
      agent_slug: string | null;
      title: string | null;
      message_count: number;
      created_at: string;
      updated_at: string;
    };
    const readRows = (ownerPredicate: string): HistoryRow[] => {
      const memberPredicates = [ownerPredicate];
      const conversationPredicates = ['row_rank = 1'];
      const values: unknown[] = [];
      if (ownerPredicate === 'h.owner_user_id = ?') {
        values.push(options.ownerUserId);
      }
      if (options.tenantId !== undefined) {
        memberPredicates.push('h.tenant_id = ?');
        values.push(options.tenantId);
      }
      if (options.agentSlug !== undefined) {
        conversationPredicates.push('agent_slug = ?');
        values.push(options.agentSlug);
      }
      if (options.requireBound)
        conversationPredicates.push('agent_slug IS NOT NULL');
      if (options.cursor) {
        conversationPredicates.push(
          '(updated_at < ? OR (updated_at = ? AND thread_id < ?))',
        );
        values.push(
          options.cursor.updatedAt,
          options.cursor.updatedAt,
          options.cursor.threadId,
        );
      }
      values.push(options.limit + 1);
      // Immutable lineage wins. Metadata is a legacy fallback only; public
      // starts cannot author it because conversationId is reserved.
      const conversationId = `COALESCE(cs.conversation_id, (
        SELECT json_extract(e.payload, '$.metadata.conversationId')
        FROM orchestration_events e
        WHERE e.thread_id = h.thread_id
          AND e.method IN ('session.started', 'session.configured')
          AND json_valid(e.payload)
          AND json_type(e.payload, '$.metadata.conversationId') = 'text'
        ORDER BY e.sequence DESC
        LIMIT 1
      ), h.thread_id)`;
      // Environment metadata is likewise server-owned. Empty is the legacy
      // pre-environment namespace, never a caller-selected scope.
      const environmentId = `COALESCE((
        SELECT json_extract(e.payload, '$.metadata.environmentId')
        FROM orchestration_events e
        WHERE e.thread_id = h.thread_id
          AND e.method IN ('session.started', 'session.configured')
          AND json_valid(e.payload)
          AND json_type(e.payload, '$.metadata.environmentId') = 'text'
        ORDER BY e.sequence DESC
        LIMIT 1
      ), '')`;
      const partition = `${environmentId}, ${conversationId}`;
      return this.db
        .prepare(
          `WITH ranked AS (
             SELECT h.thread_id, h.owner_user_id, h.tenant_id, h.agent_slug,
                    ${conversationId} AS conversation_id,
                    ${environmentId} AS environment_id,
                    h.title,
                    h.created_at,
                    h.updated_at,
                    ROW_NUMBER() OVER (
                      PARTITION BY ${partition}
                      ORDER BY h.updated_at DESC, h.thread_id DESC
                    ) AS row_rank,
                    SUM(h.message_count) OVER (
                      PARTITION BY ${partition}
                    ) AS message_count,
                    MIN(h.created_at) OVER (
                      PARTITION BY ${partition}
                    ) AS conversation_created_at,
                    FIRST_VALUE(h.title) OVER (
                      PARTITION BY ${partition}
                      ORDER BY h.created_at ASC, h.thread_id ASC
                    ) AS root_title
             FROM orchestration_conversation_history h
             LEFT JOIN orchestration_conversation_sessions cs
               ON cs.session_id = h.thread_id
             WHERE ${memberPredicates.join(' AND ')}
           )
           SELECT thread_id, conversation_id,
                  NULLIF(environment_id, '') AS environment_id,
                  owner_user_id, tenant_id, agent_slug,
                  COALESCE(root_title, title) AS title,
                  message_count, conversation_created_at AS created_at,
                  updated_at
           FROM ranked
           WHERE ${conversationPredicates.join(' AND ')}
           ORDER BY updated_at DESC, thread_id DESC
           LIMIT ?`,
        )
        .all(...values) as HistoryRow[];
    };
    const rows = [
      ...readRows('h.owner_user_id = ?'),
      ...(options.includeOwnerless ? readRows('h.owner_user_id IS NULL') : []),
    ].sort(
      (left, right) =>
        right.updated_at.localeCompare(left.updated_at) ||
        right.thread_id.localeCompare(left.thread_id),
    );
    const hasMore = rows.length > options.limit;
    const records = rows.slice(0, options.limit).map((row) => ({
      threadId: row.thread_id,
      conversationId: row.conversation_id,
      ...(row.environment_id ? { environmentId: row.environment_id } : {}),
      ...(row.owner_user_id ? { ownerUserId: row.owner_user_id } : {}),
      ...(row.tenant_id ? { tenantId: row.tenant_id } : {}),
      ...(row.agent_slug ? { agentSlug: row.agent_slug } : {}),
      title: row.title ?? 'New chat',
      messageCount: row.message_count,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
    const last = records.at(-1);
    return {
      records,
      hasMore,
      ...(hasMore && last
        ? { nextCursor: { updatedAt: last.updatedAt, threadId: last.threadId } }
        : {}),
    };
  }

  readConversationHistoryUpgrade(): ConversationHistoryUpgrade {
    const upgrade = this.db
      .prepare(
        `SELECT status FROM orchestration_conversation_history_upgrade WHERE id = 1`,
      )
      .get() as { status: string } | undefined;
    const quarantined = this.db
      .prepare(
        `SELECT COUNT(*) AS count FROM orchestration_conversation_history_quarantine`,
      )
      .get() as { count: number };
    if (upgrade?.status !== 'complete') {
      throw new Error('Conversation history upgrade is incomplete');
    }
    return { status: 'complete', quarantinedCount: quarantined.count };
  }

  listConversationHistoryQuarantine(): ConversationHistoryQuarantineRecord[] {
    return this.db
      .prepare(
        `SELECT thread_id, reason, recorded_at
         FROM orchestration_conversation_history_quarantine
         ORDER BY recorded_at ASC, thread_id ASC`,
      )
      .all()
      .map((row: any) => ({
        threadId: row.thread_id,
        reason: row.reason as 'unbound',
        recordedAt: row.recorded_at,
      }));
  }

  /**
   * Accurate event count for a thread without materializing any row payload
   * (archive#1867). `COUNT(*)` over the `(thread_id, sequence)` index is a
   * bounded index-only read; `listEvents(threadId).length` would materialize
   * and JSON.parse every payload synchronously on the event loop, which is the
   * `.all()` that wedged the server on a thread with tens of thousands of
   * events.
   */
  countEventsByThread(threadId: string): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS c
         FROM orchestration_events
         WHERE thread_id = ?`,
      )
      .get(threadId) as { c: number };
    return row.c;
  }

  /**
   * Batched sibling of {@link countEventsByThread} (archive#4466): a bounded
   * `GROUP BY` query per {@link EVENT_STORE_BATCH_CHUNK_SIZE}-sized chunk of
   * requested thread ids, instead of one `COUNT(*)` round trip per thread. A
   * thread with zero events is absent from SQLite's `GROUP BY` result, so
   * callers read a missing entry as zero — the same answer
   * `countEventsByThread` gives a threadless id.
   */
  countEventsByThreads(threadIds: readonly string[]): Map<string, number> {
    const uniqueThreadIds = [...new Set(threadIds)];
    const counts = new Map<string, number>();
    if (uniqueThreadIds.length === 0) return counts;
    for (const chunk of this.chunkArray(
      uniqueThreadIds,
      EVENT_STORE_BATCH_CHUNK_SIZE,
    )) {
      const placeholders = chunk.map(() => '?').join(', ');
      const rows = this.db
        .prepare(
          `SELECT thread_id AS threadId, COUNT(*) AS c
           FROM orchestration_events
           WHERE thread_id IN (${placeholders})
           GROUP BY thread_id`,
        )
        .all(...chunk) as Array<{ threadId: string; c: number }>;
      for (const row of rows) counts.set(row.threadId, row.c);
    }
    return counts;
  }

  /** Latest adapter-accepted model across every child Session in a lineage. */
  readLatestAcceptedConversationModel(input: {
    conversationId: string;
    environmentId?: string;
  }): string | undefined {
    const row = this.db
      .prepare(
        `SELECT json_extract(e.payload, '$.metadata.modelSelectionReceipt.appliedModel') AS model
         FROM orchestration_events e
         LEFT JOIN orchestration_conversation_sessions cs
           ON cs.session_id = e.thread_id
         WHERE e.method IN ('session.started', 'session.configured', 'turn.started')
           AND json_valid(e.payload)
           AND json_type(e.payload, '$.metadata.modelSelectionReceipt.appliedModel') = 'text'
           AND COALESCE(
             cs.conversation_id,
             (
               SELECT json_extract(identity_event.payload, '$.metadata.conversationId')
               FROM orchestration_events identity_event
               WHERE identity_event.thread_id = e.thread_id
                 AND identity_event.method IN ('session.started', 'session.configured')
                 AND json_valid(identity_event.payload)
                 AND json_type(identity_event.payload, '$.metadata.conversationId') = 'text'
               ORDER BY identity_event.sequence DESC
               LIMIT 1
             ),
             e.thread_id
           ) = ?
           AND COALESCE((
             SELECT json_extract(environment_event.payload, '$.metadata.environmentId')
             FROM orchestration_events environment_event
             WHERE environment_event.thread_id = e.thread_id
               AND environment_event.method IN ('session.started', 'session.configured')
               AND json_valid(environment_event.payload)
               AND json_type(environment_event.payload, '$.metadata.environmentId') = 'text'
             ORDER BY environment_event.sequence DESC
             LIMIT 1
           ), '') = ?
         ORDER BY e.created_at DESC, e.global_sequence DESC
         LIMIT 1`,
      )
      .get(input.conversationId, input.environmentId ?? '') as
      | { model: string }
      | undefined;
    return typeof row?.model === 'string' && row.model.trim()
      ? row.model.trim()
      : undefined;
  }

  /**
   * The `limit` most recent events for a thread, in ascending sequence order
   * (archive#1867). Bounds the synchronous `.all()` so a thread with a very
   * large event log cannot hold the event loop — the unbounded
   * `listEvents(threadId)` over such a thread is what produced 341/2354 main-
   * thread samples inside `sqlite3_step` and stalled the whole server. Reads
   * `DESC LIMIT ?` (the tail) and reverses to ASC so callers' sequential folds
   * see events in the same order `listEvents` returns them. Pair with
   * {@link countEventsByThread} for an accurate `eventCount` that does not
   * depend on how many rows were materialized.
   */
  listRecentEventsByThread(
    threadId: string,
    limit: number,
  ): PersistedRuntimeEvent[] {
    const rows = this.db
      .prepare(
        `SELECT id, provider, thread_id, turn_id, method, payload, created_at, observed_at, sequence, global_sequence
         FROM orchestration_events
         WHERE thread_id = ?
         ORDER BY sequence DESC
         LIMIT ?`,
      )
      .all(threadId, limit) as any[];
    return rows.reverse().map((row: any) => this.mapEventRow(row));
  }

  /**
   * The thread's owner, or `undefined` when no ownership-shaped event on it
   * carries one (archive#3495).
   *
   * `SessionAuthorization.sessionOwnerUserId()` is the `/events` SSE route's
   * per-event, per-connected-client authorization gate, and it deliberately
   * never caches a NEGATIVE result — so on a read-only-attached thread (which
   * never carries `metadata.userId`) every single event re-ran this read.
   * archive#1867 narrowed it from `listEvents(threadId)` to the
   * ownership-shaped methods, but the read stayed UNBOUNDED and still
   * materialized every matching payload. Measured against the live 694 MB
   * store's hot thread: 517,718 rows in 2,146 ms (rss 45 MB -> 893 MB), then
   * `JSON.parse` on all 517,718 payloads (+661 ms, rss -> 1,206 MB), to read
   * one field off each and return `undefined`. That is what took the backend
   * from 618 MB to 2.7 GB in ten seconds and made the readiness probe time
   * out (677 supervisor restarts in a day).
   *
   * The whole predicate is therefore pushed into SQL and the result is capped
   * at one row: the JS loop kept the FIRST ownership-shaped event carrying a
   * string `metadata.userId` in `created_at DESC, sequence DESC` order, and
   * `ORDER BY ... LIMIT 1` under the same predicate keeps exactly that row.
   * The ordering is byte-identical to the scan it replaces, so the "same
   * rows, same order, same first hit" argument needs no invariant proof.
   *
   * Three WHERE terms that look redundant and are not:
   * - `json_valid(payload)` — `json_extract` RAISES on a non-JSON payload, so
   *   without this an unparseable row anywhere on the thread turns an
   *   authorization check into a thrown error. It is also what makes the
   *   partial index buildable (see the migration).
   * - `... IS NOT NULL` — verbatim the partial index's own WHERE clause.
   *   SQLite only uses a partial index when a query term is identical to (or
   *   provably implies) that clause, and the `typeof(...)` form below is NOT
   *   recognised as implying it.
   * - `json_type(payload, '$.metadata.userId') = 'text'` — the JS predicate
   *   this replaces (`typeof event.metadata?.userId === 'string'`), asked of
   *   the JSON type rather than of SQLite's storage type. Without it a
   *   non-string `userId` would be returned where the loop skipped it and
   *   kept scanning.
   *
   *   Deliberately NOT `typeof(json_extract(...)) = 'text'`, which is what
   *   this shipped as first and is NOT the same predicate: `json_extract`
   *   returns the SERIALIZED JSON TEXT of an object or array, so `typeof`
   *   reads both as `'text'` and the read resolves the literal string
   *   `'{"a":1}'` as the owner. `cacheSessionOwner` then caches that, and
   *   `canReadSession` matches it against no real user — the genuine owner is
   *   locked out of their own session, cached, where the loop would have
   *   skipped that row and kept scanning to an older one that may carry the
   *   real owner. Measured shape by shape on this SQLite build (3.53.3):
   *
   *     value in payload | json_extract | typeof  | json_type | JS loop
   *     "alice"          | 'alice'      | text    | text      | keeps
   *     {"a":1}          | '{"a":1}'    | text    | object    | skips
   *     [1,2]            | '[1,2]'      | text    | array     | skips
   *     42               | 42           | integer | integer   | skips
   *     1.5              | 1.5          | real    | real      | skips
   *     true             | 1            | integer | true      | skips
   *     false            | 0            | integer | false     | skips
   *     null             | NULL         | null    | null      | skips
   *     (absent)         | NULL         | null    | NULL      | skips
   *
   *   So the claim is EQUIVALENCE OVER THE SHAPES ENUMERATED ABOVE — the
   *   nine a `Record<string, unknown>` metadata bag can put at that path —
   *   not a proof over every value SQLite's JSON parser can produce. It is a
   *   weaker claim than "verbatim the JS predicate", which is what this
   *   comment used to say and which the `typeof` form did not earn.
   *
   *   The term is a residual either way — it is not part of the index key and
   *   not the index's own WHERE clause — so it does not change the plan.
   *   Verified rather than assumed, with `EXPLAIN QUERY PLAN` on both forms
   *   over the migrated schema: both emit exactly
   *   `SEARCH orchestration_events USING INDEX idx_events_thread_owner_recency
   *   (thread_id=?)` and neither emits a temp b-tree.
   *
   * Deliberately NOT a bounded `LIMIT` over the old query: truncating could
   * turn "owned by X" into `undefined`, and `ownerlessSessionAccess:
   * 'single-user-compat'` makes an ownerless session READABLE — a silent
   * authorization widening. The predicate is what bounds this, not the limit.
   */
  /**
   * archive#4075 stage 2: append-time ownership immutability guard, called
   * first thing from both {@link appendEvent} and {@link appendEventIfAbsent}
   * — before either method does ANY work (blob writes, savepoint,
   * projections). Before this guard, both were bare INSERTs with no
   * ownership check at all (archive#4075 stage-2 probe): the only thing
   * preventing a rewritten owner was command-side gating
   * (`OrchestrationService.dispatchWithReceipt`'s
   * `canReadSessionForCommand`), which only ever protects the ordinary
   * command-dispatch path — a recovery/replay writer, or any future internal
   * caller of this store, could still append a second ownership-shaped event
   * naming a different owner with no check at all. The append layer is the
   * one place that can make "attribution is immutable once recorded" true
   * unconditionally, for every writer.
   *
   * Only `session.started`/`session.configured` are ownership-shaped (the
   * exact method set {@link findSessionOwnerUserId} already trusts as the
   * read side's authority). A session establishing its FIRST owner (no
   * owner yet resolved for the thread) is always accepted — this guard
   * rejects a REWRITE, not the original write. An event with no string
   * `metadata.userId` makes no ownership claim at all and is never compared
   * (an ownerless/read-only-attached session's events must keep appending).
   * A REPEAT of the SAME owner (a reconnect's `session.configured`, or a
   * duplicate replay through `appendEventIfAbsent`) is accepted — only a
   * genuine disagreement is rejected.
   */
  private assertOwnershipImmutable(event: CanonicalRuntimeEvent): void {
    if (
      event.method !== 'session.started' &&
      event.method !== 'session.configured'
    ) {
      return;
    }
    const incomingOwnerUserId = event.metadata?.userId;
    if (
      typeof incomingOwnerUserId !== 'string' ||
      incomingOwnerUserId.length === 0
    ) {
      return;
    }
    const existingOwnerUserId = this.findSessionOwnerUserId(event.threadId);
    if (
      existingOwnerUserId !== undefined &&
      existingOwnerUserId !== incomingOwnerUserId
    ) {
      throw new SessionOwnershipConflictError(
        event.threadId,
        existingOwnerUserId,
        incomingOwnerUserId,
      );
    }
  }

  findSessionOwnerUserId(threadId: string): string | undefined {
    const row = this.db
      .prepare(
        `SELECT json_extract(payload, '$.metadata.userId') AS user_id
         FROM orchestration_events
         WHERE thread_id = ?
           AND json_valid(payload)
           AND json_extract(payload, '$.metadata.userId') IS NOT NULL
           AND json_type(payload, '$.metadata.userId') = 'text'
           AND method IN ('session.started', 'session.configured')
         ORDER BY created_at DESC, sequence DESC
         LIMIT 1`,
      )
      .get(threadId) as { user_id?: unknown } | undefined;
    return typeof row?.user_id === 'string' ? row.user_id : undefined;
  }

  sessionAgentPresentation(
    threadId: string,
  ): { agentDisplayName?: string; agentIcon?: string } | undefined {
    const row = this.db
      .prepare(
        `SELECT
           json_extract(payload, '$.metadata.${SESSION_AGENT_DISPLAY_NAME_METADATA_KEY}') AS agent_name,
           json_extract(payload, '$.metadata.${SESSION_AGENT_ICON_METADATA_KEY}') AS agent_icon
         FROM orchestration_events
         WHERE thread_id = ?
           AND method = 'session.configured'
           AND json_valid(payload)
           AND (
             json_type(payload, '$.metadata.${SESSION_AGENT_DISPLAY_NAME_METADATA_KEY}') = 'text'
             OR json_type(payload, '$.metadata.${SESSION_AGENT_ICON_METADATA_KEY}') = 'text'
           )
         ORDER BY sequence ASC
         LIMIT 1`,
      )
      .get(threadId) as
      | { agent_name?: unknown; agent_icon?: unknown }
      | undefined;
    if (!row) return undefined;
    const agentDisplayName =
      typeof row.agent_name === 'string' &&
      row.agent_name.length > 0 &&
      row.agent_name.length <= SESSION_AGENT_DISPLAY_NAME_MAX_LENGTH
        ? row.agent_name
        : undefined;
    const agentIcon = isSupportedAgentIconToken(row.agent_icon)
      ? row.agent_icon
      : undefined;
    return agentDisplayName || agentIcon
      ? {
          ...(agentDisplayName ? { agentDisplayName } : {}),
          ...(agentIcon ? { agentIcon } : {}),
        }
      : undefined;
  }

  /**
   * The thread's newest `session.configured` events, newest-first, bounded
   * (archive#3495).
   *
   * `AttachedSessionFollowService`'s cold path needs one fact from the log —
   * the attribution its newest `session.configured` expresses — and used to
   * read every ownership-shaped row on the thread to find it. On a thread the
   * follow service itself had grown to 259,286 `session.started` rows that is
   * ~1.2 GB of parsed payloads per followed thread AT BOOT, with no client
   * connected.
   *
   * Bounded rather than `LIMIT 1` because "expresses an attribution" is a JS
   * predicate (`metadataAttributionFingerprint`) with an ambiguous branch that
   * SQL cannot express without disagreeing with the writer at the edges. The
   * caller applies the exact predicate to this window. It differs from the old
   * full scan only if the newest `limit` configured events ALL fail that
   * predicate while an older one passes; the caller's cost for that is one
   * envelope pair, once, because its event id no longer depends on a count
   * (see `envelopeEventId`).
   *
   * Ordering is identical to the scan it replaces (`created_at DESC,
   * sequence DESC`). `idx_events_turn_window` serves the SEARCH but does NOT
   * cover the ORDER BY: its key is `(thread_id, method, created_at DESC,
   * turn_id DESC)` with no `sequence`, so the last term always sorts —
   *
   *   SEARCH orchestration_events USING INDEX idx_events_turn_window
   *     (thread_id=? AND method=?)
   *   USE TEMP B-TREE FOR LAST TERM OF ORDER BY
   *
   * — and that is accepted, not overlooked. The sorter honours the `LIMIT`,
   * so it holds the window rather than the matching rows: measured over
   * 100,000 `session.configured` rows on one thread across 4 distinct
   * `created_at` values (the live store's shape — the burst writes that
   * caused this outage all share a timestamp, which is the worst case for
   * this index, since the whole burst lands in one equal-`created_at` group)
   * the read is ~21 ms with RSS flat to 0.1 MB, steady across repeats, and it
   * returns the correct newest 64 by `(created_at, sequence)`. That is a
   * once-per-followed-thread cold read, against the 3,808 ms / 1.2 GB it
   * replaces. A second partial index keyed `(thread_id, method, created_at,
   * sequence)` would remove the sort, and is deliberately not added: it grows
   * every database to save 21 ms once per thread per boot.
   */
  listRecentConfiguredEventsByThread(
    threadId: string,
    limit: number,
  ): PersistedRuntimeEvent[] {
    const rows = this.db
      .prepare(
        `SELECT id, provider, thread_id, turn_id, method, payload, created_at, observed_at, sequence, global_sequence
         FROM orchestration_events
         WHERE thread_id = ?
           AND method = 'session.configured'
         ORDER BY created_at DESC, sequence DESC
         LIMIT ?`,
      )
      .all(threadId, limit) as any[];
    return rows.map((row: any) => this.mapEventRow(row));
  }

  /**
   * Newest event timestamp for a thread without materializing payloads.
   * Attached-session cold start used to call `listEvents(threadId)` solely for
   * this value and `persistedEnvelopeFacts` — on large Claude-import threads
   * that synchronous `.all()` starved identity probes and wedged the service.
   */
  latestEventCreatedAtByThread(threadId: string): string | undefined {
    const row = this.db
      .prepare(
        `SELECT MAX(created_at) AS latest
         FROM orchestration_events
         WHERE thread_id = ?`,
      )
      .get(threadId) as { latest: string | null } | undefined;
    return row?.latest ?? undefined;
  }

  /**
   * Deliberately does NOT hydrate attachments — see {@link mapEventRow}. Its
   * `limit` bounds events, not bytes.
   */
  listEventPage(
    threadId: string,
    options: { afterSequence: number; limit: number },
  ): PersistedRuntimeEventPage {
    const rows = this.db
      .prepare(
        `SELECT id, provider, thread_id, turn_id, method, payload, created_at, sequence, global_sequence
         FROM orchestration_events
         WHERE thread_id = ? AND sequence > ?
         ORDER BY sequence ASC
         LIMIT ?`,
      )
      .all(threadId, options.afterSequence, options.limit + 1);
    const hasMore = rows.length > options.limit;
    const events = rows.slice(0, options.limit).map((row: any) => ({
      id: row.id,
      provider: row.provider,
      threadId: row.thread_id,
      turnId: row.turn_id ?? undefined,
      method: row.method,
      payload: JSON.parse(row.payload),
      createdAt: row.created_at,
      sequence: row.sequence,
      globalSequence: row.global_sequence,
    }));
    return {
      events,
      hasMore,
      nextSequence: events.at(-1)?.sequence ?? options.afterSequence,
    };
  }

  listEventWindowByTurn(
    threadId: string,
    options: { cursor?: string; turnLimit: number },
  ): PersistedRuntimeEventWindow {
    const cursor = decodeEventWindowCursor(options.cursor, threadId);
    let windowResult: PersistedRuntimeEventWindow;
    this.db.exec('BEGIN');
    try {
      const starts =
        cursor?.eventSequence === undefined
          ? ((cursor
              ? this.db
                  .prepare(
                    `SELECT turn_id, created_at, sequence FROM orchestration_events
               WHERE thread_id = ? AND method = 'turn.started' AND turn_id IS NOT NULL
                 AND (created_at < ? OR (created_at = ? AND turn_id < ?))
               ORDER BY created_at DESC, turn_id DESC LIMIT ?`,
                  )
                  .all(
                    threadId,
                    cursor.createdAt,
                    cursor.createdAt,
                    cursor.turnId,
                    options.turnLimit + 1,
                  )
              : this.db
                  .prepare(
                    `SELECT turn_id, created_at, sequence FROM orchestration_events
               WHERE thread_id = ? AND method = 'turn.started' AND turn_id IS NOT NULL
               ORDER BY created_at DESC, turn_id DESC LIMIT ?`,
                  )
                  .all(threadId, options.turnLimit + 1)) as Array<{
              turn_id: string;
              created_at: string;
              sequence: number;
            }>)
          : [];
      const selected = starts.slice(0, options.turnLimit);
      const oldest =
        cursor?.eventSequence !== undefined
          ? {
              turn_id: cursor.turnId,
              created_at: cursor.createdAt,
              sequence: cursor.eventSequence,
            }
          : selected.at(-1);
      const selectedTurnIds =
        cursor?.eventSequence !== undefined
          ? (
              this.db
                .prepare(
                  `SELECT turn_id FROM orchestration_events
                 WHERE thread_id = ? AND method = 'turn.started' AND turn_id IS NOT NULL
                   AND (created_at < ? OR (created_at = ? AND turn_id <= ?))
                   AND (created_at > ? OR (created_at = ? AND turn_id >= ?))
                 ORDER BY created_at DESC, turn_id DESC`,
                )
                .all(
                  threadId,
                  cursor.newestCreatedAt,
                  cursor.newestCreatedAt,
                  cursor.newestTurnId,
                  cursor.createdAt,
                  cursor.createdAt,
                  cursor.turnId,
                ) as Array<{ turn_id: string }>
            ).map((row) => row.turn_id)
          : selected.map((start) => start.turn_id);
      const rows =
        !oldest || selectedTurnIds.length === 0
          ? []
          : (this.db
              .prepare(
                `SELECT id, provider, thread_id, turn_id, method, payload, created_at, sequence, global_sequence
                 FROM orchestration_events
                 WHERE thread_id = ? AND turn_id IN (${selectedTurnIds.map(() => '?').join(', ')})
                   AND sequence ${cursor?.eventSequence !== undefined ? '>' : '>='} ?
                 ORDER BY sequence ASC LIMIT ?`,
              )
              .all(
                threadId,
                ...selectedTurnIds,
                cursor?.eventSequence !== undefined ? cursor.eventSequence : 0,
                SESSION_EVENT_WINDOW_MAX_EVENTS + 1,
              ) as any[]);
      const rawHasMore = rows.length > SESSION_EVENT_WINDOW_MAX_EVENTS;
      const boundedRows = rows.slice(0, SESSION_EVENT_WINDOW_MAX_EVENTS);
      const latestContext = new Map<string, string>();
      for (const row of boundedRows) {
        if (row.method === 'token-usage.updated' && row.turn_id)
          latestContext.set(row.turn_id, row.id);
      }
      const raw = boundedRows
        .filter(
          (row) =>
            row.method !== 'token-usage.updated' ||
            !row.turn_id ||
            latestContext.get(row.turn_id) === row.id,
        )
        // Deliberately NOT `mapEventRow`: this window is byte-budgeted, and
        // rehydrating an attachment here would push its `turn.started` past
        // `snapshotEvent`'s 4 KB ceiling — which strips the payload down to
        // its identity fields, taking the prompt and the attachment with it.
        // Handing on the reference is what lets the transcript keep rendering
        // the chip (archive#3374).
        .map((row) => snapshotEvent(mapPersistedEventRow(row)));
      const completed = new Set(
        raw
          .filter((item) => item.method === 'tool.completed')
          .map(
            (item) =>
              `${item.turnId ?? ''}:${(item.payload as any).toolCallId ?? ''}`,
          ),
      );
      const retained = raw.filter(
        (item) =>
          item.method !== 'tool.progress' ||
          !completed.has(
            `${item.turnId ?? ''}:${(item.payload as any).toolCallId ?? ''}`,
          ),
      );
      const events: PersistedRuntimeEvent[] = [];
      let serializedBytes = 0;
      let byteLimited = false;
      for (const event of retained) {
        const eventBytes = Buffer.byteLength(
          JSON.stringify({ sequence: event.sequence, event: event.payload }),
        );
        if (
          events.length > 0 &&
          serializedBytes + eventBytes >
            SESSION_EVENT_WINDOW_MAX_SERIALIZED_BYTES
        ) {
          byteLimited = true;
          break;
        }
        events.push(event);
        serializedBytes += eventBytes;
      }
      const continuationSequence = byteLimited
        ? events.at(-1)!.sequence
        : boundedRows.at(-1)?.sequence;
      const watermark = (
        this.db
          .prepare(
            'SELECT COALESCE(MAX(global_sequence), 0) AS watermark FROM orchestration_events WHERE thread_id = ?',
          )
          .get(threadId) as { watermark: number }
      ).watermark;
      const hasOlderTurns =
        cursor?.eventSequence !== undefined
          ? Boolean(
              this.db
                .prepare(
                  `SELECT 1 FROM orchestration_events
                 WHERE thread_id = ? AND method = 'turn.started' AND turn_id IS NOT NULL
                   AND (created_at < ? OR (created_at = ? AND turn_id < ?))
                 LIMIT 1`,
                )
                .get(
                  threadId,
                  cursor.createdAt,
                  cursor.createdAt,
                  cursor.turnId,
                ),
            )
          : starts.length > options.turnLimit;
      this.db.exec('COMMIT');
      windowResult = {
        events,
        hasMore: rawHasMore || byteLimited || hasOlderTurns,
        ...((rawHasMore || byteLimited) && oldest
          ? {
              nextCursor: encodeEventWindowCursor(threadId, {
                createdAt: oldest.created_at,
                turnId: oldest.turn_id,
                eventSequence: continuationSequence!,
                newestCreatedAt:
                  cursor?.eventSequence !== undefined
                    ? cursor.newestCreatedAt
                    : selected[0]?.created_at,
                newestTurnId:
                  cursor?.eventSequence !== undefined
                    ? cursor.newestTurnId
                    : selected[0]?.turn_id,
              }),
            }
          : hasOlderTurns && oldest
            ? {
                nextCursor: encodeEventWindowCursor(threadId, {
                  createdAt: oldest.created_at,
                  turnId: oldest.turn_id,
                }),
              }
            : {}),
        watermark,
      };
    } catch (error) {
      // archive#3433 class sweep: `windowResult` assembly above — including
      // its `encodeEventWindowCursor` calls — runs after `COMMIT`, still
      // inside this try. If any of it throws, there is no active
      // transaction left to roll back; matching the mitigation this file's
      // boundary-transition catch already uses elsewhere (its
      // `apply`/`exact` sequence), the ROLLBACK is wrapped so a "cannot
      // rollback - no transaction is active" error can never replace the
      // real one.
      try {
        this.db.exec('ROLLBACK');
      } catch {
        // The transaction may already have committed.
      }
      throw error;
    }
    // archive#3386. Deliberately OUTSIDE the transaction's error boundary: a
    // counter that throws inside it would be caught as a store failure and
    // answered with a ROLLBACK against a transaction that has already
    // committed, which is a worse bug than a missing measurement.
    for (const event of windowResult.events) {
      if (event.elided) {
        orchestrationEventWindowElisions.add(1, { reason: event.elided });
      }
    }
    return windowResult;
  }

  /**
   * Bounded conversation transcript selection. Event ids and payload
   * `threadId`s are never rewritten: the global sequence is only the stable
   * cross-session ordering/cursor seam. `turnLimit` applies to the complete
   * lineage, not independently to every child session.
   */
  listConversationEventWindowByTurn(
    threadIds: readonly string[],
    options: { cursor?: string; turnLimit: number },
  ): PersistedRuntimeEventWindow {
    const ids = [...threadIds];
    if (ids.length === 0 || new Set(ids).size !== ids.length) {
      throw new Error('Conversation event window lineage is invalid');
    }
    const cursor = decodeConversationEventWindowCursor(options.cursor, ids);
    // A continuation may append a child between transcript pages. Its events
    // are newer than this cursor's watermark, so page the immutable lineage
    // prefix and let the next head reload discover the new child.
    const sourceIds = cursor?.threadIds ?? ids;
    const placeholders = sourceIds.map(() => '?').join(', ');
    this.db.exec('BEGIN');
    try {
      const watermark = (
        this.db
          .prepare(
            `SELECT COALESCE(MAX(global_sequence), 0) AS watermark
             FROM orchestration_events WHERE thread_id IN (${placeholders})`,
          )
          .get(...sourceIds) as { watermark: number }
      ).watermark;
      const stableWatermark = cursor?.watermark ?? watermark;
      const rangeCursor =
        cursor?.rangeStartGlobalSequence !== undefined ? cursor : undefined;
      const upperBound = rangeCursor
        ? rangeCursor.rangeEndExclusive!
        : (cursor?.beforeGlobalSequence ?? stableWatermark + 1);
      const starts = rangeCursor
        ? []
        : (this.db
            .prepare(
              `SELECT global_sequence FROM orchestration_events
           WHERE thread_id IN (${placeholders})
             AND method = 'turn.started' AND turn_id IS NOT NULL
             AND global_sequence < ? AND global_sequence <= ?
           ORDER BY global_sequence DESC LIMIT ?`,
            )
            .all(
              ...sourceIds,
              upperBound,
              stableWatermark,
              options.turnLimit + 1,
            ) as Array<{ global_sequence: number }>);
      const selected = starts.slice(0, options.turnLimit);
      const oldest =
        rangeCursor?.rangeStartGlobalSequence ??
        selected.at(-1)?.global_sequence;
      const rows =
        oldest === undefined
          ? []
          : (this.db
              .prepare(
                `SELECT id, provider, thread_id, turn_id, method, payload, created_at, sequence, global_sequence
                 FROM orchestration_events
                 WHERE thread_id IN (${placeholders})
                   AND global_sequence >= ? AND global_sequence < ?
                   AND global_sequence > ?
                 ORDER BY global_sequence ASC LIMIT ?`,
              )
              .all(
                ...sourceIds,
                oldest,
                upperBound,
                rangeCursor?.afterGlobalSequence ?? 0,
                SESSION_EVENT_WINDOW_MAX_EVENTS + 1,
              ) as any[]);
      const boundedRows = rows.slice(0, SESSION_EVENT_WINDOW_MAX_EVENTS);
      const events: PersistedRuntimeEvent[] = [];
      let serializedBytes = 0;
      let byteLimited = false;
      for (const row of boundedRows) {
        // Reuse the same attachment-safe snapshot projection as the
        // session-window reader. A conversation aggregate must not turn an
        // attachment reference back into an oversized inline payload.
        const event = snapshotEvent(mapPersistedEventRow(row));
        const eventBytes = Buffer.byteLength(
          JSON.stringify({
            sequence: event.globalSequence,
            event: event.payload,
          }),
        );
        if (
          events.length > 0 &&
          serializedBytes + eventBytes >
            SESSION_EVENT_WINDOW_MAX_SERIALIZED_BYTES
        ) {
          byteLimited = true;
          break;
        }
        events.push(event);
        serializedBytes += eventBytes;
      }
      const rawHasMore =
        rows.length > SESSION_EVENT_WINDOW_MAX_EVENTS || byteLimited;
      const hasOlderTurns = rangeCursor
        ? cursor!.olderTurnsRemain === true
        : starts.length > options.turnLimit;
      this.db.exec('COMMIT');
      return {
        events,
        hasMore: rawHasMore || hasOlderTurns,
        ...((rawHasMore || hasOlderTurns) && oldest !== undefined
          ? {
              nextCursor: encodeConversationEventWindowCursor({
                threadIds: sourceIds,
                beforeGlobalSequence: oldest,
                watermark: stableWatermark,
                ...(rawHasMore || hasOlderTurns
                  ? { olderTurnsRemain: hasOlderTurns }
                  : {}),
                ...(rawHasMore && events.at(-1)
                  ? {
                      rangeStartGlobalSequence: oldest,
                      rangeEndExclusive: upperBound,
                      afterGlobalSequence: events.at(-1)!.globalSequence,
                    }
                  : {}),
              }),
            }
          : {}),
        watermark: stableWatermark,
      };
    } catch (error) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        // Preserve the original durable-read failure.
      }
      throw error;
    }
  }

  /**
   * Current global-sequence head across every thread — the value a fresh
   * `orchestration:snapshot` frame advertises as its resume cursor (archive#1092).
   */
  headGlobalSequence(): number {
    const row = this.db
      .prepare(
        `SELECT COALESCE(MAX(global_sequence), 0) AS head FROM orchestration_events`,
      )
      .get() as { head: number };
    return row.head;
  }

  /**
   * Looks up the global-sequence cursor already assigned to a persisted
   * event by its canonical `eventId`. Used by the live SSE forwarding path:
   * by the time `EventBus.emit` reaches a subscriber, the event that
   * triggered it has already been synchronously persisted (single-threaded,
   * same call stack), so this lookup always resolves for a real event.
   */
  readGlobalSequence(eventId: string): number | undefined {
    const row = this.db
      .prepare(`SELECT global_sequence FROM orchestration_events WHERE id = ?`)
      .get(eventId) as { global_sequence: number } | undefined;
    return row?.global_sequence;
  }

  /**
   * Ordered replay of events after a global-sequence cursor, optionally
   * scoped to one thread (archive#1092 resume). Ordering is always by
   * `global_sequence`, even when `threadId` narrows the result set, so the
   * returned `id:` values stay comparable to what a reconnecting client
   * remembers regardless of which stream variant it is resuming.
   */
  listEventsAfterGlobalSequence(
    afterGlobalSequence: number,
    options: { threadId?: string; limit: number },
  ): PersistedRuntimeEvent[] {
    const rows = options.threadId
      ? this.db
          .prepare(
            `SELECT id, provider, thread_id, turn_id, method, payload, created_at, sequence, global_sequence
             FROM orchestration_events
             WHERE thread_id = ? AND global_sequence > ?
             ORDER BY global_sequence ASC
             LIMIT ?`,
          )
          .all(options.threadId, afterGlobalSequence, options.limit)
      : this.db
          .prepare(
            `SELECT id, provider, thread_id, turn_id, method, payload, created_at, sequence, global_sequence
             FROM orchestration_events
             WHERE global_sequence > ?
             ORDER BY global_sequence ASC
             LIMIT ?`,
          )
          .all(afterGlobalSequence, options.limit);

    return rows.map((row: any) => ({
      id: row.id,
      provider: row.provider,
      threadId: row.thread_id,
      turnId: row.turn_id ?? undefined,
      method: row.method,
      payload: JSON.parse(row.payload),
      createdAt: row.created_at,
      sequence: row.sequence,
      globalSequence: row.global_sequence,
    }));
  }

  listEventReplayDescriptors(
    afterGlobalSequence: number,
    options: { threadId?: string; limit: number },
  ): PersistedRuntimeEventReplayDescriptor[] {
    const rows = options.threadId
      ? this.db
          .prepare(
            `SELECT e.thread_id, e.global_sequence,
             LENGTH(CAST(e.payload AS BLOB)) AS payload_bytes,
             LENGTH(CAST(p.envelope AS BLOB)) AS provenance_bytes
           FROM orchestration_events e
           LEFT JOIN orchestration_turn_provenance p
             ON e.method = 'turn.completed'
            AND p.thread_id = e.thread_id
            AND p.turn_id = e.turn_id
           WHERE e.thread_id = ? AND e.global_sequence > ?
           ORDER BY e.global_sequence ASC LIMIT ?`,
          )
          .all(options.threadId, afterGlobalSequence, options.limit)
      : this.db
          .prepare(
            `SELECT e.thread_id, e.global_sequence,
             LENGTH(CAST(e.payload AS BLOB)) AS payload_bytes,
             LENGTH(CAST(p.envelope AS BLOB)) AS provenance_bytes
           FROM orchestration_events e
           LEFT JOIN orchestration_turn_provenance p
             ON e.method = 'turn.completed'
            AND p.thread_id = e.thread_id
            AND p.turn_id = e.turn_id
           WHERE e.global_sequence > ?
           ORDER BY e.global_sequence ASC LIMIT ?`,
          )
          .all(afterGlobalSequence, options.limit);
    return (rows as any[]).map((row) => ({
      threadId: row.thread_id,
      globalSequence: row.global_sequence,
      // This is exactly JSON.stringify({ event, ...(provenance && { provenance }) })
      // without parsing either JSON blob. Both stored JSON strings are already
      // serialized UTF-8 values, and every wrapper byte is ASCII.
      serializedFrameBytes:
        Buffer.byteLength('{"event":') +
        row.payload_bytes +
        (row.provenance_bytes === null || row.provenance_bytes === undefined
          ? 0
          : Buffer.byteLength(',"provenance":') + row.provenance_bytes) +
        Buffer.byteLength('}'),
    }));
  }

  upsertSession(session: ProviderSession): void {
    // A provider may report the same already-persisted root Session again
    // with a fresh adapter timestamp. That is mutable provider state, not a
    // second attempt to claim immutable lineage. Keep the conflict check for
    // a lineage row that has no matching provider session (the hostile/manual
    // claim case pinned by the lineage contract tests).
    const priorPersistedSession = this.db
      .prepare(
        `SELECT 1 FROM provider_session_state WHERE thread_id = ? LIMIT 1`,
      )
      .get(session.threadId);
    const existingLineage = this.conversationSessionLineage.sessionForExecution(
      session.threadId,
    );
    this.db.exec('SAVEPOINT upsert_session_history');
    try {
      this.db
        .prepare(
          `INSERT INTO provider_session_state
          (thread_id, provider, status, model, cwd, resume_cursor, control_mode, attached_source, continuation_source_thread_id, adoption_idempotency_key, persist_session, ephemeral, tenant_execution_context, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(thread_id) DO UPDATE SET
           provider = excluded.provider,
           status = excluded.status,
           model = excluded.model,
           cwd = excluded.cwd,
           resume_cursor = excluded.resume_cursor,
           control_mode = excluded.control_mode,
           attached_source = excluded.attached_source,
           continuation_source_thread_id = excluded.continuation_source_thread_id,
           adoption_idempotency_key = excluded.adoption_idempotency_key,
           persist_session = excluded.persist_session,
           ephemeral = excluded.ephemeral,
           tenant_execution_context = excluded.tenant_execution_context,
           updated_at = excluded.updated_at`,
        )
        .run(
          session.threadId,
          session.provider,
          session.status,
          session.model ?? null,
          session.cwd ?? null,
          session.resumeCursor === undefined
            ? null
            : JSON.stringify(session.resumeCursor),
          session.controlMode ?? 'station-owned',
          session.attachedSource === undefined
            ? null
            : JSON.stringify(session.attachedSource),
          session.continuationSourceThreadId ?? null,
          session.adoptionIdempotencyKey ?? null,
          session.persistSession === true ? 1 : 0,
          session.ephemeral === true ? 1 : 0,
          session.tenantExecutionContext === undefined
            ? null
            : JSON.stringify(session.tenantExecutionContext),
          // A reserved child exists durably before the provider starts. Its
          // lineage creation time is therefore the Session's immutable
          // creation fact; an adapter's later process-start timestamp is an
          // observation, not authority to split those two records on restart.
          existingLineage?.createdAt ?? session.createdAt,
          session.updatedAt,
        );
      const conversationId = existingLineage?.predecessorSessionId
        ? existingLineage.conversationId
        : session.threadId;
      // A reserved child already has immutable non-root lineage. A root
      // session, in contrast, must still pass through establishInitial on
      // every upsert so a forged/conflicting legacy claim fails closed.
      if (
        !existingLineage ||
        (!existingLineage.predecessorSessionId && !priorPersistedSession)
      ) {
        this.conversationSessionLineage.establishInitialSession({
          conversationId,
          sessionId: session.threadId,
          createdAt: session.createdAt,
        });
      }
      this.db
        .prepare(
          `UPDATE orchestration_conversation_history
         SET tenant_id = ?, created_at = ?, updated_at = ?
         WHERE thread_id = ?`,
        )
        .run(
          session.tenantExecutionContext?.tenantId ?? null,
          session.createdAt,
          session.updatedAt,
          conversationId,
        );
      this.db.exec('RELEASE SAVEPOINT upsert_session_history');
    } catch (error) {
      this.db.exec(
        'ROLLBACK TO SAVEPOINT upsert_session_history; RELEASE SAVEPOINT upsert_session_history',
      );
      throw error;
    }
  }

  markSessionClosed(threadId: string, provider?: string): void {
    const now = new Date().toISOString();
    const existing = this.db
      .prepare(
        `SELECT thread_id, provider, created_at FROM provider_session_state WHERE thread_id = ?`,
      )
      .get(threadId) as
      | { thread_id: string; provider: string; created_at: string }
      | undefined;

    if (!existing && !provider) return;

    this.db.exec('SAVEPOINT mark_session_closed_lineage');
    try {
      const lineage =
        this.conversationSessionLineage.sessionForExecution(threadId);
      this.db
        .prepare(
          `INSERT INTO provider_session_state
          (thread_id, provider, status, model, resume_cursor, created_at, updated_at)
         VALUES (?, ?, 'closed', NULL, NULL, ?, ?)
         ON CONFLICT(thread_id) DO UPDATE SET
           status = 'closed',
           tenant_execution_context = NULL,
           updated_at = excluded.updated_at`,
        )
        .run(
          threadId,
          provider ?? existing!.provider,
          existing?.created_at ?? now,
          now,
        );
      if (!lineage) {
        this.conversationSessionLineage.establishInitialSession({
          conversationId: threadId,
          sessionId: threadId,
          createdAt: existing?.created_at ?? now,
        });
      }
      this.db.exec('RELEASE SAVEPOINT mark_session_closed_lineage');
    } catch (error) {
      this.db.exec(
        'ROLLBACK TO SAVEPOINT mark_session_closed_lineage; RELEASE SAVEPOINT mark_session_closed_lineage',
      );
      throw error;
    }
  }

  readSessions(): ProviderSession[] {
    const rows = this.db
      .prepare(
        `SELECT thread_id, provider, status, model, cwd, resume_cursor, control_mode, attached_source, continuation_source_thread_id, adoption_idempotency_key, persist_session, ephemeral, tenant_execution_context, created_at, updated_at
         FROM provider_session_state
         ORDER BY created_at ASC`,
      )
      .all();

    return rows.map(mapPersistedSessionRow);
  }

  /**
   * The analytics read is intentionally SQL-narrowed before it can enumerate
   * a session id. A hosted caller that names another tenant gets the exact
   * same empty result as one with no matching receipts.
   */
  readUsageSessionThreadIds(input: {
    ownerUserId: string;
    tenantId?: string;
  }): string[] {
    const rows = this.db
      .prepare(
        `SELECT state.thread_id
         FROM provider_session_state state
         INNER JOIN orchestration_conversation_history history
           ON history.thread_id = state.thread_id
         WHERE history.owner_user_id = ?
           AND ((? IS NULL AND history.tenant_id IS NULL) OR history.tenant_id = ?)
           AND state.ephemeral = 0
         ORDER BY state.created_at ASC`,
      )
      .all(
        input.ownerUserId,
        input.tenantId ?? null,
        input.tenantId ?? null,
      ) as Array<{
      thread_id: string;
    }>;
    return rows.map((row) => row.thread_id);
  }

  readSessionByThread(threadId: string): ProviderSession | undefined {
    const row = this.db
      .prepare(
        `SELECT thread_id, provider, status, model, cwd, resume_cursor, control_mode,
                attached_source, continuation_source_thread_id, adoption_idempotency_key, persist_session, ephemeral,
                tenant_execution_context, created_at, updated_at
         FROM provider_session_state WHERE thread_id = ?`,
      )
      .get(threadId);
    return row ? mapPersistedSessionRow(row as any) : undefined;
  }

  /**
   * Intent-shaped continuation seam. The caller can observe durable lineage
   * and reserve one successor, but cannot mutate arbitrary SQLite rows.
   */
  conversationSessions(
    conversationId: string,
  ): readonly Readonly<ConversationSessionLineage>[] {
    return this.conversationSessionLineage.sessionsForConversation(
      conversationId,
    );
  }

  /** Immutable conversation owner for one exact execution Session. */
  conversationForSession(
    sessionId: string,
  ): Readonly<ConversationSessionLineage> | undefined {
    return this.conversationSessionLineage.sessionForExecution(sessionId);
  }

  reserveNextConversationSession(input: {
    conversationId: string;
    predecessorSessionId: string;
    proposedSessionId: string;
    createdAt: string;
  }): {
    lineage: Readonly<ConversationSessionLineage>;
    outcome: 'created' | 'existing';
  } {
    return this.conversationSessionLineage.reserveNextSession(input);
  }

  /**
   * Persist the Station-owned marker for an explicit Agent/engine handoff.
   * This is intentionally unavailable to ordinary continuation callers.
   */
  reserveConversationHandoff(
    input: ConversationHandoffMarker,
  ): ReturnType<ConversationHandoffModule['reserve']> {
    return this.conversationHandoffs.reserve(input);
  }

  describeConversationHandoff(
    marker: ConversationHandoffMarker,
    outcome: 'created' | 'existing',
  ): ReturnType<ConversationHandoffModule['reserve']> {
    return this.conversationHandoffs.describe(marker, outcome);
  }

  conversationHandoffForSession(
    sessionId: string,
  ): Readonly<ConversationHandoffMarker> | undefined {
    return this.conversationHandoffs.markerForSession(sessionId);
  }

  conversationHandoffForPredecessor(
    sessionId: string,
  ): Readonly<ConversationHandoffMarker> | undefined {
    return this.conversationHandoffs.markerForPredecessor(sessionId);
  }

  conversationHandoffByKey(
    conversationId: string,
    idempotencyKey: string,
  ): Readonly<ConversationHandoffMarker> | undefined {
    return this.conversationHandoffs.markerForKey(
      conversationId,
      idempotencyKey,
    );
  }

  listConversationHandoffs(
    conversationId: string,
  ): readonly Readonly<ConversationHandoffMarker>[] {
    return this.conversationHandoffs.markersForConversation(conversationId);
  }

  reserveConversationContextBoundary(input: ConversationContextBoundaryMarker) {
    return this.conversationContextBoundaries.reserve(input);
  }

  conversationContextBoundaryForSuccessor(sessionId: string) {
    return this.conversationContextBoundaries.forSuccessor(sessionId);
  }

  conversationContextBoundaryByKey(
    conversationId: string,
    idempotencyKey: string,
  ) {
    return this.conversationContextBoundaries.byKey(
      conversationId,
      idempotencyKey,
    );
  }

  claimConversationContextBoundaryColdStart(
    boundaryId: string,
    startCommandId: string,
    at: string,
  ) {
    return this.conversationContextBoundaries.claimColdStart(
      boundaryId,
      startCommandId,
      at,
    );
  }

  listConversationContextBoundaries(conversationId: string) {
    return this.conversationContextBoundaries.listForConversation(
      conversationId,
    );
  }

  consumeConversationContextBoundary(
    boundaryId: string,
    startCommandId: string,
    at: string,
  ) {
    return this.conversationContextBoundaries.consumeAcceptedStart(
      boundaryId,
      startCommandId,
      at,
    );
  }

  releaseConversationContextBoundaryFailedClaim(
    boundaryId: string,
    at: string,
  ) {
    return this.conversationContextBoundaries.releaseProvablyFailedClaim(
      boundaryId,
      at,
    );
  }

  markConversationContextBoundaryIndeterminate(boundaryId: string, at: string) {
    return this.conversationContextBoundaries.markIndeterminate(boundaryId, at);
  }

  cancelConversationContextBoundary(boundaryId: string, at: string) {
    return this.conversationContextBoundaries.cancelReserved(boundaryId, at);
  }

  /**
   * Indexed Session scope for exact-answer authorization. This deliberately
   * reads the durable conversation projection, not a turn window: project
   * attribution can be established by a Session-level event with no turn id.
   */
  readConversationProjectSlug(threadId: string): string | undefined {
    const row = this.db
      .prepare(
        `SELECT project_slug FROM orchestration_conversation_history
         WHERE thread_id = ? LIMIT 1`,
      )
      .get(threadId) as { project_slug?: string | null } | undefined;
    return typeof row?.project_slug === 'string' && row.project_slug.length > 0
      ? row.project_slug
      : undefined;
  }

  /** Deliberate composition seam; callers receive conversation intent, never SQLite. */
  private composeConversationSessionLineage(): ConversationSessionLineageModule {
    const read = (row: any): ConversationSessionLineage => ({
      conversationId: row.conversation_id,
      sessionId: row.session_id,
      ordinal: row.ordinal,
      ...(row.predecessor_session_id
        ? { predecessorSessionId: row.predecessor_session_id }
        : {}),
      createdAt: row.created_at,
    });
    const readAllLineage = (): ConversationSessionLineage[] =>
      (
        this.db
          .prepare(
            `SELECT conversation_id, session_id, ordinal,
                    predecessor_session_id, created_at
             FROM orchestration_conversation_sessions
             ORDER BY conversation_id ASC, ordinal ASC, session_id ASC`,
          )
          .all() as any[]
      ).map(read);
    const validateLineageStructure = (
      lineages: readonly ConversationSessionLineage[],
    ): void => {
      const bySession = new Map(
        lineages.map((lineage) => [lineage.sessionId, lineage]),
      );
      const childrenByPredecessor = new Map<
        string,
        ConversationSessionLineage[]
      >();
      for (const lineage of lineages) {
        if (lineage.ordinal === 0) {
          if (
            lineage.sessionId !== lineage.conversationId ||
            lineage.predecessorSessionId !== undefined
          )
            throw new ConversationSessionLineageStructureError(
              'invalid-root',
              lineage,
            );
          continue;
        }
        if (!lineage.predecessorSessionId)
          throw new ConversationSessionLineageStructureError(
            'missing-predecessor',
            lineage,
          );
        const siblings =
          childrenByPredecessor.get(lineage.predecessorSessionId) ?? [];
        siblings.push(lineage);
        childrenByPredecessor.set(lineage.predecessorSessionId, siblings);
      }
      for (const children of childrenByPredecessor.values())
        if (children.length > 1)
          throw new ConversationSessionLineageStructureError(
            'branch',
            children[1]!,
            children[0],
          );
      for (const lineage of lineages) {
        if (lineage.ordinal === 0) continue;
        const predecessor = bySession.get(lineage.predecessorSessionId!);
        if (!predecessor)
          throw new ConversationSessionLineageStructureError(
            'missing-predecessor',
            lineage,
          );
        const visited = new Set([lineage.sessionId]);
        let cursor: ConversationSessionLineage | undefined = predecessor;
        while (cursor) {
          if (visited.has(cursor.sessionId))
            throw new ConversationSessionLineageStructureError(
              'cycle',
              lineage,
              cursor,
            );
          visited.add(cursor.sessionId);
          cursor = cursor.predecessorSessionId
            ? bySession.get(cursor.predecessorSessionId)
            : undefined;
        }
        if (predecessor.conversationId !== lineage.conversationId)
          throw new ConversationSessionLineageStructureError(
            'conversation-mismatch',
            lineage,
            predecessor,
          );
        if (lineage.ordinal !== predecessor.ordinal + 1)
          throw new ConversationSessionLineageStructureError(
            'ordinal-mismatch',
            lineage,
            predecessor,
          );
      }
    };
    const selectBySession = this.db.prepare(
      `SELECT conversation_id, session_id, ordinal, predecessor_session_id, created_at
       FROM orchestration_conversation_sessions WHERE session_id = ?`,
    );
    const selectSuccessor = this.db.prepare(
      `SELECT conversation_id, session_id, ordinal, predecessor_session_id, created_at
       FROM orchestration_conversation_sessions
       WHERE conversation_id = ? AND predecessor_session_id = ?`,
    );
    const selectByOrdinal = this.db.prepare(
      `SELECT conversation_id, session_id, ordinal, predecessor_session_id, created_at
       FROM orchestration_conversation_sessions
       WHERE conversation_id = ? AND ordinal = ?`,
    );
    const insertInitial = this.db.prepare(
      `INSERT OR IGNORE INTO orchestration_conversation_sessions
        (conversation_id, session_id, ordinal, predecessor_session_id, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    );
    const recordInitial = (lineage: ConversationSessionLineage) => {
      const result = insertInitial.run(
        lineage.conversationId,
        lineage.sessionId,
        lineage.ordinal,
        lineage.predecessorSessionId ?? null,
        lineage.createdAt,
      ) as { changes?: number };
      if (result.changes === 1) {
        return { lineage, outcome: 'created' as const };
      }

      const sessionRow = selectBySession.get(lineage.sessionId);
      if (sessionRow) {
        const existing = read(sessionRow);
        if (isSameConversationSessionLineage(existing, lineage)) {
          return { lineage: existing, outcome: 'existing' as const };
        }
        throw new ConversationSessionLineageConflictError(
          existing.conversationId === lineage.conversationId
            ? 'immutable-facts-mismatch'
            : 'session-already-linked',
          lineage,
          existing,
        );
      }

      const ordinalRow = selectByOrdinal.get(
        lineage.conversationId,
        lineage.ordinal,
      );
      if (ordinalRow) {
        throw new ConversationSessionLineageConflictError(
          'ordinal-already-linked',
          lineage,
          read(ordinalRow),
        );
      }
      throw new Error('Conversation session lineage conflict was not readable');
    };
    return createConversationSessionLineageModule({
      persistence: {
        recordInitial,
        backfillLegacy: () => {
          this.db.exec('SAVEPOINT backfill_conversation_lineage');
          try {
            // Structural truth comes first. A pre-fix child timestamp skew is
            // reconcilable only after its exact parent chain is proven; no
            // timestamp normalization may make a forged graph look valid.
            validateLineageStructure(readAllLineage());
            const mismatches = this.db
              .prepare(
                `SELECT p.thread_id, p.created_at AS provider_created_at,
                        l.conversation_id, l.session_id, l.ordinal,
                        l.predecessor_session_id, l.created_at
                 FROM provider_session_state p
                 INNER JOIN orchestration_conversation_sessions l
                   ON l.session_id = p.thread_id
                 WHERE l.created_at <> p.created_at
                 ORDER BY l.conversation_id ASC, l.ordinal ASC, l.session_id ASC`,
              )
              .all() as Array<{
              thread_id: string;
              provider_created_at: string;
              conversation_id: string;
              session_id: string;
              ordinal: number;
              predecessor_session_id: string | null;
              created_at: string;
            }>;
            let reconciled = 0;
            const normalizeProviderCreatedAt = this.db.prepare(
              `UPDATE provider_session_state SET created_at = ?
               WHERE thread_id = ? AND created_at = ?`,
            );
            for (const mismatch of mismatches) {
              const lineage = read(mismatch);
              if (lineage.ordinal === 0) {
                throw new ConversationSessionLineageConflictError(
                  'immutable-facts-mismatch',
                  {
                    ...lineage,
                    createdAt: mismatch.provider_created_at,
                  },
                  lineage,
                );
              }
              const result = normalizeProviderCreatedAt.run(
                lineage.createdAt,
                lineage.sessionId,
                mismatch.provider_created_at,
              ) as { changes?: number };
              reconciled += result.changes ?? 0;
            }

            // Backfill only provider sessions with no immutable lineage. A
            // linked child intentionally differs from the legacy root shape;
            // those rows were validated and reconciled above, never re-rooted.
            const sessions = this.db
              .prepare(
                `SELECT p.thread_id, p.created_at
                 FROM provider_session_state p
                 LEFT JOIN orchestration_conversation_sessions l
                   ON l.session_id = p.thread_id
                 WHERE l.session_id IS NULL
                 ORDER BY p.created_at ASC, p.thread_id ASC`,
              )
              .all() as Array<{ thread_id: string; created_at: string }>;
            const bindingEvents = this.db.prepare(
              `SELECT payload FROM orchestration_events
               WHERE thread_id = ?
                 AND method IN ('session.started', 'session.configured')
                 AND json_valid(payload)
                 AND typeof(json_extract(payload, '$.metadata.conversationId')) = 'text'
               ORDER BY sequence DESC
               LIMIT 1`,
            );
            let created = 0;
            for (const session of sessions) {
              const bindingEvent = bindingEvents.get(session.thread_id) as
                | { payload: string }
                | undefined;
              const candidateConversationId = bindingEvent
                ? parseHistoryEvent(bindingEvent.payload)?.metadata
                    ?.conversationId
                : undefined;
              const boundConversationId =
                typeof candidateConversationId === 'string'
                  ? candidateConversationId
                  : undefined;
              if (
                boundConversationId &&
                boundConversationId !== session.thread_id
              )
                throw new ConversationSessionLineageStructureError(
                  'provider-session-unmapped',
                  {
                    conversationId: boundConversationId,
                    sessionId: session.thread_id,
                    ordinal: 0,
                    createdAt: session.created_at,
                  },
                );
              if (
                recordInitial({
                  conversationId: session.thread_id,
                  sessionId: session.thread_id,
                  ordinal: 0,
                  createdAt: session.created_at,
                }).outcome === 'created'
              )
                created += 1;
            }
            validateLineageStructure(readAllLineage());
            this.db.exec('RELEASE SAVEPOINT backfill_conversation_lineage');
            return { backfilled: created, reconciled };
          } catch (error) {
            this.db.exec(
              'ROLLBACK TO SAVEPOINT backfill_conversation_lineage; RELEASE SAVEPOINT backfill_conversation_lineage',
            );
            throw error;
          }
        },
        list: (conversationId) =>
          (
            this.db
              .prepare(
                `SELECT conversation_id, session_id, ordinal, predecessor_session_id, created_at
                 FROM orchestration_conversation_sessions
                 WHERE conversation_id = ? ORDER BY ordinal ASC`,
              )
              .all(conversationId) as any[]
          ).map(read),
        findBySession: (sessionId) => {
          const row = selectBySession.get(sessionId);
          return row ? read(row) : undefined;
        },
        reserveNext: (input) => {
          this.db.exec('BEGIN IMMEDIATE');
          try {
            const predecessor = selectBySession.get(input.predecessorSessionId);
            if (!predecessor) {
              throw new Error(
                `Conversation continuation predecessor is not linked: ${input.predecessorSessionId}`,
              );
            }
            const predecessorLineage = read(predecessor);
            if (predecessorLineage.conversationId !== input.conversationId) {
              throw new ConversationSessionLineageConflictError(
                'session-already-linked',
                {
                  conversationId: input.conversationId,
                  sessionId: input.proposedSessionId,
                  ordinal: predecessorLineage.ordinal + 1,
                  predecessorSessionId: input.predecessorSessionId,
                  createdAt: input.createdAt,
                },
                predecessorLineage,
              );
            }
            const successor = selectSuccessor.get(
              input.conversationId,
              input.predecessorSessionId,
            );
            if (successor) {
              this.db.exec('COMMIT');
              return { lineage: read(successor), outcome: 'existing' as const };
            }
            const lineage: ConversationSessionLineage = {
              conversationId: input.conversationId,
              sessionId: input.proposedSessionId,
              ordinal: predecessorLineage.ordinal + 1,
              predecessorSessionId: input.predecessorSessionId,
              createdAt: input.createdAt,
            };
            const inserted = insertInitial.run(
              lineage.conversationId,
              lineage.sessionId,
              lineage.ordinal,
              lineage.predecessorSessionId,
              lineage.createdAt,
            ) as { changes?: number };
            if (inserted.changes !== 1) {
              const existing = selectSuccessor.get(
                input.conversationId,
                input.predecessorSessionId,
              );
              if (!existing)
                throw new Error('Conversation continuation was not durable');
              this.db.exec('COMMIT');
              return { lineage: read(existing), outcome: 'existing' as const };
            }
            this.db.exec('COMMIT');
            return { lineage, outcome: 'created' as const };
          } catch (error) {
            try {
              this.db.exec('ROLLBACK');
            } catch {
              // Preserve the durable failure that caused rollback.
            }
            throw error;
          }
        },
      },
      observeMutation: (outcome) => {
        try {
          conversationSessionLineageMutations.add(1, { outcome });
        } catch {
          // OTel is observation only; a unavailable exporter must not alter durability.
        }
      },
    });
  }

  /**
   * Compose the handoff marker at the SQLite seam.  Its reservation is one
   * transaction with child lineage allocation, so a retry cannot create a
   * sibling execution Session or repoint an idempotency key.
   */
  private composeConversationHandoffs(): ConversationHandoffModule {
    const read = (row: any): ConversationHandoffMarker => ({
      conversationId: row.conversation_id,
      predecessorSessionId: row.predecessor_session_id,
      sessionId: row.session_id,
      idempotencyKey: row.idempotency_key,
      targetAgentId: row.target_agent_id,
      targetEnvironmentId: row.target_environment_id,
      ...(row.target_connection_id
        ? { targetConnectionId: row.target_connection_id }
        : {}),
      ...(row.target_model_id ? { targetModelId: row.target_model_id } : {}),
      messageDigest: row.message_digest,
      createdAt: row.created_at,
    });
    const byKey = this.db.prepare(
      `SELECT conversation_id, predecessor_session_id, session_id, idempotency_key,
              target_agent_id, target_environment_id, target_connection_id,
              target_model_id, message_digest, created_at
       FROM orchestration_conversation_handoffs
       WHERE conversation_id = ? AND idempotency_key = ?`,
    );
    const byPredecessor = this.db.prepare(
      `SELECT conversation_id, predecessor_session_id, session_id, idempotency_key,
              target_agent_id, target_environment_id, target_connection_id,
              target_model_id, message_digest, created_at
       FROM orchestration_conversation_handoffs
       WHERE predecessor_session_id = ?`,
    );
    const byConversation = this.db.prepare(
      `SELECT conversation_id, predecessor_session_id, session_id, idempotency_key,
              target_agent_id, target_environment_id, target_connection_id,
              target_model_id, message_digest, created_at
       FROM orchestration_conversation_handoffs
       WHERE conversation_id = ?
       ORDER BY created_at ASC, session_id ASC`,
    );
    const lineage = this.db.prepare(
      `SELECT conversation_id, session_id, ordinal
       FROM orchestration_conversation_sessions WHERE session_id = ?`,
    );
    const successor = this.db.prepare(
      `SELECT session_id FROM orchestration_conversation_sessions
       WHERE conversation_id = ? AND predecessor_session_id = ?`,
    );
    const insertLineage = this.db.prepare(
      `INSERT INTO orchestration_conversation_sessions
        (conversation_id, session_id, ordinal, predecessor_session_id, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    );
    const insertMarker = this.db.prepare(
      `INSERT INTO orchestration_conversation_handoffs
        (conversation_id, predecessor_session_id, session_id, idempotency_key,
         target_agent_id, target_environment_id, target_connection_id,
         target_model_id, message_digest, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const sameTarget = (
      left: ConversationHandoffMarker,
      right: ConversationHandoffMarker,
    ) =>
      left.conversationId === right.conversationId &&
      left.predecessorSessionId === right.predecessorSessionId &&
      left.targetAgentId === right.targetAgentId &&
      left.targetEnvironmentId === right.targetEnvironmentId &&
      left.targetConnectionId === right.targetConnectionId &&
      left.targetModelId === right.targetModelId &&
      left.messageDigest === right.messageDigest;
    return createConversationHandoffModule({
      persistence: {
        listByConversation: (conversationId) =>
          (byConversation.all(conversationId) as any[]).map(read),
        reserve: (input) => {
          this.db.exec('BEGIN IMMEDIATE');
          try {
            const existingForKey = byKey.get(
              input.conversationId,
              input.idempotencyKey,
            );
            if (existingForKey) {
              const existing = read(existingForKey);
              if (!sameTarget(existing, input)) {
                throw new ConversationHandoffConflictError(
                  'idempotency_target_mismatch',
                );
              }
              this.db.exec('COMMIT');
              return { marker: existing, outcome: 'existing' as const };
            }
            const predecessor = lineage.get(input.predecessorSessionId) as
              | { conversation_id: string; ordinal: number }
              | undefined;
            if (
              !predecessor ||
              predecessor.conversation_id !== input.conversationId
            ) {
              throw new ConversationHandoffConflictError('successor_exists');
            }
            const existingForPredecessor = byPredecessor.get(
              input.predecessorSessionId,
            );
            if (existingForPredecessor) {
              throw new ConversationHandoffConflictError('successor_exists');
            }
            const existingSuccessor = successor.get(
              input.conversationId,
              input.predecessorSessionId,
            ) as { session_id?: string } | undefined;
            if (
              existingSuccessor &&
              existingSuccessor.session_id !== input.sessionId
            ) {
              throw new ConversationHandoffConflictError('successor_exists');
            }
            if (!existingSuccessor) {
              insertLineage.run(
                input.conversationId,
                input.sessionId,
                predecessor.ordinal + 1,
                input.predecessorSessionId,
                input.createdAt,
              );
            }
            insertMarker.run(
              input.conversationId,
              input.predecessorSessionId,
              input.sessionId,
              input.idempotencyKey,
              input.targetAgentId,
              input.targetEnvironmentId,
              input.targetConnectionId ?? null,
              input.targetModelId ?? null,
              input.messageDigest,
              input.createdAt,
            );
            this.db.exec('COMMIT');
            return { marker: input, outcome: 'created' as const };
          } catch (error) {
            try {
              this.db.exec('ROLLBACK');
            } catch {
              // Preserve the first durable error.
            }
            throw error;
          }
        },
        findBySession: (sessionId) => {
          const row = this.db
            .prepare(
              `SELECT conversation_id, predecessor_session_id, session_id, idempotency_key,
                      target_agent_id, target_environment_id, target_connection_id,
                      target_model_id, message_digest, created_at
               FROM orchestration_conversation_handoffs WHERE session_id = ?`,
            )
            .get(sessionId);
          return row ? read(row) : undefined;
        },
        findByPredecessor: (sessionId) => {
          const row = byPredecessor.get(sessionId);
          return row ? read(row) : undefined;
        },
        findByKey: (conversationId, idempotencyKey) => {
          const row = byKey.get(conversationId, idempotencyKey);
          return row ? read(row) : undefined;
        },
      },
    });
  }

  /** One transaction reserves both exact child lineage and its one-shot boundary. */
  private composeConversationContextBoundaries(): ConversationContextBoundaryModule {
    const read = (row: any): ConversationContextBoundaryMarker => ({
      boundaryId: row.boundary_id,
      conversationId: row.conversation_id,
      predecessorSessionId: row.predecessor_session_id,
      successorSessionId: row.successor_session_id,
      idempotencyKey: row.idempotency_key,
      policy: row.policy,
      status: row.status,
      actorId: row.actor_id,
      ...(row.client_origin ? { clientOrigin: row.client_origin } : {}),
      createdAt: row.created_at,
      ...(row.claimed_at ? { claimedAt: row.claimed_at } : {}),
      ...(row.start_command_id ? { startCommandId: row.start_command_id } : {}),
      ...(row.consumed_at ? { consumedAt: row.consumed_at } : {}),
    });
    const columns =
      'boundary_id, conversation_id, predecessor_session_id, successor_session_id, idempotency_key, policy, status, actor_id, client_origin, created_at, claimed_at, start_command_id, consumed_at';
    const byKey = this.db.prepare(
      `SELECT ${columns} FROM orchestration_conversation_context_boundaries WHERE conversation_id = ? AND idempotency_key = ?`,
    );
    const bySuccessor = this.db.prepare(
      `SELECT ${columns} FROM orchestration_conversation_context_boundaries WHERE successor_session_id = ?`,
    );
    const byConversation = this.db.prepare(
      `SELECT ${columns} FROM orchestration_conversation_context_boundaries WHERE conversation_id = ? ORDER BY created_at ASC`,
    );
    const predecessor = this.db.prepare(
      'SELECT conversation_id, ordinal FROM orchestration_conversation_sessions WHERE session_id = ?',
    );
    const successor = this.db.prepare(
      'SELECT session_id FROM orchestration_conversation_sessions WHERE conversation_id = ? AND predecessor_session_id = ?',
    );
    const insertLineage = this.db.prepare(
      'INSERT INTO orchestration_conversation_sessions (conversation_id, session_id, ordinal, predecessor_session_id, created_at) VALUES (?, ?, ?, ?, ?)',
    );
    const insert = this.db.prepare(
      `INSERT INTO orchestration_conversation_context_boundaries (${columns}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    return createConversationContextBoundaryModule({
      persistence: {
        reserve: (input) => {
          this.db.exec('BEGIN IMMEDIATE');
          try {
            const row = byKey.get(input.conversationId, input.idempotencyKey);
            if (row) {
              const existing = read(row);
              if (
                existing.policy !== input.policy ||
                existing.predecessorSessionId !== input.predecessorSessionId ||
                existing.actorId !== input.actorId
              )
                throw new ConversationContextBoundaryConflictError(
                  'idempotency_mismatch',
                );
              this.db.exec('COMMIT');
              return { marker: existing, outcome: 'existing' as const };
            }
            const parent = predecessor.get(input.predecessorSessionId) as
              | { conversation_id: string; ordinal: number }
              | undefined;
            const existingSuccessor = successor.get(
              input.conversationId,
              input.predecessorSessionId,
            ) as { session_id?: string } | undefined;
            if (
              !parent ||
              parent.conversation_id !== input.conversationId ||
              (existingSuccessor &&
                existingSuccessor.session_id !== input.successorSessionId)
            )
              throw new ConversationContextBoundaryConflictError(
                'successor_exists',
              );
            if (!existingSuccessor) {
              insertLineage.run(
                input.conversationId,
                input.successorSessionId,
                parent.ordinal + 1,
                input.predecessorSessionId,
                input.createdAt,
              );
            }
            insert.run(
              input.boundaryId,
              input.conversationId,
              input.predecessorSessionId,
              input.successorSessionId,
              input.idempotencyKey,
              input.policy,
              input.status,
              input.actorId,
              input.clientOrigin ?? null,
              input.createdAt,
              null,
              null,
              null,
            );
            this.db.exec('COMMIT');
            return { marker: input, outcome: 'created' as const };
          } catch (error) {
            try {
              this.db.exec('ROLLBACK');
            } catch {}
            throw error;
          }
        },
        bySuccessor: (sessionId) => {
          const row = bySuccessor.get(sessionId);
          return row ? read(row) : undefined;
        },
        byKey: (conversationId, key) => {
          const row = byKey.get(conversationId, key);
          return row ? read(row) : undefined;
        },
        listForConversation: (conversationId) =>
          (byConversation.all(conversationId) as any[]).map(read),
        update: (id, from, status, at, startCommandId) => {
          const allowed = from.map(() => '?').join(',');
          const result = this.db
            .prepare(
              `UPDATE orchestration_conversation_context_boundaries SET status = ?, claimed_at = CASE WHEN ? = 'claimed' THEN ? ELSE claimed_at END, start_command_id = CASE WHEN ? = 'claimed' THEN ? ELSE start_command_id END, consumed_at = CASE WHEN ? = 'consumed' AND start_command_id = ? THEN ? ELSE consumed_at END WHERE boundary_id = ? AND status IN (${allowed}) AND (? != 'consumed' OR start_command_id = ?)`,
            )
            .run(
              status,
              status,
              at,
              status,
              startCommandId ?? null,
              status,
              startCommandId ?? null,
              at,
              id,
              ...from,
              status,
              startCommandId ?? null,
            ) as {
            changes?: number;
          };
          if (result.changes !== 1) return undefined;
          const row = this.db
            .prepare(
              `SELECT ${columns} FROM orchestration_conversation_context_boundaries WHERE boundary_id = ?`,
            )
            .get(id);
          return row ? read(row) : undefined;
        },
        cancelReserved: (id, _at) => {
          // This is one transaction because leaving the successor lineage row
          // behind would make the cancelled, never-materialized child the
          // canonical current session forever.  Do not compensate a claim or
          // a materialized Session: either may already have crossed a
          // provider boundary and must remain fenced for recovery.
          this.db.exec('BEGIN IMMEDIATE');
          try {
            const row = this.db
              .prepare(
                `SELECT ${columns}
                   FROM orchestration_conversation_context_boundaries
                  WHERE boundary_id = ? AND status = 'reserved'`,
              )
              .get(id);
            if (!row) {
              this.db.exec('ROLLBACK');
              return undefined;
            }
            const marker = read(row);
            const materialized = this.db
              .prepare(
                `SELECT 1 FROM provider_session_state
                  WHERE thread_id = ? LIMIT 1`,
              )
              .get(marker.successorSessionId);
            const handoff = this.db
              .prepare(
                `SELECT 1 FROM orchestration_conversation_handoffs
                  WHERE session_id = ? LIMIT 1`,
              )
              .get(marker.successorSessionId);
            if (materialized || handoff) {
              this.db.exec('ROLLBACK');
              return undefined;
            }
            const cancelled = this.db
              .prepare(
                `UPDATE orchestration_conversation_context_boundaries
                    SET status = 'cancelled'
                  WHERE boundary_id = ? AND status = 'reserved'`,
              )
              .run(id) as { changes?: number };
            const retired = this.db
              .prepare(
                `DELETE FROM orchestration_conversation_sessions
                  WHERE conversation_id = ? AND session_id = ?
                    AND predecessor_session_id = ?`,
              )
              .run(
                marker.conversationId,
                marker.successorSessionId,
                marker.predecessorSessionId,
              ) as { changes?: number };
            if (cancelled.changes !== 1 || retired.changes !== 1) {
              this.db.exec('ROLLBACK');
              return undefined;
            }
            this.db.exec('COMMIT');
            return { ...marker, status: 'cancelled' as const };
          } catch (error) {
            try {
              this.db.exec('ROLLBACK');
            } catch {}
            throw error;
          }
        },
        reconcile: () => {
          // A reboot never guesses from a later turn.  The exact persisted
          // start command (or its immutable session.started fact) is the only
          // success proof; no durable start fact releases the retryable claim;
          // partial/corrupt evidence is fenced rather than replayed.
          this.db
            .prepare(
              `UPDATE orchestration_conversation_context_boundaries
                 SET status = CASE
                   WHEN start_command_id IS NOT NULL AND EXISTS (
                     SELECT 1 FROM orchestration_command_receipts r
                      WHERE r.command_id = start_command_id
                        AND r.thread_id = successor_session_id
                        AND r.command_type = 'startSession'
                        AND r.status = 'accepted'
                   ) THEN 'consumed'
                   WHEN start_command_id IS NOT NULL
                    AND NOT EXISTS (
                     SELECT 1 FROM orchestration_command_receipts r
                      WHERE r.command_id = start_command_id
                   )
                    AND NOT EXISTS (
                     SELECT 1 FROM orchestration_events e
                      WHERE e.thread_id = successor_session_id
                        AND e.method = 'session.started'
                   ) THEN 'failed'
                   ELSE 'indeterminate'
                 END,
                 consumed_at = CASE WHEN start_command_id IS NOT NULL AND EXISTS (
                   SELECT 1 FROM orchestration_command_receipts r
                    WHERE r.command_id = start_command_id
                      AND r.thread_id = successor_session_id
                      AND r.command_type = 'startSession'
                      AND r.status = 'accepted'
                 ) THEN COALESCE(consumed_at, claimed_at) ELSE consumed_at END
               WHERE status = 'claimed'`,
            )
            .run();
        },
      },
    });
  }

  /** Deliberate composition seam; SQLite coordination remains private. */
  createAdoptionLedger(): AdoptionLedger {
    const coordinator: AdoptionLedgerCoordinator = {
      reserve: (reservation) => this.reserveAdoptionRecord(reservation),
      replaceOwner: (input) => this.replaceAdoptionOwner(input),
      updateOwned: (input) => this.updateOwnedAdoption(input),
      commitOwned: (input) => this.commitOwnedAdoption(input),
      completeCleanupOwned: (input) => this.completeOwnedAdoptionCleanup(input),
      reservations: () => this.readAdoptionReservationRecords(),
      reservesProviderCursor: (provider, providerResumeCursor) =>
        this.adoptionReservesProviderCursor(provider, providerResumeCursor),
    };
    return createAdoptionLedger({ coordinator });
  }

  /** Same already-open home store; package callers never open another SQLite path. */
  createPackageMcpAdmissionJournal(): PackageMcpAdmissionJournal {
    if (this.messageSearchBackfillClosed)
      throw new Error('Package MCP journal owner is closing');
    this.packageMcpAdmissionJournal ??= composePackageMcpAdmissionJournal(
      this.db,
      this.recoveryLedgerOwner,
      this.packageMcpCommitFault,
    );
    return this.packageMcpAdmissionJournal;
  }

  /** Builds the one private direct-invocation authority for this EventStore. */
  private composeNativeInvocationRuns(): ReturnType<
    typeof createNativeInvocationRuns
  > {
    const coordinator = {
      begin: (input: {
        runId: string;
        kind: string;
        sourceId?: string;
        state: 'starting';
        ownerId: string;
        ownerPid: number;
        ownerBirth?: string;
        ownerIdentityKind: string;
        startedAt: string;
        updatedAt: string;
      }) => {
        try {
          this.db
            .prepare(
              `INSERT INTO native_invocation_runs
                (run_id, kind, source_id, state, owner_id, owner_pid, owner_birth, owner_identity_kind, started_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(
              input.runId,
              input.kind,
              input.sourceId ?? null,
              input.state,
              input.ownerId,
              input.ownerPid,
              input.ownerBirth ?? null,
              input.ownerIdentityKind,
              input.startedAt,
              input.updatedAt,
            );
          return { kind: 'applied' as const };
        } catch {
          return { kind: 'unavailable' as const };
        }
      },
      transition: (input: {
        runId: string;
        ownerId: string;
        from: string[];
        to: 'running' | 'completed' | 'failed' | 'indeterminate';
        now: string;
        failureMessage?: string;
      }) => this.transitionNativeInvocationRun(input),
      read: (runId: string) => this.readNativeInvocationRun(runId),
      list: () => this.listNativeInvocationRuns(),
      active: () => {
        this.nativeInvocationStartupFault?.();
        return this.readActiveNativeInvocationRuns();
      },
    };
    return createNativeInvocationRuns({
      coordinator,
      owner: this.recoveryLedgerOwner,
      processIdentity: this.recoveryProcessIdentity,
    });
  }

  /**
   * Voice starts are observed provider facts, not local pre-effect claims.
   * The table's `(voice_session_id, provider_turn_id)` uniqueness is the
   * authoritative duplicate/late-event fence.
   */
  private composeVoiceTurnRuns(): VoiceTurnRuns {
    const project = (row: Record<string, unknown>): RunSummary => {
      const state = row.state as string;
      const terminal =
        state === 'completed' ||
        state === 'failed' ||
        state === 'indeterminate';
      return {
        runId: row.run_id as string,
        providerId: row.provider_id as string,
        source: 'voice',
        ...(row.source_id ? { sourceId: row.source_id as string } : {}),
        status:
          state === 'running'
            ? 'running'
            : state === 'completed'
              ? 'completed'
              : 'failed',
        startedAt: row.started_at as string,
        updatedAt: row.updated_at as string,
        ...(terminal ? { completedAt: row.completed_at as string } : {}),
        ...(state === 'failed' || state === 'indeterminate'
          ? {
              failureKind:
                state === 'indeterminate'
                  ? ('unknown' as const)
                  : ('tool_error' as const),
              ...(row.failure_message
                ? { failureMessage: row.failure_message as string }
                : {}),
            }
          : {}),
        retryEligible: false,
        attempt: 1,
        metadata: {
          voiceTurnState: state,
          // Provider identities stay private; the canonical run is the only
          // public observation handle.
        },
      };
    };
    return createVoiceTurnRuns({
      owner: this.recoveryLedgerOwner,
      processIdentity: this.recoveryProcessIdentity,
      coordinator: {
        observe: (record) => {
          try {
            const changed = this.db
              .prepare(
                `INSERT OR IGNORE INTO voice_turn_runs
                  (run_id, voice_session_id, provider_session_id, provider_turn_id, provider_prompt_id, provider_id, source_id,
                   state, owner_id, owner_pid, owner_birth, owner_identity_kind, started_at, updated_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, 'running', ?, ?, ?, ?, ?, ?)`,
              )
              .run(
                record.runId,
                record.voiceSessionId,
                record.providerSessionId,
                record.providerTurnId,
                record.providerPromptId,
                record.providerId,
                record.sourceId ?? null,
                record.ownerId,
                record.ownerPid,
                record.ownerBirth ?? null,
                record.ownerIdentityKind,
                record.startedAt,
                record.updatedAt,
              ) as { changes?: number };
            if (changed.changes === 1) this.voiceTurnTransitionFault?.();
            return changed.changes === 1 ? 'started' : 'duplicate';
          } catch {
            try {
              const row = this.db
                .prepare(
                  `SELECT run_id, owner_id FROM voice_turn_runs
                   WHERE voice_session_id = ? AND provider_session_id = ? AND provider_prompt_id = ? AND provider_turn_id = ?`,
                )
                .get(
                  record.voiceSessionId,
                  record.providerSessionId,
                  record.providerPromptId,
                  record.providerTurnId,
                ) as { run_id: string; owner_id: string } | undefined;
              return row?.run_id === record.runId &&
                row.owner_id === record.ownerId
                ? 'started'
                : 'unavailable';
            } catch {
              return 'unavailable';
            }
          }
        },
        transition: (input) => {
          const exact = (
            row:
              | {
                  state: string;
                  updated_at: string;
                  completed_at: string | null;
                  failure_message: string | null;
                }
              | undefined,
          ) =>
            row?.state === input.to &&
            row.updated_at === input.now &&
            row.completed_at === input.now &&
            (input.failureMessage === undefined ||
              row.failure_message === input.failureMessage);
          const readback = () =>
            this.db
              .prepare(
                `SELECT state, updated_at, completed_at, failure_message FROM voice_turn_runs
                 WHERE run_id = ? AND voice_session_id = ? AND provider_session_id = ? AND provider_prompt_id = ? AND provider_turn_id = ?
                   ${input.ownerId ? 'AND owner_id = ?' : ''}`,
              )
              .get(
                input.runId,
                input.voiceSessionId,
                input.providerSessionId,
                input.providerPromptId,
                input.providerTurnId,
                ...(input.ownerId ? [input.ownerId] : []),
              ) as
              | {
                  state: string;
                  updated_at: string;
                  completed_at: string | null;
                  failure_message: string | null;
                }
              | undefined;
          const applied = () => {
            this.pruneVoiceTurnTerminals();
            return { kind: 'applied' as const };
          };
          try {
            const placeholders = input.from.map(() => '?').join(', ');
            const query = this.db.prepare(
              `UPDATE voice_turn_runs
                 SET state = ?, updated_at = ?, completed_at = ?,
                     terminal_sequence =
                       (SELECT COALESCE(MAX(terminal_sequence), 0) + 1 FROM voice_turn_runs),
                     failure_message = CASE WHEN ? IS NULL THEN failure_message ELSE ? END
               WHERE run_id = ? AND voice_session_id = ? AND provider_session_id = ? AND provider_prompt_id = ? AND provider_turn_id = ?
                 ${input.ownerId ? 'AND owner_id = ?' : ''}
                 AND state IN (${placeholders})`,
            );
            query.run(
              input.to,
              input.now,
              input.now,
              input.failureMessage ?? null,
              input.failureMessage ?? null,
              input.runId,
              input.voiceSessionId,
              input.providerSessionId,
              input.providerPromptId,
              input.providerTurnId,
              ...(input.ownerId ? [input.ownerId] : []),
              ...input.from,
            );
            this.voiceTurnTransitionFault?.();
            // Do not trust the driver's write acknowledgement as proof. The
            // exact durable row is the terminal fact, including after a
            // write-success/readback-boundary fault.
            return exact(readback()) ? applied() : { kind: 'stale' as const };
          } catch {
            try {
              return exact(readback()) ? applied() : { kind: 'stale' as const };
            } catch {
              return { kind: 'unavailable' as const };
            }
          }
        },
        active: () =>
          (
            this.db
              .prepare(
                `SELECT run_id, voice_session_id, provider_session_id, provider_turn_id, provider_prompt_id, provider_id, source_id,
                      owner_id, owner_pid, owner_birth, owner_identity_kind, state, started_at, updated_at
                 FROM voice_turn_runs WHERE state = 'running'`,
              )
              .all() as Array<Record<string, unknown>>
          ).map((row) => ({
            runId: row.run_id as string,
            voiceSessionId: row.voice_session_id as string,
            providerSessionId: row.provider_session_id as string,
            providerTurnId: row.provider_turn_id as string,
            providerPromptId: row.provider_prompt_id as string,
            providerId: row.provider_id as string,
            ...(row.source_id ? { sourceId: row.source_id as string } : {}),
            ownerId: row.owner_id as string,
            ownerPid: row.owner_pid as number,
            ...(row.owner_birth
              ? { ownerBirth: row.owner_birth as string }
              : {}),
            ownerIdentityKind: row.owner_identity_kind as string,
            state: 'running' as const,
            startedAt: row.started_at as string,
            updatedAt: row.updated_at as string,
          })),
        list: () => {
          const active = this.db
            .prepare(
              `SELECT run_id, provider_id, source_id, state, started_at, updated_at, completed_at, failure_message
                 FROM voice_turn_runs WHERE state = 'running'
                 ORDER BY started_at ASC, run_id ASC`,
            )
            .all() as Array<Record<string, unknown>>;
          const terminal = this.db
            .prepare(
              `SELECT run_id, provider_id, source_id, state, started_at, updated_at, completed_at, failure_message
                 FROM voice_turn_runs WHERE state != 'running'
                 ORDER BY terminal_sequence DESC, run_id DESC LIMIT ?`,
            )
            .all(VOICE_TURN_TERMINAL_RETENTION) as Array<
            Record<string, unknown>
          >;
          return [...active, ...terminal]
            .map(project)
            .sort(
              (left, right) =>
                left.startedAt.localeCompare(right.startedAt) ||
                left.runId.localeCompare(right.runId),
            );
        },
        read: (runId) => {
          const row = this.db
            .prepare(
              `SELECT run_id, provider_id, source_id, state, started_at, updated_at, completed_at, failure_message
                 FROM voice_turn_runs WHERE run_id = ?`,
            )
            .get(runId) as Record<string, unknown> | undefined;
          return row ? project(row) : null;
        },
      },
    });
  }

  /** Bounded voice terminal history; observed active effects are never pruned. */
  private pruneVoiceTurnTerminals(): void {
    try {
      this.db
        .prepare(
          `DELETE FROM voice_turn_runs
            WHERE run_id IN (
              SELECT run_id FROM voice_turn_runs
               WHERE state IN ('completed', 'failed', 'indeterminate')
               ORDER BY terminal_sequence DESC, run_id DESC
               LIMIT -1 OFFSET ?
            )`,
        )
        .run(VOICE_TURN_TERMINAL_RETENTION);
    } catch {
      // Retention is best-effort after the exact terminal receipt is proven.
    }
  }

  /** Route composition receives only a pre-effect claim starter. */
  nativeInvocationStarter(): NativeInvocationStarter {
    return this.nativeInvocationStarterAdapter;
  }

  /** RunService composition receives only the canonical run projection. */
  nativeInvocationRunReader(): NativeInvocationRunReader {
    return this.nativeInvocationRunReaderAdapter;
  }

  /** RunService receives voice projection independently from direct invoke. */
  voiceTurnRunReader(): VoiceTurnRunsReader {
    return this.voiceTurnRuns;
  }

  /** Private runtime composition for provider-correlated voice turns. */
  voiceTurnRunAuthority(): VoiceTurnRuns {
    return this.voiceTurnRuns;
  }

  /** Private runtime composition for session turn provider boundaries. */
  sessionTurnBoundaryAuthority(): SessionTurnBoundaryAuthority {
    return this.sessionTurnBoundaries;
  }

  /**
   * Route composition does not publish until this startup gate is available.
   * A short bounded backoff handles transient SQLite ownership hand-off; a
   * persistent failure closes construction with one stable typed error rather
   * than leaving starter/reader adapters unavailable forever.
   */
  private initializeNativeInvocationRuns(): void {
    for (
      let attempt = 0;
      attempt < NATIVE_INVOCATION_STARTUP_ATTEMPTS;
      attempt += 1
    ) {
      const reconciled = this.nativeInvocationRuns.reconcile(
        new Date().toISOString(),
      );
      if (reconciled.kind === 'available') {
        this.nativeInvocationRunsReady = true;
        return;
      }
      if (attempt + 1 < NATIVE_INVOCATION_STARTUP_ATTEMPTS) {
        Atomics.wait(nativeInvocationStartupBackoff, 0, 0, 2);
      }
    }
    throw new NativeInvocationStartupUnavailableError();
  }

  private initializeVoiceTurnRuns(): void {
    for (
      let attempt = 0;
      attempt < NATIVE_INVOCATION_STARTUP_ATTEMPTS;
      attempt += 1
    ) {
      if (
        this.voiceTurnRuns.reconcile(new Date().toISOString()).kind ===
        'available'
      ) {
        return;
      }
      if (attempt + 1 < NATIVE_INVOCATION_STARTUP_ATTEMPTS) {
        Atomics.wait(nativeInvocationStartupBackoff, 0, 0, attempt + 1);
      }
    }
    throw new VoiceTurnStartupUnavailableError();
  }

  private composeSessionTurnBoundaries(): SessionTurnBoundaryAuthority {
    const exact = (input: {
      boundaryId: string;
      ownerId: string;
      state: string;
      updatedAt?: string;
      providerTurnId?: string;
    }) => {
      const row = this.db
        .prepare(
          `SELECT state, updated_at, provider_turn_id
             FROM orchestration_turn_boundaries
            WHERE boundary_id = ? AND owner_id = ?`,
        )
        .get(input.boundaryId, input.ownerId) as
        | {
            state: string;
            updated_at: string;
            provider_turn_id: string | null;
          }
        | undefined;
      return (
        row?.state === input.state &&
        (input.updatedAt === undefined || row.updated_at === input.updatedAt) &&
        (input.providerTurnId === undefined ||
          row.provider_turn_id === input.providerTurnId)
      );
    };
    const coordinator: SessionTurnBoundaryCoordinator = {
      create: (record) => {
        try {
          this.db.exec('BEGIN IMMEDIATE');
          const occupied = this.db
            .prepare(
              record.state === 'lifecycle'
                ? `SELECT 1 AS occupied FROM orchestration_turn_boundaries
                    WHERE thread_id = ? LIMIT 1`
                : `SELECT 1 AS occupied FROM orchestration_turn_boundaries
                    WHERE thread_id = ?
                      AND (
                        state IN ('lifecycle', 'prepared', 'invoking', 'indeterminate')
                        OR (
                          state = 'accepted'
                          AND (SELECT COUNT(*) FROM orchestration_turn_boundaries
                                WHERE thread_id = ?) >= ?
                        )
                      )
                    LIMIT 1`,
            )
            .get(
              record.threadId,
              ...(record.state === 'lifecycle'
                ? []
                : [record.threadId, SESSION_TURN_ACCEPTED_CAPACITY]),
            ) as { occupied: number } | undefined;
          if (occupied) {
            this.db.exec('ROLLBACK');
            return { kind: 'busy' };
          }
          this.db
            .prepare(
              `INSERT INTO orchestration_turn_boundaries
                (boundary_id, thread_id, state, provider_turn_id, owner_id,
                 owner_pid, owner_birth, owner_identity_kind, created_at, updated_at)
               VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?)`,
            )
            .run(
              record.boundaryId,
              record.threadId,
              record.state,
              record.ownerId,
              record.ownerPid,
              record.ownerBirth ?? null,
              record.ownerIdentityKind,
              record.createdAt,
              record.updatedAt,
            );
          this.db.exec('COMMIT');
          return { kind: 'applied' };
        } catch {
          try {
            this.db.exec('ROLLBACK');
          } catch {
            // The transaction may already have committed.
          }
          try {
            const exactBoundary = this.db
              .prepare(
                `SELECT 1 AS occupied FROM orchestration_turn_boundaries
                  WHERE boundary_id = ? AND owner_id = ?`,
              )
              .get(record.boundaryId, record.ownerId) as
              | { occupied: number }
              | undefined;
            if (exactBoundary) return { kind: 'applied' };
            const occupied = this.db
              .prepare(
                'SELECT 1 AS occupied FROM orchestration_turn_boundaries WHERE thread_id = ? LIMIT 1',
              )
              .get(record.threadId) as { occupied: number } | undefined;
            return occupied ? { kind: 'busy' } : { kind: 'unavailable' };
          } catch {
            return { kind: 'unavailable' };
          }
        }
      },
      transition: (input) => {
        const apply = (targetState = input.to) => {
          const placeholders = input.from.map(() => '?').join(', ');
          this.db
            .prepare(
              `UPDATE orchestration_turn_boundaries
                  SET state = ?, updated_at = ?, provider_turn_id = COALESCE(?, provider_turn_id)
                WHERE boundary_id = ? AND owner_id = ? AND state IN (${placeholders})`,
            )
            .run(
              targetState,
              input.now,
              input.providerTurnId ?? null,
              input.boundaryId,
              input.ownerId,
              ...input.from,
            );
        };
        let targetState = input.to;
        let ambiguousAcceptance = false;
        try {
          if (input.to === 'accepted' && input.providerTurnId) {
            this.db.exec('BEGIN IMMEDIATE');
            const priorOrConcurrentGeneration = this.db
              .prepare(
                `SELECT 1 AS observed
                   FROM orchestration_turn_boundaries AS boundary
                  WHERE boundary.boundary_id = ?
                    AND (
                      EXISTS (
                        SELECT 1 FROM orchestration_events AS event
                         WHERE event.thread_id = boundary.thread_id
                           AND event.turn_id = ?
                           AND event.method IN ('turn.completed', 'turn.aborted', 'runtime.error')
                      )
                      OR EXISTS (
                        SELECT 1 FROM orchestration_turn_boundaries AS accepted
                         WHERE accepted.thread_id = boundary.thread_id
                           AND accepted.state = 'accepted'
                           AND accepted.provider_turn_id = ?
                           AND accepted.boundary_id != boundary.boundary_id
                      )
                    )
                  LIMIT 1`,
              )
              .get(
                input.boundaryId,
                input.providerTurnId,
                input.providerTurnId,
              ) as { observed: number } | undefined;
            if (priorOrConcurrentGeneration) {
              targetState = 'indeterminate';
              ambiguousAcceptance = true;
            }
          }
          apply(targetState);
          if (input.to === 'accepted' && input.providerTurnId) {
            this.db.exec('COMMIT');
          }
          return exact({
            boundaryId: input.boundaryId,
            ownerId: input.ownerId,
            state: targetState,
            updatedAt: input.now,
            ...(input.providerTurnId
              ? { providerTurnId: input.providerTurnId }
              : {}),
          })
            ? { kind: ambiguousAcceptance ? 'ambiguous' : 'applied' }
            : { kind: 'stale' };
        } catch {
          if (input.to === 'accepted' && input.providerTurnId) {
            try {
              this.db.exec('ROLLBACK');
            } catch {
              // The transaction may already have committed.
            }
          }
          try {
            if (
              input.to === 'accepted' &&
              input.providerTurnId &&
              exact({
                boundaryId: input.boundaryId,
                ownerId: input.ownerId,
                state: 'indeterminate',
                updatedAt: input.now,
                providerTurnId: input.providerTurnId,
              })
            ) {
              return { kind: 'ambiguous' };
            }
            return exact({
              boundaryId: input.boundaryId,
              ownerId: input.ownerId,
              state: input.to,
              updatedAt: input.now,
              ...(input.providerTurnId
                ? { providerTurnId: input.providerTurnId }
                : {}),
            })
              ? { kind: 'applied' }
              : { kind: 'unavailable' };
          } catch {
            return { kind: 'unavailable' };
          }
        }
      },
      remove: (input) => {
        try {
          const placeholders = input.from.map(() => '?').join(', ');
          this.db
            .prepare(
              `DELETE FROM orchestration_turn_boundaries
                WHERE boundary_id = ? AND owner_id = ? AND state IN (${placeholders})`,
            )
            .run(input.boundaryId, input.ownerId, ...input.from);
          const remains = this.db
            .prepare(
              'SELECT 1 AS present FROM orchestration_turn_boundaries WHERE boundary_id = ?',
            )
            .get(input.boundaryId) as { present: number } | undefined;
          return remains ? { kind: 'stale' } : { kind: 'applied' };
        } catch {
          try {
            const remains = this.db
              .prepare(
                'SELECT 1 AS present FROM orchestration_turn_boundaries WHERE boundary_id = ?',
              )
              .get(input.boundaryId) as { present: number } | undefined;
            return remains ? { kind: 'unavailable' } : { kind: 'applied' };
          } catch {
            return { kind: 'unavailable' };
          }
        }
      },
      removeTerminal: (input) => {
        try {
          if (input.sessionTerminal) {
            this.db
              .prepare(
                `DELETE FROM orchestration_turn_boundaries
                  WHERE thread_id = ? AND state != 'lifecycle'
                    AND created_at <= ?`,
              )
              .run(input.threadId, input.terminalCreatedAt);
          } else if (input.providerTurnId) {
            this.db
              .prepare(
                `DELETE FROM orchestration_turn_boundaries
                  WHERE thread_id = ? AND state = 'accepted'
                    AND provider_turn_id = ? AND created_at <= ?`,
              )
              .run(
                input.threadId,
                input.providerTurnId,
                input.terminalCreatedAt,
              );
          }
          return { kind: 'applied' };
        } catch {
          return { kind: 'unavailable' };
        }
      },
      hasPossibleEffect: (threadId) => {
        this.reconcileSessionTurnTerminalsFromEvents(threadId);
        return Boolean(
          this.db
            .prepare(
              `SELECT 1 AS active FROM orchestration_turn_boundaries
                WHERE thread_id = ? AND state != 'lifecycle'`,
            )
            .get(threadId),
        );
      },
      active: () =>
        (
          this.db
            .prepare(
              `SELECT boundary_id, thread_id, state, provider_turn_id, owner_id,
                      owner_pid, owner_birth, owner_identity_kind, created_at, updated_at
                 FROM orchestration_turn_boundaries`,
            )
            .all() as Array<Record<string, unknown>>
        ).map(
          (row): SessionTurnBoundaryRecord => ({
            boundaryId: row.boundary_id as string,
            threadId: row.thread_id as string,
            state: row.state as SessionTurnBoundaryRecord['state'],
            ...(row.provider_turn_id
              ? { providerTurnId: row.provider_turn_id as string }
              : {}),
            ownerId: row.owner_id as string,
            ownerPid: row.owner_pid as number,
            ...(row.owner_birth
              ? { ownerBirth: row.owner_birth as string }
              : {}),
            ownerIdentityKind: row.owner_identity_kind as string,
            createdAt: row.created_at as string,
            updatedAt: row.updated_at as string,
          }),
        ),
    };
    return createSessionTurnBoundaryAuthority({
      coordinator,
      owner: this.recoveryLedgerOwner,
      processIdentity: this.recoveryProcessIdentity,
    });
  }

  private initializeSessionTurnBoundaries(): void {
    this.reconcileSessionTurnTerminalsFromEvents();
    for (
      let attempt = 0;
      attempt < NATIVE_INVOCATION_STARTUP_ATTEMPTS;
      attempt += 1
    ) {
      const reconciled = this.sessionTurnBoundaries.reconcile(
        new Date().toISOString(),
      );
      if (reconciled.kind === 'available') {
        this.pendingInterruptedTurnBoundaries = reconciled.interrupted;
        return;
      }
      if (attempt + 1 < NATIVE_INVOCATION_STARTUP_ATTEMPTS) {
        Atomics.wait(nativeInvocationStartupBackoff, 0, 0, attempt + 1);
      }
    }
    throw new Error(
      'Session turn boundary recovery is temporarily unavailable.',
    );
  }

  /**
   * archive#4080: drains (does not merely read) this process's
   * boot-time interrupted-turn findings. A single boot consumer calls this
   * once; draining is what makes a second, accidental in-process call a
   * no-op rather than a duplicate banner source — the DURABLE guard against
   * a duplicate banner across a process RESTART is
   * {@link resolveInterruptedTurnBoundary}, called by the consumer once a
   * record's banner is durably written.
   */
  takeInterruptedTurnBoundaries(): SessionTurnBoundaryRecord[] {
    const drained = this.pendingInterruptedTurnBoundaries;
    this.pendingInterruptedTurnBoundaries = [];
    return drained;
  }

  /**
   * Closes one interrupted-turn boundary row this process already bannered.
   * The sanctioned closing transition for `accepted`/`indeterminate` is
   * removal — the same one a live claim's `terminalObserved()` applies to
   * `invoking`/`accepted` when a turn's outcome is settled; extended here to
   * `indeterminate` (the crash-reconcile flip's own resting state) because
   * no LIVE claim exists to apply it — the owning process is dead. Call only
   * AFTER the banner is durably recorded: this is what makes a second boot
   * a no-op (the row is gone, so `reconcile()` never reports it again) and
   * what un-blocks a fresh turn on the thread (an unresolved `indeterminate`
   * row is one of the states the boundary's own unique index treats as
   * "thread occupied").
   */
  resolveInterruptedTurnBoundary(record: {
    boundaryId: string;
    ownerId: string;
    state: 'accepted' | 'indeterminate';
  }): void {
    this.db
      .prepare(
        `DELETE FROM orchestration_turn_boundaries
          WHERE boundary_id = ? AND owner_id = ? AND state = ?`,
      )
      .run(record.boundaryId, record.ownerId, record.state);
  }

  /**
   * archive#4080 (review round 1, H1): existence check for
   * `appendEvent`'s deterministic-id dedupe pattern. A caller that derives
   * an event's `eventId` from a stable upstream identity (here, a turn
   * boundary's `boundaryId`) can crash between writing that event and
   * whatever it does next — the boot-time interrupted-turn consumer's own
   * next step is deleting the boundary row — and must not re-publish the
   * same event on retry. `orchestration_events.id` is the table's PRIMARY
   * KEY, so this is a plain existence probe, not a derived judgement.
   */
  hasEventId(eventId: string): boolean {
    return Boolean(
      this.db
        .prepare('SELECT 1 FROM orchestration_events WHERE id = ? LIMIT 1')
        .get(eventId),
    );
  }

  /**
   * Join a boundary with terminal facts already durably appended before a
   * crash or transient boundary-delete fault. Boundary creation time prevents
   * an older provider turn-id reuse from settling a newer invocation.
   */
  private reconcileSessionTurnTerminalsFromEvents(threadId?: string): void {
    this.db
      .prepare(
        `DELETE FROM orchestration_turn_boundaries
          WHERE state != 'lifecycle'
            AND (? IS NULL OR thread_id = ?)
            AND EXISTS (
              SELECT 1 FROM orchestration_events AS event
               WHERE event.thread_id = orchestration_turn_boundaries.thread_id
                 AND event.created_at >= orchestration_turn_boundaries.created_at
                 AND (
                   event.method = 'session.exited'
                   OR (event.method = 'runtime.error' AND event.turn_id IS NULL)
                   OR (
                     orchestration_turn_boundaries.state = 'accepted'
                     AND event.turn_id = orchestration_turn_boundaries.provider_turn_id
                     AND event.method IN ('turn.completed', 'turn.aborted', 'runtime.error')
                   )
                 )
            )`,
      )
      .run(threadId ?? null, threadId ?? null);
  }

  /** Deliberate composition seam; SQLite coordination stays private. */
  createRecoveryLedger(
    options: {
      credentialStartup?: {
        inspect(input: {
          provider: string;
          application: CredentialApplicationHandle;
          action: 'commit' | 'rollback';
        }): Promise<
          import('./recovery-ledger.js').RecoveryCredentialReceiptOutcome
        >;
        settle(input: {
          provider: string;
          application: CredentialApplicationHandle;
          action: 'commit' | 'rollback';
        }): Promise<
          import('./recovery-ledger.js').RecoveryCredentialReceiptOutcome
        >;
        acknowledge(input: {
          provider: string;
          application: CredentialApplicationHandle;
        }): Promise<import('./recovery-ledger.js').RecoveryTransition>;
      };
    } = {},
  ): RecoveryLedger {
    const coordinator: Parameters<
      typeof createRecoveryLedger
    >[0]['coordinator'] = {
      arm: (input) => this.armRecoveryIntent(input),
      find: (fingerprint) => this.findRecoveryIntent(fingerprint),
      latestProjection: (threadId) => this.readRecoveryProjection(threadId),
      pending: () => this.readPendingRecoveryIntents(),
      compensationSnapshot: () => this.readRecoveryCompensationSnapshot(),
      claim: (input) => this.claimRecoveryDispatch(input),
      release: (input) => this.releaseRecoveryDispatch(input),
      accept: (input) => this.acceptRecoveryDispatch(input),
      observe: (correlationId, turnId, now) =>
        this.observeRecoveryDispatchCorrelation(correlationId, turnId, now),
      indeterminate: (fingerprint, attemptId, now) =>
        this.markRecoveryDispatchIndeterminate(fingerprint, attemptId, now),
      linkCredential: (input) => this.linkRecoveryCredentialAttempt(input),
      reconcilePrepared: (kind, unlinkedOnly) =>
        this.preparedRecoveryDispatches(kind, unlinkedOnly),
      indeterminatePrepared: (input) =>
        this.indeterminatePreparedRecoveryDispatch(input),
      terminal: (fingerprint, outcome, now) =>
        this.recordRecoveryTerminal(fingerprint, outcome, now),
      compensationRequired: (fingerprint, now, expectedOutcome) =>
        this.markRecoveryCompensation(fingerprint, now, expectedOutcome),
      resolveCompensation: (fingerprint, now) =>
        this.resolveRecoveryCompensationRecord(fingerprint, now),
      cancel: (fingerprint, now) => this.cancelRecovery(fingerprint, now),
      cancelSourceTerminated: (now) =>
        this.cancelSourceTerminatedRecoveries(now),
      cancelShutdownRequested: (now) => this.cancelShutdownRecoveries(now),
    };
    const startup = options.credentialStartup;
    return createRecoveryLedger({
      coordinator,
      owner: this.recoveryLedgerOwner,
      processIdentity: this.recoveryProcessIdentity,
      credentialStartup: {
        inspect: (input) => {
          const application = this.openCredentialApplication(
            input.recoveryFingerprint,
          );
          return application && startup
            ? startup.inspect({
                provider: input.provider,
                application,
                action: input.action,
              })
            : Promise.resolve({ kind: 'indeterminate' as const });
        },
        settle: (input) => {
          const application = this.openCredentialApplication(
            input.recoveryFingerprint,
          );
          return application && startup
            ? startup.settle({
                provider: input.provider,
                application,
                action: input.action,
              })
            : Promise.resolve({ kind: 'indeterminate' as const });
        },
        acknowledge: (input) => {
          const application = this.openCredentialApplication(
            input.recoveryFingerprint,
          );
          return application && startup
            ? startup.acknowledge({
                provider: input.provider,
                application,
              })
            : Promise.resolve({ kind: 'unavailable' as const });
        },
      },
    });
  }

  /** Private SQLite composition for exact credential application obligations. */
  /** Composition-only protocol for ConnectionService; no storage operations project. */
  createCredentialApplicationFactory() {
    return createCredentialApplicationFactory({
      reserve: (input) => {
        this.db.exec('BEGIN IMMEDIATE');
        let row:
          | {
              connection_id: string;
              candidate_profile_ref: string;
              previous_profile_ref: string | null;
              state: 'reserved';
            }
          | undefined;
        try {
          const capacity = this.db
            .prepare(
              `SELECT COUNT(*) AS count FROM credential_profile_applications
               WHERE acknowledged_at IS NULL`,
            )
            .get() as { count: number | bigint };
          if (
            Number(capacity.count) >= MAX_UNACKNOWLEDGED_CREDENTIAL_APPLICATIONS
          ) {
            this.db.exec('COMMIT');
            return null;
          }
          row = this.db
            .prepare(
              `INSERT INTO credential_profile_applications
           (attempt_id, recovery_fingerprint, connection_id, candidate_profile_ref, previous_profile_ref, state, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, 'reserved', ?, ?)
           ON CONFLICT(recovery_fingerprint) DO NOTHING
           RETURNING connection_id, candidate_profile_ref, previous_profile_ref, state`,
            )
            .get(
              input.attemptId,
              input.fingerprint,
              input.connectionId,
              input.candidateProfileRef,
              input.previousProfileRef ?? null,
              input.now,
              input.now,
            ) as typeof row;
          this.db.exec('COMMIT');
        } catch (error) {
          this.db.exec('ROLLBACK');
          if (String(error).includes('UNIQUE constraint failed')) return null;
          throw error;
        }
        return row
          ? {
              connectionId: row.connection_id,
              candidateProfileRef: row.candidate_profile_ref,
              ...(row.previous_profile_ref
                ? { previousProfileRef: row.previous_profile_ref }
                : {}),
              state: row.state,
            }
          : null;
      },
      transition: (input) =>
        credentialApplicationTransition(
          this.db
            .prepare(
              `UPDATE credential_profile_applications SET state = ?, updated_at = ?
         WHERE attempt_id = ? AND state IN (${input.from.map(() => '?').join(',')})`,
            )
            .run(input.to, input.now, input.attemptId, ...input.from) as {
            changes: number | bigint;
          },
        ),
      acknowledge: (input) => {
        const result = credentialApplicationTransition(
          this.db
            .prepare(
              `UPDATE credential_profile_applications SET acknowledged_at = ?
         WHERE attempt_id = ? AND acknowledged_at IS NULL
           AND state IN ('adopted', 'rolled-back', 'superseded')`,
            )
            .run(input.now, input.attemptId) as { changes: number | bigint },
        );
        if (result.kind === 'applied') return result;
        const acknowledged = this.db
          .prepare(
            `SELECT 1 FROM credential_profile_applications
               WHERE attempt_id = ? AND acknowledged_at IS NOT NULL
                 AND state IN ('adopted', 'rolled-back', 'superseded')`,
          )
          .get(input.attemptId);
        return acknowledged ? { kind: 'applied' } : result;
      },
      latest: (connectionId) => {
        const row = this.db
          .prepare(
            `SELECT connection_id, candidate_profile_ref, previous_profile_ref, state
             FROM credential_profile_applications
             WHERE connection_id = ? AND acknowledged_at IS NULL
             ORDER BY updated_at DESC, attempt_id DESC LIMIT 1`,
          )
          .get(connectionId) as
          | {
              connection_id: string;
              candidate_profile_ref: string;
              previous_profile_ref: string | null;
              state:
                | 'reserved'
                | 'staged'
                | 'commit-pending'
                | 'adopted'
                | 'rolled-back'
                | 'superseded'
                | 'indeterminate';
            }
          | undefined;
        return row
          ? {
              connectionId: row.connection_id,
              candidateProfileRef: row.candidate_profile_ref,
              ...(row.previous_profile_ref
                ? { previousProfileRef: row.previous_profile_ref }
                : {}),
              state: row.state,
            }
          : null;
      },
      acquireMutation: (connectionId) => {
        const ownerToken = randomUUID();
        const owner = this.recoveryLedgerOwner;
        this.db.exec('BEGIN IMMEDIATE');
        try {
          const existing = this.db
            .prepare(
              `SELECT owner_token, owner_pid, owner_birth, owner_identity_kind
               FROM credential_profile_connection_locks WHERE connection_id = ?`,
            )
            .get(connectionId) as
            | {
                owner_token: string;
                owner_pid: number;
                owner_birth: string | null;
                owner_identity_kind: string;
              }
            | undefined;
          if (existing) {
            const observed = this.recoveryProcessIdentity.probe(
              existing.owner_pid,
            );
            const dead =
              existing.owner_identity_kind === 'exact' &&
              (observed.state === 'dead' ||
                (observed.state === 'exact' &&
                  observed.identity.start !== existing.owner_birth));
            // Unknown/unverifiable ownership fails closed. A known live owner
            // is never time-stolen; PID reuse proves the old owner is gone.
            if (!dead) {
              this.db.exec('COMMIT');
              return null;
            }
            this.db
              .prepare(
                `DELETE FROM credential_profile_connection_locks
                 WHERE connection_id = ? AND owner_token = ?`,
              )
              .run(connectionId, existing.owner_token);
          }
          const inserted = this.db
            .prepare(
              `INSERT OR IGNORE INTO credential_profile_connection_locks
               (connection_id, owner_token, owner_pid, owner_birth, owner_identity_kind)
               VALUES (?, ?, ?, ?, ?)`,
            )
            .run(
              connectionId,
              ownerToken,
              owner.pid,
              'birth' in owner ? owner.birth : null,
              owner.identityKind,
            ) as {
            changes: number | bigint;
          };
          this.db.exec('COMMIT');
          if (Number(inserted.changes) !== 1) return null;
        } catch (error) {
          this.db.exec('ROLLBACK');
          throw error;
        }
        return {
          stillOwner: () =>
            Boolean(
              this.db
                .prepare(
                  `SELECT 1 FROM credential_profile_connection_locks
                   WHERE connection_id = ? AND owner_token = ?`,
                )
                .get(connectionId, ownerToken),
            ),
          release: () => {
            this.db
              .prepare(
                `DELETE FROM credential_profile_connection_locks
               WHERE connection_id = ? AND owner_token = ?`,
              )
              .run(connectionId, ownerToken);
          },
        };
      },
    });
  }

  /**
   * Startup-only join from a recovery row's private key to its state-bound
   * credential behavior. This is deliberately not part of the factory
   * Interface: no caller can reopen an application from a fingerprint.
   */
  private openCredentialApplication(
    recoveryFingerprint: string,
  ): CredentialApplicationHandle | undefined {
    const row = this.db
      .prepare(
        `SELECT attempt_id, connection_id, candidate_profile_ref, previous_profile_ref, state
         FROM credential_profile_applications WHERE recovery_fingerprint = ?`,
      )
      .get(recoveryFingerprint) as
      | {
          attempt_id: string;
          connection_id: string;
          candidate_profile_ref: string;
          previous_profile_ref: string | null;
          state:
            | 'reserved'
            | 'staged'
            | 'commit-pending'
            | 'adopted'
            | 'rolled-back'
            | 'superseded'
            | 'indeterminate';
        }
      | undefined;
    if (!row) return undefined;
    const attemptId = row.attempt_id;
    const application = Object.freeze({
      connectionId: row.connection_id,
      candidateProfileRef: row.candidate_profile_ref,
      ...(row.previous_profile_ref
        ? { previousProfileRef: row.previous_profile_ref }
        : {}),
      state: row.state,
    });
    let settled = row.state;
    const transition = (
      state:
        | 'staged'
        | 'commit-pending'
        | 'adopted'
        | 'rolled-back'
        | 'superseded'
        | 'indeterminate',
      from: readonly string[],
      now: string,
    ) => {
      if (settled === state) return { kind: 'applied' as const };
      const result = credentialApplicationTransition(
        this.db
          .prepare(
            `UPDATE credential_profile_applications SET state = ?, updated_at = ?
             WHERE attempt_id = ? AND state IN (${from.map(() => '?').join(',')})`,
          )
          .run(state, now, attemptId, ...from) as { changes: number | bigint },
      );
      if (result.kind === 'applied') settled = state;
      return result;
    };
    return Object.freeze({
      application,
      staged: (now: string) => transition('staged', ['reserved'], now),
      settle: (
        state:
          | 'commit-pending'
          | 'adopted'
          | 'rolled-back'
          | 'superseded'
          | 'indeterminate',
        now: string,
      ) =>
        transition(
          state,
          state === 'adopted'
            ? ['staged', 'commit-pending']
            : ['reserved', 'staged', 'indeterminate'],
          now,
        ),
      acknowledge: (now: string) =>
        credentialApplicationTransition(
          this.db
            .prepare(
              `UPDATE credential_profile_applications SET acknowledged_at = ?
               WHERE attempt_id = ? AND acknowledged_at IS NULL
                 AND state IN ('adopted', 'rolled-back', 'superseded')`,
            )
            .run(now, attemptId) as { changes: number | bigint },
        ),
    });
  }

  private reserveAdoptionRecord(reservation: AdoptionReservation): boolean {
    const result = this.db
      .prepare(
        `INSERT OR IGNORE INTO provider_session_adoptions
          (source_thread_id, target_thread_id, owner_id, owner_pid, owner_token, provider, source_session_id, source_kind, cwd, project_root, status, provider_resume_cursor, provider_cleanup_complete, flow_run_id, flow_run_resumed, flow_cleanup_complete, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        reservation.sourceThreadId,
        reservation.targetThreadId,
        reservation.ownerId,
        reservation.ownerPid,
        reservation.ownerToken,
        reservation.provider,
        reservation.sourceSessionId,
        reservation.sourceKind,
        reservation.cwd,
        reservation.projectRoot,
        reservation.status,
        reservation.providerResumeCursor === undefined
          ? null
          : JSON.stringify(reservation.providerResumeCursor),
        reservation.providerCleanupComplete ? 1 : 0,
        reservation.flowRunId ?? null,
        reservation.flowRunResumed === undefined
          ? null
          : reservation.flowRunResumed
            ? 1
            : 0,
        reservation.flowCleanupComplete ? 1 : 0,
        reservation.createdAt,
        reservation.updatedAt,
      ) as { changes: number };
    return result.changes === 1;
  }

  private replaceAdoptionOwner(input: {
    expected: {
      sourceThreadId: string;
      ownerId: string;
      ownerPid: number;
      ownerToken: string;
    };
    next: {
      sourceThreadId: string;
      ownerId: string;
      ownerPid: number;
      ownerToken: string;
    };
  }): AdoptionReservation | undefined {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = this.db
        .prepare(
          `UPDATE provider_session_adoptions
           SET owner_id = ?, owner_pid = ?, owner_token = ?, updated_at = ?
           WHERE source_thread_id = ? AND owner_id = ? AND owner_pid = ? AND owner_token = ?`,
        )
        .run(
          input.next.ownerId,
          input.next.ownerPid,
          input.next.ownerToken,
          new Date().toISOString(),
          input.expected.sourceThreadId,
          input.expected.ownerId,
          input.expected.ownerPid,
          input.expected.ownerToken,
        ) as { changes: number };
      if (result.changes !== 1) {
        this.db.exec('COMMIT');
        return undefined;
      }
      const claimed = this.readAdoptionReservationRecord(
        input.next.sourceThreadId,
        input.next.ownerId,
        input.next.ownerPid,
        input.next.ownerToken,
      );
      this.db.exec('COMMIT');
      return claimed;
    } catch (error) {
      this.rollbackAdoptionTransaction();
      throw error;
    }
  }

  private updateOwnedAdoption(input: {
    claim: {
      sourceThreadId: string;
      ownerId: string;
      ownerPid: number;
      ownerToken: string;
    };
    next: AdoptionReservation;
  }): AdoptionReservation | undefined {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = this.db
        .prepare(
          `UPDATE provider_session_adoptions
           SET status = ?, provider_resume_cursor = ?, provider_cleanup_complete = ?,
               flow_run_id = ?, flow_run_resumed = ?, flow_cleanup_complete = ?, updated_at = ?
           WHERE source_thread_id = ? AND owner_id = ? AND owner_pid = ? AND owner_token = ?`,
        )
        .run(
          input.next.status,
          input.next.providerResumeCursor === undefined
            ? null
            : JSON.stringify(input.next.providerResumeCursor),
          input.next.providerCleanupComplete ? 1 : 0,
          input.next.flowRunId ?? null,
          input.next.flowRunResumed === undefined
            ? null
            : input.next.flowRunResumed
              ? 1
              : 0,
          input.next.flowCleanupComplete ? 1 : 0,
          new Date().toISOString(),
          input.claim.sourceThreadId,
          input.claim.ownerId,
          input.claim.ownerPid,
          input.claim.ownerToken,
        ) as { changes: number };
      if (result.changes !== 1) {
        this.db.exec('COMMIT');
        return undefined;
      }
      const updated = this.readAdoptionReservationRecord(
        input.claim.sourceThreadId,
        input.claim.ownerId,
        input.claim.ownerPid,
        input.claim.ownerToken,
      );
      this.db.exec('COMMIT');
      return updated;
    } catch (error) {
      this.rollbackAdoptionTransaction();
      throw error;
    }
  }

  private rollbackAdoptionTransaction(): void {
    try {
      this.db.exec('ROLLBACK');
    } catch {
      // Preserve the durable/read failure that triggered cleanup.
    }
  }

  private readAdoptionReservationRecords(): AdoptionReservation[] {
    return this.db
      .prepare(
        `SELECT source_thread_id, target_thread_id, owner_id, owner_pid, owner_token, provider, source_session_id,
                source_kind, cwd, project_root, status, provider_resume_cursor,
                provider_cleanup_complete, flow_run_id, flow_run_resumed,
                flow_cleanup_complete, created_at, updated_at
         FROM provider_session_adoptions
         ORDER BY created_at ASC`,
      )
      .all()
      .map(mapAdoptionReservationRow);
  }

  private readAdoptionReservationRecord(
    sourceThreadId: string,
    ownerId: string,
    ownerPid: number,
    ownerToken: string,
  ): AdoptionReservation | undefined {
    const row = this.db
      .prepare(
        `SELECT source_thread_id, target_thread_id, owner_id, owner_pid, owner_token, provider, source_session_id,
                source_kind, cwd, project_root, status, provider_resume_cursor,
                provider_cleanup_complete, flow_run_id, flow_run_resumed,
                flow_cleanup_complete, created_at, updated_at
         FROM provider_session_adoptions
         WHERE source_thread_id = ? AND owner_id = ? AND owner_pid = ? AND owner_token = ?`,
      )
      .get(sourceThreadId, ownerId, ownerPid, ownerToken);
    return row ? mapAdoptionReservationRow(row as any) : undefined;
  }

  private adoptionReservesProviderCursor(
    provider: ProviderSession['provider'],
    providerResumeCursor: unknown,
  ): boolean {
    if (providerResumeCursor === undefined) return false;
    return Boolean(
      this.db
        .prepare(
          `SELECT 1 FROM provider_session_adoptions
           WHERE provider = ? AND provider_resume_cursor = ?
           LIMIT 1`,
        )
        .get(provider, JSON.stringify(providerResumeCursor)),
    );
  }

  private commitOwnedAdoption(input: {
    claim: {
      sourceThreadId: string;
      ownerId: string;
      ownerPid: number;
      ownerToken: string;
    };
    child: ProviderSession;
    receipt?: OrchestrationCommandReceipt;
  }): boolean {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (
        !this.readAdoptionReservationRecord(
          input.claim.sourceThreadId,
          input.claim.ownerId,
          input.claim.ownerPid,
          input.claim.ownerToken,
        )
      ) {
        this.db.exec('COMMIT');
        return false;
      }
      this.upsertSession(input.child);
      if (input.receipt) this.appendCommandReceipt(input.receipt);
      const deleted = this.db
        .prepare(
          `DELETE FROM provider_session_adoptions
           WHERE source_thread_id = ? AND owner_id = ? AND owner_pid = ? AND owner_token = ?`,
        )
        .run(
          input.claim.sourceThreadId,
          input.claim.ownerId,
          input.claim.ownerPid,
          input.claim.ownerToken,
        ) as {
        changes: number;
      };
      if (deleted.changes !== 1) {
        throw new Error('Adoption ownership changed inside its transaction.');
      }
      this.db.exec('COMMIT');
      return true;
    } catch (error) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        throw new AdoptionCommitFailure('unknown', error);
      }
      throw new AdoptionCommitFailure('rolled-back', error);
    }
  }

  private completeOwnedAdoptionCleanup(input: {
    claim: {
      sourceThreadId: string;
      ownerId: string;
      ownerPid: number;
      ownerToken: string;
    };
  }): boolean {
    const deleted = this.db
      .prepare(
        `DELETE FROM provider_session_adoptions
         WHERE source_thread_id = ? AND owner_id = ? AND owner_pid = ? AND owner_token = ?
           AND flow_cleanup_complete = 1 AND provider_cleanup_complete = 1`,
      )
      .run(
        input.claim.sourceThreadId,
        input.claim.ownerId,
        input.claim.ownerPid,
        input.claim.ownerToken,
      ) as {
      changes: number;
    };
    return deleted.changes === 1;
  }

  appendCommandReceipt(receipt: OrchestrationCommandReceipt): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO orchestration_command_receipts
          (command_id, thread_id, command_type, status, created_at, client_origin)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        receipt.commandId,
        receipt.threadId,
        receipt.commandType,
        receipt.status,
        receipt.createdAt,
        receipt.clientOrigin ? JSON.stringify(receipt.clientOrigin) : null,
      );
  }

  readCommandReceipt(commandId: string): OrchestrationCommandReceipt | null {
    const row = this.db
      .prepare(
        `SELECT command_id, thread_id, command_type, status, created_at, client_origin
         FROM orchestration_command_receipts
         WHERE command_id = ?`,
      )
      .get(commandId) as CommandReceiptRow | undefined;

    return row ? mapCommandReceiptRow(row) : null;
  }

  listCommandReceipts(threadId?: string): OrchestrationCommandReceipt[] {
    const rows = threadId
      ? this.db
          .prepare(
            `SELECT command_id, thread_id, command_type, status, created_at, client_origin
             FROM orchestration_command_receipts
             WHERE thread_id = ?
             ORDER BY created_at ASC, command_id ASC`,
          )
          .all(threadId)
      : this.db
          .prepare(
            `SELECT command_id, thread_id, command_type, status, created_at, client_origin
             FROM orchestration_command_receipts
             ORDER BY created_at ASC, command_id ASC`,
          )
          .all();

    return rows.map((row: any) => mapCommandReceiptRow(row));
  }

  private armRecoveryIntent(
    input: RecoveryIntentInput,
  ): ConnectionRecoveryIntent {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO orchestration_recovery_intents
          (fingerprint, thread_id, provider, source_event_id, source_turn_id,
           failure_kind, scope, decision, due_at, attempts, max_attempts,
           outcome, dispatch_attempt_id, recovery_correlation_id,
           dispatch_settlement, dispatch_kind, resumed_turn_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, NULL, NULL, NULL, NULL, NULL, ?, ?)`,
      )
      .run(
        input.fingerprint,
        input.threadId,
        input.provider,
        input.sourceEventId,
        input.sourceTurnId,
        input.failureKind,
        input.scope,
        input.decision,
        input.dueAt ?? null,
        input.maxAttempts,
        input.outcome,
        input.createdAt,
        input.updatedAt,
      );
    return this.findRecoveryIntent(input.fingerprint)!;
  }

  private findRecoveryIntent(
    fingerprint: string,
  ): ConnectionRecoveryIntent | null {
    const row = this.db
      .prepare(
        `SELECT fingerprint, thread_id, provider, source_event_id, source_turn_id,
                failure_kind, scope, decision, due_at, attempts, max_attempts,
                outcome, dispatch_attempt_id, recovery_correlation_id,
                dispatch_settlement, dispatch_kind, resumed_turn_id, created_at, updated_at
         FROM orchestration_recovery_intents WHERE fingerprint = ?`,
      )
      .get(fingerprint) as RecoveryIntentRow | undefined;
    return row ? mapRecoveryIntentRow(row) : null;
  }

  private readRecoveryProjection(
    threadId: string,
  ): ConnectionRecoveryProjection | undefined {
    const row = this.db
      .prepare(
        `SELECT fingerprint, thread_id, provider, source_event_id, source_turn_id,
                failure_kind, scope, decision, due_at, attempts, max_attempts,
                outcome, dispatch_attempt_id, recovery_correlation_id,
                dispatch_settlement, dispatch_kind, resumed_turn_id, created_at, updated_at
         FROM orchestration_recovery_intents
         WHERE thread_id = ? ORDER BY updated_at DESC, rowid DESC LIMIT 1`,
      )
      .get(threadId) as RecoveryIntentRow | undefined;
    if (!row) return undefined;
    const intent = mapRecoveryIntentRow(row);
    return {
      failureKind: intent.failureKind,
      scope: intent.scope,
      decision: intent.decision,
      outcome: intent.outcome,
      ...(intent.dueAt ? { dueAt: intent.dueAt } : {}),
      attempts: intent.attempts,
      maxAttempts: intent.maxAttempts,
      updatedAt: intent.updatedAt,
    };
  }

  private readPendingRecoveryIntents(): ConnectionRecoveryIntent[] {
    return this.db
      .prepare(
        `SELECT fingerprint, thread_id, provider, source_event_id, source_turn_id,
                failure_kind, scope, decision, due_at, attempts, max_attempts,
                outcome, dispatch_attempt_id, recovery_correlation_id,
                dispatch_settlement, dispatch_kind, resumed_turn_id, created_at, updated_at
         FROM orchestration_recovery_intents
         WHERE outcome IN ('armed', 'resumed') ORDER BY due_at ASC, created_at ASC`,
      )
      .all()
      .map((row: unknown) => mapRecoveryIntentRow(row as RecoveryIntentRow));
  }

  private readRecoveryCompensationSnapshot(): ConnectionRecoveryIntent[] {
    return this.db
      .prepare(
        `SELECT fingerprint, thread_id, provider, source_event_id, source_turn_id,
                failure_kind, scope, decision, due_at, attempts, max_attempts,
                outcome, dispatch_attempt_id, recovery_correlation_id,
                dispatch_settlement, dispatch_kind, resumed_turn_id, created_at, updated_at
         FROM orchestration_recovery_intents
         WHERE outcome = 'compensation-required'
         ORDER BY updated_at ASC, created_at ASC`,
      )
      .all()
      .map((row: unknown) => mapRecoveryIntentRow(row as RecoveryIntentRow));
  }

  private claimRecoveryDispatch(input: {
    fingerprint: string;
    kind: 'due' | 'profile';
    dispatchAttemptId: string;
    recoveryCorrelationId: string;
    owner: RecoveryOwner;
    now: string;
  }): ConnectionRecoveryIntent | null {
    const eligibility =
      input.kind === 'due'
        ? "outcome = 'armed' AND due_at IS NOT NULL AND due_at <= ?"
        : "outcome IN ('armed', 'manual')";
    const row = this.db
      .prepare(
        `UPDATE orchestration_recovery_intents
         SET outcome = 'resumed', attempts = attempts + 1,
             dispatch_attempt_id = ?, recovery_correlation_id = ?,
             dispatch_settlement = 'prepared', dispatch_kind = ?,
             dispatch_owner_id = ?, dispatch_owner_pid = ?,
             dispatch_owner_birth = ?, dispatch_owner_identity_kind = ?, updated_at = ?
         WHERE fingerprint = ? AND ${eligibility} AND attempts < max_attempts
           AND dispatch_attempt_id IS NULL AND recovery_correlation_id IS NULL
         RETURNING fingerprint, thread_id, provider, source_event_id, source_turn_id,
                   failure_kind, scope, decision, due_at, attempts, max_attempts,
                   outcome, dispatch_attempt_id, recovery_correlation_id,
                   dispatch_settlement, dispatch_kind, resumed_turn_id, created_at, updated_at`,
      )
      .get(
        input.dispatchAttemptId,
        input.recoveryCorrelationId,
        input.kind,
        input.owner.id,
        input.owner.pid,
        input.owner.identityKind === 'exact' ? input.owner.birth : null,
        input.owner.identityKind,
        input.now,
        input.fingerprint,
        ...(input.kind === 'due' ? [input.now] : []),
      ) as RecoveryIntentRow | undefined;
    return row ? mapRecoveryIntentRow(row) : null;
  }

  private releaseRecoveryDispatch(input: {
    fingerprint: string;
    dispatchAttemptId: string;
    outcome: 'armed' | 'manual';
    now: string;
  }): RecoveryTransition {
    const result = this.db
      .prepare(
        `UPDATE orchestration_recovery_intents
         SET outcome = ?, attempts = MAX(attempts - 1, 0),
             dispatch_attempt_id = NULL, recovery_correlation_id = NULL,
             dispatch_settlement = NULL, dispatch_kind = NULL,
             dispatch_owner_id = NULL, dispatch_owner_pid = NULL,
             dispatch_owner_birth = NULL, dispatch_owner_identity_kind = NULL,
             credential_attempt_id = NULL, updated_at = ?
         WHERE fingerprint = ? AND outcome = 'resumed' AND dispatch_attempt_id = ?
           AND dispatch_settlement = 'prepared'`,
      )
      .run(
        input.outcome,
        input.now,
        input.fingerprint,
        input.dispatchAttemptId,
      ) as {
      changes: number | bigint;
    };
    return recoveryTransition(result);
  }

  private acceptRecoveryDispatch(input: {
    fingerprint: string;
    dispatchAttemptId: string;
    turnId: string;
    now: string;
  }): RecoveryTransition {
    const result = this.db
      .prepare(
        `UPDATE orchestration_recovery_intents
         SET resumed_turn_id = COALESCE(resumed_turn_id, ?),
             dispatch_settlement = 'accepted', updated_at = ?
         WHERE fingerprint = ? AND outcome = 'resumed' AND dispatch_attempt_id = ?
           AND dispatch_settlement = 'prepared'`,
      )
      .run(
        input.turnId,
        input.now,
        input.fingerprint,
        input.dispatchAttemptId,
      ) as {
      changes: number | bigint;
    };
    return recoveryTransition(result);
  }

  private observeRecoveryDispatchCorrelation(
    recoveryCorrelationId: string,
    turnId: string,
    now: string,
  ): ConnectionRecoveryIntent | null {
    const row = this.db
      .prepare(
        `UPDATE orchestration_recovery_intents
         SET resumed_turn_id = COALESCE(resumed_turn_id, ?), updated_at = ?
         WHERE recovery_correlation_id = ? AND outcome = 'resumed'
         RETURNING fingerprint, thread_id, provider, source_event_id, source_turn_id,
                   failure_kind, scope, decision, due_at, attempts, max_attempts,
                   outcome, dispatch_attempt_id, recovery_correlation_id,
                   dispatch_settlement, dispatch_kind, resumed_turn_id, created_at, updated_at`,
      )
      .get(turnId, now, recoveryCorrelationId) as RecoveryIntentRow | undefined;
    return row ? mapRecoveryIntentRow(row) : null;
  }

  private markRecoveryDispatchIndeterminate(
    fingerprint: string,
    dispatchAttemptId: string,
    now: string,
  ): RecoveryTransition {
    const result = this.db
      .prepare(
        `UPDATE orchestration_recovery_intents
         SET outcome = 'indeterminate', updated_at = ?
         WHERE fingerprint = ? AND outcome = 'resumed' AND dispatch_attempt_id = ?
           AND dispatch_settlement = 'prepared'`,
      )
      .run(now, fingerprint, dispatchAttemptId) as { changes: number | bigint };
    return recoveryTransition(result);
  }

  private linkRecoveryCredentialAttempt(input: {
    fingerprint: string;
    dispatchAttemptId: string;
    credentialAttemptId: string;
    now: string;
  }): RecoveryTransition {
    const result = this.db
      .prepare(
        `UPDATE orchestration_recovery_intents
         SET credential_attempt_id = ?, updated_at = ?
         WHERE fingerprint = ? AND outcome = 'resumed'
           AND dispatch_settlement = 'prepared' AND dispatch_kind = 'profile'
           AND dispatch_attempt_id = ?
           AND (credential_attempt_id IS NULL OR credential_attempt_id = ?)`,
      )
      .run(
        input.credentialAttemptId,
        input.now,
        input.fingerprint,
        input.dispatchAttemptId,
        input.credentialAttemptId,
      ) as { changes: number | bigint };
    return recoveryTransition(result);
  }

  private preparedRecoveryDispatches(
    kind?: 'due' | 'profile',
    unlinkedOnly = false,
  ): Array<{
    intent: ConnectionRecoveryIntent;
    ownerId: string | null;
    ownerPid: number | null;
    ownerBirth: string | null;
    ownerIdentityKind: string | null;
    credentialAttemptId: string | null;
  }> {
    return this.db
      .prepare(
        `SELECT fingerprint, thread_id, provider, source_event_id, source_turn_id,
                failure_kind, scope, decision, due_at, attempts, max_attempts,
                outcome, dispatch_attempt_id, recovery_correlation_id,
                dispatch_settlement, dispatch_kind, resumed_turn_id, created_at, updated_at,
                dispatch_owner_id, dispatch_owner_pid, dispatch_owner_birth,
                dispatch_owner_identity_kind, credential_attempt_id
         FROM orchestration_recovery_intents
         WHERE ((
             outcome = 'resumed' AND dispatch_settlement IN ('prepared', 'accepted')
           ) OR (
             outcome = 'succeeded' AND credential_attempt_id IS NOT NULL
           ) OR (
             outcome = 'indeterminate' AND credential_attempt_id IS NOT NULL
           ) OR (
             ? = 1 AND outcome = 'indeterminate'
             AND credential_attempt_id IS NULL
           ))
           AND (? IS NULL OR dispatch_kind = ?)
           AND (? = 0 OR credential_attempt_id IS NULL)
           AND (
             (dispatch_attempt_id IS NOT NULL AND recovery_correlation_id IS NOT NULL)
             OR (? = 1 AND outcome = 'indeterminate' AND credential_attempt_id IS NULL)
           )
         ORDER BY updated_at ASC, created_at ASC`,
      )
      .all(
        unlinkedOnly ? 1 : 0,
        kind ?? null,
        kind ?? null,
        unlinkedOnly ? 1 : 0,
        unlinkedOnly ? 1 : 0,
      )
      .map((row: unknown) => {
        const prepared = row as RecoveryIntentRow & {
          dispatch_owner_id: string | null;
          dispatch_owner_pid: number | null;
          dispatch_owner_birth: string | null;
          dispatch_owner_identity_kind: string | null;
          credential_attempt_id: string | null;
        };
        return {
          intent: mapRecoveryIntentRow(prepared),
          ownerId: prepared.dispatch_owner_id,
          ownerPid: prepared.dispatch_owner_pid,
          ownerBirth: prepared.dispatch_owner_birth,
          ownerIdentityKind: prepared.dispatch_owner_identity_kind,
          credentialAttemptId: prepared.credential_attempt_id,
        };
      });
  }

  private indeterminatePreparedRecoveryDispatch(input: {
    fingerprint: string;
    dispatchAttemptId: string;
    recoveryCorrelationId: string;
    ownerId: string | null;
    ownerPid: number | null;
    now: string;
  }): ConnectionRecoveryIntent | null {
    const row = this.db
      .prepare(
        `UPDATE orchestration_recovery_intents
         SET outcome = 'indeterminate', updated_at = ?
         WHERE fingerprint = ? AND outcome = 'resumed'
           AND dispatch_settlement = 'prepared'
           AND dispatch_attempt_id = ? AND recovery_correlation_id = ?
           AND dispatch_owner_id IS ? AND dispatch_owner_pid IS ?
         RETURNING fingerprint, thread_id, provider, source_event_id, source_turn_id,
                   failure_kind, scope, decision, due_at, attempts, max_attempts,
                   outcome, dispatch_attempt_id, recovery_correlation_id,
                   dispatch_settlement, dispatch_kind, resumed_turn_id, created_at, updated_at`,
      )
      .get(
        input.now,
        input.fingerprint,
        input.dispatchAttemptId,
        input.recoveryCorrelationId,
        input.ownerId,
        input.ownerPid,
      ) as RecoveryIntentRow | undefined;
    return row ? mapRecoveryIntentRow(row) : null;
  }

  private recordRecoveryTerminal(
    fingerprint: string,
    outcome: Extract<
      ConnectionRecoveryOutcome,
      'succeeded' | 'failed' | 'canceled'
    >,
    now: string,
  ): RecoveryTransition {
    try {
      const result = this.db
        .prepare(
          `UPDATE orchestration_recovery_intents SET outcome = ?, updated_at = ?
         WHERE fingerprint = ? AND outcome IN ('resumed', 'indeterminate')
           AND (? != 'succeeded' OR (outcome = 'resumed' AND dispatch_settlement = 'accepted'))`,
        )
        .run(outcome, now, fingerprint, outcome) as {
        changes: number | bigint;
      };
      this.recoveryTransitionFault?.();
      return recoveryTransition(result);
    } catch (error) {
      // A durable UPDATE can succeed before the caller observes a driver or
      // post-write fault. Re-read only this exact desired terminal fact.
      const row = this.db
        .prepare(
          'SELECT outcome FROM orchestration_recovery_intents WHERE fingerprint = ?',
        )
        .get(fingerprint) as { outcome?: string } | undefined;
      if (row?.outcome === outcome) return { kind: 'applied' };
      throw error;
    }
  }

  private markRecoveryCompensation(
    fingerprint: string,
    now: string,
    expectedOutcome: 'resumed' | 'canceled' | 'indeterminate' = 'resumed',
  ): RecoveryTransition {
    const result = this.db
      .prepare(
        `UPDATE orchestration_recovery_intents
         SET outcome = 'compensation-required', updated_at = ?
         WHERE fingerprint = ? AND outcome = ?`,
      )
      .run(now, fingerprint, expectedOutcome) as { changes: number | bigint };
    return recoveryTransition(result);
  }

  private resolveRecoveryCompensationRecord(
    fingerprint: string,
    now: string,
  ): RecoveryTransition {
    const result = this.db
      .prepare(
        `UPDATE orchestration_recovery_intents
         SET outcome = 'failed', updated_at = ?
         WHERE fingerprint = ? AND outcome = 'compensation-required'`,
      )
      .run(now, fingerprint) as { changes: number | bigint };
    return recoveryTransition(result);
  }

  private cancelRecovery(fingerprint: string, now: string): RecoveryTransition {
    const result = this.db
      .prepare(
        `UPDATE orchestration_recovery_intents SET outcome = 'canceled', updated_at = ?
         WHERE fingerprint = ? AND outcome IN ('armed', 'resumed', 'manual')`,
      )
      .run(now, fingerprint) as { changes: number | bigint };
    return recoveryTransition(result);
  }

  /**
   * A persisted source terminal is stronger than a lost in-process cancel
   * result. On restart, cancel only the exact still-pending intent whose
   * source turn has a durable terminal event; no timer or provider retry can
   * then revive it.
   */
  private cancelSourceTerminatedRecoveries(now: string): RecoveryTransition {
    const result = this.db
      .prepare(
        `UPDATE orchestration_recovery_intents AS intent
         SET outcome = 'canceled', updated_at = ?
         WHERE intent.outcome IN ('armed', 'resumed', 'manual')
           AND (
             intent.shutdown_cancel_requested_at IS NOT NULL
             OR EXISTS (
               SELECT 1 FROM orchestration_events AS event
               WHERE event.thread_id = intent.thread_id
                 AND event.turn_id = intent.source_turn_id
                 AND event.method IN ('turn.aborted', 'turn.failed')
             )
           )`,
      )
      .run(now) as { changes: number | bigint };
    return recoveryTransition(result);
  }

  /** A bounded shutdown may lose its per-intent CAS result. Persist the
   * cancel request itself so startup fences it before any timer is rebuilt. */
  private cancelShutdownRecoveries(now: string): RecoveryTransition {
    const result = this.db
      .prepare(
        `UPDATE orchestration_recovery_intents
         SET shutdown_cancel_requested_at = ?, updated_at = ?
         WHERE outcome IN ('armed', 'resumed', 'manual')`,
      )
      .run(now, now) as { changes: number | bigint };
    return recoveryTransition(result);
  }

  /** Remove a deliberately ephemeral diagnostic session and all of its receipts. */
  deleteThread(threadId: string): void {
    // Captured before the deletes, resolved after the commit: deleting a file
    // is not transactional, so unlinking before COMMIT would destroy bytes a
    // rollback then restores reachability to. Dying between the two leaves
    // unreferenced bytes that retention reclaims — the recoverable direction.
    const boundRefs = (
      this.db
        .prepare(
          'SELECT blob_ref FROM orchestration_attachment_refs WHERE thread_id = ?',
        )
        .all(threadId) as Array<{ blob_ref: string }>
    ).map((row) => row.blob_ref);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      // Every retired or active search projection retains bodies independently
      // of canonical events, so none may outlive a deliberately deleted thread.
      this.db
        .prepare('DELETE FROM orchestration_message_search WHERE thread_id = ?')
        .run(threadId);
      this.db
        .prepare(
          'DELETE FROM orchestration_message_search_v2 WHERE thread_id = ?',
        )
        .run(threadId);
      this.db
        .prepare(
          'DELETE FROM orchestration_message_search_v3 WHERE thread_id = ?',
        )
        .run(threadId);
      this.db
        .prepare(
          `DELETE FROM orchestration_message_search_projection
          WHERE event_id IN (
             SELECT id FROM orchestration_events WHERE thread_id = ?
           )`,
        )
        .run(threadId);
      this.db
        .prepare(
          `DELETE FROM orchestration_message_search_projection_v3
           WHERE event_id IN (
             SELECT id FROM orchestration_events WHERE thread_id = ?
           )`,
        )
        .run(threadId);
      this.db
        .prepare(
          'DELETE FROM orchestration_command_receipts WHERE thread_id = ?',
        )
        .run(threadId);
      this.db
        .prepare('DELETE FROM orchestration_request_state WHERE thread_id = ?')
        .run(threadId);
      this.db
        .prepare(
          'DELETE FROM orchestration_session_projection_facts WHERE thread_id = ?',
        )
        .run(threadId);
      this.db
        .prepare(
          'DELETE FROM orchestration_console_delivery_progress WHERE thread_id = ?',
        )
        .run(threadId);
      this.db
        .prepare('DELETE FROM orchestration_events WHERE thread_id = ?')
        .run(threadId);
      this.db
        .prepare(
          'DELETE FROM orchestration_turn_provenance WHERE thread_id = ?',
        )
        .run(threadId);
      this.db
        .prepare(
          'DELETE FROM orchestration_recovery_intents WHERE thread_id = ?',
        )
        .run(threadId);
      this.db
        .prepare('DELETE FROM provider_session_state WHERE thread_id = ?')
        .run(threadId);
      this.db
        .prepare(
          'DELETE FROM orchestration_conversation_history WHERE thread_id = ?',
        )
        .run(threadId);
      this.db
        .prepare(
          'DELETE FROM orchestration_conversation_history_quarantine WHERE thread_id = ?',
        )
        .run(threadId);
      this.db
        .prepare(
          'DELETE FROM orchestration_attachment_quota WHERE thread_id = ?',
        )
        .run(threadId);
      // A deleted thread must stop authorizing its blobs, or the route keeps
      // answering for a conversation that no longer exists.
      this.db
        .prepare(
          'DELETE FROM orchestration_attachment_refs WHERE thread_id = ?',
        )
        .run(threadId);
      {
        // archive#1224 HIGH fix (independent review): an unescaped `LIKE`
        // prefix would let `%`/`_` inside threadId behave as SQL wildcards,
        // over-matching another thread's keys. `substr(...) = ?` is an exact
        // string comparison -- no wildcard semantics at all -- against the
        // exact prefix `turnDedupThreadPrefix` produces.
        const prefix = turnDedupThreadPrefix(threadId);
        this.db
          .prepare(
            'DELETE FROM orchestration_turn_dedup WHERE substr(dedup_key, 1, ?) = ?',
          )
          .run(prefix.length, prefix);
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    // Deleting a conversation must delete the pasted screenshot, not merely
    // make it unreachable. Content addressing means the bytes may still belong
    // to another thread, so only a blob with no bindings left is reclaimed —
    // and because reads and re-attachments re-date a blob, one shared with any
    // live thread would otherwise never age out at all.
    for (const ref of boundRefs) {
      const stillBound = this.db
        .prepare(
          'SELECT 1 FROM orchestration_attachment_refs WHERE blob_ref = ? LIMIT 1',
        )
        .get(ref);
      if (!stillBound) this.attachmentBlobs.removeByRef(ref);
    }
  }

  /**
   * archive#1224 (offline): claims `clientTurnId` for `threadId` so
   * the caller can safely call `adapter.sendTurn` — the crux of server-side
   * turn idempotency. Thin delegate onto the shared `TurnIdempotencyStore`
   * (`../turn-idempotency.ts`) — see that file for the full claim/resolve/
   * release contract this and its `/chat`-side counterpart
   * (`routes/chat/chat-turn-dedup.ts`) both implement identically. Scoped
   * per-thread by folding `threadId` into the shared store's flat key, so
   * the same `clientTurnId` on two different threads never collides.
   */
  /** Deliberate composition seam; EventStore keeps SQLite ownership private. */
  createTurnDeduplicator(): TurnDeduplicator {
    return createTurnDeduplicator({
      store: this.turnIdempotence,
      keyFor: turnDedupKey,
    });
  }

  claimChatTurn(clientTurnId: string): {
    claimed: boolean;
    conversationId?: string;
  } {
    const claim = this.turnIdempotence.claim(chatTurnDedupKey(clientTurnId));
    return claim.claimed
      ? { claimed: true }
      : { claimed: false, conversationId: claim.value };
  }
  resolveChatTurn(clientTurnId: string, conversationId: string): void {
    this.turnIdempotence.resolve(
      chatTurnDedupKey(clientTurnId),
      conversationId,
    );
  }
  releaseChatTurn(clientTurnId: string): void {
    this.turnIdempotence.release(chatTurnDedupKey(clientTurnId));
  }
  readChatTurn(clientTurnId: string): string | undefined {
    return this.turnIdempotence.read(chatTurnDedupKey(clientTurnId));
  }
  awaitChatTurn(
    clientTurnId: string,
    timeoutMs?: number,
    intervalMs?: number,
  ): Promise<string | undefined> {
    return awaitTurnResolution(
      this.turnIdempotence,
      chatTurnDedupKey(clientTurnId),
      timeoutMs,
      intervalMs,
    );
  }

  private ensureConversationHistoryUpgrade(): void {
    const selectBatch = this.db.prepare(
      `SELECT thread_id, tenant_execution_context, created_at, updated_at
       FROM provider_session_state
       WHERE thread_id NOT IN (
         SELECT thread_id FROM orchestration_conversation_history
       )
       ORDER BY created_at ASC, thread_id ASC
       LIMIT ?`,
    );
    while (true) {
      const sessions = selectBatch.all(100) as Array<{
        thread_id: string;
        tenant_execution_context: string | null;
        created_at: string;
        updated_at: string;
      }>;
      if (sessions.length === 0) break;
      this.db.exec('BEGIN IMMEDIATE');
      try {
        for (const session of sessions) {
          const ownerEvent = this.db
            .prepare(
              `SELECT payload FROM orchestration_events
               WHERE thread_id = ?
                 AND method IN ('session.started', 'session.configured')
                 AND json_valid(payload)
                 AND typeof(json_extract(payload, '$.metadata.userId')) = 'text'
               ORDER BY sequence DESC
               LIMIT 1`,
            )
            .get(session.thread_id) as { payload: string } | undefined;
          const agentEvent = this.db
            .prepare(
              `SELECT payload FROM orchestration_events
               WHERE thread_id = ?
                 AND method IN ('session.started', 'session.configured')
                 AND json_valid(payload)
                 AND typeof(json_extract(payload, '$.metadata.agentSlug')) = 'text'
               ORDER BY sequence DESC
               LIMIT 1`,
            )
            .get(session.thread_id) as { payload: string } | undefined;
          const projectEvent = this.db
            .prepare(
              `SELECT payload FROM orchestration_events
               WHERE thread_id = ?
                 AND method IN ('session.started', 'session.configured')
                 AND json_valid(payload)
                 AND typeof(json_extract(payload, '$.metadata.projectSlug')) = 'text'
               ORDER BY sequence DESC
               LIMIT 1`,
            )
            .get(session.thread_id) as { payload: string } | undefined;
          const titleEvent = this.db
            .prepare(
              `SELECT payload FROM orchestration_events
               WHERE thread_id = ? AND method = 'turn.started'
               ORDER BY sequence ASC
               LIMIT 1`,
            )
            .get(session.thread_id) as { payload: string } | undefined;
          const messageCount = (
            this.db
              .prepare(
                `SELECT COUNT(*) AS count FROM orchestration_events
                 WHERE thread_id = ?
                   AND method IN ('turn.started', 'turn.completed')`,
              )
              .get(session.thread_id) as { count: number }
          ).count;
          let ownerUserId: string | undefined;
          let agentSlug: string | undefined;
          let projectSlug: string | undefined;
          const ownerMetadata = ownerEvent
            ? parseHistoryEvent(ownerEvent.payload)?.metadata
            : undefined;
          const agentMetadata = agentEvent
            ? parseHistoryEvent(agentEvent.payload)?.metadata
            : undefined;
          const projectMetadata = projectEvent
            ? parseHistoryEvent(projectEvent.payload)?.metadata
            : undefined;
          if (typeof ownerMetadata?.userId === 'string') {
            ownerUserId = ownerMetadata.userId;
          }
          if (typeof agentMetadata?.agentSlug === 'string') {
            agentSlug = agentMetadata.agentSlug;
          }
          if (typeof projectMetadata?.projectSlug === 'string') {
            projectSlug = projectMetadata.projectSlug;
          }
          const title = titleEvent
            ? parseHistoryEvent(titleEvent.payload)?.prompt
            : undefined;
          const tenant = parsePersistedTenantExecutionContext(
            session.tenant_execution_context,
          );
          this.db
            .prepare(
              `INSERT INTO orchestration_conversation_history
                (thread_id, owner_user_id, tenant_id, agent_slug, project_slug, title, message_count, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(
              session.thread_id,
              ownerUserId ?? null,
              tenant?.tenantId ?? null,
              agentSlug ?? null,
              projectSlug ?? null,
              typeof title === 'string' && title.trim()
                ? title.trim().slice(0, 80)
                : null,
              messageCount,
              session.created_at,
              session.updated_at,
            );
          this.refreshConversationHistoryQuarantine(session.thread_id);
        }
        this.db.exec('COMMIT');
      } catch (error) {
        this.db.exec('ROLLBACK');
        throw error;
      }
    }
    this.db
      .prepare(
        `INSERT INTO orchestration_conversation_history_upgrade (id, status, completed_at)
         VALUES (1, 'complete', ?)
         ON CONFLICT(id) DO UPDATE SET status = 'complete', completed_at = excluded.completed_at`,
      )
      .run(new Date().toISOString());
  }

  private projectConversationHistoryEvent(event: CanonicalRuntimeEvent): void {
    const existing = this.db
      .prepare(
        `SELECT owner_user_id, tenant_id, agent_slug, project_slug, title, message_count, created_at
         FROM orchestration_conversation_history WHERE thread_id = ?`,
      )
      .get(event.threadId) as
      | {
          owner_user_id: string | null;
          tenant_id: string | null;
          agent_slug: string | null;
          project_slug: string | null;
          title: string | null;
          message_count: number;
          created_at: string;
        }
      | undefined;
    const persisted = this.db
      .prepare(
        `SELECT tenant_execution_context, created_at
         FROM provider_session_state WHERE thread_id = ?`,
      )
      .get(event.threadId) as
      | { tenant_execution_context: string | null; created_at: string }
      | undefined;
    const metadata =
      event.method === 'session.started' ||
      event.method === 'session.configured'
        ? event.metadata
        : undefined;
    const tenant = parsePersistedTenantExecutionContext(
      persisted?.tenant_execution_context,
    );
    const prompt = event.method === 'turn.started' ? event.prompt : undefined;
    const agentSlug =
      existing?.agent_slug ??
      (typeof metadata?.agentSlug === 'string'
        ? metadata.agentSlug
        : undefined);
    const ownerUserId =
      existing?.owner_user_id ??
      (typeof metadata?.userId === 'string' ? metadata.userId : undefined);
    const projectSlug =
      existing?.project_slug ??
      (typeof metadata?.projectSlug === 'string'
        ? metadata.projectSlug
        : undefined);
    const messageCount =
      (existing?.message_count ?? 0) +
      (event.method === 'turn.started' || event.method === 'turn.completed'
        ? 1
        : 0);
    this.db
      .prepare(
        `INSERT INTO orchestration_conversation_history
          (thread_id, owner_user_id, tenant_id, agent_slug, project_slug, title, message_count, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(thread_id) DO UPDATE SET
           owner_user_id = excluded.owner_user_id,
           tenant_id = excluded.tenant_id,
           agent_slug = excluded.agent_slug,
           project_slug = COALESCE(orchestration_conversation_history.project_slug, excluded.project_slug),
           title = COALESCE(orchestration_conversation_history.title, excluded.title),
           message_count = excluded.message_count,
           updated_at = excluded.updated_at`,
      )
      .run(
        event.threadId,
        ownerUserId ?? null,
        tenant?.tenantId ?? existing?.tenant_id ?? null,
        agentSlug ?? null,
        projectSlug ?? null,
        typeof prompt === 'string' && prompt.trim()
          ? prompt.trim().slice(0, 80)
          : null,
        messageCount,
        existing?.created_at ?? persisted?.created_at ?? event.createdAt,
        event.createdAt,
      );
    this.refreshConversationHistoryQuarantine(event.threadId);
  }

  /**
   * Additive schema upgrade for homes whose conversation projection predates
   * project binding.  A nullable column is safe because unbound conversations
   * are a supported state.
   */
  private ensureConversationHistoryProjectSlugColumn(): void {
    const columns = this.db
      .prepare('PRAGMA table_info(orchestration_conversation_history)')
      .all() as Array<{ name: string }>;
    if (!columns.some((column) => column.name === 'project_slug')) {
      this.db.exec(
        'ALTER TABLE orchestration_conversation_history ADD COLUMN project_slug TEXT',
      );
    }
  }

  /**
   * Fill only one small legacy window per boot. This is deliberately separate
   * from the complete history upgrade: a project label is display metadata,
   * so it must not turn a normal startup into an unbounded ledger replay.
   */
  private backfillConversationHistoryProjectSlugs(): void {
    const threads = this.db
      .prepare(
        `SELECT thread_id FROM orchestration_conversation_history
         WHERE project_slug IS NULL
         ORDER BY thread_id ASC
         LIMIT ?`,
      )
      .all(MESSAGE_SEARCH_BACKFILL_EVENT_BATCH_SIZE) as Array<{
      thread_id: string;
    }>;
    // Freshly upgraded threads already projected their latest project label
    // above. If no older incomplete row remains, do not even prepare the
    // duplicate payload projection; preparation itself is part of the
    // bounded startup query budget.
    if (threads.length === 0) return;
    const selectProject = this.db.prepare(
      `SELECT payload FROM orchestration_events
       WHERE thread_id = ?
         AND method IN ('session.started', 'session.configured')
         AND json_valid(payload)
         AND typeof(json_extract(payload, '$.metadata.projectSlug')) = 'text'
       ORDER BY sequence DESC
       LIMIT 1`,
    );
    const updateProject = this.db.prepare(
      `UPDATE orchestration_conversation_history SET project_slug = ?
       WHERE thread_id = ? AND project_slug IS NULL`,
    );
    for (const thread of threads) {
      const row = selectProject.get(thread.thread_id) as
        | { payload: string }
        | undefined;
      const projectSlug = row
        ? parseHistoryEvent(row.payload)?.metadata?.projectSlug
        : undefined;
      if (typeof projectSlug === 'string') {
        updateProject.run(projectSlug, thread.thread_id);
      }
    }
  }

  /**
   * Copy at most one fixed event window from pre-search ledgers. The cursor
   * advances with the committed batch, and the event-id ledger makes a retry
   * idempotent even if a process stops between boots.
   */
  /**
   * Process one 500-event window at a time, even while v2 and v3 coexist.
   * The v3 CJK rebuild therefore inherits the established yielding and cursor
   * guarantees instead of adding a startup-wide migration.
   */
  private backfillNextMessageSearchProjection(): boolean {
    for (const projection of MESSAGE_SEARCH_PROJECTIONS) {
      if (this.backfillMessageSearchProjection(projection)) return true;
    }
    return false;
  }

  private backfillMessageSearchProjection(
    projection: MessageSearchProjection,
  ): boolean {
    const cursor = this.db
      .prepare(
        `SELECT last_global_sequence FROM ${projection.backfillTable}
         WHERE id = 1`,
      )
      .get() as { last_global_sequence: number } | undefined;
    const events = this.db
      .prepare(
        `SELECT id, provider, thread_id, turn_id, method, payload, created_at,
                global_sequence
         FROM orchestration_events
         WHERE global_sequence > ?
         ORDER BY global_sequence ASC
         LIMIT ?`,
      )
      .all(
        cursor?.last_global_sequence ?? 0,
        MESSAGE_SEARCH_BACKFILL_EVENT_BATCH_SIZE,
      ) as Array<{
      id: string;
      provider: CanonicalRuntimeEvent['provider'];
      thread_id: string;
      turn_id: string | null;
      method: CanonicalRuntimeEvent['method'];
      payload: string;
      created_at: string;
      global_sequence: number;
    }>;
    if (events.length === 0) return false;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const event of events) {
        const payload = parseMessageSearchEvent(event.payload);
        if (!payload) continue;
        this.projectMessageSearchEvent(
          {
            ...payload,
            eventId: event.id,
            provider: event.provider,
            threadId: event.thread_id,
            ...(event.turn_id ? { turnId: event.turn_id } : {}),
            method: event.method,
            createdAt: event.created_at,
          } as CanonicalRuntimeEvent,
          projection,
        );
      }
      this.db
        .prepare(
          `INSERT INTO ${projection.backfillTable}
            (id, last_global_sequence, updated_at)
           VALUES (1, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             last_global_sequence = excluded.last_global_sequence,
             updated_at = excluded.updated_at`,
        )
        .run(events.at(-1)!.global_sequence, new Date().toISOString());
      this.db.exec('COMMIT');
      return events.length === MESSAGE_SEARCH_BACKFILL_EVENT_BATCH_SIZE;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  /** Yield between fixed windows; shutdown cancels the next background step. */
  private scheduleMessageSearchBackfill(): void {
    setImmediate(() => {
      if (this.messageSearchBackfillClosed) return;
      if (this.backfillNextMessageSearchProjection()) {
        this.scheduleMessageSearchBackfill();
      }
    });
  }

  /** Write the two message kinds search is allowed to expose. */
  private projectMessageSearchEvent(
    event: CanonicalRuntimeEvent,
    projection?: MessageSearchProjection,
  ): void {
    const entry =
      event.method === 'turn.started' && typeof event.prompt === 'string'
        ? { role: 'user' as const, content: event.prompt }
        : event.method === 'turn.completed' &&
            typeof event.outputText === 'string'
          ? { role: 'assistant' as const, content: event.outputText }
          : undefined;
    if (!entry?.content.trim()) return;
    const scope = this.db
      .prepare(
        `SELECT owner_user_id, tenant_id FROM orchestration_conversation_history
         WHERE thread_id = ?`,
      )
      .get(event.threadId) as
      | { owner_user_id: string | null; tenant_id: string | null }
      | undefined;
    // An unbound conversation is quarantined and never becomes searchable.
    if (!scope?.owner_user_id) return;
    const searchableScope = {
      ownerUserId: scope.owner_user_id,
      tenantId: scope.tenant_id,
    };
    const projections = projection ? [projection] : MESSAGE_SEARCH_PROJECTIONS;
    for (const target of projections) {
      this.projectMessageSearchEntry(event, entry, searchableScope, target);
    }
  }

  private projectMessageSearchEntry(
    event: CanonicalRuntimeEvent,
    entry: { role: 'user' | 'assistant'; content: string },
    scope: { ownerUserId: string; tenantId: string | null },
    projection: MessageSearchProjection,
  ): void {
    const projected = this.db
      .prepare(
        `INSERT OR IGNORE INTO ${projection.projectionTable}
          (event_id) VALUES (?)`,
      )
      .run(event.eventId) as { changes: number };
    if (projected.changes === 0) return;
    if (projection.cjkAware) {
      this.db
        .prepare(
          `INSERT INTO ${projection.table}
            (thread_id, event_id, turn_id, role, owner_scope_key, tenant_scope_key, cjk_terms, content, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          event.threadId,
          event.eventId,
          event.turnId ?? null,
          entry.role,
          messageOwnerScopeKey(scope.ownerUserId),
          scope.tenantId ? messageTenantScopeKey(scope.tenantId) : '',
          cjkSearchTerms(entry.content),
          entry.content,
          event.createdAt,
        );
      return;
    }
    this.db
      .prepare(
        `INSERT INTO ${projection.table}
          (thread_id, event_id, turn_id, role, owner_scope_key, tenant_scope_key, content, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        event.threadId,
        event.eventId,
        event.turnId ?? null,
        entry.role,
        messageOwnerScopeKey(scope.ownerUserId),
        scope.tenantId ? messageTenantScopeKey(scope.tenantId) : '',
        entry.content,
        event.createdAt,
      );
  }

  private refreshConversationHistoryQuarantine(threadId: string): void {
    const record = this.db
      .prepare(
        `SELECT owner_user_id, agent_slug FROM orchestration_conversation_history
         WHERE thread_id = ?`,
      )
      .get(threadId) as
      | { owner_user_id: string | null; agent_slug: string | null }
      | undefined;
    if (!record) return;
    if (!record.owner_user_id || !record.agent_slug) {
      this.db
        .prepare(
          `INSERT INTO orchestration_conversation_history_quarantine
            (thread_id, reason, recorded_at) VALUES (?, 'unbound', ?)
           ON CONFLICT(thread_id) DO UPDATE SET reason = 'unbound', recorded_at = excluded.recorded_at`,
        )
        .run(threadId, new Date().toISOString());
      return;
    }
    this.db
      .prepare(
        'DELETE FROM orchestration_conversation_history_quarantine WHERE thread_id = ?',
      )
      .run(threadId);
  }

  private transitionNativeInvocationRun(input: {
    runId: string;
    ownerId: string;
    from: string[];
    to: 'running' | 'completed' | 'failed' | 'indeterminate';
    now: string;
    failureMessage?: string;
  }): { kind: 'applied' } | { kind: 'stale' } | { kind: 'unavailable' } {
    const terminal =
      input.to === 'completed' ||
      input.to === 'failed' ||
      input.to === 'indeterminate';
    const isExactDurableTransition = (
      row:
        | {
            state: string;
            updated_at: string;
            completed_at: string | null;
            failure_message: string | null;
          }
        | undefined,
    ) =>
      row?.state === input.to &&
      row.updated_at === input.now &&
      (input.to === 'running' || row.completed_at === input.now) &&
      (input.failureMessage === undefined ||
        row.failure_message === input.failureMessage);
    const applied = (): { kind: 'applied' } => {
      // The receipt is first proven durable and observable. Retention is
      // deliberately best-effort afterwards, so a clock-skewed terminal can
      // never make a successful transition report stale/unavailable.
      if (terminal) this.pruneNativeInvocationTerminals();
      return { kind: 'applied' };
    };
    try {
      const placeholders = input.from.map(() => '?').join(', ');
      this.db
        .prepare(
          `UPDATE native_invocation_runs
             SET state = ?, updated_at = ?,
                 completed_at = CASE WHEN ? IN ('completed', 'failed', 'indeterminate') THEN ? ELSE completed_at END,
                 terminal_sequence = CASE
                   WHEN ? IN ('completed', 'failed', 'indeterminate')
                     THEN (SELECT COALESCE(MAX(terminal_sequence), 0) + 1 FROM native_invocation_runs)
                   ELSE terminal_sequence
                 END,
                 failure_message = CASE WHEN ? IS NULL THEN failure_message ELSE ? END
           WHERE run_id = ? AND owner_id = ? AND state IN (${placeholders})`,
        )
        .run(
          input.to,
          input.now,
          input.to,
          input.now,
          input.to,
          input.failureMessage ?? null,
          input.failureMessage ?? null,
          input.runId,
          input.ownerId,
          ...input.from,
        );
      this.nativeInvocationTransitionFault?.();
      const row = this.db
        .prepare(
          `SELECT state, updated_at, completed_at, failure_message
             FROM native_invocation_runs WHERE run_id = ? AND owner_id = ?`,
        )
        .get(input.runId, input.ownerId) as
        | {
            state: string;
            updated_at: string;
            completed_at: string | null;
            failure_message: string | null;
          }
        | undefined;
      if (isExactDurableTransition(row)) return applied();
      return { kind: 'stale' };
    } catch {
      // Read back the exact durable intended fact: SQLite may throw after the
      // write committed, and callers must not downgrade a possible effect.
      try {
        const row = this.db
          .prepare(
            `SELECT state, updated_at, completed_at, failure_message
               FROM native_invocation_runs WHERE run_id = ? AND owner_id = ?`,
          )
          .get(input.runId, input.ownerId) as
          | {
              state: string;
              updated_at: string;
              completed_at: string | null;
              failure_message: string | null;
            }
          | undefined;
        if (isExactDurableTransition(row)) return applied();
        return { kind: 'stale' };
      } catch {
        return { kind: 'unavailable' };
      }
    }
  }

  private readNativeInvocationRun(runId: string): RunSummary | null {
    const row = this.db
      .prepare(
        `SELECT run_id, kind, source_id, state, started_at, updated_at, completed_at, failure_message
           FROM native_invocation_runs WHERE run_id = ?`,
      )
      .get(runId) as Record<string, unknown> | undefined;
    return row ? this.projectNativeInvocationRun(row) : null;
  }

  private listNativeInvocationRuns(): RunSummary[] {
    const activeRows = this.db
      .prepare(
        `SELECT run_id, kind, source_id, state, started_at, updated_at, completed_at, failure_message
           FROM native_invocation_runs
          WHERE state IN ('starting', 'running')
          ORDER BY started_at ASC, run_id ASC`,
      )
      .all() as Record<string, unknown>[];
    const terminalRows = this.db
      .prepare(
        `SELECT run_id, kind, source_id, state, started_at, updated_at, completed_at, failure_message
           FROM native_invocation_runs
          WHERE state IN ('completed', 'failed', 'indeterminate')
          ORDER BY terminal_sequence DESC, run_id DESC
          LIMIT ?`,
      )
      .all(NATIVE_INVOCATION_TERMINAL_RETENTION) as Record<string, unknown>[];
    return [...activeRows, ...terminalRows]
      .map((row) => this.projectNativeInvocationRun(row))
      .sort(
        (left, right) =>
          left.startedAt.localeCompare(right.startedAt) ||
          left.runId.localeCompare(right.runId),
      );
  }

  /** Bounded terminal history; active provider boundaries are never removed. */
  private pruneNativeInvocationTerminals(): void {
    try {
      this.db
        .prepare(
          `DELETE FROM native_invocation_runs
            WHERE run_id IN (
              SELECT run_id FROM native_invocation_runs
               WHERE state IN ('completed', 'failed', 'indeterminate')
               ORDER BY terminal_sequence DESC, run_id DESC
               LIMIT -1 OFFSET ?
            )`,
        )
        .run(NATIVE_INVOCATION_TERMINAL_RETENTION);
    } catch {
      // Retention must not change an already durable provider outcome.
    }
  }

  private readActiveNativeInvocationRuns(): Array<{
    runId: string;
    kind:
      | 'agent-invoke'
      | 'agent-invoke-stream'
      | 'global-invoke'
      | 'global-structure';
    sourceId?: string;
    state: 'starting' | 'running';
    ownerId: string;
    ownerPid: number;
    ownerBirth?: string;
    ownerIdentityKind: string;
    startedAt: string;
    updatedAt: string;
  }> {
    const rows = this.db
      .prepare(
        `SELECT run_id, kind, source_id, state, owner_id, owner_pid, owner_birth, owner_identity_kind, started_at, updated_at
           FROM native_invocation_runs WHERE state IN ('starting', 'running')`,
      )
      .all() as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      runId: row.run_id as string,
      kind: row.kind as
        | 'agent-invoke'
        | 'agent-invoke-stream'
        | 'global-invoke'
        | 'global-structure',
      ...(row.source_id ? { sourceId: row.source_id as string } : {}),
      state: row.state as 'starting' | 'running',
      ownerId: row.owner_id as string,
      ownerPid: row.owner_pid as number,
      ...(row.owner_birth ? { ownerBirth: row.owner_birth as string } : {}),
      ownerIdentityKind: row.owner_identity_kind as string,
      startedAt: row.started_at as string,
      updatedAt: row.updated_at as string,
    }));
  }

  private projectNativeInvocationRun(row: Record<string, unknown>): RunSummary {
    const state = row.state as string;
    const terminal =
      state === 'completed' || state === 'failed' || state === 'indeterminate';
    return {
      runId: row.run_id as string,
      providerId: 'native-invoke',
      source: 'invoke',
      ...(row.source_id ? { sourceId: row.source_id as string } : {}),
      status:
        state === 'starting'
          ? 'starting'
          : state === 'running'
            ? 'running'
            : state === 'completed'
              ? 'completed'
              : 'failed',
      startedAt: row.started_at as string,
      updatedAt: row.updated_at as string,
      ...(terminal ? { completedAt: row.completed_at as string } : {}),
      ...(state === 'completed'
        ? {}
        : {
            failureKind: state === 'indeterminate' ? 'unknown' : 'agent_error',
            ...(row.failure_message
              ? { failureMessage: row.failure_message as string }
              : {}),
          }),
      // A live starting owner may still cross the provider boundary. There is
      // no public exact retry capability for native invokes, so no projection
      // is ever safe to advertise as retryable.
      retryEligible: false,
      attempt: 1,
      metadata: {
        nativeInvocationKind: row.kind as string,
        nativeInvocationState: state,
      },
    };
  }

  close(): OperationalEventSubscriptionCloseOutcome {
    this.packageMcpAdmissionJournal?.closeAdmission();
    this.messageSearchBackfillClosed = true;
    let registryOutcome: OperationalEventSubscriptionCloseOutcome = {
      kind: 'closed',
    };
    for (const registry of this.operationalEventSubscriptionRegistries) {
      const outcome = registry.close();
      if (outcome.kind === 'unavailable') registryOutcome = outcome;
      else if (outcome.kind === 'pending' && registryOutcome.kind === 'closed')
        registryOutcome = outcome;
    }
    if (registryOutcome.kind !== 'closed') return registryOutcome;
    this.operationalEventSubscriptionRegistries.clear();
    for (const consumer of this.operationalEventConsumers) consumer.close();
    this.operationalEventConsumers.clear();
    for (const history of this.projectTaskRoomHistories) history.dispose();
    this.projectTaskRoomHistories.clear();
    for (const module of this.revisionEvidenceModules) module.close();
    this.revisionEvidenceModules.clear();
    releaseNativeInvocationOwner(this.recoveryLedgerOwner.id);
    releaseVoiceTurnOwner(this.recoveryLedgerOwner.id);
    releaseSessionTurnBoundaryOwner(this.recoveryLedgerOwner.id);
    releaseRecoveryLedgerOwner(this.recoveryLedgerOwner.id);
    this.db.close();
    return { kind: 'closed' };
  }

  private nextSequence(threadId: string): number {
    const row = this.db
      .prepare(
        `SELECT COALESCE(MAX(sequence), 0) AS max_sequence
         FROM orchestration_events
         WHERE thread_id = ?`,
      )
      .get(threadId) as { max_sequence: number };
    return row.max_sequence + 1;
  }

  /**
   * Next value for the cross-thread `global_sequence` cursor (archive#1092).
   * Computed the same way as {@link nextSequence} but without the thread
   * filter, so it stays monotonic across every session. Safe to call
   * speculatively from `appendEventIfAbsent` before knowing whether the
   * insert will actually land: an ignored insert never persists the
   * candidate value, so the next real append recomputes MAX+1 from what is
   * actually in the table and no gap is observable.
   */
  private nextGlobalSequence(): number {
    const row = this.db
      .prepare(
        `SELECT COALESCE(MAX(global_sequence), 0) AS max_sequence
         FROM orchestration_events`,
      )
      .get() as { max_sequence: number };
    return row.max_sequence + 1;
  }
}

function parsePersistedTenantExecutionContext(value: unknown) {
  if (typeof value !== 'string' || value.length > 256) return undefined;
  try {
    return parseTenantExecutionContext(JSON.parse(value));
  } catch {
    return undefined;
  }
}

/** Opaque FTS scope terms keep user/tenant postings disjoint from body terms. */
function messageSearchScopeKey(
  kind: 'owner' | 'tenant',
  value: string,
): string {
  return createHash('sha256').update(`${kind}\0${value}`).digest('hex');
}

function messageOwnerScopeKey(ownerUserId: string): string {
  return messageSearchScopeKey('owner', ownerUserId);
}

function messageTenantScopeKey(tenantId: string): string {
  return messageSearchScopeKey('tenant', tenantId);
}

/** Quote exactly one FTS5 column phrase; user text never becomes syntax. */
function ftsColumnPhrase(column: string, value: string): string {
  return `${column} : "${value.replaceAll('"', '""')}"`;
}

const CJK_CODE_POINT =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const CJK_RUN =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+/gu;

/**
 * unicode61 treats a CJK run as one token, so a substring query cannot match
 * it. Index each CJK code point and adjacent pair as a quoted FTS phrase;
 * this preserves phrase order while making one- and two-character queries
 * searchable without changing tokenization of scope hashes or Latin text.
 */
function cjkSearchTerms(value: string): string {
  const terms: string[] = [];
  let run: string[] = [];
  const flush = () => {
    for (let index = 0; index < run.length; index += 1) {
      terms.push(run[index]!);
      if (index + 1 < run.length) {
        terms.push(`${run[index]}${run[index + 1]}`);
      }
    }
    run = [];
  };
  for (const character of value) {
    if (CJK_CODE_POINT.test(character)) {
      run.push(character);
    } else if (run.length > 0) {
      flush();
    }
  }
  if (run.length > 0) flush();
  return terms.join(' ');
}

/** Keep unicode61's established behavior for non-CJK text in a mixed query. */
function nonCjkSearchTerms(value: string): string {
  return value.replace(CJK_RUN, ' ').trim();
}

function parseMessageSearchEvent(
  value: string,
): Record<string, unknown> | undefined {
  try {
    const event = JSON.parse(value) as unknown;
    return event && typeof event === 'object' && !Array.isArray(event)
      ? (event as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function parseHistoryEvent(
  value: string,
):
  | { method?: string; metadata?: Record<string, unknown>; prompt?: unknown }
  | undefined {
  try {
    const event = JSON.parse(value) as {
      method?: unknown;
      metadata?: unknown;
      prompt?: unknown;
    };
    if (
      typeof event.method !== 'string' ||
      (event.metadata !== undefined &&
        (typeof event.metadata !== 'object' || Array.isArray(event.metadata)))
    ) {
      return undefined;
    }
    return {
      method: event.method,
      ...(event.metadata
        ? { metadata: event.metadata as Record<string, unknown> }
        : {}),
      ...(event.prompt !== undefined ? { prompt: event.prompt } : {}),
    };
  } catch {
    // A malformed persisted event cannot establish history ownership.
  }
  return undefined;
}

function mapAdoptionReservationRow(row: any): AdoptionReservation {
  return {
    sourceThreadId: row.source_thread_id,
    targetThreadId: row.target_thread_id,
    ownerId: row.owner_id,
    ownerPid: row.owner_pid,
    ownerToken: row.owner_token,
    provider: row.provider,
    sourceSessionId: row.source_session_id,
    sourceKind: row.source_kind,
    cwd: row.cwd,
    projectRoot: row.project_root,
    status: row.status,
    ...(row.provider_resume_cursor
      ? { providerResumeCursor: JSON.parse(row.provider_resume_cursor) }
      : {}),
    providerCleanupComplete: row.provider_cleanup_complete === 1,
    ...(row.flow_run_id ? { flowRunId: row.flow_run_id } : {}),
    ...(row.flow_run_resumed === null
      ? {}
      : { flowRunResumed: row.flow_run_resumed === 1 }),
    flowCleanupComplete: row.flow_cleanup_complete === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapPersistedSessionRow(row: any): ProviderSession {
  const tenantExecutionContext = parsePersistedTenantExecutionContext(
    row.tenant_execution_context,
  );
  return {
    provider: row.provider,
    threadId: row.thread_id,
    status: row.status,
    model: row.model ?? undefined,
    ...(row.cwd ? { cwd: row.cwd } : {}),
    resumeCursor: row.resume_cursor ? JSON.parse(row.resume_cursor) : undefined,
    controlMode: row.control_mode ?? 'station-owned',
    ...(row.attached_source
      ? { attachedSource: JSON.parse(row.attached_source) }
      : {}),
    ...(row.continuation_source_thread_id
      ? { continuationSourceThreadId: row.continuation_source_thread_id }
      : {}),
    ...(row.adoption_idempotency_key
      ? { adoptionIdempotencyKey: row.adoption_idempotency_key }
      : {}),
    ...(row.persist_session === 1 ? { persistSession: true } : {}),
    ...(row.ephemeral === 1 ? { ephemeral: true as const } : {}),
    ...(tenantExecutionContext ? { tenantExecutionContext } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapPersistedEventRow(row: any): PersistedRuntimeEvent {
  return {
    id: row.id,
    provider: row.provider,
    threadId: row.thread_id,
    turnId: row.turn_id ?? undefined,
    method: row.method,
    payload: JSON.parse(row.payload),
    createdAt: row.created_at,
    ...(row.observed_at ? { observedAt: row.observed_at } : {}),
    sequence: row.sequence,
    globalSequence: row.global_sequence,
  };
}

interface CommandReceiptRow {
  command_id: string;
  thread_id: string;
  command_type: OrchestrationCommandReceipt['commandType'];
  status: OrchestrationCommandReceipt['status'];
  created_at: string;
  client_origin: string | null;
}

function recoveryTransition(result: {
  changes: number | bigint;
}): RecoveryTransition {
  return Number(result.changes) === 1 ? { kind: 'applied' } : { kind: 'stale' };
}

function credentialApplicationTransition(result: {
  changes: number | bigint;
}): { kind: 'applied' } | { kind: 'stale' } {
  return Number(result.changes) === 1 ? { kind: 'applied' } : { kind: 'stale' };
}

interface RecoveryIntentRow {
  fingerprint: string;
  thread_id: string;
  provider: string;
  source_event_id: string;
  source_turn_id: string;
  failure_kind: ConnectionRecoveryIntent['failureKind'];
  scope: ConnectionRecoveryIntent['scope'];
  decision: ConnectionRecoveryIntent['decision'];
  due_at: string | null;
  attempts: number;
  max_attempts: number;
  outcome: ConnectionRecoveryIntent['outcome'];
  dispatch_attempt_id: string | null;
  recovery_correlation_id: string | null;
  dispatch_settlement: 'prepared' | 'accepted' | null;
  dispatch_kind: 'due' | 'profile' | null;
  resumed_turn_id: string | null;
  created_at: string;
  updated_at: string;
}

function mapRecoveryIntentRow(
  row: RecoveryIntentRow,
): ConnectionRecoveryIntent {
  return {
    fingerprint: row.fingerprint,
    threadId: row.thread_id,
    provider: row.provider,
    sourceEventId: row.source_event_id,
    sourceTurnId: row.source_turn_id,
    failureKind: row.failure_kind,
    scope: row.scope,
    decision: row.decision,
    ...(row.due_at ? { dueAt: row.due_at } : {}),
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
    outcome: row.outcome,
    ...(row.dispatch_attempt_id
      ? { dispatchAttemptId: row.dispatch_attempt_id }
      : {}),
    ...(row.recovery_correlation_id
      ? { recoveryCorrelationId: row.recovery_correlation_id }
      : {}),
    ...(row.dispatch_settlement
      ? { dispatchSettlement: row.dispatch_settlement }
      : {}),
    ...(row.dispatch_kind ? { dispatchKind: row.dispatch_kind } : {}),
    ...(row.resumed_turn_id ? { resumedTurnId: row.resumed_turn_id } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapCommandReceiptRow(
  row: CommandReceiptRow,
): OrchestrationCommandReceipt {
  const clientOrigin = row.client_origin
    ? JSON.parse(row.client_origin)
    : undefined;
  if (clientOrigin !== undefined && !isClientOrigin(clientOrigin)) {
    throw new Error('Invalid persisted command receipt client origin');
  }
  return {
    commandId: row.command_id,
    threadId: row.thread_id,
    commandType: row.command_type,
    status: row.status,
    createdAt: row.created_at,
    ...(clientOrigin ? { clientOrigin } : {}),
  };
}

/**
 * archive#1224 (offline): folds `(threadId, clientTurnId)` into the
 * flat key the shared `TurnIdempotencyStore` (`../turn-idempotency.ts`)
 * deals in, so the same `clientTurnId` reused on two different threads never
 * collides.
 *
 * archive#1224 HIGH fix (independent review): a plain `${threadId}::${id}`
 * join is NOT collision-free -- `orchestration.ts`'s schema allows any
 * string for `threadId`, so `threadId = 'thread::evil'` with
 * `clientTurnId = 'id'` and `threadId = 'thread'` with
 * `clientTurnId = 'evil::id'` would both join to the literal string
 * `thread::evil::id`. Length-prefixing `threadId` makes the encoding
 * unambiguous regardless of what characters either part contains: the first
 * `threadId.length` characters after the length prefix ARE `threadId`, full
 * stop, so no content inside `threadId` (including `::` itself) can ever be
 * misread as the separator.
 */
function turnDedupKey(threadId: string, clientTurnId: string): string {
  return `${turnDedupThreadPrefix(threadId)}${clientTurnId}`;
}

/**
 * The length-prefixed, unambiguous prefix identifying every dedup key for
 * `threadId` — see `turnDedupKey`'s doc comment. Exported (module-local)
 * for `EventStore.deleteThread`'s exact-prefix cleanup query.
 */
function turnDedupThreadPrefix(threadId: string): string {
  return `${threadId.length}:${threadId}::`;
}
function chatTurnDedupKey(clientTurnId: string): string {
  return `chat:${clientTurnId.length}:${clientTurnId}`;
}

/**
 * SQLite-backed `TurnIdempotencyPersistence` adapter over
 * `orchestration_turn_dedup` — the storage half of the shared algorithm.
 * `EventStore` composes this into the behavioral TurnDeduplicator while
 * retaining SQLite and transaction ownership privately.
 */
class SqliteTurnIdempotencyPersistence implements TurnIdempotencyPersistence {
  constructor(
    private readonly db: InstanceType<typeof DatabaseSync>,
    private readonly maxEntries: number = TURN_DEDUP_MAX_ENTRIES,
  ) {}

  read(key: string): TurnIdempotencyRecord | undefined {
    const row = this.db
      .prepare(
        `SELECT value, created_at AS createdAt, owner_json AS ownerJson
         FROM orchestration_turn_dedup
         WHERE dedup_key = ?`,
      )
      .get(key) as
      | { value: string | null; createdAt: number; ownerJson: string | null }
      | undefined;
    if (!row) return undefined;
    return {
      value: row.value,
      createdAt: row.createdAt,
      ...(row.ownerJson === null
        ? {}
        : { owner: parseTurnClaimOwner(row.ownerJson) }),
    };
  }

  update<T>(
    key: string,
    updater: (current: TurnIdempotencyRecord | undefined) => {
      record?: TurnIdempotencyRecord;
      result: T;
    },
  ): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const decision = updater(this.read(key));
      if (decision.record)
        this.db
          .prepare(
            `INSERT INTO orchestration_turn_dedup (dedup_key, value, created_at, owner_json) VALUES (?, ?, ?, ?) ON CONFLICT(dedup_key) DO UPDATE SET value = excluded.value, created_at = excluded.created_at, owner_json = excluded.owner_json`,
          )
          .run(
            key,
            decision.record.value,
            decision.record.createdAt,
            decision.record.owner
              ? JSON.stringify(decision.record.owner)
              : null,
          );
      else
        this.db
          .prepare('DELETE FROM orchestration_turn_dedup WHERE dedup_key = ?')
          .run(key);
      this.prune();
      this.db.exec('COMMIT');
      return decision.result;
    } catch (error) {
      try {
        this.db.exec('ROLLBACK');
      } catch {}
      throw error;
    }
  }

  private prune(): void {
    // This is intentionally a soft cap. Resolved rows are safe to evict;
    // unresolved claims are never evicted, regardless of owner liveness, so a
    // turn in flight can never become claimable again because of retention.
    // The single statement deletes at most the overflow, oldest first, without
    // materializing rows or probing processes while the write lock is held.
    this.db
      .prepare(`DELETE FROM orchestration_turn_dedup
        WHERE dedup_key IN (
          SELECT dedup_key FROM orchestration_turn_dedup
          WHERE value IS NOT NULL
          ORDER BY created_at ASC, dedup_key ASC
          LIMIT MAX(0, (SELECT count(*) FROM orchestration_turn_dedup) - ?)
        )`)
      .run(this.maxEntries);
  }
}

function parseTurnClaimOwner(
  raw: string,
): import('../turn-idempotency.js').TurnClaimOwner {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error('Invalid orchestration turn claim owner_json');
  }
  if (
    !value ||
    typeof value !== 'object' ||
    !Number.isInteger((value as any).pid) ||
    (value as any).pid < 1 ||
    typeof (value as any).token !== 'string' ||
    !(value as any).token ||
    !(
      (value as any).identityKind === 'unverified' ||
      ((value as any).identityKind === 'exact' &&
        typeof (value as any).birth === 'string' &&
        (value as any).birth)
    )
  )
    throw new Error('Invalid orchestration turn claim owner_json');
  return value as import('../turn-idempotency.js').TurnClaimOwner;
}
