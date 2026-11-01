import { createHash } from 'node:crypto';
import { CONVERSATION_CONTEXT_UNAVAILABLE_CODE } from '@kontourai/station-contracts/orchestration';
import type {
  ProviderSendTurnInput,
  ProviderSessionStartInput,
} from '@kontourai/station-contracts/provider';
import type { CanonicalRuntimeEvent } from '@kontourai/station-contracts/runtime-events';
import type {
  SessionReadAuthority,
  TenantExecutionContext,
} from '@kontourai/station-contracts/tenancy';
import type { ConversationMessage } from '@kontourai/station-shared/conversation-message';
import type { UIMessage } from 'ai';
import { z } from 'zod';
import { observeConversationSeedTurn } from './conversation-context-seed-witness.js';
import { buildForkTranscript } from './conversation-fork.js';
import {
  createConversationContextSeedPin,
  readConversationContextSeedPin,
} from './conversation-handoff-module.js';
import { transcriptSeedSource } from './conversation-transcript-seed.js';
import type { EventStore } from './event-store.js';
import type { SessionReadScope } from './orchestration-service.js';
import type { TurnDeduplicator } from './turn-deduplicator.js';

const FORK_CONTEXT_MAX_BYTES = 2 * 1024 * 1024;
const nativeForkId = z.string().min(1).max(512);
const nativeForkDigest = z.string().regex(/^[a-f0-9]{64}$/);
const nativeForkSourceSchema = z
  .object({
    sourceConversationId: nativeForkId,
    sourceSessionId: nativeForkId,
    selectedEventId: nativeForkId,
    selectedTurnId: nativeForkId,
    headEventId: nativeForkId,
    nativeIdentityKey: nativeForkDigest,
    nativeResumeBindingKey: nativeForkDigest,
    connectionId: nativeForkId.optional(),
    provider: z.enum(['codex', 'claude']),
    environmentId: nativeForkId,
    agentId: nativeForkId,
    cwd: z.string().min(1).max(4096),
    credentialProfileRef: nativeForkId.optional(),
  })
  .strict();
export type NativeForkSourceSeal = z.infer<typeof nativeForkSourceSchema>;
const nativeForkRecordSchema = z
  .object({
    version: z.literal(1),
    targetId: nativeForkId,
    contextDigest: nativeForkDigest,
    intentId: z.uuid(),
    source: nativeForkSourceSchema,
    state: z.enum([
      'prepared',
      'invoking',
      'child-observed',
      'indeterminate',
      'cleanup-pending',
      'committed',
    ]),
    cursorJson: z.string().optional(),
    cursorDigest: nativeForkDigest.optional(),
    childIdentity: nativeForkDigest.optional(),
    commitJson: z.string().optional(),
    commitDigest: nativeForkDigest.optional(),
  })
  .strict();
export type NativeForkEffectRecord = z.infer<typeof nativeForkRecordSchema>;
export function nativeForkJson(value: unknown): string {
  const json = JSON.stringify(value);
  if (
    typeof json !== 'string' ||
    Buffer.byteLength(json) > FORK_CONTEXT_MAX_BYTES
  )
    throw new ConversationForkContextError(
      'Native fork data exceeds its retained context budget.',
    );
  return json;
}
export function nativeForkHash(json: string): string {
  return createHash('sha256').update(json).digest('hex');
}
export function readNativeForkEffect(json: string): NativeForkEffectRecord {
  if (Buffer.byteLength(json) > FORK_CONTEXT_MAX_BYTES)
    throw new ConversationForkContextError(
      'Native fork record exceeds its read budget.',
    );
  nativeForkJson(JSON.parse(json));
  const record = nativeForkRecordSchema.parse(JSON.parse(json));
  const hasCursor = record.cursorJson !== undefined;
  if (
    hasCursor !== (record.cursorDigest !== undefined) ||
    hasCursor !== (record.childIdentity !== undefined) ||
    (hasCursor && nativeForkHash(record.cursorJson!) !== record.cursorDigest) ||
    (['child-observed', 'committed'].includes(record.state) && !hasCursor) ||
    (record.commitJson !== undefined) !== (record.commitDigest !== undefined) ||
    (record.commitJson !== undefined &&
      nativeForkHash(record.commitJson) !== record.commitDigest) ||
    (record.state === 'committed') !== (record.commitJson !== undefined)
  )
    throw new ConversationForkContextError(
      'Native fork receipt is unavailable.',
    );
  return record;
}

