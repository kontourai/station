import {
  type EngineConnectionId,
  type EngineId,
  parseEngineId,
  engineId as toEngineId,
} from './agent-identity.js';

/**
 * The honest, single-source capability
 * matrix per engine (docs/design/agent-engine-unification.md §4.1). This is
 * the editor's truth AND the session-delivery truth: `sessionDeliveryChannels`
 * below derives `session-agent-resolution.ts`'s per-provider delivery map
 * from this same data, so the two surfaces cannot diverge (§5's
 * single-source-of-truth requirement).
 *
 * Cells are honest about what actually ships today, not what a wire channel
 * theoretically supports — e.g. codex's `systemPrompt` is `unsupported`
 * even though `developerInstructions` is a confirmed wire param, because
 * there is no version/capability signal to gate sending it on safely (see
 * that cell's own comment below). Entries move from `unsupported` to
 * `session`/`native` as support lands; see the
 * `docs/design/agent-engine-unification.md` §9 status table. Claude's
 * `toolServers` cell has the same shape (archive#895 → archive#1157): the
 * SDK's `mcpServers` channel existed but was unwired until archive#1157
 * wired it in `claude-adapter.ts buildOptions`. Codex's `toolServers` cell
 * (archive#1195) is the same, on the `wire` channel:
 * `codex-mcp-passthrough.ts` wires per-session
 * `-c mcp_servers.<id>....` overrides into the `codex app-server` spawn
 * argv (`codex app-server`'s own `-c`/`--config` session-layer overrides
 * — verified against codex-cli 0.145.0 — apply per-process-invocation
 * with no version/capability-signal ambiguity, unlike the `systemPrompt`
 * `developerInstructions` cell below).
 */

export type DeliveryChannel =
  // Crosses to an external, less-trusted process that spawns its own MCP
  // children (ACP: the connected agent app, e.g. Kiro; Codex: `codex
  // app-server`, an external app-server process that manages
  // its OWN outbound MCP connections — station never gets to
  // intercept or supply that connection's env). A tool server's `env` must
  // never cross this channel (see acp-mcp-passthrough.ts /
  // codex-mcp-passthrough.ts).
  | 'wire'
  // The engine spawns its MCP servers itself, IN Station's own server
  // process (Claude Agent SDK's `mcpServers` option — no external app in
  // between). Distinct from 'wire' specifically so a security-boundary
  // decision (which channel may reconstruct env for the
  // built-in station-control server) can key on this real property
  // instead of a hardcoded per-engine id check.
  | 'subprocess'
  | 'app-home'
  | 'workspace-overlay'
  | 'flag';

/**
 * Which SAFE, non-secret-crossing mechanism (if any) this
 * engine's delivery layer uses to make the canonical BUILT-IN
 * `station-control` server actually work, despite the resolver's blanket
 * secret-boundary-env rule (session-agent-resolution.ts) rejecting its
 * persisted `ToolDef.env` (`STATION_API_BASE`/`STATION_PORT`) on every
 * channel by default. This is deliberately a NAMED, per-engine, opt-in
 * capability — not a broadened env exemption — so the resolver's exemption
 * check can key on the matrix (single source of truth) instead of a
 * hardcoded per-engine id. A cell that leaves this `undefined` keeps
 * rejecting the built-in server exactly like any other env-bearing tool
 * server — no exemption, no substitution channel. Every engine with a
 * `session` toolServers cell names a mechanism, so `undefined`
 * is the shape a NEW engine class starts in, not a live engine's answer.
 * Note that naming a mechanism is not the same as being able to use it: a
 * `basis: 'runtime_observation'` mechanism (below) is a policy the
 * delivering adapter must still verify per connection.
 *
 * - `'env'` — Claude (subprocess channel): the credential rides the actual
 *   spawn env, safe because the Claude Agent SDK spawns the MCP child
 *   itself inside Station's own process (see
 *   `claude-mcp-passthrough.ts`'s header comment).
 * - `'url-token'` — Codex (wire channel): env can never cross
 *   (Codex independently manages its own MCP connections), so the
 *   substitution is a per-session, short-lived, scoped bearer token minted
 *   fresh per session and delivered in the station-control HTTP/SSE MCP
 *   endpoint's URL query string — never as env, never persisted to disk
 *   (see `station-control-mcp-token.ts` and `codex-mcp-passthrough.ts`).
 * - `'http-header-token'` — ACP (wire channel). Env can never cross — the
 *   connected agent app
 *   reads the whole `session/new` payload — and unlike Codex there is no
 *   spawn-time argv to carry a URL out of band: here the payload IS the
 *   wire, so a query-string token would be a credential sitting in a URL
 *   the external app may log, store, or echo back. The substitution is
 *   therefore the SAME per-session, 12-hour-TTL, station-control-scoped
 *   bearer token (`station-control-mcp-token.ts` `DEFAULT_TTL_MS`) presented
 *   in an
 *   `Authorization: Bearer` header on an ACP `type: 'http'` MCP server
 *   entry (`McpServerHttp.headers`) pointing at Station's own
 *   station-control endpoint — ACP's designated channel for MCP
 *   credentials, and one `station-control-mcp-route.ts` already accepts.
 *   The URL itself carries no token at all
 *   (`buildStationControlMcpHeaderUrl`). Delivery lives in
 *   `acp-mcp-passthrough.ts`; the per-connection gate that decides whether
 *   this mechanism may be used AT ALL lives in `acp-adapter.ts` — see
 *   `basis` below, and note that the gate, not this cell, is what makes the
 *   claim true for one session.
 *
 * ## Why this is an object with a `basis`, not a bare string
 *
 * The two shipped mechanisms are *statically* true of their engine: Claude's
 * SDK owns the MCP child, Codex's `-c` session overrides are confirmed
 * per-process semantics. Neither varies per connection, so their basis is
 * `'declared'` — a reviewed, permanent property of the engine class.
 *
 * ACP's HTTP MCP transport is NOT statically knowable: it is an optional,
 * capability-negotiated property of THE CONNECTED CLI, advertised (or not)
 * at `initialize` via `agentCapabilities.mcpCapabilities.http`. OpenCode
 * advertises it; gemini-cli 0.4.0 did not; Kiro 2.16.0 does (both of its
 * engines). None of those three facts can be
 * written into this cell: the same Station connection points at whatever
 * binary is on disk today, so a CLI upgrade or a swapped command changes
 * the answer with no matrix change at all. So
 * the cell can honestly declare only the POLICY — "a reviewed mechanism
 * exists, and using it requires a live runtime observation of this specific
 * subject" — while the evidence lives on the connection.
 *
 * `basis: 'runtime_observation'` is deliberately the underscore spelling: it
 * is `@kontourai/surface`'s own `EvidenceType` member, consumed rather than
 * re-worded, so the vocabulary cannot silently fork from the spec that
 * defines the declared-vs-observed distinction
 * (`conformance/sf-runtime-observation-required.json`: a claim whose policy
 * names `requiredEvidence: ["runtime_observation"]` stays unverified until a
 * live observation is recorded, and the status is then DERIVED, never
 * stored). `packages/contracts` has no dependency on `@kontourai/surface`
 * and must not gain one for a string literal; instead a type-level
 * assignability test in the station tree (which does depend on surface) pins
 * `basis` ⊆ `'declared' | EvidenceType`. See
 * `src-server/services/orchestration/__tests__/engine-capability-basis-vocabulary.test.ts`.
 *
 * Note what this is NOT: there is no `negotiated: true` marker and no stored
 * status. A marker is a label; the spec defines a derivation. The third
 * capability state lives in `engineControlPlaneCapability`'s CODOMAIN, not
 * in the matrix.
 */
