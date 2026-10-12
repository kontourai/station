import type { ClientOriginActor } from '@kontourai/station-contracts/client-origin';
import {
  type ApprovalMode,
  type EngineId,
  isApprovalMode,
  PROVIDER_CODEX,
  PROVIDER_MODEL_OPTION_SUPPORT,
  type StationConfinement,
} from '@kontourai/station-contracts/provider';
import { isFullAccessGrant } from '../../security/coding-authority.js';

/**
 * #2436: the conversation's approval posture as the SERVER orders it. See
 * docs/design/approval-posture-server-ordered.md.
 *
 * A decision is a `session.approval-mode-set` event; the latest one across
 * the conversation's sessions (by global sequence) is what every session
 * start and turn start applies, whatever path sent it. `modelOptions.
 * approvalMode` carried by a start or turn is the DEFAULT channel (the UI's
 * Station/connection default at session start, the CLI's `--approval-mode`):
 * it applies only while nothing is recorded, and is never recorded itself.
 */

/** Whether this engine's adapter maps `approvalMode` to a native knob. */
export function approvalKnobSupported(provider: EngineId): boolean {
  return (
    PROVIDER_MODEL_OPTION_SUPPORT[provider]?.includes('approvalMode') === true
  );
}

/**
 * #2493: whether this engine confines `never` to the workspace with a native
 * process sandbox (Codex's `workspace-write`). An engine without one cannot
 * run `never` confined, so a confined session applies `auto` there instead.
 */
function confinesFullAccessNatively(provider: EngineId): boolean {
  return provider === PROVIDER_CODEX;
}

/** #2493: the mode an engine can apply for `mode` under `confinement`. */
function applicableMode(
  mode: ApprovalMode,
  provider: EngineId,
  confinement: StationConfinement,
): ApprovalMode {
  return mode === 'never' &&
    confinement !== 'host' &&
    !confinesFullAccessNatively(provider)
    ? 'auto'
    : mode;
}

export interface ApprovalPostureStore {
  latestApprovalModeDecision(threadIds: readonly string[]):
    | {
        threadId: string;
        approvalMode: unknown;
        globalSequence: number;
        actor?: unknown;
      }
    | undefined;
  conversationForSession(
    sessionId: string,
  ): { conversationId: string } | undefined;
  conversationSessions(
    conversationId: string,
  ): readonly { sessionId: string }[];
}

export interface ApprovalPostureDecision {
  approvalMode: ApprovalMode;
  /** The recorded event's server global sequence. */
  sequence: number;
  /** #1796: the thread the decision was recorded on. */
  threadId: string;
  /**
   * #1796: who recorded it, from the event's server-derived
   * `clientOrigin.actor`; `undefined` on events from before it existed.
   */
  actor?: ClientOriginActor;
}

function parseActor(value: unknown): ClientOriginActor | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const actor = value as { kind?: unknown; deviceId?: unknown };
  if (actor.kind === 'device')
    return typeof actor.deviceId === 'string' && actor.deviceId
      ? { kind: 'device', deviceId: actor.deviceId }
      : undefined;
  if (
    actor.kind === 'operator' ||
    actor.kind === 'internal' ||
    actor.kind === 'unknown'
  )
    return { kind: actor.kind };
  return undefined;
}

function concrete(mode: unknown): ApprovalMode | undefined {
  return isApprovalMode(mode) && mode !== 'connection-default'
    ? mode
    : undefined;
}

/**
 * The default posture below a decision: the Agent's own, then this
 * Station's (#2436 §4.9). `ApprovalPosture` applies it at a start and for a
 * Default pick; an Agent write reads it to see what the write leaves in
 * force (#2377 slice C1).
 */
export function effectiveDefaultPosture(
  agentDefault: unknown,
  stationDefault: unknown,
): ApprovalMode | undefined {
  return concrete(agentDefault) ?? concrete(stationDefault);
}

/** Strictness order of the concrete postures: lower is stricter. */
const STRICTNESS: Readonly<Record<string, number>> = {
  ask: 0,
  auto: 1,
  never: 2,
};

/**
 * Whether `pick` is at least as strict as `standing` in a way that cannot
 * change later. A Default (`connection-default`) is never ranked, on either
 * side: what it resolves to depends on the Agent and Station defaults, which
 * can be edited after the pick is recorded, so a ranking made at record time
 * could go stale. Ask is at least as strict as any posture, a Default
 * included; Auto only against a concrete `auto` or `never`.
 */
function atLeastAsStrict(pick: ApprovalMode, standing: ApprovalMode): boolean {
  if (pick === 'ask') return true;
  if (pick === 'connection-default' || standing === 'connection-default')
    return false;
  const picked = STRICTNESS[pick];
  const stands = STRICTNESS[standing];
  return picked !== undefined && stands !== undefined && picked <= stands;
}