const nativeCreationEventBase = {
  eventId: nativeForkId,
  provider: z.enum(['codex', 'claude']),
  threadId: nativeForkId,
  sessionId: nativeForkId,
  createdAt: z.string().min(1).max(128),
  metadata: z.record(z.string(), z.unknown()),
};
const nativeCreationStarted = z
  .object({ ...nativeCreationEventBase, method: z.literal('session.started') })
  .passthrough();
const nativeCreationConfigured = z
  .object({
    ...nativeCreationEventBase,
    method: z.literal('session.configured'),
    cwd: z.string().min(1).max(4096),
  })
  .passthrough();
const nativeCreationChild = z
  .object({
    threadId: nativeForkId,
    provider: z.enum(['codex', 'claude']),
    cwd: z.string().min(1).max(4096),
    resumeCursor: z.unknown().refine((value) => value !== undefined),
    createdAt: z.string().min(1).max(128),
    updatedAt: z.string().min(1).max(128),
  })
  .passthrough();
const nativeCreationFork = z
  .object({
    eventId: nativeForkId,
    provider: z.literal('station'),
    threadId: nativeForkId,
    method: z.literal('conversation.forked'),
    sourceConversationId: nativeForkId,
    targetConversationId: nativeForkId,
    targetAgent: nativeForkId,
    sourceSessionId: nativeForkId,
    branchPointTurnId: nativeForkId,
    contextDigest: nativeForkDigest,
    continuation: z.literal('native'),
    forkedAt: z.string().min(1).max(128),
    createdAt: z.string().min(1).max(128),
  })
  .passthrough();
const nativeCreationEnvelope = z
  .object({
    child: z.unknown(),
    startedEvent: z.unknown(),
    configuredEvent: z.unknown(),
    forkEvent: z.unknown(),
  })
  .strict();

/** Receipt-owned decoder; neither historical child fields nor opaque cursors grant execution. */
export function decodeCommittedNativeForkCreation(json: string) {
  if (Buffer.byteLength(json) > FORK_CONTEXT_MAX_BYTES)
    throw new ConversationForkContextError(
      'Native creation receipt exceeds its read budget.',
    );
  const envelope = nativeCreationEnvelope.parse(JSON.parse(json));
  return {
    initialChild: nativeCreationChild.parse(envelope.child),
    started: nativeCreationStarted.parse(envelope.startedEvent),
    configured: nativeCreationConfigured.parse(envelope.configuredEvent),
    fork: nativeCreationFork.parse(envelope.forkEvent),
    eventJson: [
      nativeForkJson(envelope.startedEvent),
      nativeForkJson(envelope.configuredEvent),
      nativeForkJson(envelope.forkEvent),
    ],
  };
}
export interface NativeForkAffectedScope {
  readonly threadIds: readonly string[];
  readonly conversationIds: readonly string[];
}
export type NativeForkCreationObservation =
  | { kind: 'pending' }
  | {
      kind: 'unavailable';
      reason: 'invalid' | 'corrupt-or-incompatible' | 'unbounded';
    }
  | {
      kind: 'verified-creation';
      creation: ReturnType<typeof decodeCommittedNativeForkCreation>;
      currentSession: import('@kontourai/station-contracts/provider').ProviderSession;
      canonicalProjection: 'not-supplied';
      affected: NativeForkAffectedScope;
      activation: 'unwired';
    };