export type BuiltinStationControlDelivery =
  | { mechanism: 'env'; basis: 'declared' }
  | { mechanism: 'url-token'; basis: 'declared' }
  | {
      mechanism: 'http-header-token';
      basis: 'runtime_observation';
      /**
       * The observed fact that verifies the claim for ONE connection: a live
       * `initialize` handshake advertising `mcpCapabilities.http`. Named on
       * the cell so the policy says WHICH evidence it requires, the way
       * `VerificationPolicy.requiredEvidence` does in the spec.
       */
      observation: 'acp-mcp-http';
    };

export type CapabilityDelivery =
  | { state: 'native' }
  | {
      state: 'session';
      channel: DeliveryChannel;
      builtinStationControlDelivery?: BuiltinStationControlDelivery;
    }
  | { state: 'unsupported' };

/** The managed Station-only pre-tool seams external adapters must not call. */
export const STATION_PRE_TOOL_POLICY_SEAMS = [
  'beforeToolCall',
  'checkToolCall',
] as const;

/**
 * The Station-owned pre-tool blocking and grant chain. It is deliberately
 * narrower than every policy Station may report: configuration, quality, and
 * uniform-stop gates can run after a tool request or at a different lifecycle
 * boundary. This declaration says only whether Station can block or grant an
 * engine's tool request before the engine executes it.
 *
 * This is distinct from `toolServers`: delivering an MCP server does not imply
 * intercepting calls it subsequently makes.
 */
export type ToolPolicyDelivery =
  | {
      state: 'native';
      /** Station owns the complete pre-tool blocking/grant dispatch. */
      evidence: 'beforeToolCall';
    }
  | {
      state: 'partial';
      /** Native callback Station uses for the engine-owned interactive prompt. */
      permissionHook: 'canUseTool' | 'requestPermission';
      /** Native pre-dispatch hook when Station can block before the engine runs. */
      preToolHook?: 'PreToolUse';
      /** The demonstrably delivered portion of the Station pre-tool chain. */
      evidence: 'tools.autoApprove' | 'sharedStagedPolicy';
      /** Present when the engine, rather than Station, supplies tool identity. */
      toolIdentity?: 'self-reported';
      /** Display-safe boundary on when the native callback is observable. */
      coverageLimit?: string;
      /** Adapter module name, used by the conformance tripwire. */
      adapterModule: string;
    }
  | {
      state: 'unsupported';
      /** Known adapter module, if this is a declared engine rather than unknown. */
      adapterModule?: string;
    };

export type ExternalToolPolicyDelivery =
  | Extract<ToolPolicyDelivery, { state: 'partial' }>
  | (Extract<ToolPolicyDelivery, { state: 'unsupported' }> & {
      adapterModule: string;
    });

function hasExternalToolPolicyAdapter(
  delivery: ToolPolicyDelivery,
): delivery is ExternalToolPolicyDelivery {
  return (
    delivery.state === 'partial' ||
    (delivery.state === 'unsupported' &&
      typeof delivery.adapterModule === 'string')
  );
}

/**
 * How an engine carries a chat image attachment to the model it runs
 * (archive#3344). Two distinct mechanisms ship today, and the difference is
 * load-bearing enough to name rather than collapse into a boolean:
 *
 * - `'native-content'` — the adapter serializes the decoded bytes into the
 *   engine's OWN protocol content block (Anthropic
 *   `{type:'image',source:{type:'base64'}}` in `claude-adapter.ts`, a
 *   `{type:'image',url:'data:...'}` turn input in `codex-adapter.ts`, an ACP
 *   `ContentBlock` in `acp-adapter.ts`).
 * - `'relay-multipart'` — Station's own engine has no external protocol: the
 *   `station-agent` adapter relays the attachment back through
 *   `POST /api/agents/:slug/chat` as an AI-SDK `{type:'file', url, mediaType}`
 * part, and `convertToModelMessages` produces the model's image part
 * (archive#1885).
 */
export type ImageInputChannel = 'native-content' | 'relay-multipart';

/**
 * The declared per-engine answer to "can a pasted image reach this model?".
 *
 * This exists because the composer used to INFER it. `modelSupportsAttachments`
 * was `selectedModelSupportsImages || runtimeConnection.capabilities.includes(
 * 'image-input') || agent.supportsAttachments`, and each of those three terms
 * is false for an ordinary Station-engine chat: the model catalog is the
 * Bedrock `ListFoundationModels` projection (empty without AWS credentials),
 * an unbound Station agent has no engine connection to read capabilities off,
 * and `supportsAttachments` has no producer anywhere in the server. So the
 * composer refused every pasted image on the exact engine whose relay was
 * built to carry them.
 *
 * `basis` follows this module's existing declared-vs-observed vocabulary (see
 * `BuiltinStationControlDelivery`): `'declared'` is a permanent property of
 * the engine class, while `'runtime_observation'` means the engine class has
 * the mechanism but a given CONNECTION must still prove it — ACP's
 * `agentCapabilities.promptCapabilities.image` is negotiated at `initialize`
 * by whatever CLI is on disk, and `acp-adapter.ts` refuses the send when the
 * live handshake did not advertise it. The composer treats
 * `'runtime_observation'` as attachable (the connection probably can) and
 * lets that adapter's refusal be the honest authority; it is an error the
 * user sees, never a silent drop.
 */
export type ImageInputDelivery =
  | {
      state: 'unsupported';
      /** Shown verbatim at paste time, so the refusal names a real reason. */
      reason: string;
    }
  | {
      state: 'session';
      channel: ImageInputChannel;
      basis: 'declared' | 'runtime_observation';
    };

/**
 * What the engine's own BUILT-IN toolbox is, as far as
 * anything derives it. Three states, because three different facts exist:
 *
 * - `station-configured`: the Station engine has no built-in toolbox of its
 *   own — an agent runs exactly the tools its Station configuration
 *   supplies.
 * - `documented`: the engine ships a known built-in toolset, and Station has
 *   observed its tool identity at a real seam. `categories` names only what
 *   the cited evidence supports; `evidence` says where that observation
 *   lives, per this file's evidence-first rule.
 * - `unenumerated`: the engine runs its own tools and Station has NO
 *   derivation for what they are (custom/ACP engines are whatever the
 *   connected CLI brings; muse demonstrably RUNS tools — its stream emits
 *   `tool.completed` — but nothing enumerates which). A surface rendering
 *   this state must say Station cannot enumerate the toolbox, never guess.
 */
export type BuiltInToolCategory = 'shell' | 'file-read' | 'file-edit';
export type BuiltInToolsCell =
  | { state: 'station-configured' }
  | {
      state: 'documented';
      categories: readonly BuiltInToolCategory[];
      /** Where the observation lives — an adapter seam or its test. */
      evidence: string;
    }
  | { state: 'unenumerated' };

