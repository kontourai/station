import {
  EXTENSION_TRANSCRIPT_MARKERS,
  type ExtensionTranscriptMarkerEmitter,
} from '@kontourai/station-shared/extension-transcript-markers';

export type ExtensionNotificationConsumer =
  | 'acp.commands.available'
  | 'acp.turn-error-cause'
  | 'acp.host-chrome'
  | 'acp.cursor.todos'
  | 'ui.kiro.oauth-request'
  | 'ui.kiro.compaction-status'
  | 'ui.kiro.clear-status'
  | 'ui.claude.thinking-tokens'
  | 'ui.claude.api-retry'
  | 'ui.claude.session-status'
  | 'ui.claude.task-registry'
  | 'ui.claude.task-settled'
  | 'ui.engine.mcp-status'
  | 'transcript.marker';

/**
 * Consumers the engine-extension table names that a parity lane implements.
 * Each is a typed placeholder until `ENGINE_EXTENSION_CONSUMERS` marks it
 * implemented; only then do its notification rows bind (see
 * {@link EXTENSION_NOTIFICATION_BINDINGS}).
 */
export type EngineExtensionConsumerId =
  /** `station.input-request/v1` URL body: a link for the person to open. */
  | 'input-request.url'
  /** `station.input-request/v1` form body from an elicitation. */
  | 'input-request.form'
  /** `station.input-request/v1` choice field with `allowCustom`. */
  | 'input-request.choice'
  /** A reviewed engine-credential binding (`engine-credential-provider`). */
  | 'engine-credential'
  /** A reviewed engine secret store (`engine-secret-storage`). */
  | 'engine-secret-storage'
  /** Facts about Station's terminal bridge (the shell it runs). */
  | 'client.terminal-facts'
  /** The `engine-mcp.status` canonical event. */
  | 'engine-mcp.status'
  /** The `model.rerouted` canonical event. */
  | 'model.rerouted'
  /** `token-usage.updated.reportedCost`. */
  | 'usage.reported-cost'
  /** `token-usage.updated.contextPercent`. */
  | 'usage.context-percent'
  /** The engine's id for the user message, recorded against the turn for rewind and fork. */
  | 'session.message-id'
  /** A title the engine suggests for the session. */
  | 'session.title-suggestion'
  /** The engine's own turn start and end markers. */
  | 'session.turn-boundary'
  /** The session's current mode changed engine-side; refresh it. */
  | 'session.mode-refresh'
  /** The engine compacted (or failed to compact) its context. */
  | 'session.compaction-status'
  /** A mid-turn steer was queued, injected or cleared engine-side. */
  | 'session.steer-status'
  /** The `child-work.updated` canonical event. */
  | 'child-work'
  /** Organization-enforced feature flags the engine reports. */
  | 'engine.policy-state'
  /** Context and instructions the engine loaded on its own (read-only list). */
  | 'engine.loaded-context';

export type ExtensionHandshakeVariant =
  | 'kiro-v2'
  | 'kiro-v3'
  | 'claude-adapter'
  | 'xai-acp'
  | 'cursor-acp'
  | ExtensionTranscriptMarkerEmitter;

/**
 * Evidence tags identify a runtime observation, a pinned SDK protocol
 * contract, a vendor's published protocol contract, or (`station-session-source-emitter`) a tuple a Station session
 * source mints itself, pinned by that source's own tests.
 */
export type ExtensionNotificationEvidence =
  | 'station#1815-runtime-observation'
  | 'station#4084-runtime-observation'
  | 'station#1935-runtime-observation'
  | 'claude-sdk-api-retry-contract'
  | 'cursor-acp-docs-contract'
  | 'station-session-source-emitter'
  /** A row of {@link ENGINE_EXTENSION_BINDINGS}; that row names its evidence. */
  | 'engine-extension-binding';

export interface ExtensionNotificationBinding {
  readonly namespace: string;
  readonly type: string;
  readonly consumer: ExtensionNotificationConsumer | EngineExtensionConsumerId;
  readonly observedAgainst: readonly ExtensionHandshakeVariant[];
  readonly evidence: ExtensionNotificationEvidence;
}

/**
 * Exact evidence-backed application semantics for opaque extension events.
 * Unknown tuples remain opaque/no-op; namespace similarity is never authority.
 * Kiro v3's `_kiro` spelling binds only through its own observed rows in
 * {@link ENGINE_EXTENSION_BINDINGS}; it never inherits `_kiro.dev` behavior.
 */