export interface NativeForkCommitInput {
  startedEvent: Extract<CanonicalRuntimeEvent, { method: 'session.started' }>;
  child: import('@kontourai/station-contracts/provider').ProviderSession;
  configuredEvent: Extract<
    CanonicalRuntimeEvent,
    { method: 'session.configured' }
  >;
  forkEvent: Extract<CanonicalRuntimeEvent, { method: 'conversation.forked' }>;
}
export interface NativeForkEffectClaim {
  /** A stable wrapper; the captured authority claim is never exposed. */
  readonly sessionStart: import('@kontourai/monument/session-boundary').SessionStartBoundaryClaim;
  observeChild(cursor: unknown, nativeIdentityKey: string): void;
  commit(input: NativeForkCommitInput): 'committed' | 'already-committed';
  indeterminate(): void;
  cleanupPending(): void;
}

export class ConversationForkContextError extends Error {
  readonly code = CONVERSATION_CONTEXT_UNAVAILABLE_CODE;
}

const snapshotSchema = z
  .object({
    protocolVersion: z.literal(1),
    forkEventId: z.string().min(1),
    sourceConversationId: z.string().min(1),
    sourceAgent: z.string().min(1),
    targetConversationId: z.string().min(1),
    targetAgent: z.string().min(1),
    ownerUserId: z.string().min(1),
    tenantId: z.string().min(1).optional(),
    projectSlug: z.string().min(1).optional(),
    requestedProjectSlug: z.string().min(1).optional(),
    requestedBranchPointTurnId: z.string().min(1).optional(),
    idempotencyKey: z.string().min(1).optional(),
    branchPointTurnId: z.string().min(1).optional(),
    sourceSessionId: z.string().min(1).optional(),
    title: z.string(),
    createdAt: z.string(),
    copiedMessagesJson: z.string(),
    seedPinJson: z.string(),
    digest: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();

export type ConversationForkContextSnapshot = z.infer<typeof snapshotSchema>;
export type ConversationForkContextReference = Pick<
  ConversationForkContextSnapshot,
  | 'forkEventId'
  | 'sourceConversationId'
  | 'sourceAgent'
  | 'targetConversationId'
  | 'targetAgent'
  | 'ownerUserId'
  | 'tenantId'
  | 'projectSlug'
  | 'requestedProjectSlug'
  | 'requestedBranchPointTurnId'
  | 'idempotencyKey'
  | 'digest'
  | 'createdAt'
> & { state: 'prepared' | 'ready' | 'deleted' };

function contextDigest(
  snapshot: Omit<ConversationForkContextSnapshot, 'digest'>,
): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        'station-fork-context/v1',
        snapshot.forkEventId,
        snapshot.sourceConversationId,
        snapshot.sourceAgent,
        snapshot.targetConversationId,
        snapshot.targetAgent,
        snapshot.ownerUserId,
        snapshot.tenantId ?? null,
        snapshot.projectSlug ?? null,
        snapshot.requestedProjectSlug ?? null,
        snapshot.requestedBranchPointTurnId ?? null,
        snapshot.idempotencyKey ?? null,
        snapshot.branchPointTurnId ?? null,
        snapshot.sourceSessionId ?? null,
        snapshot.title,
        snapshot.createdAt,
        snapshot.copiedMessagesJson,
        snapshot.seedPinJson,
      ]),
    )
    .digest('hex');
}

