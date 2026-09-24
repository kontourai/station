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
  latestApprovalModeDecision(
    threadIds: readonly string[],
  ):
    | { threadId: string; approvalMode: unknown; globalSequence: number }
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
}

function concrete(mode: unknown): ApprovalMode | undefined {
  return isApprovalMode(mode) && mode !== 'connection-default'
    ? mode
    : undefined;
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
   */
  private readonly stationApplied = new Set<string>();

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
    return {
      approvalMode: latest.approvalMode,
      sequence: latest.globalSequence,
    };
  }

  /**
   * #2493: whether the conversation's latest recorded decision is a concrete
   * `never`. Recording one needs the operator in person or a device holding
   * `approval:full-access` (the `/commands` route and the foreground routes
   * that carry a pick refuse anyone else), so it is itself a grant of `host`.
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
    return concrete(await this.deps.resolveStationDefault?.());
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
          : undefined);
    }
    if (!mode) return Object.keys(rest).length > 0 ? rest : undefined;
    this.stationApplied.add(input.threadId);
    return {
      ...rest,
      approvalMode: applicableMode(mode, input.provider, input.confinement),
    };
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

  forgetThread(threadId: string): void {
    this.stationApplied.delete(threadId);
  }
}
