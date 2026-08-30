import type { CanonicalRuntimeEvent } from '@kontourai/station-contracts/runtime-events';
import { SERVER_EVENTS } from '@kontourai/station-contracts/runtime-events';
import { foldUsageEvents } from '@kontourai/station-shared/usage-fold';
import type { EventBus } from '../orchestration/event-bus.js';
import type { OrchestrationTurnAdmission } from '../orchestration/orchestration-service.js';
import type {
  AttachedMonitorTrigger,
  MonitorTerminal,
} from './scheduler-ledger.js';

type MonitorSession = {
  triggerId: string;
  taskId: string;
  sessionId: string;
  deadlineAt: number;
  limits: { maxTurns: number; maxTokens: number };
  signal: AbortSignal;
  deadlineTimer?: ReturnType<typeof setTimeout>;
  initialTurnId?: string;
  /** Latest canonical terminal event for this Task's observed turns. */
  terminalAt?: number;
  terminalTurnId?: string;
  onInitialTurnStarted: (task: {
    taskId: string;
    sessionId: string;
    turnId: string;
  }) => void;
};

export type MonitorTaskTurnSupervisorOptions = {
  eventBus: EventBus;
  registerTurnAdmission: (admission: OrchestrationTurnAdmission) => () => void;
  interruptTurn: (sessionId: string) => Promise<unknown>;
  listEvents: (sessionId: string) => readonly CanonicalRuntimeEvent[];
};

/**
 * Owns the narrow execution envelope for an externally-triggered Task.  It
 * observes the provider's canonical `turn.started` rather than accepting a
 * dispatch id as a turn receipt, and is the only extra admission observer
 * installed for monitor sessions.
 */
export class MonitorTaskTurnSupervisor {
  private readonly sessions = new Map<string, MonitorSession>();
  private readonly unsubscribeAdmission: () => void;
  private readonly unsubscribeEvents: () => void;

  constructor(private readonly options: MonitorTaskTurnSupervisorOptions) {
    this.unsubscribeAdmission = options.registerTurnAdmission((input) =>
      this.admit(input.threadId),
    );
    this.unsubscribeEvents = options.eventBus.subscribe((message) => {
      if (message.event !== SERVER_EVENTS.ORCHESTRATION_EVENT) return;
      const event = message.data?.event as CanonicalRuntimeEvent | undefined;
      if (event) this.observe(event);
    });
  }

  arm(input: {
    triggerId: string;
    taskId: string;
    sessionId: string;
    deadlineAt: number;
    limits: { maxTurns: number; maxTokens: number };
    signal: AbortSignal;
    initialTurnId?: string;
    onInitialTurnStarted: MonitorSession['onInitialTurnStarted'];
  }): void {
    const current = this.sessions.get(input.sessionId);
    if (current) return;
    const session: MonitorSession = { ...input };
    this.sessions.set(input.sessionId, session);
    if (Number.isFinite(input.deadlineAt)) {
      session.deadlineTimer = setTimeout(
        () => this.stop(session),
        Math.max(0, input.deadlineAt - Date.now()),
      );
    }
    if (input.signal.aborted) this.stop(session);
    else
      input.signal.addEventListener('abort', () => this.stop(session), {
        once: true,
      });
    // The event store is the restart authority. Process its full bounded
    // window even when the ledger already retained the initial turn id: the
    // persisted usage and terminal timestamp are still needed to recreate an
    // exact receipt before a new EventBus event arrives.
    for (const event of this.options.listEvents(session.sessionId)) {
      this.observe(event);
    }
  }