export function createConversationForkContext(
  input: Omit<
    ConversationForkContextSnapshot,
    | 'protocolVersion'
    | 'copiedMessagesJson'
    | 'seedPinJson'
    | 'digest'
    | 'title'
  > & {
    sourceTitle: string;
    messages: ConversationMessage[];
  },
): ConversationForkContextSnapshot {
  const { sourceTitle, messages, ...identity } = input;
  const seed = buildForkTranscript({
    sourceTitle,
    sourceAgent: input.sourceAgent,
    messages,
  });
  const seedPin = createConversationContextSeedPin({
    text: seed.text,
    sourceCutoffs: [],
    omission: {
      totalMessages: seed.totalMessages,
      includedMessages: seed.includedMessages,
      omittedMessages: seed.omittedMessages,
      newestShortened: seed.newestShortened,
      nonTextMessages: transcriptSeedSource(messages).nonTextMessages,
    },
  });
  const copied = messages.map((message) => {
    if (!message.id)
      throw new ConversationForkContextError(
        'Selected context has no stable message identity.',
      );
    const legacy =
      'content' in message && typeof message.content === 'string'
        ? message.content
        : undefined;
    const parts = Array.isArray(message.parts)
      ? message.parts
      : legacy !== undefined
        ? [{ type: 'text', text: legacy }]
        : undefined;
    if (!parts)
      throw new ConversationForkContextError(
        'Selected context has an unsupported message body.',
      );
    return {
      ...message,
      parts,
      id: createHash('sha256')
        .update(`${input.forkEventId}\0${message.id}`)
        .digest('hex'),
      metadata: { ...message.metadata, forkSourceMessageId: message.id },
    };
  });
  const body = {
    ...identity,
    protocolVersion: 1 as const,
    title: `Fork of ${sourceTitle}`,
    copiedMessagesJson: JSON.stringify(copied),
    seedPinJson: JSON.stringify(seedPin),
  };
  const snapshot = { ...body, digest: contextDigest(body) };
  const json = JSON.stringify(snapshot);
  if (Buffer.byteLength(json, 'utf8') > FORK_CONTEXT_MAX_BYTES)
    throw new ConversationForkContextError(
      'Selected fork context exceeds the bounded import size.',
    );
  return readConversationForkContext(json);
}

/** Stored bodies came from the unified serve-sanitized reader, not a request payload. */
function copiedForkMessages(
  snapshot: ConversationForkContextSnapshot,
): ConversationMessage[] {
  const messages = JSON.parse(
    snapshot.copiedMessagesJson,
  ) as ConversationMessage[];
  if (
    !Array.isArray(messages) ||
    messages.some(
      (message) =>
        !message ||
        typeof message.id !== 'string' ||
        !['user', 'assistant', 'system'].includes(message.role) ||
        !Array.isArray(message.parts),
    )
  )
    throw new Error('Saved fork context is unavailable.');
  return messages.map((message) => ({
    ...message,
    metadata: {
      ...message.metadata,
      forkOrigin: { eventId: snapshot.forkEventId, digest: snapshot.digest },
    },
  }));
}

/** The framework prompt copy is text-only; the immutable snapshot retains rich history. */
export function forkMemoryMessages(
  snapshot: ConversationForkContextSnapshot,
): UIMessage[] {
  return copiedForkMessages(snapshot).flatMap<UIMessage>((message) => {
    const entry = transcriptSeedSource([message]).entries[0];
    if (!entry) return [];
    return [
      {
        id: message.id,
        role: entry.role,
        parts: [{ type: 'text', text: entry.text }],
        metadata: { ...message.metadata },
      },
    ];
  });
}

export function readConversationForkContext(
  json: string,
): ConversationForkContextSnapshot {
  try {
    if (Buffer.byteLength(json, 'utf8') > FORK_CONTEXT_MAX_BYTES)
      throw new Error('size');
    const snapshot = snapshotSchema.parse(JSON.parse(json));
    if (contextDigest(snapshot) !== snapshot.digest) throw new Error('digest');
    readConversationContextSeedPin(snapshot.seedPinJson);
    copiedForkMessages(snapshot);
    return snapshot;
  } catch {
    throw new ConversationForkContextError(
      'Saved fork context is unavailable.',
    );
  }
}

export function forkRequestMatches(
  snapshot: ConversationForkContextReference,
  input: {
    sourceAgent: string;
    targetAgent: string;
    requestedProjectSlug?: string;
    requestedBranchPointTurnId?: string;
  },
): boolean {
  return (
    snapshot.sourceAgent === input.sourceAgent &&
    snapshot.targetAgent === input.targetAgent &&
    snapshot.requestedProjectSlug === input.requestedProjectSlug &&
    snapshot.requestedBranchPointTurnId === input.requestedBranchPointTurnId
  );
}

