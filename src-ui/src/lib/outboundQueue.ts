/**
 * Durable offline message dispatch.
 *
 * `outboundDispatch` is the Module callers cross. Its Interface accepts an
 * intent, invokes a supplied transport Adapter, and projects durable state.
 * It owns the important ordering invariant: before the Adapter is called the
 * intent is durably `invoking`; after that point it is never replayed unless
 * the Adapter proves a pre-invocation rejection. A possibly-started turn is
 * evidence, not cache data, so it is visible after restart and is neither
 * pruned nor evicted.
 *
 * Terminal reconciliation is exact `(sessionId, providerTurnId)` only. Its
 * one-shot terminal evidence is part of the same locked queue state as the
 * accepted row, so tabs cannot consume another session's evidence or race a
 * second terminal mutation.
 */
import { createStore, get, set, update } from 'idb-keyval';
import type { FileAttachment } from '../types';

export type OutboundDispatchStatus =
  | 'pending'
  | 'invoking'
  | 'accepted'
  | 'failed'
  | 'may-have-started';

export interface QueuedOutboundTurn {
  clientTurnId: string;
  sessionId: string;
  agentSlug: string;
  conversationId?: string;
  content: string;
  attachments?: FileAttachment[];
  ambientContext?: string;
  requestedModel?: string | null;
  requestedProviderOptions?: Record<string, unknown>;
  model?: string;
  providerOptions?: Record<string, unknown>;
  createdAt: number;
  attempts: number;
  status: OutboundDispatchStatus;
  lastError?: string;
  lastAttemptAt?: number;
  /** Private claim facts are persisted only so another tab cannot replay. */
  dispatchBootId?: string;
  claimedAt?: number;
  /** Provider turn identity, only when the transport can prove it. */
  providerTurnId?: string;
  /**
   * The original pending rows collapsed into this opt-in text merge. Keeping
   * their complete pre-send records makes the merge reversible until this row
   * is claimed for dispatch; it is never provider-effect evidence.
   */
  mergedTurns?: QueuedOutboundTurn[];
}

import { WORKSPACE_REFUSAL_PREFIX } from './workspaceRefusal';

export {
  isWorkspaceRefusedTurn,
  WORKSPACE_REFUSAL_PREFIX,
} from './workspaceRefusal';

/** The durable queue's own terminal workspace-refusal signal. */

/**
 * The caller-facing projection. Claim fencing stays inside this Module; a
 * transport Adapter can act on an intent but cannot copy or manufacture its
 * durable claim.
 */
export type OutboundDispatchTurn = Omit<
  QueuedOutboundTurn,
  'dispatchBootId' | 'claimedAt'
>;

export interface OutboundDispatchIntent
  extends Omit<
    QueuedOutboundTurn,
    | 'attempts'
    | 'status'
    | 'createdAt'
    | 'lastError'
    | 'lastAttemptAt'
    | 'dispatchBootId'
    | 'claimedAt'
    | 'providerTurnId'
  > {
  createdAt?: number;
}

export interface OutboundDispatchClaim {
  /** The Adapter knows an invocation may have started. This never replays. */
  indeterminate(reason: string): Promise<OutboundSettlement>;
}

export type OutboundSettlement =
  | 'applied'
  | 'already-applied'
  | 'stale'
  | 'unavailable';

/**
 * The transport Adapter must make its invocation fact explicit. `not-invoked`
 * is permitted only for a gate reached before the provider call. Any error,
 * abort, or offline result after invocation throws or calls `indeterminate`,
 * and is therefore retained as possible-effect evidence.
 */
export type OutboundDispatchTransportResult =
  | { kind: 'accepted'; providerTurnId: string }
  /** A temporary pre-provider gate. Releasing it must not consume an attempt. */
  | { kind: 'deferred'; reason?: string }
  | { kind: 'not-invoked'; reason?: string };

/** The transport Adapter receives no raw storage or claim identity. */
export type OutboundDispatchTransport = (
  turn: Readonly<OutboundDispatchTurn>,
  claim: OutboundDispatchClaim,
) => Promise<OutboundDispatchTransportResult>;

export type OutboundFlushOutcome = 'drained' | 'unavailable';

/** A queue-relative movement intent, resolved inside the durable update. */
export type OutboundQueueMoveDirection = 'up' | 'down';

export interface OutboundDispatchModule {
  enqueue(
    intent: OutboundDispatchIntent,
    error?: unknown,
  ): Promise<OutboundDispatchTurn>;
  open(): Promise<OutboundDispatchTurn[]>;
  snapshot(): Promise<OutboundDispatchTurn[]>;
  subscribe(listener: () => void): () => void;
  fenceConversationHandoff<T>(
    input: { conversationId: string; sessionId: string },
    effect: () => Promise<T>,
  ): Promise<
    { status: 'blocked'; count: number } | { status: 'completed'; value: T }
  >;
  flush(
    transport: OutboundDispatchTransport,
    options?: { blockedSessionIds?: ReadonlySet<string> },
  ): Promise<OutboundFlushOutcome>;
  /**
   * A terminal event may remove an accepted head only when it names the same
   * provider turn the transport durably recorded.
   */
  completeAcceptedTurn(
    sessionId: string,
    providerTurnId: string,
  ): Promise<void>;
  discard(clientTurnId: string): Promise<void>;
  edit(clientTurnId: string, content: string): Promise<OutboundDispatchTurn>;
  reorder(
    clientTurnId: string,
    direction: OutboundQueueMoveDirection,
  ): Promise<OutboundDispatchTurn>;
  merge(
    clientTurnId: string,
    nextClientTurnId: string,
  ): Promise<OutboundDispatchTurn>;
  unmerge(clientTurnId: string): Promise<void>;
  retry(clientTurnId: string): Promise<void>;
}