/**
 * Whether Station has a WIRED path to disable specific
 * built-in tools on this engine. The rule: a disable control may
 * only ever ship where this cell names a real enforcement path; an engine at
 * `none` gets NO control, because a switch wired to nothing is the
 * label-without-derivation defect. NO external engine has
 * a wired per-tool disable:
 *
 * - claude: the Claude Agent SDK exposes `disallowedTools`, but
 *   `claude-adapter.ts buildOptions` does not pass it — an upstream option
 *   is not a wired path (the same actually-ships-today rule as codex's
 *   `systemPrompt` cell above).
 * - codex: `approvalPolicy`/`sandbox` knobs (codex-approval-mode.ts) are
 *   MODE-level gates over execution, not per-tool disables.
 * - muse / acp / unknown: no channel exists at all.
 */
export type BuiltInToolControlCell =
  | { state: 'station-owned' }
  | { state: 'none'; note?: string };

export interface EngineCapabilityMatrix {
  engineId: EngineId;
  /**
   * The engine's canonical human name, or `null` when this matrix genuinely
   * cannot name the engine and only the live connection can — a
   * command-backed connection is shown by its OWN connection name ("Kiro"),
   * never by the protocol it happens to speak (docs/glossary.md), and the
   * unknown-engine default below has nothing honest to call itself. Carried
   * HERE, next to the capability cells, so any surface that has to name the
   * engines a capability applies to reads the same objects the capability
   * predicate reads (`controlPlaneCapableEngineNames` below) instead of
   * keeping a parallel list that can silently drift out of date.
   */
  displayName: string | null;
  systemPrompt: CapabilityDelivery;
  toolServers: CapabilityDelivery;
  skills: CapabilityDelivery;
  commands: CapabilityDelivery;
  modelSelection: CapabilityDelivery;
  /** The declared pre-tool blocking/grant boundary; see `ToolPolicyDelivery`. */
  toolPolicy: ToolPolicyDelivery;
  /** Whether a pasted image reaches the model; see `ImageInputDelivery`. */
  imageInput: ImageInputDelivery;
  /** Whether a running turn accepts additional user input through a real engine channel. */
  midTurnSteer: boolean;
  /** The engine's own built-in toolbox, as derived. */
  builtInTools: BuiltInToolsCell;
  /** Whether a per-tool disable path is WIRED today. */
  builtInToolControl: BuiltInToolControlCell;
}

/**
 * What the MODEL catalog says about the selected model's image input, as a
 * three-state answer rather than a boolean.
 *
 * `'unknown'` is the common case and must not be read as `'no'`: the catalog
 * behind it is the Bedrock `ListFoundationModels` projection served by
 * `GET /api/models/capabilities`, which is empty without AWS credentials and
 * has no entry at all for a Claude Code, Codex, ACP or Ollama model id.
 * Collapsing "no entry" into "cannot see images" is what made the composer
 * refuse every paste.
 */
export type ModelImageSupport = 'yes' | 'no' | 'unknown';

export interface ComposerImageSupport {
  attachable: boolean;
  /** Present exactly when `attachable` is false; safe to show a user. */
  refusal?: string;
}

export interface ComposerImageSupportInputs {
  /**
   * `AgentConnectionView.capabilities` for the session's bound engine
   * connection, when one exists — omit it entirely when the session has no
   * engine connection (an unbound Station agent). This is the server's
   * projection of the dispatching adapter's own
   * `metadata.capabilities`, the same declaration
   * `OrchestrationService`'s pre-dispatch gate reads, so when a connection
   * record is in hand it is the most precise answer available and outranks
   * the matrix cell. The matrix answers the case it cannot: a Station-engine
   * chat has no connection record to read.
   *
   * "Projection", not "the identical value": these views are assembled per
   * connection kind, and the ACP view is hand-built in
   * `connection-inspector.ts` rather than read off the adapter. That copy had
   * already lost `image-input` (archive#3344), which is why it now spreads
   * `ACP_ADAPTER_CAPABILITIES` — the adapter's own array — instead of a
   * second literal. A view that drifts from its adapter makes this input
   * lie, and it is pinned by a test for exactly that reason.
   */
  connectionCapabilities?: readonly string[];
  /**
   * The live handshake's answer for an engine whose `imageInput` cell has
   * `basis: 'runtime_observation'` — ACP's
   * `agentCapabilities.promptCapabilities.image`, carried on the connection
   * as `capabilityInventory.sessionSurfaces.promptImage`.
   *
   * This is what makes that basis a derivation rather than a label. `true`
   * and `false` are both statements the connected CLI made about itself;
   * `undefined` means Station has not completed a handshake with it (never
   * connected this boot, or the status has not loaded), and is deliberately
   * NOT read as `false` — refusing a capability because nobody has looked
   * yet is the exact defect class this whole derivation replaced. The
   * unobserved case attaches and lets `acp-adapter.ts`'s own send-time
   * refusal be the authority, which surfaces as a visible error rather than
   * a silent drop.
   */
  observedImagePrompt?: boolean;
  /** Names the connected CLI in an observation-backed refusal. */
  connectionLabel?: string;
  modelSupport?: ModelImageSupport;
  /** The selected model, named in a model-level refusal. */
  modelLabel?: string;
}

/**
 * The composer's paste-time answer, derived only from DECLARED sources: the
 * bound connection's adapter-declared capabilities, this module's per-engine
 * `imageInput` cell, and the model catalog's positive statement about the
 * selected model. Nothing here is inferred from a model id, a provider name,
 * or the absence of a catalog row.
 *
 * A model-level `'no'` outranks a capable engine: the Station engine can
 * carry an image to any model it runs, which does not mean the model can read
 * one, and attaching an image the model will discard is the fake attach this
 * derivation exists to prevent.
 */
export function resolveComposerImageSupport(
  matrix: EngineCapabilityMatrix,
  inputs: ComposerImageSupportInputs = {},
): ComposerImageSupport {
  const engineCarriesImages = inputs.connectionCapabilities
    ? inputs.connectionCapabilities.includes('image-input')
    : matrix.imageInput.state === 'session';
  if (!engineCarriesImages) {
    return {
      attachable: false,
      refusal:
        matrix.imageInput.state === 'unsupported'
          ? matrix.imageInput.reason
          : `${matrix.displayName ?? 'This engine'} cannot see images.`,
    };
  }
  // The cell said an observation is required. If one exists and says no, that
  // is the connected CLI's own answer about itself and it outranks the
  // engine-class declaration — this engine's ability to build image content
  // does not mean THIS command can accept it.
  if (
    matrix.imageInput.state === 'session' &&
    matrix.imageInput.basis === 'runtime_observation' &&
    inputs.observedImagePrompt === false
  ) {
    return {
      attachable: false,
      refusal: `${inputs.connectionLabel ?? 'This connected engine'} reported that it cannot accept images.`,
    };
  }
  if (inputs.modelSupport === 'no') {
    return {
      attachable: false,
      refusal: inputs.modelLabel
        ? `${inputs.modelLabel} cannot see images. Pick a model that accepts image input.`
        : 'This model cannot see images. Pick a model that accepts image input.',
    };
  }
  return { attachable: true };
}