export interface InitialConversationForkContext {
  contextId: string;
  contextDigest: string;
  seed: ReturnType<typeof readConversationContextSeedPin>;
  fallbackClientTurnId: string;
}

export interface ForkConversationTranscriptRead {
  messages: ConversationMessage[];
  ownerUserId: string;
  prefersRuntime: boolean;
}

const originSchema = z
  .object({ contextId: z.string(), contextDigest: z.string() })
  .strict();
const carrierSchema = originSchema
  .extend({ seedDigest: z.string(), clientTurnId: z.string() })
  .strict();

export class ConversationForkContextModule {
  constructor(
    private readonly deps: {
      store: () => EventStore | undefined;
      deduplicator: () => TurnDeduplicator | undefined;
      canRead(
        reference: ConversationForkContextReference,
        scope: SessionReadScope,
      ): boolean;
      canStart(
        reference: ConversationForkContextReference,
        actor: {
          userId?: string;
          tenantExecutionContext?: TenantExecutionContext;
        },
      ): boolean;
      canReadSession(threadId: string, scope: SessionReadScope): boolean;
      runtimeMessages(
        threadId: string,
        scope: SessionReadScope,
      ): ConversationMessage[];
      metadata(threadId: string): Record<string, unknown> | undefined;
      nativeMemoryOwnsTranscript(
        threadId: string,
        provider?: ProviderSessionStartInput['provider'],
      ): boolean;
      requiresNativeIdentity(threadId: string): boolean;
    },
  ) {}

  reference(
    id: string,
    scope: SessionReadScope,
  ): ConversationForkContextReference | null | undefined {
    const reference = this.deps.store()?.conversationForkContextReference(id);
    if (!reference) return undefined;
    return reference.state !== 'deleted' && this.deps.canRead(reference, scope)
      ? reference
      : null;
  }

  forRequest(sourceId: string, key: string, scope: SessionReadAuthority) {
    const reference = this.deps
      .store()
      ?.conversationForkContextForRequest(
        sourceId,
        key,
        scope.userId,
        scope.tenantExecutionContext?.tenantId,
      );
    if (reference && !this.deps.canRead(reference, scope))
      throw new ConversationForkContextError(
        'The requested fork was not found.',
      );
    return reference;
  }

  reserve(
    snapshot: ConversationForkContextSnapshot,
    scope: SessionReadAuthority,
  ) {
    const store = this.deps.store();
    if (
      !store ||
      snapshot.ownerUserId !== scope.userId ||
      !this.deps.canRead({ ...snapshot, state: 'prepared' }, scope)
    )
      throw new ConversationForkContextError(
        'The fork request is not authorized.',
      );
    return store.reserveConversationForkContext(snapshot);
  }

  snapshot(id: string, scope: SessionReadScope, ready = false) {
    const reference = this.reference(id, scope);
    if (reference === undefined) return undefined;
    if (!reference || (ready && reference.state !== 'ready'))
      throw new ConversationForkContextError(
        'The requested fork context is unavailable.',
      );
    const snapshot = this.deps.store()?.conversationForkContextSnapshot(id);
    if (!snapshot)
      throw new ConversationForkContextError(
        'Saved fork context is unavailable.',
      );
    return snapshot;
  }

  publish(
    event: CanonicalRuntimeEvent,
    digest: string,
    scope: SessionReadAuthority,
  ): boolean {
    if (
      event.method !== 'conversation.forked' ||
      !this.reference(event.targetConversationId, scope)
    )
      throw new ConversationForkContextError(
        'The requested fork was not found.',
      );
    const store = this.deps.store();
    if (!store)
      throw new ConversationForkContextError(
        'Fork persistence is unavailable.',
      );
    return store.publishConversationForkContext(event, digest);
  }