/** Oldest-first ordinary-cache ceiling. Protected evidence is never evicted. */
export const OUTBOUND_QUEUE_MAX_ENTRIES = 50;
export const OUTBOUND_QUEUE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
export const OUTBOUND_QUEUE_MAX_ATTEMPTS = 5;

export class OutboundDispatchCapacityError extends Error {
  constructor() {
    super(
      'Offline queue retains possible-effect messages; inspect them before queuing another.',
    );
    this.name = 'OutboundDispatchCapacityError';
  }
}

/** Private storage Adapter. Tests supply the same transaction-shaped fake. */
export interface OutboundQueueStorage {
  getItem(key: string): Promise<unknown>;
  setItem(key: string, value: unknown): Promise<void>;
  updateItem?(key: string, updater: (value: unknown) => unknown): Promise<void>;
}

interface TerminalEvidence {
  sessionId: string;
  providerTurnId: string;
  observedAt: number;
}

interface OutboundQueueState {
  version: 2;
  turns: QueuedOutboundTurn[];
  terminalEvidence: TerminalEvidence[];
  /** Bounded exact tombstones ignore a replayed terminal after completion. */
  completedTerminals: TerminalEvidence[];
}

/** Legacy array reads remain supported; all writes use this private state. */
type OutboundQueuePersisted = OutboundQueueState | QueuedOutboundTurn[];

const IDB_DATABASE_NAME = 'station-outbound-queue';
const IDB_STORE_NAME = 'queue';
const STORAGE_KEY = 'station-outbound-queue-v1';
const TERMINAL_EVIDENCE_MAX_ENTRIES = 128;

class OutboundQueueStateError extends Error {
  constructor() {
    super('Outbound queue state is malformed and was left unchanged.');
    this.name = 'OutboundQueueStateError';
  }
}

/** Error-only foreground receipt projection, kept with the lazy queue Module. */
export function readForeground(error: unknown):
  | {
      sessionId?: string;
      translation: {
        title: string;
        body: string;
        hint: string;
        indeterminateSession: true;
      };
    }
  | undefined {
  const candidate = error as {
    code?: unknown;
    outcome?: unknown;
    detail?: { session?: { threadId?: unknown } };
  };
  if (
    candidate.code !== 'foreground_message_indeterminate' ||
    candidate.outcome !== 'indeterminate'
  ) {
    return undefined;
  }
  const sessionId =
    typeof candidate.detail?.session?.threadId === 'string'
      ? candidate.detail.session.threadId
      : undefined;
  return {
    ...(sessionId ? { sessionId } : {}),
    translation: {
      title: 'Session start needs confirmation',
      body: sessionId
        ? `Station may already have started session ${sessionId}. Your message was not sent again.`
        : 'Station may already have started this session. Your message was not sent again.',
      hint: 'Open the session and wait for its events before sending another message.',
      indeterminateSession: true,
    },
  };
}

/**
 * Why a send could not be delivered, named for what was actually observed.
 *
 * Neither value asserts the network's condition, because this device cannot
 * observe it:
 *
 * - `send-unconfirmed` — the request threw before producing a response. It is
 *   NOT proof the request never arrived: the SDK's `isProvablyNotSent` exists
 *   precisely because a bare `TypeError` is what the browser also throws for
 *   post-send failures (`chatRuntimeOrchestration.ts`). All we know is that no
 *   answer came back.
 * - `browser-reports-offline` — `navigator.onLine` is false. Named for the
 *   reporter, not the fact, because this repo's own connection layer refuses
 *   to trust that signal: `useConnectionStatus` hardcodes `online: true` and
 *   documents why — "navigator.onLine reports link-layer state, not
 *   reachability. Mobile WebViews can report false while a tailnet/VPN route
 *   is healthy." A flag the reachability layer will not believe cannot be the
 *   basis for telling the user they are offline.
 */
export type UndeliverableSendCause =
  | 'send-unconfirmed'
  | 'browser-reports-offline';

/**
 * archive#3686: this used to be `isOffline`, returning one boolean, and the
 * composer printed "Offline — sends on reconnect" for every case. The name
 * asserted a device network state; the derivation was "a fetch threw". A user
 * watching the app work in another tab was told they were offline.
 *
 * Returns null for a failure that produced a RESPONSE — the address answered,
 * so nothing here is undeliverable, whatever the browser thinks of the
 * network. That send falls through to the ordinary error path, which restores
 * the draft to the composer (`rejectedSendRollback`) rather than queueing it
 * for a retry that cannot help.
 *
 * Order matters: response evidence outranks `navigator.onLine`, because the
 * response is a fact this device observed and the flag is a report about
 * hardware.
 */
export function classifyUndeliverableSend(
  error: unknown,
): UndeliverableSendCause | null {
  if (hasResponseEvidence(error)) return null;
  if (error instanceof TypeError) {
    // Both are true at once when the browser reports offline AND the fetch
    // threw; the offline report is the more specific thing to tell the user,
    // and it is still only a report.
    return browserReportsOffline()
      ? 'browser-reports-offline'
      : 'send-unconfirmed';
  }
  return browserReportsOffline() ? 'browser-reports-offline' : null;
}

function browserReportsOffline(): boolean {
  return typeof navigator !== 'undefined' && navigator.onLine === false;
}

/**
 * Did this failure carry a server response? A numeric HTTP `status` is the
 * one shape every response-bearing error in this codebase shares
 * (`ChatHttpError` and the SDK's thrown HTTP errors both set it), and a
 * response is proof the address answered.
 */