/** A display-safe projection of a declared pre-tool blocking/grant cell. */
export function toolPolicyDeliveryLabel(
  delivery: ToolPolicyDelivery | undefined,
): string {
  if (!delivery) return 'Station approval coverage unknown';
  if (delivery.state === 'native') return 'Station approvals apply';
  if (delivery.state === 'partial') {
    return delivery.evidence === 'sharedStagedPolicy'
      ? 'Station approvals partly apply'
      : 'Station auto-approvals only';
  }
  return 'Station approvals do not apply';
}

/** The detailed, non-overclaiming explanation paired with the label above. */
export function toolPolicyDeliveryExplanation(
  delivery: ToolPolicyDelivery | undefined,
): string {
  if (!delivery) {
    return 'Station cannot tell whether its tool approvals cover this session: no engine capability matrix resolved.';
  }
  if (delivery.state === 'native') {
    return 'Station checks its blocks and auto-approve grants before every tool call.';
  }
  if (delivery.state === 'partial') {
    const limits = [
      "Station auto-applies only its matching auto-approve grants; everything else still goes through this engine's own approval flow.",
      delivery.coverageLimit,
      delivery.toolIdentity === 'self-reported'
        ? 'Tool identity is self-reported by the engine.'
        : undefined,
    ].filter(Boolean);
    return limits.join(' ');
  }
  return "This engine runs its own approvals; Station's blocks and auto-approve grants are not consulted.";
}

/**
 * Every declared external adapter with a source file that must stay aligned to
 * the pre-tool delivery matrix. The tripwire is derived from this declaration,
 * so a declared adapter module cannot silently bypass it.
 */
export function externalToolPolicyAdapters(): Array<{
  provider: string;
  delivery: ExternalToolPolicyDelivery;
}> {
  return Object.entries(ENGINE_CAPABILITY_MATRICES).flatMap(
    ([provider, matrix]) => {
      const { toolPolicy } = matrix;
      if (!hasExternalToolPolicyAdapter(toolPolicy)) return [];
      return [{ provider, delivery: toolPolicy }];
    },
  );
}

/**
 * Keyed by `ProviderKind` (a plain `string`, matching both the resolver's
 * `connection.type` and this module's own lookups) — NOT by `engineId`,
 * which carries §4.1's canonical display id (e.g. 'claude-code' for the
 * 'claude' provider). 'station' is editor-only: sessions never carry it as
 * a provider (Station's own engine has no session-delivery concept — it IS
 * the execution, not a delivered-to target).
 */
/**
 * ACP model selection is start-only. Shared with the adapter so the UI's
 * continuation picker cannot drift from the precise launch declaration.
 */
export const ACP_MODEL_OVERRIDE_PER_TURN = false;

export const ENGINE_CAPABILITY_MATRICES: Record<
  string,
  EngineCapabilityMatrix