  abandon(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session?.deadlineTimer) clearTimeout(session.deadlineTimer);
    this.sessions.delete(sessionId);
  }

  release(triggerId: string): void {
    for (const [sessionId, session] of this.sessions) {
      if (session.triggerId !== triggerId) continue;
      if (session.deadlineTimer) clearTimeout(session.deadlineTimer);
      this.sessions.delete(sessionId);
      return;
    }
  }

  adopt(
    trigger: AttachedMonitorTrigger,
    signal: AbortSignal,
    onInitialTurnStarted: MonitorSession['onInitialTurnStarted'],
  ): void {
    if (!trigger.task.sessionId) return;
    this.arm({
      triggerId: trigger.triggerId,
      taskId: trigger.task.taskId,
      sessionId: trigger.task.sessionId,
      deadlineAt: Date.parse(trigger.deadlineAt),
      limits: trigger.limits,
      signal,
      initialTurnId: trigger.task.turnId,
      onInitialTurnStarted,
    });
  }

  receipt(
    trigger: AttachedMonitorTrigger,
  ): { turns: number; tokens: number; runtimeMs: number } | undefined {
    const session = trigger.task.sessionId
      ? this.sessions.get(trigger.task.sessionId)
      : undefined;
    if (!session?.initialTurnId) return undefined;
    const usage = this.usage(session);
    if (!usage || session.terminalAt === undefined) return undefined;
    const events = this.taskEvents(session);
    const latestTurnId = [...events]
      .reverse()
      .find((event) => event.method === 'turn.started')?.turnId;
    if (!latestTurnId || session.terminalTurnId !== latestTurnId)
      return undefined;
    const started = events.find(
      (event) =>
        event.method === 'turn.started' &&
        event.turnId === session.initialTurnId,
    );
    const startedAt = started ? Date.parse(started.createdAt) : NaN;
    if (!Number.isFinite(startedAt)) return undefined;
    return {
      turns: usage.turns,
      tokens: usage.tokens,
      runtimeMs: Math.max(0, session.terminalAt - startedAt),
    };
  }

  enforce(triggers: readonly AttachedMonitorTrigger[]): MonitorTerminal[] {
    return triggers.flatMap((trigger) => {
      const session = trigger.task.sessionId
        ? this.sessions.get(trigger.task.sessionId)
        : undefined;
      if (!session) return [];
      const usage = this.usage(session);
      const exceeded =
        Date.now() >= session.deadlineAt ||
        session.signal.aborted ||
        (usage !== undefined &&
          (usage.turns >= session.limits.maxTurns ||
            usage.tokens >= session.limits.maxTokens));
      if (!exceeded) return [];
      this.stop(session);
      const receipt = this.receipt(trigger);
      // A live token/deadline fence stops the active provider turn now, but
      // does not invent a terminal runtime receipt before the provider emits
      // one. The next scheduler reconciliation records that exact event.
      if (!receipt) return [];
      return [
        {
          triggerId: trigger.triggerId,
          terminal: 'indeterminate' as const,
          usage: receipt,
        },
      ];
    });
  }

  close(): void {
    this.unsubscribeAdmission();
    this.unsubscribeEvents();
    for (const session of this.sessions.values()) {
      if (session.deadlineTimer) clearTimeout(session.deadlineTimer);
    }
    this.sessions.clear();
  }

  private admit(
    sessionId: string,
  ): { allowed: true } | { allowed: false; reason: string } {
    const session = this.sessions.get(sessionId);
    if (!session) return { allowed: true };
    const usage = this.usage(session);
    if (
      session.signal.aborted ||
      Date.now() >= session.deadlineAt ||
      (usage !== undefined &&
        (usage.turns >= session.limits.maxTurns ||
          usage.tokens >= session.limits.maxTokens))
    ) {
      this.stop(session);
      return {
        allowed: false,
        reason: 'External monitor execution limit reached',
      };
    }
    return { allowed: true };
  }

  private observeTurnStarted(
    event: Extract<CanonicalRuntimeEvent, { method: 'turn.started' }>,
  ): void {
    const session = this.sessions.get(event.threadId);
    if (!session || session.initialTurnId) return;
    session.initialTurnId = event.turnId;
    session.onInitialTurnStarted({
      taskId: session.taskId,
      sessionId: session.sessionId,
      turnId: event.turnId,
    });
  }

  private observe(event: CanonicalRuntimeEvent): void {
    if (event.method === 'turn.started') this.observeTurnStarted(event);
    else if (event.method === 'token-usage.updated') this.observeUsage(event);
    else if (
      event.method === 'turn.completed' ||
      event.method === 'turn.aborted'
    )
      this.observeTerminal(event);
  }

  private observeUsage(
    event: Extract<CanonicalRuntimeEvent, { method: 'token-usage.updated' }>,
  ): void {
    const session = this.sessions.get(event.threadId);
    if (!session?.initialTurnId) return;
    const usage = this.usage(session);
    if (usage && usage.tokens >= session.limits.maxTokens) this.stop(session);
  }

  private observeTerminal(
    event: Extract<
      CanonicalRuntimeEvent,
      { method: 'turn.completed' | 'turn.aborted' }
    >,
  ): void {
    const session = this.sessions.get(event.threadId);
    if (!session?.initialTurnId) return;
    const belongsToTask = this.taskEvents(session).some(
      (candidate) =>
        candidate.method === 'turn.started' &&
        candidate.turnId === event.turnId,
    );
    if (!belongsToTask) return;
    const at = Date.parse(event.createdAt);
    if (Number.isFinite(at)) {
      session.terminalAt = at;
      session.terminalTurnId = event.turnId;
    }
  }

  private usage(session: MonitorSession) {
    const events = this.taskEvents(session);
    // No reporter: this supervisor has no logger seam, and its own guard
    // below already refuses a non-finite total. A refused figure is read as
    // absent here and reported by the transcript read of the same thread,
    // which is the surface a human actually looks at.
    const usage = foldUsageEvents(events);
    if (usage.totalTokens === undefined || !Number.isFinite(usage.totalTokens))
      return undefined;
    return { turns: usage.turns, tokens: usage.totalTokens };
  }

  private taskEvents(session: MonitorSession): CanonicalRuntimeEvent[] {
    if (!session.initialTurnId) return [];
    const events = [...this.options.listEvents(session.sessionId)];
    const first = events.findIndex(
      (event) =>
        event.method === 'turn.started' &&
        event.turnId === session.initialTurnId,
    );
    if (first < 0) return [];
    const turns = new Set<string>();
    for (const event of events.slice(first)) {
      if (event.method === 'turn.started') turns.add(event.turnId);
    }
    return events
      .slice(first)
      .filter((event) => (event.turnId ? turns.has(event.turnId) : false));
  }

  private stop(session: MonitorSession): void {
    if (session.deadlineTimer) clearTimeout(session.deadlineTimer);
    session.deadlineTimer = undefined;
    void this.options.interruptTurn(session.sessionId).catch(() => undefined);
  }
}
