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

import {
  FOREGROUND_MESSAGE_INDETERMINATE_CODE,
  type TurnDeliveryInspection,
  type TurnDeliveryOutcome,
} from '@kontourai/station-contracts/orchestration';
import { randomCorrelationId } from '@kontourai/station-shared/random-id';
import { createStore, get, promisifyRequest, set, update } from 'idb-keyval';
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
  executionAgentId?: string;
  executionOnCurrentStation?: boolean;
  expectedDefinitionFingerprint?: string;
  conversationId?: string;
  /**
   * The Project the chat was sending in, so a chat restored from this row
   * alone (its tab's state lost with the app) sends to the same place.
   */
  projectSlug?: string;
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
  /**
   * When a send of it last hit a temporary gate (`deferred`, typically a
   * turn still running). A flush leaves it alone for
   * `OUTBOUND_DEFER_RETRY_MS` after that, whatever starts the flush.
   */
  deferredAt?: number;
  /** Private claim facts are persisted only so another tab cannot replay. */
  dispatchBootId?: string;
  claimedAt?: number;
  /** Provider turn identity, only when the transport can prove it. */
  providerTurnId?: string;
  /**
   * `live`: a send the user made from the composer while Station looked
   * reachable, recorded `invoking` BEFORE its request so the text survives the
   * app closing mid-send. Rows without it entered as offline intents.
   */
  origin?: 'live';
  /**
   * The newest answer Station's delivery lookup gave for this row's key. An
   * observation, kept with the row so a restarted app can say what it last
   * learned; never a reason to send by itself.
   */
  deliveryCheck?: { outcome: TurnDeliveryOutcome; checkedAt: number };
  /**
   * The Station this row was written for. A row is only ever sent to, or
   * asked about at, that same Station; for another it waits, visibly.
   * Absent on rows written before it existed (they keep the old behaviour).
   */
  station?: OutboundStationIdentity;
  /**
   * A pending row the renderer `bootId` is holding in its chat's local queue
   * behind a running turn: the durable copy of a held follow-up. Nothing
   * sends it automatically: that renderer's queue drain does (under the same
   * key), or, once no live queue holds it, the user does (`sendHeld`), after
   * seeing it listed. A copy is never released by a timer or a guess.
   */
  heldBy?: { bootId: string; heldAt: number };
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
> & {
  /**
   * A live send this renderer is still waiting on. Its message is already on
   * screen as the optimistic bubble, so a projection must not list it again.
   */
  liveInFlight?: true;
  /**
   * A held copy this renderer's own queue holds (its queue shows it). A held
   * copy without it belongs to another window or a closed one: listed, with
   * Send.
   */
  heldHere?: true;
  /**
   * A send that got no answer, released by its own renderer for Station's
   * delivery lookup (`unanswered`), or claimed by a renderer proven gone (its
   * Web Lock is no longer held): nothing sends it until the lookup says
   * Station never received it, then it goes once with its key. Either can be
   * withdrawn with `dismissUnconfirmed`.
   */
  awaitingLookup?: true;
  /**
   * An `invoking` row whose send is under way: claimed by another renderer
   * proven running (its Web Lock is held), or by a pass of this renderer's
   * own flush that is still in its transport call. Without it the row waits
   * for Station's delivery lookup: its owner is gone, unknown, or (a claim of
   * this renderer's that no pass holds) never finished writing back.
   */
  sendUnderWay?: true;
};