export class ApprovalPosture {
  /**
   * Threads to which Station itself passed a concrete posture (a start or a
   * turn it resolved). A Default pick on such a thread must move the engine
   * off what Station set; on a thread Station never set, the engine's own
   * configuration is already the default (#1950). Cleared when the session
   * exits, so a respawned engine starts clean.
   *
   * #2898: each entry also keeps the mode Station last passed and the
   * confinement the engine was started under (`undefined` when this
   * process did not start it), which `reconfinedMode` compares a turn's
   * confinement against.
   */
  private readonly stationApplied = new Map<
    string,
    { mode: ApprovalMode; startConfinement?: StationConfinement }
  >();

  constructor(
    private readonly deps: {
      store?: ApprovalPostureStore;
      /** This Station's `AppConfig.defaultApprovalMode`. Loaded per call. */
      resolveStationDefault?: () => Promise<ApprovalMode | undefined>;
      /** The Agent's own default (`AgentSpec.execution.approvalMode`). */
      resolveAgentDefault?: (
        agentSlug: string,
      ) => Promise<ApprovalMode | undefined>;
    },
  ) {}

  /** The thread's conversation's sessions (the thread itself at least). */
  private conversationThreads(threadId: string): string[] {
    const store = this.deps.store;
    const lineage = store?.conversationForSession(threadId);
    if (!store || !lineage) return [threadId];
    return [
      threadId,
      ...store
        .conversationSessions(lineage.conversationId)
        .map((session) => session.sessionId),
    ];
  }

  /** The latest recorded decision for the thread's conversation. */
  decision(threadId: string): ApprovalPostureDecision | undefined {
    const latest = this.deps.store?.latestApprovalModeDecision(
      this.conversationThreads(threadId),
    );
    if (!latest || !isApprovalMode(latest.approvalMode)) return undefined;
    const actor = parseActor(latest.actor);
    return {
      approvalMode: latest.approvalMode,
      sequence: latest.globalSequence,
      threadId: latest.threadId,
      ...(actor ? { actor } : {}),
    };
  }

  /**
   * #1796: which default, if any, puts `agentSlug`'s sessions at `never`:
   * the Agent's own, else this Station's. A revocation lists, and never
   * changes, a session whose full access comes from a default.
   */
  async fullAccessDefaultSource(
    agentSlug: string | undefined,
  ): Promise<'agent-default' | 'station-default' | undefined> {
    const agent = agentSlug
      ? concrete(await this.deps.resolveAgentDefault?.(agentSlug))
      : undefined;
    if (agent) return agent === 'never' ? 'agent-default' : undefined;
    return concrete(await this.deps.resolveStationDefault?.()) === 'never'
      ? 'station-default'
      : undefined;
  }

  /**
   * #2493: whether the conversation's latest recorded decision is a concrete
   * `never`. Every writer of a decision is a route that refuses `never`
   * unless `mayGrantFullAccess` holds (`/commands` `setApprovalMode`, and a
   * pick carried on `/chat`, `/chat/:id/continue` or a handoff): the operator
   * in person or a device holding `approval:full-access`, never Station's
   * internal principal, marked as an agent's tool or not. So a recorded
   * `never` is itself a grant of `host`.
   */
  private recordedFullAccess(threadId: string): boolean {
    return this.decision(threadId)?.approvalMode === 'never';
  }

  /**
   * #2493: the confinement a session START runs in. `host` only when the
   * start's caller proved it may grant full access (`grant`, minted from the
   * request by `fullAccessGrantFor` and checked by `instanceof`, so nothing
   * parsed from JSON satisfies it), or the conversation's recorded decision
   * is a concrete `never`. Everything else is `workspace`.
   */
  startConfinement(threadId: string, grant: unknown): StationConfinement {
    return isFullAccessGrant(grant) || this.recordedFullAccess(threadId)
      ? 'host'
      : 'workspace';
  }

  /**
   * #2493: the confinement of a session that already started: a turn, a
   * dormant respawn, a credential-profile restart or recovery replay. `stamp`
   * is the server's start stamp (`STATION_CONFINEMENT_METADATA_KEY`); a
   * missing or unknown stamp (a session from before #2493) counts as
   * `workspace`. Never derived from an approval mode a turn or replay
   * carries: that is exactly the value a confined caller controls.
   *
   * #2493 review F2, closed for new picks by #2377 slice C1: a Default pick
   * resolves to the Agent's and Station's defaults, even when that is
   * `never`, and on a `host`-stamped session that `never` runs unconfined.
   * Recording such a Default now needs the full-access grant
   * (`pickReachesFullAccess`). Still accepted: a default edited to `never`
   * AFTER a Default pick was recorded reaches that session without a new
   * pick.
   */
  standingConfinement(threadId: string, stamp: unknown): StationConfinement {
    return stamp === 'host' || this.recordedFullAccess(threadId)
      ? 'host'
      : 'workspace';
  }