const DECLARED_EXTENSION_NOTIFICATION_BINDINGS = [
  {
    namespace: '_kiro.dev',
    type: 'commands/available',
    consumer: 'acp.commands.available',
    observedAgainst: ['kiro-v2'],
    evidence: 'station#1815-runtime-observation',
  },
  {
    namespace: '_kiro.dev',
    type: 'mcp/oauth_request',
    consumer: 'ui.kiro.oauth-request',
    observedAgainst: ['kiro-v2'],
    evidence: 'station#1815-runtime-observation',
  },
  {
    namespace: '_kiro.dev',
    type: 'compaction/status',
    consumer: 'ui.kiro.compaction-status',
    observedAgainst: ['kiro-v2'],
    evidence: 'station#1815-runtime-observation',
  },
  {
    namespace: '_kiro.dev',
    type: 'clear/status',
    consumer: 'ui.kiro.clear-status',
    observedAgainst: ['kiro-v2'],
    evidence: 'station#1815-runtime-observation',
  },
  {
    // station#4084 (review fix round F1): the live #1860 verification run
    // observed this exact tuple carrying a human-readable `message`
    // ("The monthly usage limit has been reached") milliseconds before an
    // otherwise-generic turn failure. Per this registry's own rule —
    // "namespace similarity is never authority" — only this exact,
    // evidenced tuple is bound; an analogous notification from another
    // vendor, or another `_kiro.dev/error/*` type, is NOT matched until it
    // is itself observed and added here with its own evidence.
    namespace: '_kiro.dev',
    type: 'error/rate_limit',
    consumer: 'acp.turn-error-cause',
    observedAgainst: ['kiro-v2'],
    evidence: 'station#4084-runtime-observation',
  },
  {
    // SDKAPIRetryMessage in the pinned Claude Agent SDK; adapter publishes
    // only attempt, delay, and a safe display reason from that typed signal.
    namespace: 'claude-code',
    type: 'api/retry',
    consumer: 'ui.claude.api-retry',
    observedAgainst: ['claude-adapter'],
    evidence: 'claude-sdk-api-retry-contract',
  },
  {
    namespace: 'claude-code',
    type: 'thinking/tokens',
    consumer: 'ui.claude.thinking-tokens',
    observedAgainst: ['claude-adapter'],
    evidence: 'station#1815-runtime-observation',
  },
  {
    namespace: 'claude-code',
    type: 'session/status',
    consumer: 'ui.claude.session-status',
    observedAgainst: ['claude-adapter'],
    evidence: 'station#1815-runtime-observation',
  },
  // Replay only since #2457: the Claude adapter emits `child-work.updated`;
  // these two bind the tuples persisted pre-#2457 history still carries.
  {
    namespace: 'claude-code',
    type: 'task/registry',
    consumer: 'ui.claude.task-registry',
    observedAgainst: ['claude-adapter'],
    evidence: 'station#1815-runtime-observation',
  },
  {
    namespace: 'claude-code',
    type: 'task/settled',
    consumer: 'ui.claude.task-settled',
    observedAgainst: ['claude-adapter'],
    evidence: 'station#1815-runtime-observation',
  },
  // station#1935: live stable orchestration.sqlite observation. These
  // tuples reach the dock as extension.notification; they are host/session
  // chrome, not transcript facts. Binding them as host-chrome makes the
  // fold exhaustive without inventing chat semantics from vendor payloads.
  // Kiro v2's `mcp/server_initialized` and `metadata` moved to their
  // engine-extension rows below, which the ACP mapper turns into canonical
  // events.
  {
    // Its engine row (consumer `child-work`, `acp-child-work.ts`) publishes
    // the roster as child work; the opaque envelope itself stays chrome.
    namespace: '_kiro.dev',
    type: 'subagent/list_update',
    consumer: 'acp.host-chrome',
    observedAgainst: ['kiro-v2'],
    evidence: 'station#1935-runtime-observation',
  },
  {
    namespace: '_x.ai',
    type: 'models/update',
    consumer: 'acp.host-chrome',
    observedAgainst: ['xai-acp'],
    evidence: 'station#1935-runtime-observation',
  },
  {
    namespace: '_x.ai',
    type: 'settings/update',
    consumer: 'acp.host-chrome',
    observedAgainst: ['xai-acp'],
    evidence: 'station#1935-runtime-observation',
  },
  {
    namespace: '_x.ai',
    type: 'sessions/changed',
    consumer: 'acp.host-chrome',
    observedAgainst: ['xai-acp'],
    evidence: 'station#1935-runtime-observation',
  },
  {
    namespace: '_x.ai',
    type: 'announcements/update',
    consumer: 'acp.host-chrome',
    observedAgainst: ['xai-acp'],
    evidence: 'station#1935-runtime-observation',
  },
  {
    namespace: '_x.ai',
    type: 'queue/changed',
    consumer: 'acp.host-chrome',
    observedAgainst: ['xai-acp'],
    evidence: 'station#1935-runtime-observation',
  },
  {
    namespace: '_x.ai',
    type: 'session_notification',
    consumer: 'acp.host-chrome',
    observedAgainst: ['xai-acp'],
    evidence: 'station#1935-runtime-observation',
  },
  {
    namespace: '_x.ai',
    type: 'session/prompt_complete',
    consumer: 'acp.host-chrome',
    observedAgainst: ['xai-acp'],
    evidence: 'station#1935-runtime-observation',
  },
  {
    namespace: '_x.ai',
    type: 'mcp/init_progress',
    consumer: 'ui.engine.mcp-status',
    observedAgainst: ['xai-acp'],
    evidence: 'station#1935-runtime-observation',
  },
  {
    namespace: '_x.ai',
    type: 'mcp_initialized',
    consumer: 'ui.engine.mcp-status',
    observedAgainst: ['xai-acp'],
    evidence: 'station#1935-runtime-observation',
  },
  {
    namespace: '_x.ai',
    type: 'mcp/servers_updated',
    consumer: 'ui.engine.mcp-status',
    observedAgainst: ['xai-acp'],
    evidence: 'station#1935-runtime-observation',
  },
  {
    // Cursor's published ACP contract (cursor.com/docs/cli/acp): a
    // fire-and-forget todo-list update, folded into the typed plan surface.
    namespace: 'cursor',
    type: 'update_todos',
    consumer: 'acp.cursor.todos',
    observedAgainst: ['cursor-acp'],
    evidence: 'cursor-acp-docs-contract',
  },
] as const satisfies readonly ExtensionNotificationBinding[];

