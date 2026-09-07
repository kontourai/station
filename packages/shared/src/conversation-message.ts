import type { TurnProvenanceEnvelope } from '@kontourai/station-contracts/turn-provenance';

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
}

export interface ConversationMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  parts: MessagePart[];
  metadata?: {
    timestamp?: number;
    /** User input appended inside an already-running provider turn. */
    inputKind?: 'steer';
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