> = {
  station: {
    engineId: toEngineId('station'),
    displayName: 'Station',
    systemPrompt: { state: 'native' },
    toolServers: { state: 'native' },
    skills: { state: 'native' },
    commands: { state: 'native' },
    modelSelection: { state: 'native' },
    // `createAgentHooks().beforeToolCall` owns the complete Station chain.
    toolPolicy: { state: 'native', evidence: 'beforeToolCall' },
    // archive#1885: `station-agent-adapter.ts`'s `buildRelayInput` forwards
    // each attachment to /chat as an AI-SDK file part, which VoltAgent's
    // `convertToModelMessages` turns into the model's own image part. The
    // adapter declares `image-input` for exactly this reason.
    imageInput: {
      state: 'session',
      channel: 'relay-multipart',
      basis: 'declared',
    },
    // Station's loopback executes one /chat request at a time; it has abort but no additive input channel.
    midTurnSteer: false,
    // The Station engine HAS no built-in toolbox: an agent runs exactly the
    // tools its configuration supplies, which is also why the control cell
    // is station-owned — disabling a tool is editing the agent.
    builtInTools: { state: 'station-configured' },
    builtInToolControl: { state: 'station-owned' },
  },
  claude: {
    engineId: toEngineId('claude-code'),
    displayName: 'Claude Code',
    // systemPrompt deliverable via a per-session flag.
    systemPrompt: { state: 'session', channel: 'flag' },
    // SDK mcpServers wired in claude-adapter.ts buildOptions —
    // stdio/sse/streamable-http tool servers, plus a station-control-only
    // token injection. Channel 'subprocess' (NOT 'wire' — see
    // DeliveryChannel's doc comment): the Claude Agent SDK spawns each MCP
    // server itself, inside Station's own process, so
    // session-agent-resolution.ts's resolver-stage secret-boundary-env
    // filter can safely exempt the canonical built-in station-control
    // server for this channel only (see claude-mcp-passthrough.ts's
    // header comment for the full rationale).
    toolServers: {
      state: 'session',
      channel: 'subprocess',
      builtinStationControlDelivery: { mechanism: 'env', basis: 'declared' },
    },
    skills: { state: 'session', channel: 'workspace-overlay' },
    commands: { state: 'unsupported' },
    modelSelection: { state: 'session', channel: 'flag' },
    // PreToolUse runs Station's shared staged evaluator before Claude executes,
    // while canUseTool remains the single interactive approval authority.
    // This is intentionally partial until the entire native chain is proven.
    toolPolicy: {
      state: 'partial',
      permissionHook: 'canUseTool',
      preToolHook: 'PreToolUse',
      evidence: 'sharedStagedPolicy',
      adapterModule: 'claude-adapter',
    },
    // `claude-adapter.ts` builds Anthropic `{type:'image', source:{type:
    // 'base64', media_type, data}}` blocks from the decoded attachment.
    imageInput: {
      state: 'session',
      channel: 'native-content',
      basis: 'declared',
    },
    // Claude Agent SDK Query.streamInput writes another SDKUserMessage into the live streaming-input session.
    midTurnSteer: true,
    // Tool identity observed at the shared staged-policy seam this matrix's
    // own toolPolicy cell names: claude-adapter.test.ts pins permission
    // rules keyed on 'Bash' and exercises 'Read'. Categories name ONLY what
    // those tests observe — 'file-edit' is deliberately absent: no adapter
    // or policy test observes a Write/Edit
    // identity, and the generic toolName seam proves identities are
    // CARRIED, not that a specific tool exists. Add the category only with
    // a test that observes an editing-tool identity at this seam.
    builtInTools: {
      state: 'documented',
      categories: ['shell', 'file-read'],
      evidence:
        "tool identity at the PreToolUse/canUseTool policy seam (claude-adapter.test.ts pins 'Bash' rules and exercises 'Read')",
    },
    // The SDK's `disallowedTools` option exists UNWIRED — see
    // BuiltInToolControlCell's audit note. No control may render for this
    // engine until an adapter wires and proves it.
    builtInToolControl: {
      state: 'none',
      note: 'SDK disallowedTools exists but claude-adapter does not pass it',
    },
  },
  codex: {
    engineId: toEngineId('codex'),
    displayName: 'Codex',
    // Evidence gate (docs/design/agent-engine-unification.md
    // §4.1/§6.1): `codex app-server generate-json-schema` against the
    // installed codex-cli 0.145.0 CONFIRMS `developerInstructions` as a
    // wire param on `ThreadStartParams`/`ThreadResumeParams`/
    // `ThreadForkParams` — the systemPrompt wire channel is real. But
    // there is no server-side version or feature-negotiation signal
    // anywhere in the app-server protocol to gate sending it on, so
    // sending it unconditionally would be exactly the "accept and
    // quietly not deliver" behavior §5 forbids for an app-server that
    // predates the field. This stays `unsupported` — evidence-gated
    // DROP, not a silent gap: delivery ships once a genuine
    // version/capability signal exists to gate on.
    systemPrompt: { state: 'unsupported' },
    // `codex
    // app-server`'s `-c`/`--config` session-layer overrides (evidence:
    // `ConfigLayerSource`'s `sessionFlags` variant, confirmed against
    // codex-cli 0.145.0 — a `-c mcp_servers.<id>....` flag appended to the
    // `codex app-server` spawn argv registers a live, tool-call-capable MCP
    // connection for that one process, with NO disk write and no version-
    // skew ambiguity, unlike the systemPrompt cell above) lets Station
    // deliver an agent's authored `toolServers` to Codex. Channel 'wire'
    // (NOT 'subprocess'): unlike Claude's Agent SDK, `codex app-server` is
    // an external app-server process that manages its OWN outbound MCP
    // connections — Station spawns the codex app-server child, but codex
    // itself decides how to reach each configured MCP server, exactly the
    // "external, less-trusted process spawns its own MCP children"
    // property `DeliveryChannel`'s doc comment names for 'wire'. The
    // canonical built-in station-control server is exempted from the
    // resolver's blanket env rejection via `builtinStationControlDelivery:
    // 'url-token'` — NOT by broadening 'wire' env exemptions generally
    // (ACP is also 'wire' and delivers station-control
    // too, but it names its OWN mechanism — 'http-header-token', on its own
    // evidence basis — rather than inheriting this one. Two engines, one
    // channel, two independent substitutions: exactly what
    // keying on this FIELD rather than on the channel buys) — because
    // codex-mcp-passthrough.ts
    // never forwards env at all: it mints a short-lived, per-session,
    // station-control-scoped bearer token (station-control-mcp-token.ts)
    // and substitutes a `url` config value pointing at Station's own
    // HTTP/SSE MCP endpoint for station-control, with the token riding the
    // URL's query string — the one part of a wire payload that is safe to
    // cross this channel.
    toolServers: {
      state: 'session',
      channel: 'wire',
      builtinStationControlDelivery: {
        mechanism: 'url-token',
        basis: 'declared',
      },
    },
    skills: { state: 'unsupported' },
    commands: { state: 'unsupported' },
    modelSelection: { state: 'session', channel: 'flag' },
    // The app-server adapter has no Station pre-tool interception seam.
    toolPolicy: { state: 'unsupported', adapterModule: 'codex-adapter' },
    // `codex-adapter.ts` sends `{type:'image', url:'data:...'}` entries in the
    // `turn/start` input array. Documents are separately refused there
    // (`rejectFileAttachments`), which is why only images are declared here.
    imageInput: {
      state: 'session',
      channel: 'native-content',
      basis: 'declared',
    },
    // codex app-server exposes turn/start and turn/interrupt, but no input/steer method for an active turn.
    midTurnSteer: false,
    // Codex's core loop is command execution and patch application, and the
    // adapter's EVENT seam observes both identities: codex-adapter-events.ts
    // handles `item/commandExecution/requestApproval` and maps
    // `item/fileChange/requestApproval` to the `apply_patch` tool identity.
    builtInTools: {
      state: 'documented',
      categories: ['shell', 'file-edit'],
      evidence:
        'commandExecution and fileChange→apply_patch identities at the approval event seam (codex-adapter-events.ts)',
    },
    // approvalPolicy/sandbox are MODE-level gates over execution, not
    // per-tool disables — see BuiltInToolControlCell's audit note.
    builtInToolControl: {
      state: 'none',
      note: 'approval/sandbox modes gate execution but disable no individual tool',
    },
  },
  muse: {
    engineId: toEngineId('muse'),
    displayName: 'Muse Code',
    // Slice 1 is deliberately narrow. `muse exec` is a one-prompt-per-process
    // headless runner; nothing in its flag surface or its observed JSONL
    // stream delivers an authored system prompt, MCP tool servers, skills, or
    // commands, so every one of those cells stays `unsupported` rather than
    // claiming a channel Station cannot demonstrate.
    systemPrompt: { state: 'unsupported' },
    toolServers: { state: 'unsupported' },
    skills: { state: 'unsupported' },
    commands: { state: 'unsupported' },
    // The one positively evidenced channel: `muse exec --model <ID>` is
    // validated by muse against its OWN catalog — an unknown id exits 1 with
    // "model `<id>` is not in the catalog" and emits no JSONL at all — so the
    // flag is demonstrably applied, not accepted-and-ignored. `muse-adapter.ts`
    // passes it on every turn.
    //
    // A matrix cell is a claim, not a delivery: both model gates must also
    // admit muse or this reads `session` while every model request is refused
    // upstream. They do, from one declaration —
    // `MUSE_MODEL_LAUNCH` (muse-adapter-types.ts), read by
    // `MuseAdapter.metadata.modelLaunch` and by `launchCapabilities()` in
    // `execution-target-resolver.ts`.
    modelSelection: { state: 'session', channel: 'flag' },
    toolPolicy: { state: 'unsupported', adapterModule: 'muse-adapter' },
    // `buildMuseExecArgs` spawns `muse exec` with a text prompt and nothing
    // else; the adapter never reads `input.attachments` and declares no
    // `image-input`, so orchestration refuses the turn rather than dropping
    // the image.
    imageInput: {
      state: 'unsupported',
      reason: 'Muse Code runs a text-only prompt and cannot see images.',
    },
    // One prompt is bound to one muse process; there is no live input channel.
    midTurnSteer: false,
    // Muse demonstrably RUNS tools — its JSONL stream emits tool.completed
    // with a toolName (muse-adapter-events.ts) — but nothing enumerates
    // WHICH tools the CLI ships, so this stays unenumerated rather than
    // guessing categories from observed names in one stream.
    builtInTools: { state: 'unenumerated' },
    builtInToolControl: { state: 'none' },
  },
  acp: {
    engineId: toEngineId('acp'),
    // Only the connection can name a command-backed engine — see
    // `displayName`'s doc comment on the interface above.
    displayName: null,
    systemPrompt: { state: 'unsupported' },
    // archive#888/archive#895 (authored passthrough), archive#1684 (the built-in server).
    //
    // Mechanism 'http-header-token', NOT codex's 'url-token', even though
    // both are the same 'wire' channel: an ACP `session/new` payload is
    // itself the thing the external agent app receives and keeps, so a
    // token in a URL query string would be a credential written into a
    // field that app is free to log or echo. ACP designates a header list
    // on its `type: 'http'` MCP server entry for exactly this, so the
    // credential rides `Authorization: Bearer` and the URL stays bare
    // (`buildStationControlMcpHeaderUrl`). Env still never crosses: the
    // http branch in `acp-mcp-passthrough.ts` emits no `env` at all for
    // this server rather than filtering one.
    //
    // `basis: 'runtime_observation'`, NOT 'declared', because the property
    // this mechanism needs is not a property of the ACP engine CLASS. HTTP
    // MCP transport is optional in ACP and advertised per connection by the
    // connected CLI at `initialize`
    // (`agentCapabilities.mcpCapabilities.http`); Station's `acp` matrix
    // covers every command-backed CLI a user can point a connection at, and
    // those disagree with each other and with their own past versions. So
    // the honest static claim is the POLICY — a reviewed mechanism exists,
    // and using it requires a live observation of THIS subject — and the
    // evidence half lives on the connection
    // (`projectControlPlaneObservation` in
    // `connection-service-helpers.ts`), where `engineControlPlaneCapability`
    // combines the two.
    //
    // The live gate is NOT here and cannot be: this file is static data.
    // `acp-adapter.ts` reads the session's own `initResult` before minting
    // anything and fails closed when the capability is absent — no token
    // minted, no stdio transport, an `engine-capability-absent` receipt, and
    // the session starts anyway. This cell says the mechanism exists; that
    // gate says whether it applied.
    toolServers: {
      state: 'session',
      channel: 'wire',
      builtinStationControlDelivery: {
        mechanism: 'http-header-token',
        basis: 'runtime_observation',
        observation: 'acp-mcp-http',
      },
    },
    skills: { state: 'unsupported' },
    commands: { state: 'unsupported' },
    // The adapter applies start-time selection only when this session's fresh
    // option catalog advertises the value and the operation response confirms
    // the exact currentValue. Resume/per-turn remain unsupported.
    modelSelection: { state: 'session', channel: 'wire' },
    // ACP enters the shared staged policy at requestPermission. Coverage is
    // still partial: ACP does not guarantee every tool call requests
    // permission, and the tool identity is reported by the external engine.
    toolPolicy: {
      state: 'partial',
      permissionHook: 'requestPermission',
      evidence: 'sharedStagedPolicy',
      toolIdentity: 'self-reported',
      coverageLimit:
        'Only calls that invoke requestPermission and report a tool name enter this policy seam.',
      adapterModule: 'acp-adapter',
    },
    // `acp-adapter.ts` builds ACP image `ContentBlock`s — but only when THIS
    // connection's `initialize` handshake advertised
    // `agentCapabilities.promptCapabilities.image`; otherwise it refuses the
    // send. The engine class has the mechanism, the connection carries the
    // evidence, so the basis is an observation, not a declaration.
    imageInput: {
      state: 'session',
      channel: 'native-content',
      basis: 'runtime_observation',
    },
    // ACP permits session/prompt and session/cancel; it defines no concurrent steer operation.
    midTurnSteer: false,
    // A custom engine's toolbox is whatever the connected CLI brings; ACP
    // advertises protocol capabilities at initialize, not a tool inventory.
    builtInTools: { state: 'unenumerated' },
    builtInToolControl: { state: 'none' },
  },
};