// --- Engine extensions (Kiro parity, one row per wire shape) ---------------

/**
 * Where an engine extension arrives.
 * - `notification` / `request`: an engine→client JSON-RPC method.
 * - `session-info-kind`: a core `session_info_update` whose
 *   `_meta.<namespace>.kind` is `kind`.
 * - `session-update-kind`: a vendor notification `method` whose
 *   `update.sessionUpdate` is `sessionUpdate`.
 * - `tool-call-meta-kind`: a core `tool_call` / `tool_call_update` whose
 *   `_meta.<namespace>.kind` is `kind`.
 * - `tool-call-meta-field`: a core `tool_call` / `tool_call_update` whose
 *   top-level `_meta.<field>` is `value`, for an engine that keeps its
 *   facts outside a vendor namespace.
 */
export type EngineExtensionWire =
  | { readonly kind: 'notification'; readonly method: string }
  | { readonly kind: 'request'; readonly method: string }
  | {
      readonly kind: 'session-info-kind';
      readonly namespace: string;
      readonly metaKind: string;
    }
  | {
      readonly kind: 'session-update-kind';
      readonly method: string;
      readonly sessionUpdate: string;
    }
  | {
      readonly kind: 'tool-call-meta-kind';
      readonly namespace: string;
      readonly metaKind: string;
    }
  | {
      readonly kind: 'tool-call-meta-field';
      readonly field: string;
      readonly value: string;
    };

/**
 * Why Station may rely on the engine sending it (ADR 0013).
 * - `declared`: the live handshake declares the method or flag.
 * - `client-announced`: the engine sends it because Station announced a
 *   client capability, which is announced only while the handler exists.
 * - `undeclared-engine`: the engine sends it unasked; a reviewed handshake
 *   identity (`resolveAcpEngineVariant`) says which engine does.
 */
export type EngineExtensionBasis =
  | 'declared'
  | 'client-announced'
  | 'undeclared-engine';

/** The live capture in this repository the `kiro-v3-2.35` rows were observed in. */
export const KIRO_V3_LIVE_CAPTURE =
  'src-server/services/acp/__tests__/fixtures/kiro-v3-2.35.0-session-frames.jsonl';

/**
 * What a row was observed against.
 * - `kiro-v3-2.35`: a live kiro-cli 2.35.0 `--agent-engine v3` run, scrubbed
 *   into {@link KIRO_V3_LIVE_CAPTURE}.
 * - `kirocrew-fixture`: only a recorded frame or test in
 *   kirodotdev/kirocrew; `fixture` is the path in that repository.
 * - `kiro-v2`: a Station runtime observation already cited by the
 *   notification table.
 * - `vendor-source`: read from the engine's own published source, not a
 *   live run; `source` is the repository, commit and paths.
 */
export type EngineExtensionObservation =
  | { readonly variant: 'kiro-v3-2.35'; readonly capture: string }
  | { readonly variant: 'kirocrew-fixture'; readonly fixture: string }
  | {
      readonly variant: 'kiro-v2';
      readonly ref: ExtensionNotificationEvidence;
    }
  | { readonly variant: 'vendor-source'; readonly source: string };

