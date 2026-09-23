import {
  type ApprovalMode,
  type EngineId,
  isApprovalMode,
  PROVIDER_MODEL_OPTION_SUPPORT,
  readApprovalMode,
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
      /**
       * The engine connection's own `approvalMode`, else this Station's
       * `AppConfig.defaultApprovalMode`. Loaded per call.
       */
      resolveStationDefault?: (input: {
        connectionId?: string;
        provider: EngineId;
      }) => Promise<ApprovalMode | undefined>;
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
   * The `modelOptions` a start or turn on `threadId` must carry to the
   * adapter. An engine with no knob gets its options untouched: a posture is
   * a request nothing there can honour, and sending it would be refused as an
   * unsupported option.
   */
  async resolve(input: {
    threadId: string;
    provider: EngineId;
    connectionId?: string;
    modelOptions?: Record<string, unknown>;
    /**
     * A decision this start carries that cannot be recorded yet (the session
     * does not exist until the start succeeds). It is the newest decision by
     * construction — the server has only just received it — so it outranks
     * anything recorded. The turn that follows records it.
     */
    carriedDecision?: ApprovalMode;
  }): Promise<Record<string, unknown> | undefined> {
    if (!approvalKnobSupported(input.provider)) return input.modelOptions;
    const decision = input.carriedDecision
      ? { approvalMode: input.carriedDecision }
      : this.decision(input.threadId);
    let mode: ApprovalMode | undefined;
    if (!decision) {
      mode = readApprovalMode(input.modelOptions);
      if (mode && mode !== 'connection-default')
        this.stationApplied.add(input.threadId);
      return input.modelOptions;
    }
    mode =
      decision.approvalMode === 'connection-default'
        ? await this.resolveDefaultPick(input)
        : decision.approvalMode;
    const { approvalMode: _carried, ...rest } = input.modelOptions ?? {};
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
   * 1. The connection's own default, then this Station's default.
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
    provider: EngineId;
    connectionId?: string;
  }): Promise<ApprovalMode | undefined> {
    const configured = await this.deps.resolveStationDefault?.({
      ...(input.connectionId ? { connectionId: input.connectionId } : {}),
      provider: input.provider,
    });
    if (configured && configured !== 'connection-default') return configured;
    return this.stationApplied.has(input.threadId) ? 'ask' : undefined;
  }

  forgetThread(threadId: string): void {
    this.stationApplied.delete(threadId);
  }
}
