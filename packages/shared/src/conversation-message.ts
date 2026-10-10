import type { InputRequestRecord } from '@kontourai/station-contracts/input-request';
import type { EngineToolKind } from '@kontourai/station-contracts/runtime-events';
import type { TurnProvenanceEnvelope } from '@kontourai/station-contracts/turn-provenance';
import type {
  ToolRequestServerGrant,
  ToolRequestSessionGrant,
} from './tool-request-preview.js';

/**
 * Canonical conversation message shape — the single shared contract every
 * persistence/refresh path produces and the chat UI consumes (internal runtime,
 * ACP bridge, and native-SDK event projection). Lives in station-shared so both
 * the server and the client import the exact same types.
 */
export interface MessagePart {
  type: string;
  text?: string;
  url?: string;
  /**
   * Content-addressed handle for a `file` part whose bytes this read did not
   * carry (station#3374/#3385). Present without `url` when the transcript came
   * through a byte-budgeted read; the client fetches the bytes from
   * `GET /api/attachments/:ref`. Absent on both when retention has reclaimed
   * the blob, which is the honest icon-only chip.
   */
  blobRef?: string;
  mediaType?: string;
  name?: string;
  toolCallId?: string;
  /** Durable terminal tool-result event identity, never a tool-call id. */
  sourceEventId?: string;
  toolName?: string;
  /**
   * The engine's own category for the call (ACP `ToolKind`), when it reported
   * one. Carried so a renderer classifies by what the engine said rather than
   * by guessing from `toolName`, which for a nameless ACP call is its human
   * title — often a whole shell command.
   */
  toolKind?: EngineToolKind;
  purpose?: string;
  /**
   * Strands persistence writer shape; see
   * src-server/runtime/frameworks/strands-message-sync.ts.
   */
  toolInvocation?: {
    toolCallId?: string;
    toolName?: string;
    args?: unknown;
    state?: string;
    result?: unknown;
    isError?: boolean;
  };
  // Tool input; intentionally permissive — providers emit arbitrary argument shapes.
  args?: any;
  state?: string;
  result?: string;
  /** Provider output retained in its original JSON-compatible shape. */
  output?: unknown;
  error?: string;
  cancelled?: boolean;
  isError?: boolean;
  progressMessage?: string;
  /** Engine output was deliberately narrowed before publication. */
  outputTruncated?: true;
  /**
   * station#3769: set only by `runtime-event-projection.ts` on the text part
   * it writes for a `runtime.error`, so a failure replayed from the durable
   * event window is recognisable as a failure by its SHAPE rather than by the
   * `⚠️` its display text happens to start with. The chat dock's
   * one-failure-one-surface arbitration (`utils/sessionFailure.ts`) reads it
   * to know the transcript is already showing this failure; without it the
   * session-failure banner described the same incident a second time, in a
   * different vocabulary. No other writer sets it.
   */
  runtimeError?: boolean;
  /**
   * #765 A1: the originating `RuntimeErrorEvent.code`, carried alongside
   * `runtimeError` when the durable event had one (e.g.
   * `engine-session-binding-dead`). The live SSE path already translates a
   * coded failure into plain-language copy (`turnHandlers.ts` /
   * `chatErrorTranslation.ts`); without this field the rehydrated projection
   * of the SAME failure could only render the engine's raw prose verbatim.
   * Set only by `runtime-event-projection.ts`, only next to
   * `runtimeError: true`.
   */
  runtimeErrorCode?: string;
  needsApproval?: boolean;
  approvalId?: string;
  /**
   * #2316: the execution session (`threadId`) of the `request.opened` that set
   * `approvalId`. A request id is only meaningful to the adapter session that
   * minted it, so the inline approval card answers through orchestration
   * `respondToRequest` on exactly this thread — never the chat tab's id, which
   * names a conversation, not the child session holding the request. Set only
   * by `runtime-event-projection.ts`, only next to `approvalId`.
   */
  approvalThreadId?: string;
  /**
   * #2316: the `eventId` of that `request.opened`. The card sends it as the
   * respond command's `expectedRequestEventId`, so the server answers only the
   * exact prompt the user saw (and verifies it is still open and answerable).
   * Set only next to `approvalThreadId`.
   */
  approvalEventId?: string;
  /**
   * The tool name that `request.opened`'s payload reported, if any — the name
   * an adapter records a session grant under. The session-grant button names
   * THIS, never `toolName`: for a nameless ACP or Codex call `toolName` is
   * display text (the whole command line), and the grant is not for it. Set
   * only next to `approvalThreadId`.
   */
  approvalToolName?: string;
  /**
   * #2915/#2916: what a session answer to that request grants, computed from
   * its payload with `toolRequestSessionGrantFromPayload` — the inline card's
   * session option and label. Set only next to `approvalEventId`.
   */
  approvalSessionGrant?: ToolRequestSessionGrant;
  /**
   * Whether that request also offers the server-wide Station browser grant
   * (`toolRequestServerGrantFromPayload`); `'none'` or absent offers nothing.
   */
  approvalServerGrant?: ToolRequestServerGrant;
  /**
   * station#3117: `'policy-denied'` is set only from the runtime event's own
   * `policyDenied` marker (see `runtime-event-projection.ts`'s `tool.completed`
   * case) — never inferred from `state === 'error'` alone, so a rehydrated
   * transcript shows the same distinct state a live one does.
   */
  approvalStatus?:
    | 'auto-approved'
    | 'user-approved'
    | 'user-denied'
    | 'policy-denied';
  /**
   * #3390: the `input-request` part's record of one request that has no
   * tool row to carry it — every form, and an approval bound to no call. It
   * opens on `request.opened` and records its outcome on `request.resolved`.
   */
  inputRequestRecord?: InputRequestRecord;
}

export interface ConversationMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  parts: MessagePart[];
  metadata?: {
    timestamp?: number;
    /** User input appended inside an already-running provider turn. */
    inputKind?: 'steer';
    /** That steer was delivered by cancelling the running step (see `TurnStartedEvent`). */
    steerInterruptedRun?: true;
    /** Durable source event for an authored user row, never an optimistic id. */
    sourceEventId?: string;
    /** The model Station requested — NOT a runtime-confirmed observation. See `reportedModel`. */
    model?: string | null;
    modelOptions?: Record<string, string | number | boolean>;
    /**
     * station#1182: the model a runtime independently reported, when its
     * adapter has one (see `effective-model-metadata.ts`). Absent, never
     * defaulted to `model`, when the connected engine reports nothing.
     */
    reportedModel?: string | null;
    /**
     * station#1410: the canonical turn this assistant message projects,
     * carried so a chat row correlates to its turn exactly rather than by
     * position (projected message ids are positional and unstable). Present
     * only when the turn's own events carried a `turnId`.
     */
    turnId?: string;
    /**
     * The execution Session that produced this historical row. This is
     * deliberately row-scoped: a conversation may later span replacement
     * execution Sessions, so consumers must not substitute the active one.
     */
    sessionId?: string;
    /** True only for a terminal successful assistant response. */
    answerEligible?: boolean;
    /**
     * station#1410: the turn's provenance envelope, re-derived from the
     * durable orchestration event stream on every read. A projection, not a
     * second store — see `packages/contracts/src/turn-provenance.ts`.
     */
    provenance?: TurnProvenanceEnvelope;
  };
}