export interface EngineExtensionBinding {
  readonly id: string;
  readonly wire: EngineExtensionWire;
  readonly basis: EngineExtensionBasis;
  readonly observed: EngineExtensionObservation;
  readonly consumer: ExtensionNotificationConsumer | EngineExtensionConsumerId;
}

/**
 * Who implements each placeholder consumer, and whether it has. Flip
 * `implemented` in the change that lands the consumer: that is what binds
 * its notification rows.
 */
export const ENGINE_EXTENSION_CONSUMERS: Readonly<
  Record<
    EngineExtensionConsumerId,
    {
      readonly lane: 'host-auth' | 'adapter' | 'events-ui';
      readonly implemented: boolean;
    }
  >
> = Object.freeze({
  'input-request.url': Object.freeze({ lane: 'adapter', implemented: false }),
  'input-request.form': Object.freeze({ lane: 'adapter', implemented: false }),
  'input-request.choice': Object.freeze({
    lane: 'adapter',
    implemented: false,
  }),
  'engine-credential': Object.freeze({ lane: 'host-auth', implemented: false }),
  'engine-secret-storage': Object.freeze({
    lane: 'host-auth',
    implemented: false,
  }),
  'client.terminal-facts': Object.freeze({
    lane: 'adapter',
    implemented: false,
  }),
  'engine-mcp.status': Object.freeze({ lane: 'events-ui', implemented: true }),
  'model.rerouted': Object.freeze({ lane: 'events-ui', implemented: true }),
  'usage.reported-cost': Object.freeze({
    lane: 'events-ui',
    implemented: true,
  }),
  'usage.context-percent': Object.freeze({
    lane: 'events-ui',
    implemented: true,
  }),
  'session.message-id': Object.freeze({
    lane: 'events-ui',
    implemented: true,
  }),
  'session.title-suggestion': Object.freeze({
    lane: 'events-ui',
    implemented: false,
  }),
  'session.turn-boundary': Object.freeze({
    lane: 'events-ui',
    implemented: false,
  }),
  'session.mode-refresh': Object.freeze({
    lane: 'events-ui',
    implemented: false,
  }),
  'session.compaction-status': Object.freeze({
    lane: 'events-ui',
    implemented: false,
  }),
  'session.steer-status': Object.freeze({
    lane: 'events-ui',
    implemented: false,
  }),
  // `acp-child-work.ts`: the ACP subagent cell is declared, and an engine
  // whose handshake names no subagent reporter says `not-reported` at start.
  'child-work': Object.freeze({ lane: 'events-ui', implemented: true }),
  'engine.policy-state': Object.freeze({
    lane: 'events-ui',
    implemented: false,
  }),
  'engine.loaded-context': Object.freeze({
    lane: 'events-ui',
    implemented: false,
  }),
});

const LIVE = {
  variant: 'kiro-v3-2.35',
  capture: KIRO_V3_LIVE_CAPTURE,
} as const;
const crew = (fixture: string) =>
  ({ variant: 'kirocrew-fixture', fixture }) as const;
const note = (method: string) => ({ kind: 'notification', method }) as const;
const request = (method: string) => ({ kind: 'request', method }) as const;
const info = (metaKind: string) =>
  ({ kind: 'session-info-kind', namespace: 'kiro', metaKind }) as const;

/**
 * Every engine→client extension the Kiro parity work binds, and the rows
 * other engines' depth work added after it, one row per wire shape. Rows whose tuple the notification table above already binds
 * (`_kiro.dev/mcp/oauth_request`, …) re-route it to a new consumer; the
 * older row wins until it is removed with its handler.
 *
 * Not here, by decision (docs/guides/acp.md, unsupported list): `_kiro/hooks/*`,
 * `_kiro/workflow/*` notifications, and anything from a remote session source
 * or a cloud execution target.
 */