function hasResponseEvidence(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const status = (error as { status?: unknown }).status;
  return typeof status === 'number' && Number.isFinite(status);
}

function createIdbOutboundQueueStorage(): OutboundQueueStorage {
  if (typeof indexedDB === 'undefined') {
    return {
      getItem: async () => {
        throw new Error('Persistent outbound queue requires IndexedDB');
      },
      setItem: async () => {
        throw new Error('Persistent outbound queue requires IndexedDB');
      },
    };
  }
  const store = createStore(IDB_DATABASE_NAME, IDB_STORE_NAME);
  return {
    getItem: (key) => get<OutboundQueuePersisted>(key, store),
    setItem: (key, value) => set(key, value, store),
    updateItem: (key, updater) => update(key, updater, store),
  };
}

let storage: OutboundQueueStorage = createIdbOutboundQueueStorage();
let mutationTail: Promise<void> = Promise.resolve();
const listeners = new Set<() => void>();
/** A same-renderer safety net when a post-effect IndexedDB transition fails. */
const unavailableClaims = new Set<string>();

function queueState(stored: unknown): OutboundQueueState {
  if (stored === undefined || stored === null) {
    return {
      version: 2,
      turns: [],
      terminalEvidence: [],
      completedTerminals: [],
    };
  }
  if (Array.isArray(stored)) {
    if (!stored.every(isStoredTurn)) throw new OutboundQueueStateError();
    return {
      version: 2,
      turns: stored.map(normalizeEntry),
      terminalEvidence: [],
      completedTerminals: [],
    };
  }
  if (
    stored &&
    (stored as { version?: unknown }).version === 2 &&
    Array.isArray((stored as { turns?: unknown }).turns) &&
    Array.isArray(
      (stored as { terminalEvidence?: unknown }).terminalEvidence,
    ) &&
    ((stored as { completedTerminals?: unknown }).completedTerminals ===
      undefined ||
      Array.isArray(
        (stored as { completedTerminals?: unknown }).completedTerminals,
      ))
  ) {
    const state = stored as OutboundQueueState;
    if (
      !state.turns.every(isStoredTurn) ||
      !state.terminalEvidence.every(isTerminalEvidence) ||
      !(state.completedTerminals ?? []).every(isTerminalEvidence)
    ) {
      throw new OutboundQueueStateError();
    }
    return {
      version: 2,
      turns: state.turns.map(normalizeEntry),
      terminalEvidence: state.terminalEvidence,
      completedTerminals: state.completedTerminals ?? [],
    };
  }
  throw new OutboundQueueStateError();
}

function isStoredTurn(value: unknown): value is QueuedOutboundTurn {
  if (typeof value !== 'object' || value === null) return false;
  const turn = value as Partial<QueuedOutboundTurn>;
  const status = (value as { status?: unknown }).status;
  const knownStatus =
    status === undefined ||
    status === 'pending' ||
    status === 'invoking' ||
    status === 'accepted' ||
    status === 'failed' ||
    status === 'may-have-started' ||
    status === 'dispatching' ||
    status === 'indeterminate';
  return (
    typeof turn.clientTurnId === 'string' &&
    typeof turn.sessionId === 'string' &&
    typeof turn.agentSlug === 'string' &&
    typeof turn.content === 'string' &&
    typeof turn.createdAt === 'number' &&
    typeof turn.attempts === 'number' &&
    knownStatus
  );
}

function isTerminalEvidence(value: unknown): value is TerminalEvidence {
  if (typeof value !== 'object' || value === null) return false;
  const evidence = value as Partial<TerminalEvidence>;
  return (
    typeof evidence.sessionId === 'string' &&
    typeof evidence.providerTurnId === 'string' &&
    typeof evidence.observedAt === 'number'
  );
}

function normalizeEntry(entry: QueuedOutboundTurn): QueuedOutboundTurn {
  // One-way read migration for the short-lived earlier queue vocabulary.
  const legacy = entry as unknown as {
    status?: OutboundDispatchStatus | 'dispatching' | 'indeterminate';
    indeterminateClaim?: boolean;
  };
  const status =
    legacy.status === 'dispatching'
      ? 'invoking'
      : legacy.status === 'indeterminate'
        ? 'may-have-started'
        : (legacy.status ?? 'pending');
  if (
    status === 'accepted' &&
    (typeof entry.providerTurnId !== 'string' ||
      entry.providerTurnId.trim().length === 0)
  ) {
    // Older queue rows were able to call a turn accepted without an exact
    // terminal correlation. They may have started, but can never safely be
    // replayed or presented as accepted.
    return {
      ...entry,
      status: 'may-have-started',
      providerTurnId: undefined,
      lastError:
        'Migration: legacy accepted outbound turn lacks an exact provider turn id.',
    };
  }
  return { ...entry, status };
}

function protectedEvidence(entry: QueuedOutboundTurn): boolean {
  return (
    entry.status === 'invoking' ||
    entry.status === 'accepted' ||
    entry.status === 'may-have-started' ||
    unavailableClaims.has(entry.clientTurnId)
  );
}

