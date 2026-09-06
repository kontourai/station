import type { EngineConnectionId } from './agent-identity.js';
import type { ContributionConfig } from './contribution.js';
import type { DistributionProfileSelection } from './distribution.js';
import type { FleetContributionConfig } from './fleet-contribution.js';
import type { AgentConnectionSettings } from './tool.js';
import type { UserProfileSettings } from './user-profile.js';

export interface ApprovalGuardianConfig {
  enabled?: boolean;
  mode?: 'review' | 'enforce';
  model?: string;
  instructions?: string;
}

export interface AppConfig {
  region?: string;
  defaultModel: string;
  invokeModel: string;
  structureModel: string;
  runtime?: 'voltagent' | 'strands';
  defaultMaxTurns?: number;
  defaultMaxOutputTokens?: number;
  systemPrompt?: string;
  templateVariables?: TemplateVariable[];
  defaultChatFontSize?: number;
  logLevel?: 'trace' | 'debug' | 'info' | 'warn' | 'error';
  /** Default on, but nothing is sent unless an endpoint is configured. */
  telemetryEnabled?: boolean;
  registryUrl?: string;
  gitRemote?: string;
  defaultLLMProvider?: string;
  defaultEmbeddingProvider?: string;
  defaultEmbeddingModel?: string;
  defaultVectorDbProvider?: string;
  agentConnections?: Record<string, AgentConnectionSettings>;
  terminalShell?: string;
  /**
   * Runtime-derived (never persisted): the shell this host would try FIRST
   * when `terminalShell` is unset — `SHELL` where the environment sets one,
   * else the platform's own first fallback. Produced by
   * `defaultTerminalShell` in the server's terminal-shell resolver, which is
   * the same list a spawn walks, so the hint the Settings input shows cannot
   * disagree with what a terminal actually starts. Absent when the resolver
   * offers no candidate at all.
   *
   * "Tries first", not "uses": a spawn falls through when a candidate fails to
   * start, and nothing computes that without launching a process.
   */
  defaultTerminalShell?: string;
  disableDefaultSkillRegistries?: boolean;
  approvalGuardian?: ApprovalGuardianConfig;
  /**
   * Render resolved MCP tool UIs in a sandboxed iframe (MCP Apps host).
   * **Default on** — set `false` to opt out, which makes a successfully-resolved
   * MCP UI fall back to the inert "unsupported" state. (Was off-by-default while
   * the sandbox soaked; enabled by default once the host was validated
   * end-to-end against real MCP servers with a containment + integration suite.)
   */
  mcpUiHost?: boolean;
  /**
   * Runtime-derived (never persisted): the origin of the dedicated MCP-UI frame
   * server when one is running (`MCP_UI_FRAME_PORT` set). Distinct from
   * Station's own origin, so the host may grant `allow-same-origin` to that
   * frame for spec-complete storage-app support. Absent → opaque-origin render.
   */
  mcpUiFrameOrigin?: string;
  /**
   * Runtime-derived (never persisted): the dedicated isolated plugin-frame
   * origin. It is served by the same asset-free listener as the MCP UI proxy.
   */
  pluginFrameOrigin?: string;
  /**
   * Surface the trust bundle embedded in the latest Veritas evidence record
   * (`.kontourai/veritas/evidence/veritas-*.json` → `trust.bundle`) as a project Trust
   * bundle, so the Surface trust panel lights up wherever Veritas has run
   * without a separate bundle producer. **Default on** — set `false` to opt out
   * (e.g. a project that only wants explicitly-published bundles).
   */
  surfaceTrustFromVeritasEvidence?: boolean;
  /**
   * Register the K2 `KnowledgeStoreProvider` seam (root registry + adapter-backed
   * record CRUD) alongside today's `KnowledgeService`/namespace-based knowledge path.
   * **Default off** (same pattern as `mcpUiHost`) — no read path is rewired, no data
   * moves, and existing `ProjectConfig.knowledgeNamespaces` behavior is byte-identical
   * with this flag unset, until an explicit future migration/cutover (ADR-0009 K3+).
   */
  knowledgeStores?: boolean;
  /**
   * archive#980: whether the interactive managed-chat callers (CLI `station
   * chat`, the UI managed branch) start a `station-agent` orchestration
   * session (mirroring `delegateTask`) instead of calling
   * `POST /api/agents/:slug/chat` directly — so managed chats land in
   * orchestration.sqlite and appear in `station runs`. **Runtime-derived from
   * `STATION_FEATURES=managed-chat-orchestration`, never persisted** (same
   * pattern as `mcpUiFrameOrigin`): `GET /config/app` injects this field when
   * the flag is on and omits it when off — it is never accepted by
   * `PUT /config/app`. **Default off** — off is today's exact managed-chat
   * behavior, byte-identical.
   */
  managedChatOrchestration?: boolean;
  /**
   * archive#2802: capture workspace checkpoints at turn boundaries — a
   * git snapshot (hidden `STATION_CHECKPOINTS/…` pseudo-ref + reflog) of
   * the session's bound project working directory at `turn.started` and
   * `turn.completed`/`turn.aborted`, indexed per thread in the Station
   * home. **Default off** — absent/undefined/false all mean off, exactly
   * today's behavior (no git calls, no index writes, no `.git` growth).
   * Deliberately OFF by default rather than on: checkpoint objects are
   * pinned against `git gc` by their reflogs (reclaimable after
   * `gc.reflogExpire`, default 90 days, or via `station checkpoints
   * prune`), so turning capture on is a disk-spending decision the owner
   * makes per Station (the archive#980 ship-dormant pattern). Read once at
   * boot wiring time — a flip applies on the next Station start.
   */
  workspaceCheckpoints?: boolean;
  /** Distribution defaults for starter layouts and registry sources. */
  distributionProfile?: DistributionProfileSelection;
  /**
   * archive#1194: the user's engine choice for the
   * built-in agents (Station's own default agent, `station-voice`) from the
   * first-run onboarding engine picker — see
   * `resolveBuiltinAgentEngineBinding` (`engine-capability-matrix.ts`), the
   * single source of truth for how this field resolves to a binding.
   *
   * - Absent (`undefined`): never chosen — the runtime computes a sensible
   *   default each boot (Station if a model connection is chat-ready, else
   *   the single ready external engine) and does NOT persist that computed
   *   value here; it stays re-derived until an explicit choice is made.
   * - `null`: explicitly chose Station. Sticky — never recomputed.
   * - A connection id string: explicitly chose that engine connection.
   *   Sticky — re-running bootstrap must never clobber it back to Station.
   */
  builtinAgentEngineConnectionId?: EngineConnectionId | null;
  /**
   * Which local model connections this Station offers
   * to its owner's inference fleet. **Default off** — absent means this
   * Station contributes nothing, which is byte-identical to today's
   * behavior. See `fleet-contribution.ts` for the shape and
   * `docs/design/inference-fleet.md` §11 for the scope.
   */
  fleetContribution?: FleetContributionConfig;
  /**
   * What this Station offers, PER SPACE — keyed by
   * scope key (`"fleet"`, `"project:prj_…"`; see `contribution.ts`'s
   * `contributionScopeKey`). **Default off** — an absent map, an absent entry,
   * an absent `enabled`, and an empty axis list all offer nothing, and no value
   * of this map offers a resource the operator did not name.
   *
   * The `"fleet"` key is deliberately NOT the fleet scope's authority:
   * `fleetContribution` above is, and `resolveScopedContribution` refuses a
   * shadowing entry by name rather than merging it. One writable home per scope
   * — a second copy of one consent is the drift this contract exists to prevent.
   *
   * No consumer reads this yet; the authenticated projection route is future
   * work.
   */
  contribution?: Record<string, ContributionConfig>;
  /**
   * archive#2652: the two things the person using this
   * Station told it about themselves — their role and how much technical
   * detail they want back.
   *
   * **Absent means they were not asked or chose to skip, and Station injects
   * nothing.** There is deliberately no default User Profile: a `[USER PROFILE]`
   * block stating a role nobody claimed is a fabricated observation, and the
   * model cannot tell it apart from a stated one. `buildUserProfileContextBlock`
   * (`user-profile.ts`) is the single derivation and returns `null` for absent,
   * empty, and unrecognised values alike.
   *
   * Reach: read only by `prepareChatRequest`, which is on Station's own
   * engine's turn path. External engines assemble their own context and never
   * see this — see `USER_PROFILE_ENGINE_REACH_NOTE`.
   */
  userProfile?: UserProfileSettings;
  /**
   * Whether the guided first run has been offered on THIS HOME, and what the
   * person did with it (archive#3591 / UX audit RT-02, SHELL-12).
   *
   * The durable fact the first-run gate reads. It replaces the old rule —
   * "only a session that saw the connect launcher is a first run" — which
   * derived a permanent property of the home from a readiness probe that
   * flaps: on a machine with `claude`/`codex` installed the launcher never
   * appeared and the whole guided run never ran, and when the probe happened
   * to answer `cannot_verify` it ran ten seconds into whatever route the user
   * was on.
   *
   * **Absent is not `pending`.** A home whose `config/app.json` predates this
   * field is a home that has already been used, and re-running first run
   * there would be the ambush the launcher rule existed to prevent. Only
   * `loadAppConfigFile`'s brand-new-home path writes `pending`
   * (`config-loader-app.ts`), so `pending` means "this home was created and
   * nobody has answered yet" and nothing else. `resolveFirstRunOffer`
   * (`src-ui/src/components/first-run/first-run-gate.ts`) is the single
   * derivation.
   */
  firstRun?: FirstRunState;
}