export interface OutboundDispatchIntent
  extends Omit<
    QueuedOutboundTurn,
    | 'attempts'
    | 'status'
    | 'createdAt'
    | 'lastError'
    | 'lastAttemptAt'
    | 'deferredAt'
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
  /** A request already attempted without a receipt; only a lookup may release it. */
  recordUnanswered(
    intent: OutboundDispatchIntent,
    error?: unknown,
  ): Promise<OutboundDispatchTurn>;
  open(): Promise<OutboundDispatchTurn[]>;
  snapshot(): Promise<OutboundDispatchTurn[]>;
  subscribe(listener: () => void): () => void;
  /**
   * Notified when ANOTHER tab in this browser profile changed the queue.
   * Same-tab transitions arrive through `subscribe`; this never doubles them.
   */
  subscribeRemoteChange(listener: () => void): () => void;
  fenceConversationHandoff<T>(
    input: { conversationId: string; sessionId: string },
    effect: () => Promise<T>,
  ): Promise<
    { status: 'blocked'; count: number } | { status: 'completed'; value: T }
  >;
  flush(
    transport: OutboundDispatchTransport,
    options?: {
      blockedSessionIds?: ReadonlySet<string>;
      /** Only rows written for this Station are sent (see `station`). */
      station?: OutboundStationIdentity;
    },
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
  /**
   * The user's explicit "I checked, discard it" for a row that may have
   * reached the agent: `may-have-started`, or a send that got no answer and
   * waits for the delivery lookup (`awaitingLookup`). Never automatic:
   * `discard` refuses such a row, and nothing else removes it. The row goes and its
   * key is retired in one write, so no window can send it again. Refuses
   * every other status (a send still in flight, an accepted one, or a row
   * whose dispatch state this renderer could not record).
   */
  dismissUnconfirmed(clientTurnId: string): Promise<void>;
  /** The status of this key's row, if the outbox holds one. */
  rowStatus(clientTurnId: string): Promise<OutboundDispatchStatus | undefined>;
  /**
   * Keys finished with in any window: discarded by the user, or accepted by
   * Station (its answer, or the delivery lookup's `started`). Bounded, as the
   * retired list is.
   */
  retiredKeys(): Promise<{ discarded: string[]; accepted: string[] }>;
  /**
   * Records a live send `invoking` before its request is made, so its text is
   * durable while it is in flight. Rejects when storage is unavailable; the
   * caller then sends without the durability (and keeps the draft).
   */
  beginLive(intent: OutboundDispatchIntent): Promise<LiveOutboundDispatch>;
  /**
   * Settles `invoking` rows whose renderer is gone (the app was closed or
   * crashed mid-send) by asking Station what became of each key:
   * `not-received` → pending (sent again with the SAME key), `started` →
   * removed (delivered), `received` → left to ask again later,
   * `indeterminate`/`expired` → may-have-started (never resent). A lookup
   * that fails leaves the row as it is. Returns how many rows Station still
   * reports as received, so the caller can ask again with backoff.
   */
  reconcile(
    lookup: OutboundDeliveryLookup,
    options?: { station?: OutboundStationIdentity },
  ): Promise<{ received: number }>;
  /**
   * Makes this renderer's held follow-ups (`heldBy`) exactly `intents`:
   * writes the new, updates the changed, removes the ones no longer held.
   * Touches only pending rows this renderer holds.
   */
  syncHeld(intents: readonly HeldOutboundIntent[]): Promise<void>;
  /** The user sends a listed held copy (see `heldBy`). */
  sendHeld(clientTurnId: string): Promise<void>;
  /**
   * The user's explicit check of one unconfirmed or orphaned row. Like
   * {@link reconcile}, except `not-received` on a row that may have started
   * becomes `failed` (not sent; the user retries it with the same key)
   * instead of being resent automatically.
   */
  check(
    clientTurnId: string,
    lookup: OutboundDeliveryLookup,
  ): Promise<TurnDeliveryOutcome | undefined>;
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

/** Which Station a row belongs to: its API base and its environment id. */
export interface OutboundStationIdentity {
  apiBase: string;
  /** The Station's public environment id, once this renderer verified it. */
  environmentId?: string;
}

function normalizedBase(apiBase: string): string {
  return apiBase.replace(/\/+$/, '');
}

/**
 * Whether a row may be sent to, or settled by, `current`. A row that names
 * an environment id needs the same verified one; a legacy row with no
 * Station recorded keeps the old any-Station behaviour.
 */
export function rowBelongsToStation(
  row: { station?: OutboundStationIdentity },
  current: OutboundStationIdentity | undefined,
): boolean {
  if (!row.station) return true;
  if (!current) return false;
  // A verified Station identity decides, whatever address reaches it now (a
  // tunnel port or host can change); an address alone decides only when the
  // row never learned which Station it was.
  if (row.station.environmentId !== undefined)
    return row.station.environmentId === current.environmentId;
  return (
    normalizedBase(row.station.apiBase) === normalizedBase(current.apiBase)
  );
}

let currentStation: OutboundStationIdentity | undefined;

/** The Station this renderer talks to now; stamped on rows written here. */
export function noteCurrentStation(
  station: OutboundStationIdentity | undefined,
): void {
  currentStation = station;
}

export function currentOutboundStation(): OutboundStationIdentity | undefined {
  return currentStation;
}

/** One follow-up held in a chat's local queue (see `heldBy`). */
export type HeldOutboundIntent = Omit<OutboundDispatchIntent, 'createdAt'>;

/** Station's delivery lookup for one row (`getTurnDelivery`). */
export type OutboundDeliveryLookup = (
  turn: Readonly<OutboundDispatchTurn>,
) => Promise<TurnDeliveryInspection>;

/** The live send's hold on its own row; see `beginLive`. */
export interface LiveOutboundDispatch {
  readonly clientTurnId: string;
  /** Station answered with the turn: the transcript holds it now. */
  accepted(): Promise<void>;
  /** Station refused it before anything ran; the composer has the text back. */
  refused(): Promise<void>;
  /** No answer came back: keep it for replay with the same key. */
  undeliverable(error: unknown): Promise<void>;
  /**
   * It may have reached the agent: keep it as evidence, never resend. With
   * `listed`, the row is shown in the chat's outbox list at once (the caller
   * has no message of its own on screen for it).
   */
  indeterminate(reason: string, options?: { listed?: boolean }): Promise<void>;
  /** Records a lookup answer observed while the request is still out. */
  observed(outcome: TurnDeliveryOutcome): Promise<void>;
  /**
   * No answer, and nothing proves which way it went: release the row for
   * Station's delivery lookup to settle (never resent without its answer).
   */
  unanswered(): Promise<void>;
  /** Moved back into the chat's local queue: keep it durable, held, same key. */
  hold(): Promise<void>;
  /** Station refused it for good: keep it durable as not sent. */
  notSent(reason: string): Promise<void>;
}

/**
 * How long another renderer's `invoking` row is presumed alive when the
 * platform cannot report renderer liveness (no Web Locks). A Station request
 * outlives this only during an unusually long session start, and the lookup
 * then answers `received`, which leaves the row alone.
 */
export const OUTBOUND_ORPHAN_GRACE_MS = 2 * 60 * 1000;

/**
 * The backstop against a send loop: a row whose send was deferred is not
 * claimed again for this long. A trigger that fires sooner (a turn ending
 * right after) finds it skipped, so the flush hook schedules one retry for
 * when the wait ends (`deferredAt` is public on each row).
 */
export const OUTBOUND_DEFER_RETRY_MS = 1_500;

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
  /**
   * Reads and writes the queue record and the retired-key list in ONE
   * transaction, so neither can be saved without the other.
   */
  updateWithRetired?(
    updater: (
      record: unknown,
      retired: unknown,
    ) => { record: unknown; retired: unknown },
  ): Promise<void>;
}

/**
 * One readwrite transaction over the queue's object store: both keys are
 * read, the updater decides, and both are put before the transaction
 * commits. An updater that throws writes nothing.
 */
export function updateRecordAndRetired(
  objectStore: Pick<IDBObjectStore, 'get' | 'put' | 'transaction'>,
  updater: (
    record: unknown,
    retired: unknown,
  ) => { record: unknown; retired: unknown },
): Promise<void> {
  return new Promise((resolve, reject) => {
    const record = objectStore.get(STORAGE_KEY);
    const retired = objectStore.get(RETIRED_STORAGE_KEY);
    let pending = 2;
    const both = () => {
      pending -= 1;
      if (pending > 0) return;
      try {
        const next = updater(record.result, retired.result);
        objectStore.put(next.record, STORAGE_KEY);
        if (next.retired !== retired.result)
          objectStore.put(next.retired, RETIRED_STORAGE_KEY);
        resolve(promisifyRequest(objectStore.transaction));
      } catch (error) {
        // Neither key is kept: a record put before a failing retired put
        // would otherwise commit alone.
        try {
          objectStore.transaction.abort();
        } catch {
          // Already finished: nothing of this call was committed.
        }
        reject(error);
      }
    };
    record.onsuccess = both;
    retired.onsuccess = both;
    record.onerror = () => reject(record.error);
    retired.onerror = () => reject(retired.error);
  });
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
  /**
   * Keys whose message is finished with: discarded by the user, or accepted
   * by Station. A held copy is never re-created for one, and no send of one
   * is started again, in any window. Bounded, newest kept.
   */
  retired?: RetiredKey[];
}

interface RetiredKey {
  clientTurnId: string;
  /** `discarded` or `accepted`; any other value still means retired. */
  reason: string;
  at: number;
}

/**
 * Kept apart from the queue's own record, under its own key: a build that
 * predates retirement rewrites the queue record without knowing this list,
 * and must not erase it.
 */
const RETIRED_STORAGE_KEY = 'station-outbound-retired-v1';
/** Per reason, newest kept: many deliveries never push out a Discard. */
const RETIRED_KEYS_PER_REASON_MAX = 512;

