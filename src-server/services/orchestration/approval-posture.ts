import {
  type ApprovalMode,
  type EngineId,
  isApprovalMode,
  PROVIDER_MODEL_OPTION_SUPPORT,
} from '@kontourai/station-contracts/provider';

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
   * Compare-and-set (#2436 MEDIUM-1): the decision that stands against a pick
   * made having seen `basedOnSequence` (`null`: having seen none), or
   * `undefined` when the pick may be recorded. A pick made without knowing a
   * newer decision does not overwrite it, whatever order the two reach the
   * server in. `basedOnSequence === undefined` is an unconditional caller.
   */
  supersedingDecision(
    threadId: string,
    basedOnSequence: number | null | undefined,
  ): ApprovalPostureDecision | undefined {
    if (basedOnSequence === undefined) return undefined;
    const standing = this.decision(threadId);
    if (!standing) return undefined;
    return basedOnSequence === null || standing.sequence > basedOnSequence
      ? standing
      : undefined;
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
   */
  async resolve(input: {
    threadId: string;
    provider: EngineId;
    phase: 'start' | 'turn';
    agentSlug?: string;
    /** The Agent execution config a foreground admission captured. */
    capturedAgent?: { approvalMode?: ApprovalMode };
    modelOptions?: Record<string, unknown>;
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
    return { ...rest, approvalMode: mode };
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