  private originMatches(
    id: string,
    reference: ConversationForkContextReference,
  ): boolean {
    const origin = originSchema.safeParse(
      this.deps.metadata(id)?.forkContextOrigin,
    );
    return (
      origin.success &&
      origin.data.contextId === reference.forkEventId &&
      origin.data.contextDigest === reference.digest
    );
  }

  transcript(
    id: string,
    scope: SessionReadScope,
  ): ForkConversationTranscriptRead | null | undefined {
    const reference = this.reference(id, scope);
    if (reference === undefined || reference === null) return reference;
    const runtime = this.deps.store()?.readSessionByThread(id);
    if (
      runtime &&
      (!this.deps.canReadSession(id, scope) ||
        !this.originMatches(id, reference))
    )
      return null;
    const snapshot = this.snapshot(id, scope);
    if (!snapshot) return null;
    return {
      messages: [
        ...copiedForkMessages(snapshot),
        ...(runtime ? this.deps.runtimeMessages(id, scope) : []),
      ],
      ownerUserId: reference.ownerUserId,
      prefersRuntime: !runtime || !this.deps.nativeMemoryOwnsTranscript(id),
    };
  }

  copiedForSession(id: string, scope: SessionReadScope): ConversationMessage[] {
    if (!this.deps.canReadSession(id, scope)) return [];
    const reference = this.reference(id, scope);
    if (
      !reference ||
      reference.state !== 'ready' ||
      !this.originMatches(id, reference)
    )
      return [];
    const snapshot = this.snapshot(id, scope, true);
    return snapshot ? copiedForkMessages(snapshot) : [];
  }

  initial(
    id: string,
    agent: string,
    projectSlug: string | undefined,
    userId: string | undefined,
    scope: SessionReadAuthority,
  ): InitialConversationForkContext | undefined {
    const store = this.deps.store();
    const reference = this.reference(id, scope);
    if (reference === undefined) {
      if (
        store?.readConversationForkProvenance(id).forkedFrom?.continuation ===
        'replay-seed'
      )
        throw new ConversationForkContextError(
          'This legacy fork has no verified saved context. Create a new fork explicitly.',
        );
      return undefined;
    }
    if (
      !reference ||
      reference.state !== 'ready' ||
      !userId ||
      userId !== scope.userId ||
      reference.targetAgent !== agent ||
      reference.projectSlug !== projectSlug ||
      store?.readSessionByThread(id)
    )
      throw new ConversationForkContextError(
        'The fork does not match this first-start request.',
      );
    const snapshot = this.snapshot(id, scope, true);
    if (!snapshot)
      throw new ConversationForkContextError(
        'Saved fork context is unavailable.',
      );
    return {
      contextId: reference.forkEventId,
      contextDigest: reference.digest,
      seed: readConversationContextSeedPin(snapshot.seedPinJson),
      fallbackClientTurnId: `fork:${createHash('sha256').update(reference.forkEventId).digest('hex')}`,
    };
  }

  assertStart(
    input: ProviderSessionStartInput,
    actor: { userId?: string; tenantExecutionContext?: TenantExecutionContext },
  ): void {
    const reference = this.deps
      .store()
      ?.conversationForkContextReference(input.threadId);
    if (!reference) return;
    const origin = originSchema.safeParse(input.metadata?.forkContextOrigin);
    if (
      reference.state !== 'ready' ||
      !this.deps.canStart(reference, actor) ||
      !origin.success ||
      origin.data.contextId !== reference.forkEventId ||
      origin.data.contextDigest !== reference.digest ||
      input.metadata?.agentSlug !== reference.targetAgent ||
      input.metadata?.projectSlug !== reference.projectSlug
    )
      throw new ConversationForkContextError(
        'The fork context no longer authorizes this provider start.',
      );
    if (!this.deps.nativeMemoryOwnsTranscript(input.threadId, input.provider)) {
      const carrier = carrierSchema.safeParse(input.metadata?.forkSeedCarrier);
      const snapshot = this.deps
        .store()
        ?.conversationForkContextSnapshot(input.threadId);
      if (
        !snapshot ||
        !carrier.success ||
        carrier.data.contextId !== reference.forkEventId ||
        carrier.data.contextDigest !== reference.digest ||
        carrier.data.seedDigest !==
          readConversationContextSeedPin(snapshot.seedPinJson).seedDigest
      )
        throw new ConversationForkContextError(
          'The fork seed carrier does not match its saved context.',
        );
    }
  }