/**
 * - `pending` — created, never answered. The chapter opens on Home.
 * - `skipped` — "Not now". The chapter does not open again by itself; Home
 *   keeps offering it from a card until it is completed.
 * - `completed` — answered. Nothing offers it again.
 */
export type FirstRunStatus = 'pending' | 'skipped' | 'completed';

/**
 * Deliberately a `status`, not a `completed: boolean` plus a timestamp. Three
 * states are real here — "never asked", "asked and deferred", "done" — and a
 * boolean would force the deferred state to be re-derived somewhere else, which
 * is how a surface ends up disagreeing with the fact it claims to read.
 *
 * The timestamps are observations, one per terminal transition, written only
 * when that transition happens; neither is read by any decision.
 */
export interface FirstRunState {
  status: FirstRunStatus;
  completedAt?: string;
  skippedAt?: string;
}

/** What a client may ask for: a status, and nothing else. */
export interface FirstRunTransitionRequest {
  status: 'skipped' | 'completed';
}

/**
 * Why this transition may not be recorded, or `undefined` when it may.
 *
 * The invariant `pending` depends on — "only the code path that CREATES a home
 * writes it" — was documentation, not enforcement: `firstRun` is an ordinary
 * composite setting, so any caller of the generic config write could re-arm an
 * existing home as `pending`, forge `completed` on a home that was never
 * offered the run, or stamp a `completedAt` of its choosing. This is the rule
 * that makes the record mean what it says, and it lives in contracts so the
 * route and the offline CLI path cannot diverge on it.
 *
 * - **`pending` is never a target.** Only home creation writes it. A client
 *   that could re-arm it could re-run the guided chapter on anyone's Station.
 * - **A home that was never offered the run cannot record a decision.** Absent
 *   means "this home predates the field"; a `completed` there would be a
 *   statement about something that never happened.
 * - **`completed` is terminal**, and a status may not be re-recorded — the
 *   timestamps are observations of a transition, so rewriting one moves an
 *   observation to a moment when nothing happened.
 * - **Timestamps are Station's to write.** A request carrying one is refused
 *   rather than silently stripped: silently dropping a field a caller sent is
 *   how a caller comes to believe it was honoured.
 */