function parseRetired(stored: unknown): RetiredKey[] {
  if (!Array.isArray(stored)) return [];
  // Unreadable entries are skipped, never a reason to stop the outbox.
  return stored.filter(
    (entry): entry is RetiredKey =>
      typeof entry === 'object' &&
      entry !== null &&
      typeof (entry as RetiredKey).clientTurnId === 'string' &&
      typeof (entry as RetiredKey).reason === 'string' &&
      typeof (entry as RetiredKey).at === 'number',
  );
}

function withRetired(
  state: OutboundQueueState,
  clientTurnId: string,
  reason: 'discarded' | 'accepted',
): OutboundQueueState {
  const others = (state.retired ?? []).filter(
    (entry) => entry.clientTurnId !== clientTurnId,
  );
  const sameReason = others.filter((entry) => entry.reason === reason);
  const dropped = new Set(
    sameReason.slice(
      0,
      Math.max(0, sameReason.length + 1 - RETIRED_KEYS_PER_REASON_MAX),
    ),
  );
  return {
    ...state,
    retired: [
      ...others.filter((entry) => !dropped.has(entry)),
      { clientTurnId, reason, at: Date.now() },
    ],
  };
}

function retiredReason(
  state: OutboundQueueState,
  clientTurnId: string,
): 'discarded' | 'accepted' | undefined {
  const reason = state.retired?.find(
    (entry) => entry.clientTurnId === clientTurnId,
  )?.reason;
  if (reason === undefined) return undefined;
  return reason === 'discarded' ? 'discarded' : 'accepted';
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
    candidate.code !== FOREGROUND_MESSAGE_INDETERMINATE_CODE ||
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
  // Something other than Station answered: the send may or may not have
  // reached it, exactly like a request that threw.
  if (hasNonStationResponse(error)) return 'send-unconfirmed';
  if (hasResponseEvidence(error)) return null;
  const code = (error as { code?: unknown } | null)?.code;
  const name = (error as { name?: unknown } | null)?.name;
  if (
    error instanceof TypeError ||
    ['AbortError', 'TimeoutError', 'StationRequestTimeoutError'].includes(
      typeof name === 'string' ? name : '',
    ) ||
    [
      'network_changed',
      'transport',
      'transport_tls',
      'transport_reset',
      'transport_timeout',
      'transport_unreachable',
      'response_timeout',
      'response_too_large',
    ].includes(typeof code === 'string' ? code : '')
  ) {
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

/**
 * A response that is not Station's own answer: a proxy's or tunnel's
 * 502/503/504, or a body without Station's envelope. The address answered,
 * but Station's decision about the send is unknown.
 */
function hasNonStationResponse(error: unknown): boolean {
  return (
    hasResponseEvidence(error) &&
    (error as { stationEnvelope?: unknown }).stationEnvelope === false
  );
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
    updateWithRetired: (updater) =>
      store('readwrite', (objectStore) =>
        updateRecordAndRetired(objectStore, updater),
      ),
  };
}

let storage: OutboundQueueStorage = createIdbOutboundQueueStorage();

/** Where the retired-key list is kept (see RETIRED_STORAGE_KEY). */
export interface OutboundRetiredStorage {
  get(): Promise<unknown>;
  set(value: unknown): Promise<void>;
}

/** The same IndexedDB store as the queue, under the list's own key. */
function storeRetiredBeside(
  queue: OutboundQueueStorage,
): OutboundRetiredStorage {
  return {
    get: () => queue.getItem(RETIRED_STORAGE_KEY),
    set: (value) => queue.setItem(RETIRED_STORAGE_KEY, value),
  };
}

function memoryRetiredStorage(): OutboundRetiredStorage {
  let value: unknown;
  return {
    get: async () => value,
    set: async (next) => {
      value = next;
    },
  };
}

let retiredStorage: OutboundRetiredStorage = storeRetiredBeside(storage);
let mutationTail: Promise<void> = Promise.resolve();
const listeners = new Set<() => void>();
/** A same-renderer safety net when a post-effect IndexedDB transition fails. */
const unavailableClaims = new Set<string>();
/** Live sends this renderer is still waiting on (see `liveInFlight`). */
const liveOwned = new Set<string>();
/** Keys a flush pass of this renderer has claimed and not yet let go. */
const drainInFlight = new Set<string>();
/**
 * The claim each live send of this renderer currently holds, by key: an
 * abandoned attempt (its write landed late and a re-send adopted the row)
 * must not clear the flag of the attempt that adopted it.
 */
const liveClaimOf = new Map<string, number>();

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

/**
 * A held copy is the durable shadow of a message a chat's queue holds (in
 * this window or another): changing the copy would not change what that
 * queue sends. Only Send or Discard act on it.
 */
function heldCopyRefusal(action: 'edited' | 'reordered' | 'merged'): Error {
  return new Error(
    `This message is held in a chat's queue and cannot be ${action} here. Send it, or edit it where it is queued.`,
  );
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

/** This renderer's boot id once the lease module is loaded (sync reads). */
let knownBootId: string | undefined;

function publicTurn(
  entry: QueuedOutboundTurn,
  underWay: ReadonlySet<string> = new Set(),
  ownerGone: ReadonlySet<string> = new Set(),
): OutboundDispatchTurn {
  const {
    dispatchBootId: _dispatchBootId,
    claimedAt: _claimedAt,
    ...turn
  } = entry;
  return Object.freeze({
    ...turn,
    ...(liveOwned.has(entry.clientTurnId)
      ? { liveInFlight: true as const }
      : {}),
    ...(entry.heldBy && entry.heldBy.bootId === knownBootId
      ? { heldHere: true as const }
      : {}),
    ...(awaitingLookup(entry) || ownerGone.has(entry.clientTurnId)
      ? { awaitingLookup: true as const }
      : {}),
    ...(underWay.has(entry.clientTurnId)
      ? { sendUnderWay: true as const }
      : {}),
  });
}

/**
 * The stored rows as callers see them. Whether a claimed send is still under
 * way is read now. This renderer's own claim counts only while a flush pass
 * of its holds it (one whose write-back failed is not "sending" for ever).
 * Another renderer's counts while it is proven running; one proven gone is
 * released like an unanswered send; an unknown one is neither.
 */
async function publicTurns(): Promise<OutboundDispatchTurn[]> {
  const rows = await readStored();
  const self = await rendererBootId();
  const underWay = new Set<string>();
  const ownerGone = new Set<string>();
  for (const row of rows) {
    if (
      row.status !== 'invoking' ||
      row.dispatchBootId === undefined ||
      liveOwned.has(row.clientTurnId)
    )
      continue;
    if (row.dispatchBootId === self) {
      if (drainInFlight.has(row.clientTurnId)) underWay.add(row.clientTurnId);
      continue;
    }
    const live = await ownerLiveness(row.dispatchBootId);
    if (live === true) underWay.add(row.clientTurnId);
    else if (live === false) ownerGone.add(row.clientTurnId);
  }
  return rows.map((row) => publicTurn(row, underWay, ownerGone));
}

/** An `invoking` row no renderer holds a claim on: released for the lookup. */
function awaitingLookup(entry: QueuedOutboundTurn): boolean {
  return (
    entry.status === 'invoking' &&
    entry.dispatchBootId === undefined &&
    !liveOwned.has(entry.clientTurnId)
  );
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

/**
 * Cross-tab change signal.
 *
 * `listeners` is a per-renderer in-memory Set, and this queue is explicitly
 * multi-tab — its write lock is a `navigator.locks` lease precisely because
 * another tab can be mutating the same durable rows. A tab that does not
 * perform the mutation itself has no other way to learn that one happened, so
 * every consumer of `subscribe` would otherwise hold a projection that goes
 * stale the moment a sibling tab enqueues, discards or drains a turn.
 *
 * ONE channel object carries both directions on purpose: a `BroadcastChannel`
 * does not deliver a message to the object that posted it, so this tab cannot
 * hear its own echo and re-read the queue for a change it already applied.
 */
const CHANGE_CHANNEL_NAME = 'station-outbound-queue';
let changeChannel: BroadcastChannel | null = null;
let changeSubscribers = 0;

function queueChangeChannel(): BroadcastChannel | null {
  if (changeChannel) return changeChannel;
  if (typeof BroadcastChannel !== 'function') return null;
  changeChannel = new BroadcastChannel(CHANGE_CHANNEL_NAME);
  return changeChannel;
}

function closeChangeChannel(): void {
  changeChannel?.close();
  changeChannel = null;
}

function subscribeRemoteChange(listener: () => void): () => void {
  const channel = queueChangeChannel();
  if (!channel) return () => {};
  changeSubscribers += 1;
  const handler = () => {
    try {
      listener();
    } catch {
      // A throwing observer must not break the channel for the others.
    }
  };
  channel.addEventListener('message', handler);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    channel.removeEventListener('message', handler);
    changeSubscribers -= 1;
    if (changeSubscribers === 0) closeChangeChannel();
  };
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
  try {
    queueChangeChannel()?.postMessage(CHANGE_CHANNEL_NAME);
  } catch {
    // A closed or unavailable channel is not a failed dispatch.
  }
}

async function withQueueLock<T>(operation: () => Promise<T>): Promise<T> {
  const { withOutboundQueueLock } = await import('./outboundQueueLease');
  return withOutboundQueueLock(operation);
}

async function rendererBootId(): Promise<string> {
  const { rendererBootId } = await import('./outboundQueueLease');
  knownBootId = rendererBootId;
  return rendererBootId;
}

/** Called before this renderer writes any `invoking` row it then owns. */
async function holdRendererLiveness(): Promise<void> {
  const { ensureRendererLiveness } = await import('./outboundQueueLease');
  await ensureRendererLiveness();
}

async function ownerLiveness(
  bootId: string | undefined,
): Promise<boolean | undefined> {
  const { rendererLiveness } = await import('./outboundQueueLease');
  return rendererLiveness(bootId);
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
  /** The caller already holds the queue lock (it is not re-entrant). */
  options: { locked?: boolean } = {},
): Promise<T> {
  const locked = <R>(run: () => Promise<R>) =>
    options.locked ? run() : withQueueLock(run);
  let result!: T;
  let changed = false;
  // The retired list is read and written beside the queue record, inside
  // the same lock (see RETIRED_STORAGE_KEY).
  const persisted = (state: OutboundQueueState) => {
    const { retired: _retired, ...rest } = state;
    void _retired;
    return { ...rest, turns: prune(state.turns, Date.now()) };
  };
  const applyAtomic = () =>
    storage.updateWithRetired!((stored, storedRetired) => {
      const retired = parseRetired(storedRetired);
      const outcome = operation({ ...queueState(stored), retired });
      result = outcome.result;
      changed = outcome.changed;
      const nextRetired = outcome.state.retired ?? retired;
      return {
        record: persisted(outcome.state),
        retired: nextRetired === retired ? storedRetired : nextRetired,
      };
    });
  const apply = async () => {
    const retired = parseRetired(await retiredStorage.get());
    let nextRetired = retired;
    await storage.updateItem!(STORAGE_KEY, (stored) => {
      const outcome = operation({ ...queueState(stored), retired });
      result = outcome.result;
      changed = outcome.changed;
      nextRetired = outcome.state.retired ?? retired;
      return persisted(outcome.state);
    });
    if (nextRetired !== retired) await retiredStorage.set(nextRetired);
  };
  if (storage.updateWithRetired) {
    await locked(applyAtomic);
  } else if (storage.updateItem) {
    await locked(apply);
  } else {
    await serialize(async () => {
      const retired = parseRetired(await retiredStorage.get());
      const outcome = operation({ ...(await readState()), retired });
      result = outcome.result;
      changed = outcome.changed;
      if (changed) {
        await storage.setItem(STORAGE_KEY, persisted(outcome.state));
        if ((outcome.state.retired ?? retired) !== retired)
          await retiredStorage.set(outcome.state.retired ?? retired);
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
        state:
          status === 'accepted'
            ? withRetired(
                {
                  ...state,
                  turns: next,
                  terminalEvidence,
                  completedTerminals,
                },
                claimed.clientTurnId,
                'accepted',
              )
            : { ...state, turns: next, terminalEvidence, completedTerminals },
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
        deferredAt: Date.now(),
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
  station: OutboundStationIdentity | undefined,
): Promise<QueuedOutboundTurn | undefined> {
  const bootId = await rendererBootId();
  await holdRendererLiveness();
  const claimedAt = Date.now();
  let marked: string | undefined;
  try {
    return await mutate((entries) => {
      const candidate = entries.find(
        (entry, index) =>
          entry.status === 'pending' &&
          !entry.heldBy &&
          rowBelongsToStation(entry, station) &&
          !blockedSessions.has(entry.sessionId) &&
          // Deferred moments ago: whatever retriggered this pass, wait.
          !(
            entry.deferredAt !== undefined &&
            claimedAt - entry.deferredAt < OUTBOUND_DEFER_RETRY_MS
          ) &&
          !entries.slice(0, index).some(
            (earlier) =>
              earlier.sessionId === entry.sessionId &&
              // An unconfirmed row is evidence, not a send in progress, and a
              // held copy waits on its queue or on the user: neither holds back
              // the messages written after it.
              earlier.status !== 'may-have-started' &&
              !earlier.heldBy,
          ),
      );
      if (!candidate) {
        if (marked) drainInFlight.delete(marked);
        marked = undefined;
        return { entries, result: undefined, changed: false };
      }
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
      // In flight here before the claim's write is announced, so a projection
      // that change prompts already reads it as this renderer's send under way.
      if (marked !== candidate.clientTurnId) {
        if (marked) drainInFlight.delete(marked);
        marked = candidate.clientTurnId;
        drainInFlight.add(marked);
      }
      return { entries: next, result: claimed, changed: true };
    });
  } catch (error) {
    if (marked) drainInFlight.delete(marked);
    throw error;
  }
}

async function enqueue(
  intent: OutboundDispatchIntent,
  error?: unknown,
  unanswered = false,
): Promise<OutboundDispatchTurn> {
  // Runtime callers can still be untyped JavaScript. Provider terminal
  // evidence is produced only by an accepted transport result, never trusted
  // from an enqueue intent; nor is a deferral, which only a release records.
  const {
    providerTurnId: _ignoredProviderTurnId,
    deferredAt: _ignoredDeferredAt,
    ...safeIntent
  } = intent as OutboundDispatchIntent & {
    providerTurnId?: unknown;
    deferredAt?: unknown;
  };
  const now = safeIntent.createdAt ?? Date.now();
  return mutateState((state) => {
    // A message already delivered or discarded is not queued again.
    const retired = retiredReason(state, safeIntent.clientTurnId);
    if (retired) throw new OutboundKeyRetiredError(retired);
    const entries = prune(state.turns, Date.now());
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
        ...(currentStation ? { station: currentStation } : {}),
        ...safeIntent,
        createdAt: now,
        attempts: 1,
        status: unanswered ? 'invoking' : 'pending',
        ...(unanswered ? { origin: 'live' as const } : {}),
        lastError,
        lastAttemptAt: now,
      };
      return {
        state: { ...state, turns: [...retained, next] },
        result: next,
        changed: true,
      };
    }
    const existing = entries[index]!;
    if (protectedEvidence(existing)) {
      // A timed-out beginLive write may land as this request ends. Invalidate
      // that claim before its late `refused` cleanup can erase the evidence.
      if (
        unanswered &&
        existing.status === 'invoking' &&
        existing.dispatchBootId === knownBootId
      ) {
        const released = {
          ...existing,
          dispatchBootId: undefined,
          claimedAt: undefined,
        };
        liveOwned.delete(existing.clientTurnId);
        const replacement = [...entries];
        replacement[index] = released;
        return {
          state: { ...state, turns: replacement },
          result: released,
          changed: true,
        };
      }
      return { state, result: existing, changed: false };
    }
    const attempts = existing.attempts + 1;
    const next: QueuedOutboundTurn = {
      ...existing,
      ...safeIntent,
      createdAt: existing.createdAt,
      attempts,
      status: unanswered
        ? 'invoking'
        : attempts >= OUTBOUND_QUEUE_MAX_ATTEMPTS
          ? 'failed'
          : 'pending',
      ...(unanswered ? { origin: 'live' as const, heldBy: undefined } : {}),
      lastError,
      lastAttemptAt: now,
      dispatchBootId: undefined,
      claimedAt: undefined,
      providerTurnId: undefined,
    };
    const replacement = [...entries];
    replacement[index] = next;
    return {
      state: { ...state, turns: replacement },
      result: next,
      changed: true,
    };
  }).then(publicTurn);
}

async function discard(clientTurnId: string): Promise<void> {
  await mutateState((state) => {
    const entry = state.turns.find(
      (candidate) => candidate.clientTurnId === clientTurnId,
    );
    if (!entry) return { state, result: undefined, changed: false };
    if (protectedEvidence(entry)) {
      throw new Error(
        'Queued turn may have started and cannot be withdrawn. Inspect the session instead.',
      );
    }
    // Discarded for good, in every window: a queue still holding it (another
    // window's) neither re-creates its copy nor sends it.
    return {
      state: withRetired(
        {
          ...state,
          turns: state.turns.filter(
            (candidate) => candidate.clientTurnId !== clientTurnId,
          ),
        },
        clientTurnId,
        'discarded',
      ),
      result: undefined,
      changed: true,
    };
  });
}

async function dismissUnconfirmed(clientTurnId: string): Promise<void> {
  // Under the queue lock throughout: a claim is withdrawn only if its owner
  // is proven gone at the moment of the write, never on an earlier reading.
  await withQueueLock(async () => {
    const row = (await readStored()).find(
      (candidate) => candidate.clientTurnId === clientTurnId,
    );
    const goneClaim =
      row?.status === 'invoking' &&
      row.dispatchBootId !== undefined &&
      !liveOwned.has(clientTurnId) &&
      (await ownerLiveness(row.dispatchBootId)) === false
        ? row.dispatchBootId
        : undefined;
    await mutateState((state) => dismissal(state, clientTurnId, goneClaim), {
      locked: true,
    });
  });
}

function dismissal(
  state: OutboundQueueState,
  clientTurnId: string,
  goneClaim: string | undefined,
): { state: OutboundQueueState; result: undefined; changed: boolean } {
  // Rechecked inside the write: a claim since re-taken by another renderer
  // is no longer the one proven gone.
  const entry = state.turns.find(
    (candidate) => candidate.clientTurnId === clientTurnId,
  );
  if (!entry) return { state, result: undefined, changed: false };
  const claimedByGone =
    goneClaim !== undefined &&
    entry.status === 'invoking' &&
    entry.dispatchBootId === goneClaim;
  if (
    (entry.status !== 'may-have-started' &&
      !awaitingLookup(entry) &&
      !claimedByGone) ||
    unavailableClaims.has(clientTurnId)
  ) {
    throw new Error(
      'Only a message that may have reached the agent can be dismissed this way.',
    );
  }
  return {
    state: withRetired(
      {
        ...state,
        turns: state.turns.filter(
          (candidate) => candidate.clientTurnId !== clientTurnId,
        ),
      },
      clientTurnId,
      'discarded',
    ),
    result: undefined,
    changed: true,
  };
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
    if (entries[index]!.heldBy) throw heldCopyRefusal('edited');
    const edited = {
      ...entries[index]!,
      clientTurnId: randomCorrelationId(),
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
    if (moved.heldBy) throw heldCopyRefusal('reordered');
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
    if (current.heldBy || nextTurn.heldBy) throw heldCopyRefusal('merged');
    if (current.sessionId !== nextTurn.sessionId) {
      throw new Error('Only messages from the same session can be merged.');
    }
    // A merged row can itself be edited before a later merge. The user sees
    // the current row contents, so the persisted composite must compose those
    // visible values and retain the current merge tree for reversible undo.
    const displayedTurns = [current, nextTurn];
    const merged: QueuedOutboundTurn = {
      ...current,
      clientTurnId: randomCorrelationId(),
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
  options?: {
    blockedSessionIds?: ReadonlySet<string>;
    station?: OutboundStationIdentity;
  },
): Promise<OutboundFlushOutcome> {
  const blockedSessions = new Set(options?.blockedSessionIds);
  const station = options?.station ?? currentStation;
  let unavailable = false;
  while (true) {
    let claimed: QueuedOutboundTurn | undefined;
    try {
      claimed = await claimNext(blockedSessions, station);
    } catch {
      // Storage cannot prove a claim was not durably written. A later flush
      // must inspect the retained row; this pass simply makes no transport
      // call rather than guessing it is safe to replay.
      return 'unavailable';
    }
    if (!claimed) return unavailable ? 'unavailable' : 'drained';
    const capability = claimCapability(claimed);
    // claimNext marked it in flight before announcing the claim.
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
    } finally {
      drainInFlight.delete(claimed.clientTurnId);
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

/**
 * Room for one more row, evicting the oldest ordinary drafts as `enqueue`
 * does; fenced evidence is never a victim.
 */
function admitOne(entries: QueuedOutboundTurn[]): QueuedOutboundTurn[] {
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
  return entries.filter((entry) => !evicted.has(entry.clientTurnId));
}

/**
 * `beginLive` refused: a row with this key is already on its way, or may
 * already have reached the agent. Sending it now would bypass that row; the
 * caller must not send.
 */
export class OutboundRowInFlightError extends Error {
  constructor() {
    super('This message is already on its way.');
    this.name = 'OutboundRowInFlightError';
  }
}

/**
 * `beginLive` refused: this key's message was discarded or already accepted
 * (in this window or another). It is never sent again.
 */
export class OutboundKeyRetiredError extends Error {
  constructor(readonly reason: 'discarded' | 'accepted') {
    super(
      reason === 'discarded'
        ? 'This message was discarded.'
        : 'This message was already delivered.',
    );
    this.name = 'OutboundKeyRetiredError';
  }
}

async function beginLive(
  intent: OutboundDispatchIntent,
): Promise<LiveOutboundDispatch> {
  const {
    providerTurnId: _ignoredProviderTurnId,
    deferredAt: _ignoredDeferredAt,
    ...safeIntent
  } = intent as OutboundDispatchIntent & {
    providerTurnId?: unknown;
    deferredAt?: unknown;
  };
  const bootId = await rendererBootId();
  await holdRendererLiveness();
  const claimedAt = Date.now();
  const clientTurnId = safeIntent.clientTurnId;
  // Before the write: the write notifies observers, and a projection must
  // never list this send a second time beside its own bubble.
  liveOwned.add(clientTurnId);
  let claimed: QueuedOutboundTurn;
  try {
    claimed = await mutateState((state) => {
      const retired = retiredReason(state, clientTurnId);
      if (retired) throw new OutboundKeyRetiredError(retired);
      const entries = prune(state.turns, Date.now());
      const existing = entries.find(
        (entry) => entry.clientTurnId === clientTurnId,
      );
      // This renderer's own earlier claim of the key (a durable write that
      // landed after its send went without it) is not another send: the
      // message is being sent again here, so the row is adopted, never left
      // for the abandoned attempt's cleanup to delete.
      const ownAbandoned =
        existing?.status === 'invoking' && existing.dispatchBootId === bootId;
      if (existing && protectedEvidence(existing) && !ownAbandoned)
        throw new OutboundRowInFlightError();
      const { heldBy: _held, ...withoutHold } = existing ?? {};
      void _held;
      const next: QueuedOutboundTurn = {
        ...(currentStation ? { station: currentStation } : {}),
        ...(existing?.station ? { station: existing.station } : {}),
        ...(existing ? withoutHold : {}),
        ...safeIntent,
        createdAt: existing?.createdAt ?? safeIntent.createdAt ?? claimedAt,
        attempts: (existing?.attempts ?? 0) + 1,
        status: 'invoking',
        origin: 'live',
        dispatchBootId: bootId,
        // Distinct from an adopted claim's, even within one millisecond, so
        // that attempt's own transitions can never touch this one.
        claimedAt: Math.max(claimedAt, (existing?.claimedAt ?? 0) + 1),
        lastAttemptAt: claimedAt,
      };
      const retained = existing
        ? entries.filter((entry) => entry !== existing)
        : admitOne(entries);
      return {
        state: { ...state, turns: [...retained, next] },
        result: next,
        changed: true,
      };
    });
  } catch (error) {
    // Only when no attempt of this renderer holds the key's claim.
    if (!liveClaimOf.has(clientTurnId)) liveOwned.delete(clientTurnId);
    throw error;
  }
  liveClaimOf.set(clientTurnId, claimed.claimedAt!);
  /** Clears the in-flight flag only while this attempt is the current one. */
  const releaseLive = () => {
    if (liveClaimOf.get(clientTurnId) !== claimed.claimedAt) return;
    liveClaimOf.delete(clientTurnId);
    liveOwned.delete(clientTurnId);
  };
  const transition = async (
    change: (entry: QueuedOutboundTurn) => QueuedOutboundTurn | undefined,
  ): Promise<void> => {
    try {
      await mutate((entries) => {
        const index = entries.findIndex((entry) => exact(entry, claimed));
        if (index === -1) return { entries, result: undefined, changed: false };
        const next = change(entries[index]!);
        const replaced = [...entries];
        if (next) replaced[index] = next;
        else replaced.splice(index, 1);
        return { entries: replaced, result: undefined, changed: true };
      });
    } catch {
      // Best effort: a row left `invoking` is reconciled by the delivery
      // lookup after this renderer is gone, never replayed blindly.
    }
  };
  return {
    clientTurnId,
    accepted: async () => {
      // One operation: the row goes and its key is retired together (one
      // IndexedDB transaction in production), so no window can see the
      // message gone yet still sendable.
      try {
        await mutateState((state) => ({
          state: withRetired(
            {
              ...state,
              turns: state.turns.filter(
                (entry) => entry.clientTurnId !== clientTurnId,
              ),
            },
            clientTurnId,
            'accepted',
          ),
          result: undefined,
          changed: true,
        }));
      } catch {
        // Best effort, as every live transition: a row left `invoking` is
        // settled by the delivery lookup, which answers `started`.
      }
      releaseLive();
    },
    refused: async () => {
      await transition(() => undefined);
      releaseLive();
    },
    undeliverable: async (error) => {
      releaseLive();
      // Back to waiting for the connection: whatever Station said about the
      // attempt that just ended describes nothing pending now (as `hold`).
      await transition(({ deliveryCheck: _stale, ...entry }) => ({
        ...entry,
        status: 'pending',
        lastError: error instanceof Error ? error.message : undefined,
        dispatchBootId: undefined,
        claimedAt: undefined,
      }));
    },
    indeterminate: async (reason, options) => {
      // Still this renderer's unless listed: the chat already says so, and
      // the row is otherwise listed once this renderer is gone.
      if (options?.listed) releaseLive();
      await transition((entry) => ({
        ...entry,
        status: 'may-have-started',
        lastError: `Dispatch may have started: ${reason}`,
        dispatchBootId: undefined,
        claimedAt: undefined,
      }));
    },
    observed: async (outcome) => {
      await transition((entry) => ({
        ...entry,
        deliveryCheck: { outcome, checkedAt: Date.now() },
      }));
    },
    unanswered: async () => {
      // Released for the lookup: with no claim left, `reconcile` settles it by
      // Station's answer at the next pass instead of waiting out a renderer.
      releaseLive();
      await transition((entry) => ({
        ...entry,
        dispatchBootId: undefined,
        claimedAt: undefined,
        lastAttemptAt: Date.now(),
      }));
    },
    hold: async () => {
      releaseLive();
      // Back in the queue, to be sent again: whatever Station said about the
      // attempt that just ended (a `received` while it waited on a starting
      // session) describes nothing pending now.
      await transition(({ deliveryCheck: _stale, ...entry }) => ({
        ...entry,
        status: 'pending',
        heldBy: { bootId: claimed.dispatchBootId!, heldAt: Date.now() },
        dispatchBootId: undefined,
        claimedAt: undefined,
      }));
    },
    notSent: async (reason) => {
      // Still this renderer's while it shows the refusal itself.
      await transition((entry) => ({
        ...entry,
        status: 'failed',
        lastError: reason,
        dispatchBootId: undefined,
        claimedAt: undefined,
      }));
    },
  };
}

const NOT_RECEIVED_RESEND =
  'Station had not received this message; it is being sent again.';
const NOT_RECEIVED_STOPPED =
  'Station never received this message. Send it again when you are ready.';
const POSSIBLE_EFFECT =
  'Dispatch may have started: Station cannot confirm whether this message reached the agent. It was not sent again.';

/**
 * Applies one lookup answer to the row exactly as it was observed (same
 * status and claim), so a row another tab moved meanwhile is left alone.
 */
async function applyDeliveryAnswer(
  observed: QueuedOutboundTurn,
  outcome: TurnDeliveryOutcome,
  notReceived: 'resend' | 'stop',
): Promise<void> {
  await mutateState((state) => {
    const entries = state.turns;
    const index = entries.findIndex(
      (entry) =>
        entry.clientTurnId === observed.clientTurnId &&
        entry.status === observed.status &&
        entry.dispatchBootId === observed.dispatchBootId &&
        entry.claimedAt === observed.claimedAt,
    );
    if (index === -1) return { state, result: undefined, changed: false };
    const entry = entries[index]!;
    // The same answer again changes nothing (and wakes no observer).
    if (outcome === 'received' && entry.deliveryCheck?.outcome === 'received')
      return { state, result: undefined, changed: false };
    const deliveryCheck = { outcome, checkedAt: Date.now() };
    const released = {
      ...entry,
      deliveryCheck,
      dispatchBootId: undefined,
      claimedAt: undefined,
    };
    let next: QueuedOutboundTurn | undefined;
    switch (outcome) {
      case 'started':
        next = undefined;
        break;
      case 'received':
        next = { ...entry, deliveryCheck };
        break;
      case 'indeterminate':
      case 'expired':
      case 'unknown':
        next = {
          ...released,
          status: 'may-have-started',
          lastError: POSSIBLE_EFFECT,
        };
        break;
      case 'not-received':
        next =
          notReceived === 'resend'
            ? { ...released, status: 'pending', lastError: NOT_RECEIVED_RESEND }
            : {
                ...released,
                status: 'failed',
                lastError: NOT_RECEIVED_STOPPED,
              };
        break;
      // #3568: Station holds the message in the conversation's inbox. This
      // queue never hands a send to the inbox, so it cannot meet one of its
      // own keys there yet: like an unknown answer, change nothing.
      case 'queued':
        return { state, result: undefined, changed: false };
      default: {
        // An answer this build does not know proves nothing: change nothing.
        const unhandled: never = outcome;
        void unhandled;
        return { state, result: undefined, changed: false };
      }
    }
    const replaced = [...entries];
    if (next) replaced[index] = next;
    else replaced.splice(index, 1);
    unavailableClaims.delete(entry.clientTurnId);
    const settled = { ...state, turns: replaced };
    return {
      // Station started it: delivered, so never sent again from anywhere.
      state:
        outcome === 'started'
          ? withRetired(settled, entry.clientTurnId, 'accepted')
          : settled,
      result: undefined,
      changed: true,
    };
  });
}

async function askStation(
  row: QueuedOutboundTurn,
  lookup: OutboundDeliveryLookup,
): Promise<TurnDeliveryOutcome | undefined> {
  try {
    const answer = await lookup(publicTurn(row));
    // The answer must be about this exact key, never a near match.
    return answer.clientTurnId === row.clientTurnId
      ? answer.outcome
      : undefined;
  } catch {
    return undefined;
  }
}

async function reconcile(
  lookup: OutboundDeliveryLookup,
  options?: { station?: OutboundStationIdentity },
): Promise<{ received: number }> {
  const now = Date.now();
  const station = options?.station ?? currentStation;
  let received = 0;
  for (const row of await readStored()) {
    if (liveOwned.has(row.clientTurnId)) continue;
    // Held copies are never released here: a live queue sends them, or the
    // user does once they are listed (`sendHeld`).
    if (row.heldBy) continue;
    if (row.status !== 'invoking') continue;
    // Only the Station a row was written for can say what became of it.
    if (!rowBelongsToStation(row, station)) continue;
    // A row released without a claim (its request got no answer) is the
    // lookup's at once; a claimed row waits until its renderer is gone.
    if (row.dispatchBootId !== undefined) {
      const live = await ownerLiveness(row.dispatchBootId);
      if (live === true) continue;
      if (
        live === undefined &&
        now - (row.claimedAt ?? row.lastAttemptAt ?? row.createdAt) <
          OUTBOUND_ORPHAN_GRACE_MS
      )
        continue;
    }
    const outcome = await askStation(row, lookup);
    if (!outcome) continue;
    await applyDeliveryAnswer(row, outcome, 'resend');
    if (outcome === 'received') received += 1;
  }
  return { received };
}

/**
 * The user's Send on a held copy no live queue of theirs shows (another
 * window's, or a closed one's): it becomes an ordinary pending row and the
 * flush sends it with its own key.
 */
async function sendHeld(clientTurnId: string): Promise<void> {
  await mutate((entries) => {
    const index = entries.findIndex(
      (entry) => entry.clientTurnId === clientTurnId && entry.heldBy,
    );
    if (index === -1) return { entries, result: undefined, changed: false };
    const { heldBy: _released, ...pending } = entries[index]!;
    void _released;
    const replaced = [...entries];
    replaced[index] = { ...pending, status: 'pending', attempts: 0 };
    return { entries: replaced, result: undefined, changed: true };
  });
}

async function syncHeld(intents: readonly HeldOutboundIntent[]): Promise<void> {
  const bootId = await rendererBootId();
  await holdRendererLiveness();
  const now = Date.now();
  const wanted = new Map(
    intents.map((intent) => [intent.clientTurnId, intent]),
  );
  await mutateState((state) => {
    // A finished key (discarded or accepted) is never held again.
    for (const key of wanted.keys())
      if (retiredReason(state, key)) wanted.delete(key);
    const entries = prune(state.turns, Date.now());
    let changed = false;
    const next: QueuedOutboundTurn[] = [];
    for (const entry of entries) {
      if (entry.heldBy?.bootId !== bootId || entry.status !== 'pending') {
        next.push(entry);
        continue;
      }
      const intent = wanted.get(entry.clientTurnId);
      if (!intent) {
        // No longer held here (sent, removed, or edited under a new key).
        changed = true;
        continue;
      }
      wanted.delete(entry.clientTurnId);
      if (entry.content !== intent.content) {
        changed = true;
        next.push({ ...entry, ...intent, heldBy: { bootId, heldAt: now } });
      } else next.push(entry);
    }
    let retained = next;
    for (const intent of wanted.values()) {
      const index = retained.findIndex(
        (entry) => entry.clientTurnId === intent.clientTurnId,
      );
      if (index !== -1) {
        const existing = retained[index]!;
        // The same message held again here, typically by the queue this tab
        // restored after a reload: its earlier copy (another renderer's held
        // row, or one already released to pending) becomes this renderer's,
        // with the queue's current text. One message, one sender. A row
        // that is on its way or settled is left alone.
        if (
          existing.status === 'pending' &&
          existing.heldBy?.bootId !== bootId
        ) {
          retained = [...retained];
          retained[index] = {
            ...existing,
            ...intent,
            // A verified Station identity is never traded for an address.
            ...(existing.station?.environmentId &&
            !intent.station?.environmentId
              ? { station: existing.station }
              : {}),
            heldBy: { bootId, heldAt: now },
          };
          changed = true;
        }
        continue;
      }
      retained = admitOne(retained);
      retained.push({
        ...(currentStation ? { station: currentStation } : {}),
        ...intent,
        createdAt: now,
        attempts: 0,
        status: 'pending',
        heldBy: { bootId, heldAt: now },
      });
      changed = true;
    }
    return {
      state: { ...state, turns: retained },
      result: undefined,
      changed,
    };
  });
}

async function check(
  clientTurnId: string,
  lookup: OutboundDeliveryLookup,
): Promise<TurnDeliveryOutcome | undefined> {
  const row = (await readStored()).find(
    (entry) => entry.clientTurnId === clientTurnId,
  );
  if (!row) return undefined;
  if (row.status !== 'may-have-started' && row.status !== 'invoking')
    return undefined;
  // A send this renderer still has out is not checked; its answer is coming.
  if (row.status === 'invoking' && liveOwned.has(clientTurnId))
    return undefined;
  if (
    row.status === 'invoking' &&
    row.dispatchBootId !== undefined &&
    (await ownerLiveness(row.dispatchBootId))
  )
    return undefined;
  if (!rowBelongsToStation(row, currentStation)) return undefined;
  const outcome = await askStation(row, lookup);
  if (!outcome) return undefined;
  await applyDeliveryAnswer(
    row,
    outcome,
    row.status === 'invoking' ? 'resend' : 'stop',
  );
  return outcome;
}

export const outboundDispatch: OutboundDispatchModule = {
  enqueue,
  recordUnanswered: (intent, error) => enqueue(intent, error, true),
  open: async () => {
    await reconcileAcceptedTerminals();
    // Known before projecting: which held copies are this renderer's own.
    await rendererBootId();
    return publicTurns();
  },
  snapshot: async () => {
    await reconcileAcceptedTerminals();
    await rendererBootId();
    return publicTurns();
  },
  fenceConversationHandoff,
  subscribe: (listener) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  subscribeRemoteChange,
  flush,
  completeAcceptedTurn,
  discard,
  dismissUnconfirmed,
  rowStatus: async (clientTurnId) =>
    (await readStored()).find((entry) => entry.clientTurnId === clientTurnId)
      ?.status,
  retiredKeys: async () => {
    const retired = parseRetired(await retiredStorage.get());
    return {
      discarded: retired
        .filter((entry) => entry.reason === 'discarded')
        .map((entry) => entry.clientTurnId),
      accepted: retired
        .filter((entry) => entry.reason !== 'discarded')
        .map((entry) => entry.clientTurnId),
    };
  },
  beginLive,
  reconcile,
  syncHeld,
  sendHeld,
  check,
  edit,
  reorder,
  merge,
  unmerge,
  retry,
};

/** Test-only private-Adapter composition seam. */
export function _setOutboundQueueStorage(
  next: OutboundQueueStorage,
  /** A test's shared retired list (several renderers); else a fresh one. */
  retired: OutboundRetiredStorage = memoryRetiredStorage(),
): void {
  storage = next;
  retiredStorage = retired;
  mutationTail = Promise.resolve();
  unavailableClaims.clear();
  liveOwned.clear();
  drainInFlight.clear();
  liveClaimOf.clear();
}

/** Test-only: drop the cross-tab channel so one test's stub cannot outlive it. */
export function _resetOutboundQueueChangeChannel(): void {
  closeChangeChannel();
  changeSubscribers = 0;
}

/** Test-only reset to the production IndexedDB Adapter. */
export function _resetOutboundQueueStorage(): void {
  storage = createIdbOutboundQueueStorage();
  retiredStorage = storeRetiredBeside(storage);
  mutationTail = Promise.resolve();
  unavailableClaims.clear();
  liveOwned.clear();
  drainInFlight.clear();
  liveClaimOf.clear();
}

/** Test-only: as if this renderer had not yet learned its own boot id. */
export function _forgetKnownBootId(): void {
  knownBootId = undefined;
}