  async delivery(id: string, scope: SessionReadScope) {
    const reference = this.reference(id, scope);
    if (reference === undefined) return undefined;
    if (
      !reference ||
      reference.state !== 'ready' ||
      !this.originMatches(id, reference)
    )
      throw new ConversationForkContextError(
        'The requested fork context is unavailable.',
      );
    if (this.deps.nativeMemoryOwnsTranscript(id)) return undefined;
    const carrier = carrierSchema.safeParse(
      this.deps.metadata(id)?.forkSeedCarrier,
    );
    const store = this.deps.store();
    if (
      !store ||
      !carrier.success ||
      carrier.data.contextId !== reference.forkEventId ||
      carrier.data.contextDigest !== reference.digest
    )
      throw new ConversationForkContextError(
        'The fork seed carrier is unavailable.',
      );
    return observeConversationSeedTurn({
      store,
      deduplicator: this.deps.deduplicator(),
      threadId: id,
      clientTurnId: carrier.data.clientTurnId,
      expected: {
        kind: 'fork',
        contextId: reference.forkEventId,
        contextDigest: reference.digest,
        seedDigest: carrier.data.seedDigest,
      },
      requiresNativeIdentity: this.deps.requiresNativeIdentity(id),
    });
  }

  assertTurnCurrent(
    input: ProviderSendTurnInput,
    actor: { userId?: string; tenantExecutionContext?: TenantExecutionContext },
  ): void {
    const store = this.deps.store();
    const reference = store?.conversationForkContextReference(input.threadId);
    if (!reference) return;
    if (
      reference.state !== 'ready' ||
      !this.deps.canStart(reference, actor) ||
      !this.originMatches(input.threadId, reference)
    )
      throw new ConversationForkContextError(
        'The requested fork context is unavailable.',
      );
    if (this.deps.nativeMemoryOwnsTranscript(input.threadId)) return;
    const carrier = carrierSchema.safeParse(
      this.deps.metadata(input.threadId)?.forkSeedCarrier,
    );
    if (
      !carrier.success ||
      carrier.data.contextId !== reference.forkEventId ||
      carrier.data.contextDigest !== reference.digest
    )
      throw new ConversationForkContextError(
        'The fork seed carrier is unavailable.',
      );
    if (input.clientTurnId === carrier.data.clientTurnId) {
      const snapshot = store!.conversationForkContextSnapshot(input.threadId);
      if (
        snapshot &&
        input.ambientContext?.includes(
          readConversationContextSeedPin(snapshot.seedPinJson).text,
        )
      )
        return;
    }
    const witness = store!.conversationSeedWitness(
      input.threadId,
      carrier.data.clientTurnId,
    );
    if (
      !witness ||
      witness.kind !== 'fork' ||
      witness.contextId !== reference.forkEventId ||
      witness.contextDigest !== reference.digest ||
      witness.seedDigest !== carrier.data.seedDigest ||
      (witness.nativeIdentityKey !== undefined &&
        !store!.contextSeedWitnessHasCurrentNativeBinding(witness)) ||
      (this.deps.requiresNativeIdentity(input.threadId) &&
        witness.nativeIdentityKey === undefined)
    )
      throw new ConversationForkContextError(
        'Fork context delivery is not qualified for this provider turn.',
      );
  }

  deleteUnstarted(id: string, scope: SessionReadScope): boolean {
    const reference = this.reference(id, scope);
    if (reference === undefined) return false;
    if (!reference)
      throw new ConversationForkContextError(
        'The requested fork was not found.',
      );
    this.deps.store()!.deleteUnstartedConversationForkContext(id);
    return true;
  }
}