/**
 * Native adapter projections carry two identities on purpose: their private
 * adapter selector (`codex-runtime`) is the connection `type`, while their
 * public engine identity (`codex`) is carried in `engineId`. The latter can
 * name a matrix only when the former is that matrix's own provider key or its
 * native runtime selector. Requiring both prevents an arbitrary unknown
 * connection that merely claims a known engine id from inheriting its
 * delivery capability.
 */
function matrixForNativeEngineProjection(
  type: string | undefined,
  engineId: EngineId,
): EngineCapabilityMatrix | undefined {
  for (const [providerKind, matrix] of Object.entries(
    ENGINE_CAPABILITY_MATRICES,
  )) {
    if (matrix.engineId !== engineId) continue;
    if (type === providerKind || type === `${providerKind}-runtime`) {
      return matrix;
    }
  }
  return undefined;
}

/**
 * The conservative matrix for an external engine connection whose type has
 * no dedicated entry in `ENGINE_CAPABILITY_MATRICES` — every authored
 * capability surface is `unsupported` (never guessed editable), including
 * model selection until an adapter positively declares an apply path.
 */
export const UNKNOWN_EXTERNAL_ENGINE_MATRIX: EngineCapabilityMatrix = {
  engineId: toEngineId('unknown'),
  displayName: null,
  systemPrompt: { state: 'unsupported' },
  toolServers: { state: 'unsupported' },
  skills: { state: 'unsupported' },
  commands: { state: 'unsupported' },
  modelSelection: { state: 'unsupported' },
  toolPolicy: { state: 'unsupported' },
  imageInput: {
    state: 'unsupported',
    reason: 'Station cannot tell whether this engine can see images.',
  },
  // Unknown engines never inherit an unobserved control capability.
  midTurnSteer: false,
  builtInTools: { state: 'unenumerated' },
  builtInToolControl: { state: 'none' },
};

const KNOWN_MANAGED_RUNTIME_IDS = new Set([
  'bedrock-runtime',
  'ollama-runtime',
]);

/**
 * Derives `session-agent-resolution.ts`'s per-provider delivery-channel map
 * from this module's matrices — the single-source guarantee: editor truth
 * and session-delivery truth cannot diverge because they read the same
 * cells. A provider absent from `ENGINE_CAPABILITY_MATRICES` (e.g.
 * 'bedrock', 'ollama') or that resolves to the station entry returns
 * `undefined`, matching the resolver's existing no-op-for-unmapped-provider
 * behavior exactly.
 */
export function sessionDeliveryChannels(
  provider: string,
): Record<'toolServers' | 'skills' | 'systemPrompt', boolean> | undefined {
  const matrix = ENGINE_CAPABILITY_MATRICES[provider];
  if (!matrix || matrix.engineId === 'station') return undefined;
  return {
    toolServers: matrix.toolServers.state === 'session',
    skills: matrix.skills.state === 'session',
    systemPrompt: matrix.systemPrompt.state === 'session',
  };
}

/**
 * Resolves the engine capability matrix for an agent's bound connection —
 * the single source of truth for engine identity (the parallel
 * `resolveAgentTypeFromRuntimeConnection` resolver is retired; acp is
 * still checked first so a stale
 * connection record carrying BOTH an acp type/id and a managed engine
 * identity resolves to `acp`, never letting the managed check shadow it).
 *
 *   id/type 'acp'                                 -> acp
 *   explicit engineId (top-level or config-nested) -> that engine only when
 *                                                     its type is its exact
 *                                                     provider/native selector;
 *                                                     otherwise UNKNOWN_EXTERNAL_ENGINE_MATRIX
 *   known managed id / executionClass 'managed'   -> station (deprecated
 *                                                     read-compat)
 *   executionClass 'connected' or any other id     -> that connection's type
 *                                                     (a matrix entry, else
 *                                                     UNKNOWN_EXTERNAL_ENGINE_MATRIX)
 *   otherwise (no id, no connection)               -> station
 */