  /**
   * Compare-and-set (#2436 MEDIUM-1, narrowed by the orchestrator's decisions
   * of 2026-09-23): the decision that stands against a pick made having seen
   * `basedOnSequence` (`null`: having seen none), or `undefined` when the pick
   * may be recorded.
   *
   * Only a pick that is not provably at least as strict as the standing
   * decision is held to the basis (`atLeastAsStrict`). Ask is always
   * recorded, so a second device's Ask on a full-access session is never
   * refused for not having seen that session's history. A Default pick is
   * always held to its basis: it is ranked by nothing, because what it
   * resolves to can change after it is recorded.
   */
  supersedingDecision(
    threadId: string,
    pick: ApprovalMode,
    basedOnSequence: number | null,
  ): ApprovalPostureDecision | undefined {
    const standing = this.decision(threadId);
    if (!standing) return undefined;
    if (basedOnSequence !== null && standing.sequence <= basedOnSequence)
      return undefined;
    return atLeastAsStrict(pick, standing.approvalMode) ? undefined : standing;
  }

  /**
   * The defaults below a decision: the Agent's own, then this Station's.
   * An engine connection's `config.approvalMode` is not a layer here: no
   * writer persists it (`sanitizeRuntimeConfig` keeps only named keys).
   */
  private async defaultPosture(input: {
    agentSlug?: string;
    capturedAgent?: { approvalMode?: ApprovalMode };
  }): Promise<ApprovalMode | undefined> {
    // A foreground invocation admission captured the Agent's definition when
    // it was admitted; the start must consume that, never reread the store
    // (a reread could see a definition the admission did not). A read that
    // fails is not "no default": it propagates and fails the start, like the
    // credential-profile pin read beside it.
    // Both sources are the Agent's EFFECTIVE default: for a plugin-owned
    // Agent, the operator's override, else the plugin's own value short of
    // full access (`agent-approval-overrides.ts`, applied at the read seam).
    const agent = input.capturedAgent
      ? concrete(input.capturedAgent.approvalMode)
      : input.agentSlug
        ? concrete(await this.deps.resolveAgentDefault?.(input.agentSlug))
        : undefined;
    if (agent) return agent;
    return effectiveDefaultPosture(
      undefined,
      await this.deps.resolveStationDefault?.(),
    );
  }

  /**
   * The `modelOptions` a start or turn on `threadId` must carry to the
   * adapter. An engine with no knob gets its options untouched: a posture is
   * a request nothing there can honour, and sending it would be refused as an
   * unsupported option.
   *
   * - A recorded decision wins. A recorded Default resolves through
   *   `resolveDefaultPick`.
   * - Otherwise a posture the start or turn carries (`station chat
   *   --approval-mode`, an older remote client) applies as sent.
   * - Otherwise, at a session START only, the defaults apply (Agent, then
   *   Station). A turn on a live session sends nothing: a default is the
   *   posture a session starts in, and re-requesting it would let an edit of
   *   the setting reconfigure a running chat (#2144 slice 6).
   * - #2898 (owner decision 2026-09-27), the one exception to that: while
   *   the session's confinement is not the one its engine was started under
   *   (a device's full access was revoked, so its `host` stamp now applies
   *   as `workspace`), the turn re-sends the mode Station last passed that
   *   engine, applied under the confinement that holds now. It is the mode
   *   the engine already runs, never a re-read default, so an edited default
   *   still reconfigures nothing, and an ordinary turn still sends nothing.
   *
   * #2493: on an engine with no native sandbox, `never` in a `workspace`
   * session is applied as `auto`, so the engine is never spawned or turned
   * with its permission checks bypassed on a caller's say-so. Codex keeps
   * `never` and confines it with its sandbox (codex-approval-mode.ts).
   */
  async resolve(input: {
    threadId: string;
    provider: EngineId;
    phase: 'start' | 'turn';
    agentSlug?: string;
    /** The Agent execution config a foreground admission captured. */
    capturedAgent?: { approvalMode?: ApprovalMode };
    modelOptions?: Record<string, unknown>;
    /** `startConfinement` or `standingConfinement`; required so every caller states it. */
    confinement: StationConfinement;
  }): Promise<Record<string, unknown> | undefined> {
    if (!approvalKnobSupported(input.provider)) return input.modelOptions;
    const decision = this.decision(input.threadId);
    const { approvalMode: carried, ...rest } = input.modelOptions ?? {};
    let mode: ApprovalMode | undefined;
    if (decision) {
      mode =
        decision.approvalMode === 'connection-default'
          ? await this.resolveDefaultPick(input)
          : decision.approvalMode;
    } else {
      mode =
        concrete(carried) ??
        (input.phase === 'start'
          ? await this.defaultPosture(input)
          : this.reconfinedMode(input.threadId, input.confinement));
    }
    if (!mode) return Object.keys(rest).length > 0 ? rest : undefined;
    const startConfinement =
      input.phase === 'start'
        ? input.confinement
        : this.stationApplied.get(input.threadId)?.startConfinement;
    this.stationApplied.set(input.threadId, {
      mode,
      ...(startConfinement ? { startConfinement } : {}),
    });
    return {
      ...rest,
      approvalMode: applicableMode(mode, input.provider, input.confinement),
    };
  }