const ENGINE_EXTENSION_ROWS: readonly EngineExtensionBinding[] = [
  // Kiro v2 (kiro-cli's own engine).
  {
    id: 'kiro-v2.agent-switched',
    wire: note('_kiro.dev/agent/switched'),
    basis: 'undeclared-engine',
    observed: crew('test/fixtures/acp_frames/kiro/notifications.jsonl'),
    consumer: 'session.mode-refresh',
  },
  {
    id: 'kiro-v2.mcp-server-initialized',
    wire: note('_kiro.dev/mcp/server_initialized'),
    basis: 'undeclared-engine',
    observed: { variant: 'kiro-v2', ref: 'station#1935-runtime-observation' },
    consumer: 'engine-mcp.status',
  },
  {
    id: 'kiro-v2.mcp-server-init-failure',
    wire: note('_kiro.dev/mcp/server_init_failure'),
    basis: 'undeclared-engine',
    observed: crew('test/fixtures/acp_frames/kiro/notifications.jsonl'),
    consumer: 'engine-mcp.status',
  },
  {
    id: 'kiro-v2.mcp-oauth-request',
    wire: note('_kiro.dev/mcp/oauth_request'),
    basis: 'undeclared-engine',
    observed: { variant: 'kiro-v2', ref: 'station#1815-runtime-observation' },
    consumer: 'input-request.url',
  },
  {
    id: 'kiro-v2.metadata',
    wire: note('_kiro.dev/metadata'),
    basis: 'undeclared-engine',
    observed: crew('test/fixtures/acp_frames/kiro/compaction-live.jsonl'),
    consumer: 'usage.context-percent',
  },
  {
    id: 'kiro-v2.subagent-list-update',
    wire: note('_kiro.dev/subagent/list_update'),
    basis: 'undeclared-engine',
    observed: crew('test/fixtures/acp_frames/kiro/notifications.jsonl'),
    consumer: 'child-work',
  },
  {
    id: 'kiro-v2.model-fallback',
    wire: {
      kind: 'session-update-kind',
      method: '_kiro.dev/session/update',
      sessionUpdate: 'model_fallback',
    },
    basis: 'undeclared-engine',
    observed: crew('test/fixtures/acp_frames/kiro/refusal-fallback-live.jsonl'),
    consumer: 'model.rerouted',
  },
  // Kiro v3 (the agent service), engine→client notifications.
  {
    id: 'kiro-v3.memory-sync-status',
    wire: note('_kiro/memory/syncStatus'),
    basis: 'undeclared-engine',
    observed: LIVE,
    consumer: 'acp.host-chrome',
  },
  {
    // Organization feature flags. Station has no engine-policy fact surface
    // yet; its own policy governs tool calls regardless, so this is chrome.
    id: 'kiro-v3.governance-state',
    wire: note('_kiro/governance/state'),
    basis: 'undeclared-engine',
    observed: LIVE,
    consumer: 'acp.host-chrome',
  },
  {
    // Kiro's packaged capability bundles. No Station abstraction fits yet.
    id: 'kiro-v3.powers-items-changed',
    wire: note('_kiro/powers/items_changed'),
    basis: 'undeclared-engine',
    observed: LIVE,
    consumer: 'acp.host-chrome',
  },
  {
    // The engine's own session index; Station's resume picker reads
    // `session/list` instead.
    id: 'kiro-v3.sessions-changed',
    wire: note('_kiro/sessions/changed'),
    basis: 'undeclared-engine',
    observed: LIVE,
    consumer: 'acp.host-chrome',
  },
  {
    id: 'kiro-v3.mcp-status',
    wire: note('_kiro/mcp/status'),
    basis: 'undeclared-engine',
    observed: LIVE,
    consumer: 'engine-mcp.status',
  },
  {
    // The engine's tool-tag inventory, not a server status: server state and
    // tool counts come from `_kiro/mcp/status`.
    id: 'kiro-v3.tools-did-change',
    wire: note('_kiro/tools/didChange'),
    basis: 'undeclared-engine',
    observed: LIVE,
    consumer: 'acp.host-chrome',
  },
  {
    // No read-only "engine-loaded context" surface exists yet.
    id: 'kiro-v3.progressive-context-items-changed',
    wire: note('_kiro/progressive_context/items_changed'),
    basis: 'undeclared-engine',
    observed: LIVE,
    consumer: 'acp.host-chrome',
  },
  {
    // No read-only "engine-loaded context" surface exists yet.
    id: 'kiro-v3.steering-documents-changed',
    wire: note('_kiro/steering/documents_changed'),
    basis: 'undeclared-engine',
    observed: LIVE,
    consumer: 'acp.host-chrome',
  },
  // Kiro v3 `session_info_update._meta.kiro.kind`.
  {
    id: 'kiro-v3.info.context-usage',
    wire: info('context_usage'),
    basis: 'undeclared-engine',
    observed: LIVE,
    consumer: 'usage.context-percent',
  },
  {
    id: 'kiro-v3.info.user-message-id-assigned',
    wire: info('user_message_id_assigned'),
    basis: 'undeclared-engine',
    observed: LIVE,
    consumer: 'session.message-id',
  },
  {
    // A title suggestion and activity status. No canonical title-suggestion
    // event exists, so this is chrome until one does.
    id: 'kiro-v3.info.focus-update',
    wire: info('focus_update'),
    basis: 'undeclared-engine',
    observed: LIVE,
    consumer: 'acp.host-chrome',
  },
  {
    // Station's turns already start on its own `session/prompt`. An
    // engine-started turn needs the adapter to own provider-triggered turns
    // (`PROVIDER_TURN_TRIGGER`); until it does, this is chrome.
    id: 'kiro-v3.info.turn-start',
    wire: info('turn_start'),
    basis: 'undeclared-engine',
    observed: LIVE,
    consumer: 'acp.host-chrome',
  },
  {
    // See `kiro-v3.info.turn-start`.
    id: 'kiro-v3.info.turn-end',
    wire: info('turn_end'),
    basis: 'undeclared-engine',
    observed: LIVE,
    consumer: 'acp.host-chrome',
  },
  {
    // The engine-side mirror of a `session/request_permission` it also
    // sends; the request is the approval, this is chrome.
    id: 'kiro-v3.info.pending-interaction',
    wire: info('pending_interaction'),
    basis: 'undeclared-engine',
    observed: LIVE,
    consumer: 'acp.host-chrome',
  },
  {
    id: 'kiro-v3.info.interaction-resolved',
    wire: info('interaction_resolved'),
    basis: 'undeclared-engine',
    observed: LIVE,
    consumer: 'acp.host-chrome',
  },
  {
    // Per turn: `promptTurnSummaries[unit=credit]`, scope `turn`.
    id: 'kiro-v3.info.turn-completion',
    wire: info('turn_completion'),
    basis: 'undeclared-engine',
    observed: LIVE,
    consumer: 'usage.reported-cost',
  },
  {
    // Cumulative: `credits[]`, scope `session`.
    id: 'kiro-v3.info.session-usage',
    wire: info('session_usage'),
    basis: 'undeclared-engine',
    observed: LIVE,
    consumer: 'usage.reported-cost',
  },
  {
    id: 'kiro-v3.info.summarization-started',
    wire: info('summarization_started'),
    basis: 'undeclared-engine',
    observed: crew('test/fixtures/acp_frames/kas/auto-compaction-live.jsonl'),
    consumer: 'session.compaction-status',
  },
  {
    id: 'kiro-v3.info.summarization-completed',
    wire: info('summarization_completed'),
    basis: 'undeclared-engine',
    observed: crew('test/fixtures/acp_frames/kas/auto-compaction-live.jsonl'),
    consumer: 'session.compaction-status',
  },
  {
    id: 'kiro-v3.info.summarization-failed',
    wire: info('summarization_failed'),
    basis: 'undeclared-engine',
    observed: crew('test/test_kas_display_mapping.py'),
    consumer: 'session.compaction-status',
  },
  {
    id: 'kiro-v3.info.model-fallback',
    wire: info('model_fallback'),
    basis: 'declared',
    observed: crew('test/acp_frame_replay_harness.py'),
    consumer: 'model.rerouted',
  },
  {
    // On the subagent's own `tool_call` / `tool_call_update`, not on a
    // `session_info_update` (kirocrew `session_handle_native_children.py`,
    // `test_kas_subagent_progress.py`).
    id: 'kiro-v3.tool.agent-subtask',
    wire: {
      kind: 'tool-call-meta-kind',
      namespace: 'kiro',
      metaKind: 'agent-subtask',
    },
    basis: 'undeclared-engine',
    observed: crew('test/test_kas_wire.py'),
    consumer: 'child-work',
  },
  {
    id: 'kiro-v3.info.steering-queued',
    wire: info('steering_queued'),
    basis: 'undeclared-engine',
    observed: crew('test/fixtures/acp_frames/kas/steering-live.jsonl'),
    consumer: 'session.steer-status',
  },
  {
    id: 'kiro-v3.info.steering-injected',
    wire: info('steering_injected'),
    basis: 'undeclared-engine',
    observed: crew('test/fixtures/acp_frames/kas/steering-live.jsonl'),
    consumer: 'session.steer-status',
  },
  {
    id: 'kiro-v3.info.steering-cleared',
    wire: info('steering_cleared'),
    basis: 'undeclared-engine',
    observed: crew('test/fixtures/acp_frames/kas/steering-live.jsonl'),
    consumer: 'session.steer-status',
  },
  // Kiro v3 engine→client requests.
  {
    // Bundle route only (`--auth=acp-callback`); the kiro-cli relay runs
    // `--auth-method cli` and never asks.
    id: 'kiro-v3.auth-get-access-token',
    wire: request('_kiro/auth/getAccessToken'),
    basis: 'undeclared-engine',
    observed: crew(
      'test/fixtures/acp_frames/kas/host-auth-callback-live.jsonl',
    ),
    consumer: 'engine-credential',
  },
  {
    id: 'kiro-v3.secret-get',
    wire: request('_kiro/secret/get'),
    basis: 'client-announced',
    observed: crew('test/test_kas_mcp_secret_storage.py'),
    consumer: 'engine-secret-storage',
  },
  {
    id: 'kiro-v3.secret-store',
    wire: request('_kiro/secret/store'),
    basis: 'client-announced',
    observed: crew('test/test_kas_mcp_secret_storage.py'),
    consumer: 'engine-secret-storage',
  },
  {
    id: 'kiro-v3.secret-delete',
    wire: request('_kiro/secret/delete'),
    basis: 'client-announced',
    observed: crew('test/test_kas_mcp_secret_storage.py'),
    consumer: 'engine-secret-storage',
  },
  {
    id: 'kiro-v3.open-external-url',
    wire: request('_kiro/openExternalUrl'),
    basis: 'client-announced',
    observed: crew('test/fixtures/acp_frames/kas/open-external-url-live.jsonl'),
    consumer: 'input-request.url',
  },
  {
    // Fields nested under `params.elicitation`.
    id: 'kiro-v3.mcp-elicitation',
    wire: request('_kiro/mcp/elicitation'),
    basis: 'undeclared-engine',
    observed: crew('test/fixtures/acp_frames/kas/mcp-elicitation.jsonl'),
    consumer: 'input-request.form',
  },
  {
    // Any answer but `{action:'answered', answer:<non-empty>}` reads as yes.
    id: 'kiro-v3.user-input',
    wire: request('_kiro/userInput'),
    basis: 'client-announced',
    observed: crew('test/test_acp_user_input.py'),
    consumer: 'input-request.choice',
  },
  {
    // `{sessionId}`. On 2.35 a -32601 no longer fails session/new.
    id: 'kiro-v3.terminal-shell-type',
    wire: request('_kiro/terminal/shell_type'),
    basis: 'undeclared-engine',
    observed: LIVE,
    consumer: 'client.terminal-facts',
  },
  // Qwen Code (`agentInfo.name` `qwen-code`).
  {
    // A subagent's own tool calls carry `_meta.provenance: 'subagent'` and
    // name the Agent tool call that runs it as `_meta.parentToolCallId`;
    // its progress notes on that call carry the marker with
    // `subagentProgress: true`. The parent call's own result ends it.
    id: 'qwen-code.tool.subagent',
    wire: {
      kind: 'tool-call-meta-field',
      field: 'provenance',
      value: 'subagent',
    },
    basis: 'undeclared-engine',
    observed: {
      variant: 'vendor-source',
      source:
        'QwenLM/qwen-code 6f754be65489 packages/cli/src/acp-integration/session/SubAgentTracker.ts, session/emitters/tool-call-emitter.ts, packages/acp-bridge/src/transcript-replay.ts buildUpdateMeta',
    },
    consumer: 'child-work',
  },
];