function mutationRefusal(
  entry: QueuedOutboundTurn,
  action: 'edited' | 'reordered' | 'merged' | 'unmerged',
): Error {
  const subject =
    action === 'merged' || action === 'unmerged'
      ? 'Queued message'
      : 'Queued turn';
  if (unavailableClaims.has(entry.clientTurnId)) {
    return new Error(
      `${subject} dispatch state is unavailable and cannot be ${action}. Inspect the session instead.`,
    );
  }
  switch (entry.status) {
    case 'invoking':
      return new Error(
        `${subject} is invoking and cannot be ${action}. Inspect the session instead.`,
      );
    case 'accepted':
      return new Error(
        `${subject} was accepted and cannot be ${action}. Inspect the session instead.`,
      );
    case 'may-have-started':
      return new Error(
        `${subject} may have started and cannot be ${action}. Inspect the session instead.`,
      );
    case 'failed':
      return new Error(
        `${subject} was rejected before invocation and cannot be ${action}. Retry or edit it instead.`,
      );
    case 'pending':
      return new Error(`${subject} cannot be ${action}.`);
  }
}

function reorderBarrier(
  moved: QueuedOutboundTurn,
  neighbour: QueuedOutboundTurn | undefined,
): boolean {
  return (
    neighbour?.sessionId === moved.sessionId &&
    (neighbour.status === 'accepted' ||
      neighbour.status === 'invoking' ||
      neighbour.status === 'may-have-started' ||
      unavailableClaims.has(neighbour.clientTurnId))
  );
}

function publicTurn(entry: QueuedOutboundTurn): OutboundDispatchTurn {
  const {
    dispatchBootId: _dispatchBootId,
    claimedAt: _claimedAt,
    ...turn
  } = entry;
  return Object.freeze(turn);
}

function mergedContent(entries: readonly QueuedOutboundTurn[]): string {
  return entries.map((entry) => entry.content).join('\n\n');
}

function mergedAttachments(
  entries: readonly QueuedOutboundTurn[],
): FileAttachment[] | undefined {
  const attachments = entries.flatMap((entry) => entry.attachments ?? []);
  return attachments.length ? attachments : undefined;
}

function prune(
  entries: readonly QueuedOutboundTurn[],
  now: number,
): QueuedOutboundTurn[] {
  const retained = entries
    .map(normalizeEntry)
    .filter(
      (entry) =>
        protectedEvidence(entry) ||
        now - entry.createdAt <= OUTBOUND_QUEUE_MAX_AGE_MS,
    );
  const overflow = Math.max(0, retained.length - OUTBOUND_QUEUE_MAX_ENTRIES);
  if (overflow === 0) return retained;
  const evicted = new Set(
    retained
      .filter((entry) => !protectedEvidence(entry))
      .sort((a, b) => a.createdAt - b.createdAt)
      .slice(0, overflow)
      .map((entry) => entry.clientTurnId),
  );
  return retained.filter((entry) => !evicted.has(entry.clientTurnId));
}

function notify(): void {
  // Subscription is observation, not a participant in the durable
  // transition. A throwing UI listener must not starve the others or turn an
  // already-settled dispatch into a rejection.
  for (const listener of listeners) {
    try {
      listener();
    } catch {
      // Deliberately isolated.
    }
  }
}

async function withQueueLock<T>(operation: () => Promise<T>): Promise<T> {
  const { withOutboundQueueLock } = await import('./outboundQueueLease');
  return withOutboundQueueLock(operation);
}

async function rendererBootId(): Promise<string> {
  const { rendererBootId } = await import('./outboundQueueLease');
  return rendererBootId;
}