  /**
   * #2377 slice C1: whether recording `pick` on `threadId` would run an
   * engine at `never` unconfined, which is what full access means here.
   *
   * - `never` itself: recording it makes the conversation `host`
   *   (`recordedFullAccess`).
   * - A Default: a decision governs every session of the conversation
   *   (`decision` reads the whole lineage), so each is checked, not only the
   *   one the pick names. Once recorded, each session's confinement is its
   *   start `stamp` again, and the Default resolves for it as `resolve`
   *   applies it (its own Agent, `resolveDefaultPick`). Full access when any
   *   `host`-stamped session resolves to `never`. On `workspace` sessions the
   *   same Default runs confined, which the owner decided a member may pick
   *   without a grant (2026-09-23, fork 1). A session added later starts in
   *   its own starter's confinement (`startConfinement`), and a Default is
   *   not a recorded `never`, so it inherits no `host`.
   * - Ask and Auto: never.
   *
   * `startOf` reads a session's start stamp and Agent; `agentSlug` stands in
   * for a named thread that has no session yet.
   */
  async pickReachesFullAccess(input: {
    threadId: string;
    pick: ApprovalMode;
    agentSlug?: string;
    startOf: (threadId: string) => { stamp: unknown; agentSlug?: string };
  }): Promise<boolean> {
    if (input.pick === 'never') return true;
    if (input.pick !== 'connection-default') return false;
    for (const threadId of new Set(this.conversationThreads(input.threadId))) {
      const start = input.startOf(threadId);
      if (start.stamp !== 'host') continue;
      const agentSlug =
        start.agentSlug ??
        (threadId === input.threadId ? input.agentSlug : undefined);
      const resolved = await this.resolveDefaultPick({
        threadId,
        ...(agentSlug ? { agentSlug } : {}),
      });
      if (resolved === 'never') return true;
    }
    return false;
  }

  /**
   * #2409: a Default pick resolved to something the engine will actually
   * apply. An absent mode is a no-op for both adapters (Claude calls no
   * `setPermissionMode`; Codex omits its knobs and keeps the previous pair),
   * so sending nothing would leave a session Station put at full access
   * there, while the chat claimed Default.
   *
   * 1. The Agent's own default, then this Station's default.
   * 2. Else, on a thread Station set a posture on: `ask`, each engine's own
   *    standard mode (Claude `default`; Codex `untrusted`/`workspace-write`).
   *    The engine's configured default cannot be observed once Station has
   *    overridden it at spawn, and `ask` is at least as strict as any
   *    posture, so it can never be the looser choice. The applied report
   *    then names it, so the chip does not claim more than happened.
   * 3. Else nothing: the engine's own configuration IS the default.
   */
  private async resolveDefaultPick(input: {
    threadId: string;
    agentSlug?: string;
    capturedAgent?: { approvalMode?: ApprovalMode };
  }): Promise<ApprovalMode | undefined> {
    const configured = await this.defaultPosture(input);
    if (configured) return configured;
    return this.stationApplied.has(input.threadId) ? 'ask' : undefined;
  }

  /**
   * #2898: the mode a turn with nothing recorded or carried re-applies: the
   * one Station last passed the engine, while the session's confinement
   * differs from the one the engine started under. Otherwise `undefined`
   * (#2144 slice 6).
   *
   * Sent on every such turn rather than once, so a turn that fails before
   * its engine takes it cannot leave the engine at its start posture; both
   * adapters treat a repeated mode as no change (Claude calls
   * `setPermissionMode` only when the mode differs, Codex sends a sandbox
   * policy only when it differs). Re-granting the scope makes the
   * confinement match again: nothing is sent, and the engine stays at the
   * confined mode until it restarts, which is never looser.
   */
  private reconfinedMode(
    threadId: string,
    confinement: StationConfinement,
  ): ApprovalMode | undefined {
    const applied = this.stationApplied.get(threadId);
    return applied?.startConfinement && applied.startConfinement !== confinement
      ? applied.mode
      : undefined;
  }

  forgetThread(threadId: string): void {
    this.stationApplied.delete(threadId);
  }
}