export const ENGINE_EXTENSION_BINDINGS: readonly EngineExtensionBinding[] =
  Object.freeze(
    ENGINE_EXTENSION_ROWS.map((row) =>
      Object.freeze({
        ...row,
        wire: Object.freeze({ ...row.wire }),
        observed: Object.freeze({ ...row.observed }),
      }),
    ),
  );

function engineConsumerImplemented(
  consumer: EngineExtensionBinding['consumer'],
): boolean {
  return Object.hasOwn(ENGINE_EXTENSION_CONSUMERS, consumer)
    ? ENGINE_EXTENSION_CONSUMERS[consumer as EngineExtensionConsumerId]
        .implemented
    : true;
}

function splitNotificationMethod(method: string): {
  namespace: string;
  type: string;
} {
  const slash = method.indexOf('/');
  return slash === -1
    ? { namespace: method, type: method }
    : { namespace: method.slice(0, slash), type: method.slice(slash + 1) };
}

/**
 * The engine table's notification rows that bind now: an implemented
 * consumer and a tuple the table above does not already bind.
 */
function engineNotificationBindings(
  bound: readonly ExtensionNotificationBinding[],
): ExtensionNotificationBinding[] {
  const taken = new Set(
    bound.map(({ namespace, type }) => `${namespace}\0${type}`),
  );
  const rows: ExtensionNotificationBinding[] = [];
  for (const row of ENGINE_EXTENSION_BINDINGS) {
    if (row.wire.kind !== 'notification') continue;
    if (!engineConsumerImplemented(row.consumer)) continue;
    const { namespace, type } = splitNotificationMethod(row.wire.method);
    const key = `${namespace}\0${type}`;
    if (taken.has(key)) continue;
    taken.add(key);
    rows.push({
      namespace,
      type,
      consumer: row.consumer,
      // A `_kiro.dev` method is kiro-cli's own (v2) engine wherever it was
      // observed; a kirocrew fixture row says nothing about the variant.
      observedAgainst: [
        row.observed.variant === 'kiro-v2' || namespace === '_kiro.dev'
          ? 'kiro-v2'
          : 'kiro-v3',
      ],
      evidence: 'engine-extension-binding',
    });
  }
  return rows;
}