export function resolveEngineCapabilityMatrix(
  agentConnectionId?: string | null,
  connection?: {
    type?: string;
    engineId?: EngineId | string;
    config?: { engineId?: unknown; executionClass?: unknown };
  } | null,
): EngineCapabilityMatrix {
  if (agentConnectionId === 'acp' || connection?.type === 'acp') {
    return ENGINE_CAPABILITY_MATRICES.acp;
  }
  // Phase B: engineId (top-level, e.g. server RuntimeConnectionSummary; or
  // config-nested, e.g. AgentConnectionView/ConnectionConfig) is the
  // canonical engine identity and wins over the deprecated executionClass
  // read-compat fields below when present.
  const rawExplicitEngineId =
    connection?.engineId ??
    (typeof connection?.config?.engineId === 'string'
      ? connection.config.engineId
      : undefined);
  if (rawExplicitEngineId !== undefined) {
    const explicitEngineId = parseEngineId(rawExplicitEngineId);
    if (!explicitEngineId) return UNKNOWN_EXTERNAL_ENGINE_MATRIX;
    if (explicitEngineId === 'station') {
      return ENGINE_CAPABILITY_MATRICES.station;
    }
    const type = connection?.type;
    const nativeMatrix = matrixForNativeEngineProjection(
      type,
      explicitEngineId,
    );
    if (nativeMatrix) return nativeMatrix;
    // A canonical engine id is authoritative. Do not fall through to a
    // provider-type matrix when the two disagree: that would let a malformed
    // projection borrow a capability (including declared control delivery)
    // from a different engine.
    return UNKNOWN_EXTERNAL_ENGINE_MATRIX;
  }
  if (
    (agentConnectionId && KNOWN_MANAGED_RUNTIME_IDS.has(agentConnectionId)) ||
    connection?.config?.executionClass === 'managed'
  ) {
    return ENGINE_CAPABILITY_MATRICES.station;
  }
  if (connection?.config?.executionClass === 'connected' || agentConnectionId) {
    const type = connection?.type;
    if (type && ENGINE_CAPABILITY_MATRICES[type]) {
      return ENGINE_CAPABILITY_MATRICES[type];
    }
    return UNKNOWN_EXTERNAL_ENGINE_MATRIX;
  }
  return ENGINE_CAPABILITY_MATRICES.station;
}

/**
 * The per-connection evidence half of the capability
 * derivation below — one live `initialize` handshake's answer to "does THIS
 * connected CLI advertise MCP over HTTP". Held in memory per connection
 * (the ACP probe cache), never persisted: a durable "yes" would have to be
 * identity-bound to the CLI's fingerprint and invalidated on version change
 * to avoid trusting a stale answer across an upgrade, and ACP readiness
 * already implies a fresh live probe every process lifetime, so persistence
 * would buy seconds and cost that machinery. If the bootstrap window ever
 * matters, the follow-up is spec'd: key on the execution-identity
 * fingerprint, add a version-change staleness trigger.
 *
 * A stored observation is a claim about the PAST and is therefore never the
 * delivery gate — the wire path reads the live session's own
 * handshake. Staleness here can only make the picker conservative or produce
 * a truthful skip-with-receipt; it can never cause a wrong grant.
 */
export interface ControlPlaneObservation {
  /** `initialize.agentCapabilities.mcpCapabilities.http === true`. */
  mcpHttp: boolean;
  /** ISO-8601 instant of the handshake that produced this evidence. */
  observedAt: string;
}

/**
 * Can this
 * engine host Station's own built-in `station-control` control-plane server
 * FOR THIS SUBJECT? Derived GENERICALLY from the matrix's `toolServers` cell
 * plus (when the cell's mechanism requires it) a per-connection runtime
 * observation — never a per-engine-id branch, so an engine gains or loses
 * this the moment its matrix entry changes or its evidence arrives, with no
 * picker code change.
 *
 * - "full" ⟺ station-control is actually deliverable to this subject now:
 *   Station's own engine (`native`); a `basis: 'declared'` mechanism (Claude
 *   Code's `'env'` over its subprocess channel; Codex's `'url-token'`
 *   over its wire channel), which is statically true of the engine
 *   class and ignores the observation entirely; or a
 *   `basis: 'runtime_observation'` mechanism whose observation says yes.
 * - "chat-only" — the engine can carry a chat turn but cannot be handed the
 *   control-plane server: `unsupported`, a session channel with no delivery
 *   mechanism, or an observed NO.
 * - "observation-required" — a reviewed mechanism exists for this engine
 *   class, but this specific subject has never been observed. NOT capable:
 *   an unprobed connection is never optimistically bindable.
 *
 * ## Doc-contract change — READ THIS BEFORE FLAGGING DRIFT
 *
 * This predicate and `session-agent-resolution.ts`'s secret-boundary
 * exemption used to be documented as the SAME predicate ("the same cell, the
 * same `!== undefined` check — so what the picker offers and what the
 * resolver will deliver cannot diverge"). They are now INTENTIONALLY
 * different, and that is the design, not drift:
 *
 * - The resolver exemption asks a static, engine-class question — "does a
 *   reviewed non-secret-crossing mechanism exist for this engine?" — and
 *   keeps its `!== undefined` shape unchanged.
 * - This predicate asks the subject-scoped question — "does a mechanism
 *   exist AND is it verified for THIS connection?"
 *
 * They coincided in effect only while every shipped cell was
 * `basis: 'declared'` — a declared mechanism ignores the observation
 * entirely. That is no longer the case: the `acp` cell (~180 lines below)
 * carries `basis: 'runtime_observation'`, so the two now genuinely
 * diverge on every ACP connection.
 *
 * Concretely, for an ACP connection with no observation yet, or one whose
 * observation says no: the resolver exemption answers YES (a reviewed
 * mechanism exists for the engine class), while this predicate answers
 * `'observation-required'` / `'chat-only'` and the picker offers nothing.
 * Neither answer is wrong; they are answers to different questions. The
 * per-subject truth belongs to neither static check — it belongs to the
 * delivering adapter's LIVE gate (`acp-adapter.ts` reads the session's own
 * `initResult`, never a stored observation) plus its undelivered receipt.
 * The picker being conservative while the resolver exempts is safe in
 * exactly one direction: nothing is offered that cannot be delivered, and a
 * resolver exemption that reaches an incapable session delivers nothing and
 * says so.
 *
 * Key this on the delivery field, never on `channel === 'subprocess'`:
 * the field the delivery path reads is the truth, and the channel name is
 * only ever a proxy for it.
 */
export type EngineControlPlaneCapability =
  | 'full'
  | 'chat-only'
  | 'observation-required';

export function engineControlPlaneCapability(
  matrix: Pick<EngineCapabilityMatrix, 'toolServers'>,
  observation?: ControlPlaneObservation,
): EngineControlPlaneCapability {
  const toolServers = matrix.toolServers;
  if (toolServers.state === 'native') return 'full';
  if (toolServers.state !== 'session') return 'chat-only';
  const delivery = toolServers.builtinStationControlDelivery;
  if (delivery === undefined) return 'chat-only';
  if (delivery.basis === 'declared') return 'full';
  // `basis: 'runtime_observation'` — the cell declares a policy, not an
  // outcome. No evidence yet is NOT a no (that would be a lie about a
  // connection Station has simply never met) and NOT a yes (that would
  // offer a capability Station cannot know it has).
  if (!observation) return 'observation-required';
  return observation.mcpHttp ? 'full' : 'chat-only';
}