function serialize<T>(operation: () => Promise<T>): Promise<T> {
  const result = mutationTail.then(operation, operation);
  mutationTail = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

async function mutate<T>(
  operation: (entries: QueuedOutboundTurn[]) => {
    entries: QueuedOutboundTurn[];
    result: T;
    changed: boolean;
  },
): Promise<T> {
  let result!: T;
  let changed = false;
  const apply = () =>
    storage.updateItem!(STORAGE_KEY, (stored) => {
      const state = queueState(stored);
      const outcome = operation(prune(state.turns, Date.now()));
      result = outcome.result;
      changed = outcome.changed;
      return {
        ...state,
        turns: prune(outcome.entries, Date.now()),
      };
    });
  if (storage.updateItem) {
    await withQueueLock(apply);
  } else {
    await serialize(async () => {
      const state = await readState();
      const outcome = operation(state.turns);
      result = outcome.result;
      changed = outcome.changed;
      if (changed) {
        await storage.setItem(STORAGE_KEY, {
          ...state,
          turns: prune(outcome.entries, Date.now()),
        });
      }
    });
  }
  if (changed) notify();
  return result;
}

async function mutateState<T>(
  operation: (state: OutboundQueueState) => {
    state: OutboundQueueState;
    result: T;
    changed: boolean;
  },
): Promise<T> {
  let result!: T;
  let changed = false;
  const apply = () =>
    storage.updateItem!(STORAGE_KEY, (stored) => {
      const outcome = operation(queueState(stored));
      result = outcome.result;
      changed = outcome.changed;
      return {
        ...outcome.state,
        turns: prune(outcome.state.turns, Date.now()),
      };
    });
  if (storage.updateItem) {
    await withQueueLock(apply);
  } else {
    await serialize(async () => {
      const outcome = operation(await readState());
      result = outcome.result;
      changed = outcome.changed;
      if (changed) {
        await storage.setItem(STORAGE_KEY, {
          ...outcome.state,
          turns: prune(outcome.state.turns, Date.now()),
        });
      }
    });
  }
  if (changed) notify();
  return result;
}

async function readState(): Promise<OutboundQueueState> {
  return queueState(await storage.getItem(STORAGE_KEY));
}

async function readStored(): Promise<QueuedOutboundTurn[]> {
  return prune((await readState()).turns, Date.now());
}

async function fenceConversationHandoff<T>(
  input: { conversationId: string; sessionId: string },
  effect: () => Promise<T>,
): Promise<
  { status: 'blocked'; count: number } | { status: 'completed'; value: T }
> {
  return withQueueLock(async () => {
    const count = (await readStored()).filter(
      (turn) =>
        turn.conversationId === input.conversationId ||
        turn.sessionId === input.sessionId,
    ).length;
    if (count > 0) return { status: 'blocked', count };
    return { status: 'completed', value: await effect() };
  });
}

function exact(
  entry: QueuedOutboundTurn,
  claimed: QueuedOutboundTurn,
): boolean {
  return (
    entry.clientTurnId === claimed.clientTurnId &&
    entry.status === 'invoking' &&
    entry.dispatchBootId === claimed.dispatchBootId &&
    entry.claimedAt === claimed.claimedAt
  );
}

async function settle(
  claimed: QueuedOutboundTurn,
  status: 'accepted' | 'failed' | 'may-have-started',
  reason?: string,
  providerTurnId?: string,
): Promise<OutboundSettlement> {
  // Set only inside the locked state updater. If it later throws after a
  // durable write, an absent row is the exact accepted+terminal completion,
  // rather than an unavailable dispatch claim.
  let completedByEarlyTerminal = false;
  try {
    const outcome = await mutateState((state) => {
      const entries = state.turns;
      const index = entries.findIndex((entry) => exact(entry, claimed));
      if (index === -1) {
        const same = entries.find(
          (entry) => entry.clientTurnId === claimed.clientTurnId,
        );
        return {
          state,
          result:
            same?.status === status &&
            (status !== 'accepted' || same.providerTurnId === providerTurnId)
              ? ('already-applied' as const)
              : ('stale' as const),
          changed: false,
        };
      }
      let next = [...entries];
      next[index] = {
        ...next[index]!,
        status,
        lastError:
          status === 'may-have-started'
            ? `Dispatch may have started: ${reason ?? 'transport outcome was unavailable'}`
            : status === 'failed'
              ? `${WORKSPACE_REFUSAL_PREFIX} ${reason ?? 'request was rejected before invocation'}`
              : undefined,
        lastAttemptAt: Date.now(),
        ...(status === 'accepted'
          ? {
              dispatchBootId: undefined,
              claimedAt: undefined,
              providerTurnId,
            }
          : {}),
      };
      let terminalEvidence = state.terminalEvidence;
      let completedTerminals = state.completedTerminals;
      if (status === 'accepted') {
        const evidenceIndex = terminalEvidence.findIndex(
          (evidence) =>
            evidence.sessionId === claimed.sessionId &&
            evidence.providerTurnId === providerTurnId,
        );
        if (evidenceIndex !== -1) {
          // Both facts now share this Web-Lock/transaction. Consume the
          // one-shot terminal only after the exact accepted identity exists.
          next = next.filter((_, candidateIndex) => candidateIndex !== index);
          terminalEvidence = terminalEvidence.filter(
            (_, candidateIndex) => candidateIndex !== evidenceIndex,
          );
          completedTerminals = [
            ...completedTerminals.filter(
              (candidate) =>
                candidate.sessionId !== claimed.sessionId ||
                candidate.providerTurnId !== providerTurnId,
            ),
            {
              sessionId: claimed.sessionId,
              providerTurnId: providerTurnId!,
              observedAt: Date.now(),
            },
          ]
            .sort((left, right) => right.observedAt - left.observedAt)
            .slice(0, TERMINAL_EVIDENCE_MAX_ENTRIES);
          completedByEarlyTerminal = true;
        }
      }
      return {
        state: { ...state, turns: next, terminalEvidence, completedTerminals },
        result: 'applied' as const,
        changed: true,
      };
    });
    if (outcome === 'applied' || outcome === 'already-applied') {
      unavailableClaims.delete(claimed.clientTurnId);
    } else if (status !== 'failed') {
      unavailableClaims.add(claimed.clientTurnId);
    }
    return outcome;
  } catch {
    // A transaction Adapter can report after its write committed. Exact
    // readback distinguishes that idempotent fact from a genuinely
    // unavailable transition without ever releasing a possible effect.
    try {
      const persisted = (await readStored()).find(
        (entry) => entry.clientTurnId === claimed.clientTurnId,
      );
      if (
        persisted?.status === status &&
        (status !== 'accepted' || persisted.providerTurnId === providerTurnId)
      ) {
        unavailableClaims.delete(claimed.clientTurnId);
        return 'already-applied';
      }
      if (status === 'accepted' && completedByEarlyTerminal && !persisted) {
        unavailableClaims.delete(claimed.clientTurnId);
        return 'already-applied';
      }
    } catch {
      // The durable pre-call claim below remains the conservative truth.
    }
    // A provider effect may already exist. The durable pre-call `invoking`
    // record and this same-renderer fence both prohibit a replay.
    unavailableClaims.add(claimed.clientTurnId);
    notify();
    return 'unavailable';
  }
}

async function releaseRejected(
  claimed: QueuedOutboundTurn,
  reason?: string,
): Promise<OutboundSettlement> {
  try {
    return await mutate((entries) => {
      const index = entries.findIndex((entry) => exact(entry, claimed));
      if (index === -1)
        return { entries, result: 'stale' as const, changed: false };
      const attempts = entries[index]!.attempts + 1;
      const next = [...entries];
      next[index] = {
        ...next[index]!,
        attempts,
        status: attempts >= OUTBOUND_QUEUE_MAX_ATTEMPTS ? 'failed' : 'pending',
        lastError: reason,
        lastAttemptAt: Date.now(),
        dispatchBootId: undefined,
        claimedAt: undefined,
      };
      return { entries: next, result: 'applied' as const, changed: true };
    });
  } catch {
    // This path is only entered for an Adapter's definite pre-effect outcome.
    // Storage uncertainty is nevertheless conservative: do not replay it.
    unavailableClaims.add(claimed.clientTurnId);
    notify();
    return 'unavailable';
  }
}

async function releaseDeferred(
  claimed: QueuedOutboundTurn,
): Promise<OutboundSettlement> {
  try {
    return await mutate((entries) => {
      const index = entries.findIndex((entry) => exact(entry, claimed));
      if (index === -1)
        return { entries, result: 'stale' as const, changed: false };
      const next = [...entries];
      next[index] = {
        ...next[index]!,
        status: 'pending',
        dispatchBootId: undefined,
        claimedAt: undefined,
      };
      return { entries: next, result: 'applied' as const, changed: true };
    });
  } catch {
    unavailableClaims.add(claimed.clientTurnId);
    notify();
    return 'unavailable';
  }
}

interface InternalClaim {
  readonly public: OutboundDispatchClaim;
  readonly settled: () => boolean;
  readonly state: () => 'may-have-started' | undefined;
  readonly outcome: () => OutboundSettlement | undefined;
}

function claimCapability(claimed: QueuedOutboundTurn): InternalClaim {
  let latched: 'may-have-started' | undefined;
  let settlement: OutboundSettlement | undefined;
  const transition = async (reason: string): Promise<OutboundSettlement> => {
    if (latched) return 'already-applied';
    latched = 'may-have-started';
    settlement = await settle(claimed, 'may-have-started', reason);
    return settlement;
  };
  return {
    public: {
      indeterminate: transition,
    },
    settled: () => latched !== undefined,
    state: () => latched,
    outcome: () => settlement,
  };
}

async function claimNext(
  blockedSessions: ReadonlySet<string>,
): Promise<QueuedOutboundTurn | undefined> {
  const bootId = await rendererBootId();
  const claimedAt = Date.now();
  return mutate((entries) => {
    const candidate = entries.find(
      (entry, index) =>
        entry.status === 'pending' &&
        !blockedSessions.has(entry.sessionId) &&
        !entries
          .slice(0, index)
          .some((earlier) => earlier.sessionId === entry.sessionId),
    );
    if (!candidate) return { entries, result: undefined, changed: false };
    const index = entries.indexOf(candidate);
    const claimed = {
      ...candidate,
      status: 'invoking' as const,
      dispatchBootId: bootId,
      claimedAt,
      lastAttemptAt: claimedAt,
    };
    const next = [...entries];
    next[index] = claimed;
    return { entries: next, result: claimed, changed: true };
  });
}

async function enqueue(
  intent: OutboundDispatchIntent,
  error?: unknown,
): Promise<OutboundDispatchTurn> {
  // Runtime callers can still be untyped JavaScript. Provider terminal
  // evidence is produced only by an accepted transport result, never trusted
  // from an enqueue intent.
  const { providerTurnId: _ignoredProviderTurnId, ...safeIntent } =
    intent as OutboundDispatchIntent & { providerTurnId?: unknown };
  const now = safeIntent.createdAt ?? Date.now();
  return mutate((entries) => {
    const index = entries.findIndex(
      (entry) => entry.clientTurnId === safeIntent.clientTurnId,
    );
    const lastError = error instanceof Error ? error.message : undefined;
    if (index === -1) {
      // A pending draft has no possible provider effect, so the Module may
      // evict the oldest ordinary draft to make room. Fenced evidence is never
      // an admission victim.
      const requiredEvictions = Math.max(
        0,
        entries.length - OUTBOUND_QUEUE_MAX_ENTRIES + 1,
      );
      const evicted = new Set(
        entries
          .filter(
            (entry) => entry.status === 'pending' || entry.status === 'failed',
          )
          .sort((a, b) => a.createdAt - b.createdAt)
          .slice(0, requiredEvictions)
          .map((entry) => entry.clientTurnId),
      );
      if (evicted.size !== requiredEvictions)
        throw new OutboundDispatchCapacityError();
      const retained = entries.filter(
        (entry) => !evicted.has(entry.clientTurnId),
      );
      const next: QueuedOutboundTurn = {
        ...safeIntent,
        createdAt: now,
        attempts: 1,
        status: 'pending',
        lastError,
        lastAttemptAt: now,
      };
      return { entries: [...retained, next], result: next, changed: true };
    }
    const existing = entries[index]!;
    if (protectedEvidence(existing)) {
      return { entries, result: existing, changed: false };
    }
    const attempts = existing.attempts + 1;
    const next: QueuedOutboundTurn = {
      ...existing,
      ...safeIntent,
      createdAt: existing.createdAt,
      attempts,
      status: attempts >= OUTBOUND_QUEUE_MAX_ATTEMPTS ? 'failed' : 'pending',
      lastError,
      lastAttemptAt: now,
      dispatchBootId: undefined,
      claimedAt: undefined,
      providerTurnId: undefined,
    };
    const replacement = [...entries];
    replacement[index] = next;
    return { entries: replacement, result: next, changed: true };
  }).then(publicTurn);
}

async function discard(clientTurnId: string): Promise<void> {
  await mutate((entries) => {
    const entry = entries.find(
      (candidate) => candidate.clientTurnId === clientTurnId,
    );
    if (!entry) return { entries, result: undefined, changed: false };
    if (protectedEvidence(entry)) {
      throw new Error(
        'Queued turn may have started and cannot be withdrawn. Inspect the session instead.',
      );
    }
    return {
      entries: entries.filter(
        (candidate) => candidate.clientTurnId !== clientTurnId,
      ),
      result: undefined,
      changed: true,
    };
  });
}

async function edit(
  clientTurnId: string,
  content: string,
): Promise<OutboundDispatchTurn> {
  const trimmed = content.trim();
  if (!trimmed) throw new Error('Queued turn content must not be empty');
  return mutate((entries) => {
    const index = entries.findIndex(
      (entry) => entry.clientTurnId === clientTurnId,
    );
    if (index === -1) throw new Error('Queued turn no longer exists');
    if (protectedEvidence(entries[index]!)) {
      throw mutationRefusal(entries[index]!, 'edited');
    }
    const edited = {
      ...entries[index]!,
      clientTurnId: crypto.randomUUID(),
      content: trimmed,
    };
    const next = [...entries];
    next[index] = edited;
    return { entries: next, result: edited, changed: true };
  }).then(publicTurn);
}

async function reorder(
  clientTurnId: string,
  direction: OutboundQueueMoveDirection,
): Promise<OutboundDispatchTurn> {
  return mutate((entries) => {
    const index = entries.findIndex(
      (entry) => entry.clientTurnId === clientTurnId,
    );
    if (index === -1) throw new Error('Queued turn no longer exists');
    const moved = entries[index]!;
    if (protectedEvidence(moved)) throw mutationRefusal(moved, 'reordered');
    const target = direction === 'up' ? index - 1 : index + 1;
    if (target < 0 || target >= entries.length) {
      return { entries, result: entries[index]!, changed: false };
    }
    if (reorderBarrier(moved, entries[target])) {
      throw new Error(
        'Queued message cannot cross an in-flight message from the same session.',
      );
    }
    const next = [...entries];
    next.splice(index, 1);
    next.splice(target, 0, moved!);
    return { entries: next, result: moved!, changed: true };
  }).then(publicTurn);
}

async function merge(
  clientTurnId: string,
  nextClientTurnId: string,
): Promise<OutboundDispatchTurn> {
  return mutate((entries) => {
    const index = entries.findIndex(
      (entry) => entry.clientTurnId === clientTurnId,
    );
    if (index === -1) throw new Error('Queued turn no longer exists');
    const current = entries[index]!;
    const nextTurn = entries[index + 1];
    if (!nextTurn || nextTurn.clientTurnId !== nextClientTurnId) {
      throw new Error('Queued messages must be adjacent to merge.');
    }
    if (current.status !== 'pending') throw mutationRefusal(current, 'merged');
    if (nextTurn.status !== 'pending')
      throw mutationRefusal(nextTurn, 'merged');
    if (current.sessionId !== nextTurn.sessionId) {
      throw new Error('Only messages from the same session can be merged.');
    }
    // A merged row can itself be edited before a later merge. The user sees
    // the current row contents, so the persisted composite must compose those
    // visible values and retain the current merge tree for reversible undo.
    const displayedTurns = [current, nextTurn];
    const merged: QueuedOutboundTurn = {
      ...current,
      clientTurnId: crypto.randomUUID(),
      content: mergedContent(displayedTurns),
      attachments: mergedAttachments(displayedTurns),
      mergedTurns: displayedTurns,
    };
    const replacement = [...entries];
    replacement.splice(index, 2, merged);
    return { entries: replacement, result: merged, changed: true };
  }).then(publicTurn);
}

async function unmerge(clientTurnId: string): Promise<void> {
  await mutate((entries) => {
    const index = entries.findIndex(
      (entry) => entry.clientTurnId === clientTurnId,
    );
    if (index === -1) throw new Error('Queued turn no longer exists');
    const merged = entries[index]!;
    if (protectedEvidence(merged)) {
      throw mutationRefusal(merged, 'unmerged');
    }
    if (!merged.mergedTurns?.length) {
      throw new Error('Queued turn is not a merged message.');
    }
    const replacement = [...entries];
    replacement.splice(index, 1, ...merged.mergedTurns.map(normalizeEntry));
    return { entries: replacement, result: undefined, changed: true };
  });
}

async function retry(clientTurnId: string): Promise<void> {
  await mutate((entries) => {
    const index = entries.findIndex(
      (entry) => entry.clientTurnId === clientTurnId,
    );
    if (index === -1) throw new Error('Queued turn no longer exists');
    if (protectedEvidence(entries[index]!)) {
      throw new Error(
        'Queued turn may have started; inspect the session instead of retrying it.',
      );
    }
    const next = [...entries];
    next[index] = {
      ...next[index]!,
      attempts: 0,
      status: 'pending',
      lastError: undefined,
      lastAttemptAt: undefined,
    };
    return { entries: next, result: undefined, changed: true };
  });
}

async function flush(
  transport: OutboundDispatchTransport,
  options?: { blockedSessionIds?: ReadonlySet<string> },
): Promise<OutboundFlushOutcome> {
  const blockedSessions = new Set(options?.blockedSessionIds);
  let unavailable = false;
  while (true) {
    let claimed: QueuedOutboundTurn | undefined;
    try {
      claimed = await claimNext(blockedSessions);
    } catch {
      // Storage cannot prove a claim was not durably written. A later flush
      // must inspect the retained row; this pass simply makes no transport
      // call rather than guessing it is safe to replay.
      return 'unavailable';
    }
    if (!claimed) return unavailable ? 'unavailable' : 'drained';
    const capability = claimCapability(claimed);
    try {
      const result = await transport(publicTurn(claimed), capability.public);
      if (!capability.settled()) {
        if (result.kind === 'accepted') {
          const accepted = await settle(
            claimed,
            'accepted',
            undefined,
            result.providerTurnId,
          );
          if (accepted === 'unavailable' || accepted === 'stale') {
            unavailableClaims.add(claimed.clientTurnId);
            unavailable ||= accepted === 'unavailable';
          }
        } else if (result.kind === 'deferred') {
          const released = await releaseDeferred(claimed);
          unavailable ||= released === 'unavailable';
          blockedSessions.add(claimed.sessionId);
        } else {
          const released = await releaseRejected(
            claimed,
            'Dispatch did not accept the queued message.',
          );
          unavailable ||= released === 'unavailable';
        }
      }
    } catch (error) {
      // An Adapter that throws without using its claim cannot prove that no
      // invocation occurred. Latch it before allowing any observer to react.
      if (!capability.settled()) {
        const settled = await capability.public.indeterminate(
          error instanceof Error
            ? error.message
            : 'transport threw after invocation began',
        );
        unavailable ||= settled === 'unavailable';
      }
    }
    const state = capability.state();
    unavailable ||= capability.outcome() === 'unavailable';
    if (state || protectedEvidence(claimed))
      blockedSessions.add(claimed.sessionId);
  }
}

async function completeAcceptedTurn(
  sessionId: string,
  providerTurnId: string,
): Promise<void> {
  await mutateState((state) => {
    const acceptedIndex = state.turns.findIndex(
      (entry) =>
        entry.sessionId === sessionId &&
        entry.status === 'accepted' &&
        entry.providerTurnId === providerTurnId,
    );
    if (acceptedIndex !== -1) {
      // An already-durable acceptance and terminal settle in one state write.
      // Consume any early evidence for this tuple as well, then retain a
      // bounded tombstone so a duplicate terminal cannot poison a later row.
      const completedTerminals = [
        ...state.completedTerminals.filter(
          (candidate) =>
            candidate.sessionId !== sessionId ||
            candidate.providerTurnId !== providerTurnId,
        ),
        { sessionId, providerTurnId, observedAt: Date.now() },
      ]
        .sort((left, right) => right.observedAt - left.observedAt)
        .slice(0, TERMINAL_EVIDENCE_MAX_ENTRIES);
      return {
        state: {
          ...state,
          turns: state.turns.filter((_, index) => index !== acceptedIndex),
          terminalEvidence: state.terminalEvidence.filter(
            (candidate) =>
              candidate.sessionId !== sessionId ||
              candidate.providerTurnId !== providerTurnId,
          ),
          completedTerminals,
        },
        result: undefined,
        changed: true,
      };
    }
    if (
      state.completedTerminals.some(
        (candidate) =>
          candidate.sessionId === sessionId &&
          candidate.providerTurnId === providerTurnId,
      )
    ) {
      // The exact provider terminal was already consumed for this lifetime.
      // Do not convert a duplicate/replayed event into early evidence.
      return { state, result: undefined, changed: false };
    }
    const evidence = [
      ...state.terminalEvidence.filter(
        (candidate) =>
          candidate.sessionId !== sessionId ||
          candidate.providerTurnId !== providerTurnId,
      ),
      { sessionId, providerTurnId, observedAt: Date.now() },
    ]
      .sort((left, right) => right.observedAt - left.observedAt)
      .slice(0, TERMINAL_EVIDENCE_MAX_ENTRIES);
    return {
      state: { ...state, terminalEvidence: evidence },
      result: undefined,
      changed: true,
    };
  });
}

async function reconcileAcceptedTerminals(): Promise<void> {
  await mutateState((state) => {
    const matches = (evidence: TerminalEvidence, turn: QueuedOutboundTurn) =>
      turn.status === 'accepted' &&
      evidence.sessionId === turn.sessionId &&
      evidence.providerTurnId === turn.providerTurnId;
    const matched = state.terminalEvidence.filter((evidence) =>
      state.turns.some((turn) => matches(evidence, turn)),
    );
    if (matched.length === 0) {
      return { state, result: undefined, changed: false };
    }
    const completedTerminals = [
      ...state.completedTerminals.filter(
        (completed) =>
          !matched.some(
            (evidence) =>
              evidence.sessionId === completed.sessionId &&
              evidence.providerTurnId === completed.providerTurnId,
          ),
      ),
      ...matched.map(({ sessionId, providerTurnId }) => ({
        sessionId,
        providerTurnId,
        observedAt: Date.now(),
      })),
    ]
      .sort((left, right) => right.observedAt - left.observedAt)
      .slice(0, TERMINAL_EVIDENCE_MAX_ENTRIES);
    return {
      state: {
        ...state,
        turns: state.turns.filter(
          (turn) => !matched.some((evidence) => matches(evidence, turn)),
        ),
        terminalEvidence: state.terminalEvidence.filter(
          (evidence) => !matched.includes(evidence),
        ),
        completedTerminals,
      },
      result: undefined,
      changed: true,
    };
  });
}

export const outboundDispatch: OutboundDispatchModule = {
  enqueue,
  open: async () => {
    await reconcileAcceptedTerminals();
    return (await readStored()).map(publicTurn);
  },
  snapshot: async () => {
    await reconcileAcceptedTerminals();
    return (await readStored()).map(publicTurn);
  },
  fenceConversationHandoff,
  subscribe: (listener) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  flush,
  completeAcceptedTurn,
  discard,
  edit,
  reorder,
  merge,
  unmerge,
  retry,
};

/** Test-only private-Adapter composition seam. */
export function _setOutboundQueueStorage(next: OutboundQueueStorage): void {
  storage = next;
  mutationTail = Promise.resolve();
  unavailableClaims.clear();
}

/** Test-only reset to the production IndexedDB Adapter. */
export function _resetOutboundQueueStorage(): void {
  storage = createIdbOutboundQueueStorage();
  mutationTail = Promise.resolve();
  unavailableClaims.clear();
}