/** The engine-table row for a wire shape, implemented or not. */
export function engineExtensionBinding(
  wire: EngineExtensionWire,
): EngineExtensionBinding | undefined {
  return ENGINE_EXTENSION_BINDINGS.find((row) => {
    if (row.wire.kind !== wire.kind) return false;
    switch (wire.kind) {
      case 'notification':
      case 'request':
        return (row.wire as { method: string }).method === wire.method;
      case 'session-info-kind':
      case 'tool-call-meta-kind': {
        const other = row.wire as Extract<
          EngineExtensionWire,
          { kind: 'session-info-kind' | 'tool-call-meta-kind' }
        >;
        return (
          other.namespace === wire.namespace && other.metaKind === wire.metaKind
        );
      }
      case 'session-update-kind': {
        const other = row.wire as Extract<
          EngineExtensionWire,
          { kind: 'session-update-kind' }
        >;
        return (
          other.method === wire.method &&
          other.sessionUpdate === wire.sessionUpdate
        );
      }
      case 'tool-call-meta-field': {
        const other = row.wire as Extract<
          EngineExtensionWire,
          { kind: 'tool-call-meta-field' }
        >;
        return other.field === wire.field && other.value === wire.value;
      }
    }
  });
}

/**
 * station#3415: the transcript-marker tuples come from the projection's own
 * table, so one entry there both binds a tuple and renders it.
 */