/**
 * The engines that can host `station-control` today, named — DERIVED from
 * the matrices by the same predicate that filters what the picker offers, so
 * a surface explaining "these are the engines that can run the built-in
 * assistant" cannot drift from what the resolver will actually accept. When
 * an engine's cell gains a `builtinStationControlDelivery` mechanism (as
 * Codex's does with `'url-token'`) its name appears here on the
 * same commit, with no copy change anywhere.
 *
 * An entry whose `displayName` is `null` is omitted rather than named by its
 * id: only the live connection can name a command-backed engine, and this
 * list is a general statement about engines, not about one connection.
 *
 * This is a statement about ENGINES, so it deliberately passes
 * no observation — a `runtime_observation` cell therefore derives
 * `observation-required`, which is not `full`, and stays out of the sentence.
 * That is correct: "engines that can run it today" cannot honestly name an
 * engine class whose answer is per-connection. The sentence for those is a
 * separate one ("Station checks each one when it connects"), owned by the
 * surface that has a connection in hand.
 * `engine-capability-matrix.test.ts` pins that every CAPABLE entry does carry
 * a name, so a capable engine can never silently drop out of this sentence.
 *
 * A FUNCTION, not a module-level computed const, deliberately: a const whose
 * initializer walks `ENGINE_CAPABILITY_MATRICES` runs at import time, so
 * every bundle chunk importing anything at all from this module has to retain
 * the whole matrix — measured at +489 gzip bytes on the UI entry chunk, for a
 * sentence only the lazily-loaded engine picker ever renders. As a function
 * the cost lands in the chunk that actually calls it.
 */
export function controlPlaneCapableEngineNames(): string[] {
  return Object.values(ENGINE_CAPABILITY_MATRICES)
    .filter((matrix) => engineControlPlaneCapability(matrix) === 'full')
    .map((matrix) => matrix.displayName)
    .filter((name): name is string => name !== null);
}

/** One ready, engine-runtime-capable connection, as seen by the built-in
 * agent engine binding resolver below — the minimal shape both the server
 * bootstrap and the onboarding picker need. */
export interface ReadyEngineConnection {
  connectionId: EngineConnectionId;
  matrix: EngineCapabilityMatrix;
  /**
   * This connection's own runtime evidence, when Station has
   * observed it. Threaded PER CONNECTION (never projected from a
   * first-connection collapse) so the binding resolver, the server bootstrap
   * and the picker all call `engineControlPlaneCapability` with the same two
   * inputs and cannot disagree. Absent for every engine whose cell carries a
   * `declared` mechanism — the derivation ignores it there.
   */
  controlPlaneObservation?: ControlPlaneObservation;
}

/**
 * The built-in agents' (Station's own default agent,
 * `station-voice`) engine binding — `null` means Station's own engine (the
 * historical, byte-identical default), matching every other engine-identity
 * resolution in this module (`resolveEngineCapabilityMatrix`'s own "no id, no
 * connection -> station" default). A resolved non-null value always names a
 * connection present in `readyExternalEngines` — this function never returns
 * a dangling id.
 */
export interface BuiltinAgentEngineBinding {
  connectionId: EngineConnectionId;
  matrix: EngineCapabilityMatrix;
  /**
   * The evidence this binding was resolved
   * ON, carried forward rather than discarded. Without it a consumer that
   * re-derives the capability from the matrix alone — the bootstrap's own
   * "bound to an external engine" log did exactly this — would report a
   * connection bound PRECISELY BECAUSE its observation said yes as
   * `observation-required`, i.e. not capable. A binding that cannot state
   * why it exists is how a receipt starts lying.
   */
  controlPlaneObservation?: ControlPlaneObservation;
}

/**
 * The single source of truth for both "idempotent, no clobber-back" (AC2)
 * and "sensible default when unchosen" (AC3):
 *
 * - `explicitConnectionId` is the persisted `AppConfig.builtinAgentEngineConnectionId`
 *   verbatim — `undefined` means "the user has never chosen" (the picker was
 *   dismissed or never acted on), `null` means "explicitly chose Station",
 *   and a string names an explicitly chosen connection. Once EITHER of the
 *   latter two is recorded, this function returns it deterministically on
 *   every call — nothing here ever recomputes a "smarter" answer over an
 *   explicit choice, which is exactly what makes re-running bootstrap
 *   idempotent: the same persisted input always resolves to the same
 *   binding, never drifting back to Station on its own.
 * - Only when nothing has ever been explicitly chosen does the sensible
 *   default apply: Station if a model connection is chat-ready, else the
 *   single ready external engine (ambiguous — two or more ready external
 *   engines with no Station model — safely defaults to Station rather than
 *   guessing which one the user meant).
 * - An explicit choice that no longer resolves to a ready external engine
 *   (disabled, removed, or gone unready) fails safe to Station for THIS
 *   resolution only; the persisted choice itself is untouched; a
 *   reappearing connection resolves again on the next call with no user
 *   action required.
 * - Only control-plane-capable engines can carry the binding (offer only
 *   capable engines, keyed off
 *   capability). The built-in default agent's whole identity is "assistant
 *   that manages Station through `station-control`"; on an engine whose
 *   `toolServers` delivery cannot carry that server, it registers, responds,
 *   and cannot do the one thing it exists for. An incapable engine is
 *   therefore treated exactly like an unready one, on BOTH branches: never
 *   auto-defaulted onto (a machine whose only ready engine cannot carry the
 *   server resolves to null rather than silently binding a decorative
 *   assistant), and an explicit choice of one fails safe for THIS resolution
 *   with the persisted choice untouched — so when an engine's matrix cell
 *   gains a `builtinStationControlDelivery` mechanism (as Codex's does with
 *   `'url-token'`), the same persisted choice starts resolving
 *   with no user action, which is the payoff of keying off the capability
 *   cell instead of an engine list. The same payoff extends to
 *   EVIDENCE arrival: for a `runtime_observation` cell the same persisted
 *   choice starts resolving the moment the connection's observation says
 *   yes, with no code change and no user action.
 */
export function resolveBuiltinAgentEngineBinding(input: {
  explicitConnectionId: EngineConnectionId | null | undefined;
  stationChatReady: boolean;
  readyExternalEngines: ReadyEngineConnection[];
}): BuiltinAgentEngineBinding | null {
  const capableEngines = input.readyExternalEngines.filter(
    // `=== 'full'` deliberately, not `!== 'chat-only'` — an
    // `observation-required` connection is one Station has never met, and
    // binding it optimistically would produce exactly the decorative
    // assistant this filter exists to prevent.
    (engine) =>
      engineControlPlaneCapability(
        engine.matrix,
        engine.controlPlaneObservation,
      ) === 'full',
  );
  if (input.explicitConnectionId !== undefined) {
    if (input.explicitConnectionId === null) return null;
    return (
      capableEngines.find(
        (engine) => engine.connectionId === input.explicitConnectionId,
      ) ?? null
    );
  }
  if (input.stationChatReady) return null;
  if (capableEngines.length === 1) {
    return capableEngines[0];
  }
  return null;
}