export function describeFirstRunTransitionViolation(
  current: FirstRunState | undefined,
  next: unknown,
): string | undefined {
  if (!next || typeof next !== 'object' || Array.isArray(next)) {
    return 'A first-run decision must be an object with a status.';
  }
  const keys = Object.keys(next);
  const extra = keys.filter((key) => key !== 'status');
  if (extra.length > 0) {
    return `Station records when a first-run decision happened; a request may not set ${extra
      .map((key) => `"${key}"`)
      .join(', ')}.`;
  }
  const status = (next as { status?: unknown }).status;
  if (status !== 'skipped' && status !== 'completed') {
    return status === 'pending'
      ? 'A first run is offered when a home is created; it cannot be re-armed.'
      : 'A first-run decision must be "skipped" or "completed".';
  }
  if (current === undefined) {
    return 'This home was never offered the guided first run, so there is no decision to record.';
  }
  if (current.status === 'completed') {
    return 'This home has already completed its first run.';
  }
  if (current.status === status) {
    return `This home has already recorded "${status}".`;
  }
  if (current.status !== 'pending' && current.status !== 'skipped') {
    return 'Station cannot read this home’s first-run record.';
  }
  return undefined;
}

/**
 * The record Station persists for an ACCEPTED transition. The timestamp is the
 * server's observation of when it happened, never the caller's claim, and only
 * the one that belongs to the new status is written.
 */
export function firstRunStateForTransition(
  next: FirstRunTransitionRequest,
  now: Date,
): FirstRunState {
  return next.status === 'completed'
    ? { status: 'completed', completedAt: now.toISOString() }
    : { status: 'skipped', skippedAt: now.toISOString() };
}

export interface TemplateVariable {
  key: string;
  type: 'static' | 'date' | 'time' | 'datetime' | 'custom';
  value?: string;
  format?: string;
}