const TRANSCRIPT_MARKER_BINDINGS: readonly ExtensionNotificationBinding[] =
  EXTENSION_TRANSCRIPT_MARKERS.map(({ namespace, type, emitter }) => ({
    namespace,
    type,
    consumer: 'transcript.marker',
    observedAgainst: [emitter],
    evidence: 'station-session-source-emitter',
  }));

const TABLE_NOTIFICATION_BINDINGS: readonly ExtensionNotificationBinding[] = [
  ...DECLARED_EXTENSION_NOTIFICATION_BINDINGS,
  ...TRANSCRIPT_MARKER_BINDINGS,
];

export const EXTENSION_NOTIFICATION_BINDINGS: readonly ExtensionNotificationBinding[] =
  Object.freeze(
    [
      ...TABLE_NOTIFICATION_BINDINGS,
      ...engineNotificationBindings(TABLE_NOTIFICATION_BINDINGS),
    ].map((binding) =>
      Object.freeze({
        ...binding,
        observedAgainst: Object.freeze([...binding.observedAgainst]),
      }),
    ),
  );

export function extensionNotificationBinding(
  namespace: string,
  type: string,
): ExtensionNotificationBinding | undefined {
  return EXTENSION_NOTIFICATION_BINDINGS.find(
    (binding) => binding.namespace === namespace && binding.type === type,
  );
}

export function isBoundExtensionNotification(
  namespace: string,
  type: string,
): boolean {
  return extensionNotificationBinding(namespace, type) !== undefined;
}

/**
 * At most this many distinct unbound (provider, namespace, type) keys are
 * remembered. Engines choose the names, so the set is bounded; past the cap
 * a new key is not noticed again, only counted
 * ({@link unboundExtensionNoticeOverflow}).
 */
export const UNBOUND_EXTENSION_NOTICE_KEYS_MAX = 256;

const unboundFirstSeen = new Set<string>();
let unboundOverflow = 0;

/** Unbound notifications not noticed because the key set was full. */
export function unboundExtensionNoticeOverflow(): number {
  return unboundOverflow;
}

export function unboundExtensionNoticeKey(
  provider: string,
  namespace: string,
  type: string,
): string {
  return `${provider}\0${namespace}\0${type}`;
}

/**
 * True the first time this process sees an unbound (namespace, type,
 * provider), while fewer than {@link UNBOUND_EXTENSION_NOTICE_KEYS_MAX} keys
 * have been seen.
 */
export function takeUnboundExtensionNotice(
  provider: string,
  namespace: string,
  type: string,
): boolean {
  const key = unboundExtensionNoticeKey(provider, namespace, type);
  if (unboundFirstSeen.has(key)) return false;
  if (unboundFirstSeen.size >= UNBOUND_EXTENSION_NOTICE_KEYS_MAX) {
    unboundOverflow += 1;
    return false;
  }
  unboundFirstSeen.add(key);
  return true;
}
