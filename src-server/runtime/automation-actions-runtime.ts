import type { SessionStartResult } from '@kontourai/monument';
import {
  AUTOMATION_EXECUTION_LIMITS,
  type AutomationActionIntent,
  type AutomationRevocationCause,
  type AutomationRule,
} from '@kontourai/station-contracts/automation';
import { UNKNOWN_CLIENT_ORIGIN } from '@kontourai/station-contracts/client-origin';
import { PROVIDER_SESSION_START_FAILED_CODE } from '@kontourai/station-contracts/provider';
import { SessionStartRefusedError } from '../providers/adapter-shape.js';
import {
  automationAmendmentMessage,
  automationIntentMessage,
  automationMandate,
  automationRevocationMessage,
  classifyAutomationPolicy,
} from '../services/automation/automation-intent.js';
import type { AutomationLedger } from '../services/automation/automation-ledger.js';
import type { AutomationStore } from '../services/automation/automation-store.js';
import type {
  FeaturePreviewRegistry,
  FeaturePreviewSelector,
} from '../services/feature-previews/feature-preview-registry.js';
import { LOCAL_OPERATOR_PRINCIPAL_ID } from '../services/identity/principal-resolver.js';
import { canonicalTerminalOutcome } from '../services/orchestration/canonical-terminal-outcome.js';
import type { EventBus } from '../services/orchestration/event-bus.js';
import type { EventStore } from '../services/orchestration/event-store.js';
import type { OrchestrationService } from '../services/orchestration/orchestration-service.js';
import { UNATTRIBUTED_AGENT_OWNER_ATTRIBUTION } from '../services/orchestration/session-owner-attribution.js';
import type {
  AutomationInboxPlacement,
  ThreadInboxDelivery,
  ThreadInboxPayload,
} from '../services/orchestration/thread-inbox.js';
import type { TaskDispatcher } from '../services/projects/task-dispatcher.js';
import type { TaskGraphService } from '../services/projects/task-graph-service.js';
import { MonitorTaskTurnSupervisor } from '../services/scheduling/monitor-task-supervisor.js';
import type { Logger } from '../utils/logger.js';
import { runWithUnattendedPrincipal } from './agents/unattended-principal-context.js';

interface AutomationActionsOptions {
  hosted: boolean;
  featurePreviews: FeaturePreviewRegistry;
  store: Pick<AutomationStore, 'read'>;
  /** Exact current Project id; a same-named replacement never inherits a grant. */
  isProjectCurrent: (projectId: string) => boolean;
  ledger: () => AutomationLedger;
  existingLedger: () => AutomationLedger | undefined;
  taskGraph: Pick<
    TaskGraphService,
    'createTaskIdempotent' | 'readTaskView' | 'updateTaskStatus'
  >;
  taskDispatcher: TaskDispatcher;
  orchestration: Pick<
    OrchestrationService,
    | 'registerTurnAdmission'
    | 'interruptTurn'
    | 'recordSessionBlocked'
    | 'recordAskWhereUndecided'
  >;
  eventStore: Pick<
    EventStore,
    | 'listEvents'
    | 'conversationForSession'
    | 'readProjectTaskRoomExecutionBinding'
  >;
  eventBus: EventBus;
  inbox: () => Pick<ThreadInboxDelivery, 'submit' | 'entry'> | undefined;
  logger: Logger;
}

export interface AutomationActions extends AutomationInboxPlacement {
  tick(): Promise<void>;
  close(): void;
}

/**
 * What the action's current authority allows (#4511). `revoked` names a
 * policy change; `stopped` is any other reason the action may no longer act
 * (a closed Task, a stale event, a superseded episode), which is not the
 * operator's policy and so posts no revocation notice.
 */
type ActionAuthority =
  | Readonly<{ kind: 'current'; rule: AutomationRule }>
  | Readonly<{ kind: 'revoked'; cause: AutomationRevocationCause }>
  | Readonly<{ kind: 'stopped'; reason: 'stale_event' | 'policy_changed' }>;

/** The inbox key of an action's first turn and of its amendment notices. */
function startTurnKey(intentId: string): string {
  return `automation:${intentId}`;
}
function amendmentTurnKey(intentId: string, index: number): string {
  return `automation:${intentId}:amendment:${index}`;
}

/** Automation actions have a separate operator opt-in from observe-only intake. */
export function createAutomationActionsRuntime(
  options: AutomationActionsOptions,
): AutomationActions {
  const preview = options.hosted
    ? undefined
    : options.featurePreviews.bind({
        id: 'github-automation-actions',
        label: 'GitHub automation Tasks',
        description:
          'Start bounded agent Tasks for configured GitHub rules. Can spend provider credits. Publication remains unavailable without credential-isolated execution.',
      });
  return new AutomationActionsRuntime(options, preview);
}

type NativeAutomationIntent = AutomationActionIntent & {
  action: Extract<AutomationActionIntent['action'], { kind: 'dispatch-task' }>;
};
function nativeIntent(
  intent: AutomationActionIntent | undefined,
): intent is NativeAutomationIntent {
  return intent?.action.kind === 'dispatch-task';
}

class AutomationActionsRuntime implements AutomationActions {
  private readonly supervisor: MonitorTaskTurnSupervisor;
  private readonly active = new Map<string, AbortController>();
  private readonly sessionIntents = new Map<string, string>();
  private busy = false;
  private closed = false;
  private journalObserved = false;
  private recoveryUnavailable = false;

  constructor(
    private readonly options: AutomationActionsOptions,
    private readonly preview: FeaturePreviewSelector | undefined,
  ) {
    this.supervisor = new MonitorTaskTurnSupervisor({
      eventBus: options.eventBus,
      registerTurnAdmission: (admission) =>
        options.orchestration.registerTurnAdmission((input) => {
          const id = this.sessionIntents.get(input.threadId);
          // #4511: a person's own turn (the server classifies it from the
          // authenticated client origin, never from the request body) is
          // admitted under that person's authority, even after a revocation.
          // It never runs under the rule's budget or approval posture: the
          // Session is handed over to the person.
          if (input.dispatchOrigin === 'interactive') {
            this.takeOver(input.threadId, id);
            return { allowed: true };
          }
          if (!id && (!this.journalObserved || this.recoveryUnavailable)) {
            const binding =
              options.eventStore.readProjectTaskRoomExecutionBinding(
                input.threadId,
              );
            const task = binding
              ? options.taskGraph.readTaskView(binding.taskId)
              : undefined;
            if (binding && (!task || task.createdBy === 'automation-rule'))
              return {
                allowed: false,
                reason: 'Automation recovery authority is unavailable.',
              };
          }
          if (id) {
            try {
              const intent = options.ledger().readIntent(id);
              if (intent?.personTakeoverAt)
                return {
                  allowed: false,
                  reason:
                    'A person took over this automation Session; automation turns are no longer admitted.',
                };
              if (
                !intent ||
                (intent.state !== 'queued' && intent.state !== 'running') ||
                !this.currentRule(intent)
              )
                return {
                  allowed: false,
                  reason: intent?.revocation
                    ? `${intent.revocation.message} Automation turns are no longer admitted.`
                    : 'Automation authority changed before turn dispatch.',
                };
            } catch {
              return {
                allowed: false,
                reason: 'Automation authority is unavailable.',
              };
            }
          }
          return admission(input);
        }),
      interruptTurn: (sessionId) =>
        options.orchestration.interruptTurn(sessionId),
      listEvents: (sessionId) =>
        options.eventStore.listEvents(sessionId).map((event) => event.payload),
    });
    if (!options.hosted) {
      try {
        const existing = options.existingLedger();
        if (existing) {
          this.journalObserved = true;
          for (const intent of existing.listActionIntents()) {
            if (
              !intent.sessionId ||
              !['queued', 'running', 'indeterminate'].includes(intent.state)
            )
              continue;
            this.arm(intent);
            void this.reconcile(intent, false).catch(() => {
              this.recoveryUnavailable = true;
            });
          }
        }
      } catch {
        this.recoveryUnavailable = true;
        options.logger.warn('Automation journal recovery is unavailable');
      }
    }
  }

  private enabled(): boolean {
    return (
      !this.closed &&
      this.preview?.select({ enabled: () => true, disabled: () => false }) ===
        true
    );
  }

  /**
   * The action's current authority (#4511). Only authority-bearing fields
   * count (see `automationPolicyFingerprint`), so renaming a rule or changing
   * its rate limit leaves a running action `current`. An amendment (the
   * action's instructions or budget only) is adopted here, durably, before
   * `current` is returned, so every caller acts under the newest version;
   * a running Session is told at its next turn boundary.
   */
  private authority(intent: AutomationActionIntent): ActionAuthority {
    if (!nativeIntent(intent))
      return { kind: 'stopped', reason: 'policy_changed' };
    if (!this.enabled()) return { kind: 'revoked', cause: 'preview-disabled' };
    if (!this.options.isProjectCurrent(intent.action.projectId))
      return { kind: 'revoked', cause: 'project-unavailable' };
    const occurredAt = Date.parse(intent.event.occurredAt);
    const now = Date.now();
    if (
      !Number.isFinite(occurredAt) ||
      occurredAt > now ||
      occurredAt < now - AUTOMATION_EXECUTION_LIMITS.maxEventAgeMs
    )
      return { kind: 'stopped', reason: 'stale_event' };
    if (intent.taskId) {
      const task = this.options.taskGraph.readTaskView(intent.taskId);
      if (
        !task ||
        task.createdAt !== intent.taskCreatedAt ||
        task.projectId !== intent.action.projectId ||
        task.status === 'done' ||
        task.status === 'canceled'
      )
        return { kind: 'stopped', reason: 'policy_changed' };
    }
    const config = this.options.store.read();
    const source = config.sources.find(
      (source) => source.id === intent.sourceId,
    );
    const rule = config.rules.find((rule) => rule.id === intent.ruleId);
    // Only a `live` rule may act; one switched to `observe` or `off` (or
    // deleted, or moved to another action kind) revokes what it left.
    const classified = classifyAutomationPolicy(intent, source, rule);
    if (classified.kind === 'revoked') return classified;
    if (
      this.options.ledger().episode(intent.episodeKey)?.episodeId !==
      intent.episodeId
    )
      return { kind: 'stopped', reason: 'policy_changed' };
    if (classified.kind === 'amended') {
      const amended = this.options.ledger().amendIntent(
        intent.intentId,
        {
          action: classified.action,
          policyFingerprint: classified.policyFingerprint,
          changed: classified.changed,
        },
        Date.now(),
      );
      this.adoptAmendment(amended, intent.action.budget.maxWallRuntimeMs);
    }
    return { kind: 'current', rule: classified.rule };
  }

  private currentRule(
    intent: AutomationActionIntent,
  ): AutomationRule | undefined {
    const authority = this.authority(intent);
    return authority.kind === 'current' ? authority.rule : undefined;
  }

  /**
   * #4511: an adopted amendment applies to the running action now. The
   * budget supervisor takes the new limits, and a Session that has started
   * is sent the new text as its next turn (an internal, automation-origin
   * entry the placement check below recognizes), so it continues under the
   * new version rather than being stopped.
   */
  private adoptAmendment(
    intent: AutomationActionIntent,
    previousWallRuntimeMs: number,
  ): void {
    if (!nativeIntent(intent) || intent.personTakeoverAt) return;
    const latest = intent.amendments?.at(-1);
    if (!latest) return;
    if (intent.deadlineAt !== undefined) {
      const deadlineAt =
        intent.deadlineAt -
        previousWallRuntimeMs +
        intent.action.budget.maxWallRuntimeMs;
      if (deadlineAt !== intent.deadlineAt && deadlineAt > intent.createdAt)
        this.options
          .ledger()
          .updateIntent(intent.intentId, { deadlineAt }, Date.now());
    }
    const current = this.options.ledger().readIntent(intent.intentId) ?? intent;
    if (current.sessionId && current.deadlineAt !== undefined)
      this.supervisor.update(current.sessionId, {
        deadlineAt: current.deadlineAt,
        limits: {
          maxTurns: intent.action.budget.maxTurns,
          maxTokens: intent.action.budget.maxTokens,
        },
      });
    if (
      current.conversationId &&
      (current.state === 'queued' || current.state === 'running')
    )
      this.submitAmendment(current);
  }

  private submitAmendment(intent: AutomationActionIntent): void {
    const index = intent.amendments?.length ?? 0;
    if (!intent.conversationId || !intent.mandate || index === 0) return;
    this.options.inbox()?.submit({
      conversationId: intent.conversationId,
      clientTurnId: amendmentTurnKey(intent.intentId, index),
      payload: {
        message: this.amendmentNotice(intent),
        serverAutomationIntentId: intent.intentId,
        actor: {
          userId: LOCAL_OPERATOR_PRINCIPAL_ID,
          ownerAttribution: UNATTRIBUTED_AGENT_OWNER_ATTRIBUTION,
        },
        clientOrigin: { ...UNKNOWN_CLIENT_ORIGIN, actor: { kind: 'internal' } },
      },
    });
  }

  private amendmentNotice(intent: AutomationActionIntent): string {
    const latest = intent.amendments?.at(-1);
    return automationAmendmentMessage(
      intent.mandate?.ruleName ?? intent.ruleId,
      intent.action,
      latest?.changed ?? [],
    );
  }

  /**
   * #4511: a person sent a turn into this Session. It becomes theirs: the
   * action's budget no longer supervises it, the rule's approval posture is
   * not inherited (Ask is recorded unless someone already chose a mode), and
   * no automation turn is admitted into it again. Recorded durably so a
   * restart keeps the hand-over.
   */
  private takeOver(sessionId: string, intentId: string | undefined): void {
    try {
      const ledger = this.options.existingLedger();
      let intent = intentId ? ledger?.readIntent(intentId) : undefined;
      if (!intent && ledger) {
        const binding =
          this.options.eventStore.readProjectTaskRoomExecutionBinding(
            sessionId,
          );
        const task = binding
          ? this.options.taskGraph.readTaskView(binding.taskId)
          : undefined;
        const candidate =
          binding && task?.createdBy === 'automation-rule'
            ? ledger.intentForTask(binding.taskId)
            : undefined;
        if (candidate?.sessionId === sessionId) intent = candidate;
      }
      if (!intent || !nativeIntent(intent)) return;
      if (!intent.personTakeoverAt)
        ledger?.updateIntent(
          intent.intentId,
          { personTakeoverAt: new Date().toISOString() },
          Date.now(),
        );
      this.supervisor.abandon(sessionId);
      if (intent.action.approvalMode === 'auto')
        this.options.orchestration.recordAskWhereUndecided(sessionId);
    } catch (error) {
      // The person's turn is admitted either way; it never ran under the
      // unattended principal, whose grants exist only inside the action's
      // own placement.
      this.options.logger.warn('Automation hand-over was not recorded', {
        error: error instanceof Error ? error.message : 'unknown',
      });
    }
  }

  /**
   * #4511: a revocation stops automatic work and says why, once: the
   * Session is marked blocked with the reason (so it shows in Needs you),
   * the Task moves to `blocked`, and the reason is kept on the intent for
   * the Task's "Started by automation" block.
   */
  private async recordRevocation(
    intent: AutomationActionIntent,
    cause: AutomationRevocationCause,
  ): Promise<void> {
    if (intent.revocation || intent.personTakeoverAt) return;
    const message = automationRevocationMessage(
      cause,
      intent.mandate?.ruleName ?? intent.ruleId,
    );
    this.options.ledger().updateIntent(
      intent.intentId,
      {
        revocation: { at: new Date().toISOString(), cause, message },
        reason: 'policy_changed',
      },
      Date.now(),
    );
    if (intent.sessionId)
      try {
        this.options.orchestration.recordSessionBlocked({
          threadId: intent.sessionId,
          message,
        });
      } catch {
        /* The Task and intent still carry the reason. */
      }
    if (intent.taskId)
      try {
        const task = this.options.taskGraph.readTaskView(intent.taskId);
        if (
          task &&
          task.createdAt === intent.taskCreatedAt &&
          task.status !== 'blocked' &&
          task.status !== 'done' &&
          task.status !== 'canceled'
        )
          await this.options.taskGraph.updateTaskStatus(
            intent.taskId,
            'blocked',
          );
      } catch (error) {
        this.options.logger.warn('Automation Task could not be blocked', {
          intentId: intent.intentId,
          error: error instanceof Error ? error.message : 'unknown',
        });
      }
  }

  placementRefusal(input: {
    conversationId: string;
    clientTurnId: string;
    payload: ThreadInboxPayload;
  }) {
    if (!input.payload.serverAutomationIntentId) return undefined;
    try {
      const intent = this.options
        .ledger()
        .readIntent(input.payload.serverAutomationIntentId);
      const amendmentIndex = intent?.amendments?.length ?? 0;
      const expectedMessage = !intent
        ? undefined
        : input.clientTurnId === startTurnKey(intent.intentId)
          ? automationIntentMessage(intent)
          : amendmentIndex > 0 &&
              input.clientTurnId ===
                amendmentTurnKey(intent.intentId, amendmentIndex)
            ? this.amendmentNotice(intent)
            : undefined;
      if (
        intent &&
        !intent.personTakeoverAt &&
        (intent.state === 'queued' || intent.state === 'running') &&
        intent.conversationId === input.conversationId &&
        expectedMessage !== undefined &&
        input.payload.message === expectedMessage &&
        input.payload.actor.userId === LOCAL_OPERATOR_PRINCIPAL_ID &&
        input.payload.actor.ownerAttribution ===
          UNATTRIBUTED_AGENT_OWNER_ATTRIBUTION &&
        input.payload.clientOrigin?.actor.kind === 'internal' &&
        this.currentRule(intent) &&
        intent.deadlineAt !== undefined &&
        Date.now() < intent.deadlineAt &&
        this.options.ledger().episode(intent.episodeKey) !== undefined
      )
        return undefined;
    } catch {
      /* Refuse an unavailable policy or retained intent. */
    }
    return {
      reasonCode: 'automation_policy_unavailable',
      reason:
        'Automation authority changed or is unavailable. Nothing was sent.',
    };
  }

  async runPlacement(
    input: {
      conversationId: string;
      threadId: string;
      clientTurnId: string;
      payload: ThreadInboxPayload;
    },
    start: () => Promise<SessionStartResult>,
  ): Promise<SessionStartResult> {
    const refusal = this.placementRefusal(input);
    if (refusal) throw new Error(refusal.reason);
    const intentId = input.payload.serverAutomationIntentId;
    if (!intentId) throw new Error('Automation intent is missing.');
    const intent = this.options.ledger().readIntent(intentId);
    if (!nativeIntent(intent) || intent.sessionId !== input.threadId)
      throw new Error('Automation execution binding changed.');
    this.arm(intent);
    const result = await runWithUnattendedPrincipal(
      { kind: 'automation-rule', ruleId: intent.ruleId },
      intent.intentId,
      start,
    );
    if (result.outcome === 'started')
      this.options
        .ledger()
        .updateIntent(
          intent.intentId,
          { state: 'running', turnId: result.turnId },
          Date.now(),
        );
    else
      this.options
        .ledger()
        .updateIntent(
          intent.intentId,
          { state: 'indeterminate', reason: 'turn_start_unconfirmed' },
          Date.now(),
        );
    return result;
  }

  async tick(): Promise<void> {
    if (this.busy || this.closed || this.options.hosted) return;
    if (!this.enabled() && this.active.size === 0) return;
    this.busy = true;
    try {
      const ledger = this.options.ledger();
      const intents = ledger.listActionIntents();
      this.journalObserved = true;
      this.recoveryUnavailable = false;
      for (const intent of intents) {
        if (!nativeIntent(intent)) continue;
        if (
          intent.state === 'queued' ||
          intent.state === 'running' ||
          (intent.state === 'indeterminate' && intent.sessionId)
        ) {
          this.arm(intent);
          await this.reconcile(intent);
          continue;
        }
        if (intent.state !== 'pending' || !this.enabled()) continue;
        const authority = this.authority(intent);
        if (authority.kind !== 'current') {
          ledger.updateIntent(
            intent.intentId,
            {
              state: 'refused',
              reason:
                authority.kind === 'stopped'
                  ? authority.reason
                  : 'policy_changed',
            },
            Date.now(),
          );
          continue;
        }
        const rule = authority.rule;
        // #4513: a held claim records why; only a claim starts work.
        const receipt = ledger.claimIntent(intent, {
          now: Date.now(),
          maxStartsPerHour: rule.rateLimit.maxStartsPerHour,
        });
        if (!receipt) continue;
        await this.dispatch(
          ledger.readIntent(intent.intentId) as NativeAutomationIntent,
          receipt,
        );
      }
    } catch (error) {
      this.recoveryUnavailable = true;
      this.options.logger.warn('Automation actions are unavailable', {
        error: error instanceof Error ? error.message : 'unknown',
      });
    } finally {
      this.busy = false;
    }
  }

  private async dispatch(
    intent: NativeAutomationIntent,
    claim: import('../services/automation/automation-ledger.js').AutomationActionReceipt,
  ): Promise<void> {
    const ledger = this.options.ledger();
    let invoked = false;
    try {
      const rule = this.currentRule(intent);
      if (!rule || !this.options.inbox()) {
        claim.release();
        return;
      }
      // An amendment adopted just now is the version this Task starts under.
      intent = (ledger.readIntent(intent.intentId) ??
        intent) as NativeAutomationIntent;
      const task = await this.options.taskGraph.createTaskIdempotent(
        {
          projectId: intent.action.projectId,
          title: `Automation: ${rule.name}`,
          description: automationIntentMessage(intent),
          agentId: intent.action.agentId,
          createdBy: 'automation-rule',
        },
        'automation-rule',
        intent.intentId,
      );
      ledger.updateIntent(
        intent.intentId,
        {
          taskId: task.id,
          taskCreatedAt: task.createdAt,
          // Captured once: a capacity-deferred retry reuses its Task and
          // keeps the mandate it was first created under.
          ...(intent.mandate
            ? {}
            : { mandate: automationMandate(intent, rule.name) }),
        },
        Date.now(),
      );
      intent = (ledger.readIntent(intent.intentId) ??
        intent) as NativeAutomationIntent;
      if (!this.currentRule(intent)) {
        claim.release();
        return;
      }
      const deadlineAt = Date.now() + intent.action.budget.maxWallRuntimeMs;
      ledger.updateIntent(intent.intentId, { deadlineAt }, Date.now());
      const controller = new AbortController();
      this.active.set(intent.intentId, controller);
      const outcome = await runWithUnattendedPrincipal(
        { kind: 'automation-rule', ruleId: intent.ruleId },
        intent.intentId,
        () =>
          this.options.taskDispatcher.dispatch(task.id, {
            agentId: intent.action.agentId,
            fullAccessGrant: null,
            ownerUserId: LOCAL_OPERATOR_PRINCIPAL_ID,
            ownerAttribution: UNATTRIBUTED_AGENT_OWNER_ATTRIBUTION,
            sourceSurface: 'automation-rule',
            signal: controller.signal,
            runtimeConfig: {
              modelOptions: {
                approvalMode: intent.action.approvalMode ?? 'ask',
              },
            },
            monitor: {
              agentId: intent.action.agentId,
              signal: controller.signal,
              deadlineAt,
              maxCompletedTurns: intent.action.budget.maxTurns,
              maxTokens: intent.action.budget.maxTokens,
              beforeProviderStart: (sessionId) => {
                if (
                  !this.currentRule(
                    ledger.readIntent(intent.intentId) ?? intent,
                  ) ||
                  controller.signal.aborted ||
                  ledger.readIntent(intent.intentId)?.sessionId !== sessionId ||
                  invoked ||
                  claim.beginInvocation(Date.now()) !== 'applied'
                )
                  throw new SessionStartRefusedError(
                    'Automation provider admission changed before start.',
                    PROVIDER_SESSION_START_FAILED_CODE,
                  );
                invoked = true;
              },
              onSessionReserved: ({ sessionId }) => {
                ledger.updateIntent(intent.intentId, { sessionId }, Date.now());
                const retained = ledger.readIntent(intent.intentId);
                if (retained) this.arm(retained);
              },
              onSessionAbandoned: (sessionId) => {
                this.supervisor.abandon(sessionId);
                this.sessionIntents.delete(sessionId);
              },
            },
          }),
      );
      if (outcome.kind !== 'dispatched') {
        this.options.logger.warn('Automation Task dispatch did not start', {
          intentId: intent.intentId,
          outcome: outcome.kind,
          reason: outcome.reason,
        });
        const uncertain = outcome.kind === 'indeterminate';
        const deferred =
          !invoked &&
          (outcome.kind === 'unavailable' ||
            outcome.kind === 'aborted' ||
            outcome.kind === 'contended');
        if (!invoked) claim.release();
        ledger.updateIntent(
          intent.intentId,
          {
            state: uncertain
              ? 'indeterminate'
              : deferred
                ? 'pending'
                : 'failed',
            reason: `dispatch_${outcome.kind}`,
            ...(!invoked && !uncertain
              ? {
                  sessionId: undefined,
                  conversationId: undefined,
                  turnId: undefined,
                }
              : {}),
          },
          Date.now(),
        );
        if (invoked)
          claim.settle({
            state: uncertain ? 'indeterminate' : 'failed',
            now: Date.now(),
            taskId: task.id,
          });
        if (!uncertain) this.releaseKnown(intent.intentId);
        return;
      }
      if (!invoked) {
        claim.release();
        ledger.updateIntent(
          intent.intentId,
          { state: 'indeterminate', reason: 'provider_start_boundary_missing' },
          Date.now(),
        );
        controller.abort();
        return;
      }
      const sessionId = outcome.result.session.threadId;
      const conversationId =
        this.options.eventStore.conversationForSession(
          sessionId,
        )?.conversationId;
      if (!conversationId)
        throw new Error('Automation conversation lineage is unavailable.');
      ledger.updateIntent(
        intent.intentId,
        { state: 'queued', sessionId, conversationId },
        Date.now(),
      );
      claim.settle({
        state: 'completed',
        now: Date.now(),
        taskId: task.id,
        sessionId,
      });
      const retained = ledger.readIntent(intent.intentId);
      if (retained) this.submit(retained);
    } catch (error) {
      if (!invoked) {
        claim.release();
        this.releaseKnown(intent.intentId);
        throw error;
      }
      ledger.updateIntent(
        intent.intentId,
        { state: 'indeterminate', reason: 'dispatch_response_unknown' },
        Date.now(),
      );
      claim.settle({
        state: 'indeterminate',
        now: Date.now(),
        ...(intent.taskId ? { taskId: intent.taskId } : {}),
      });
      this.active.get(intent.intentId)?.abort();
      this.options.logger.warn(
        'Automation dispatch is indeterminate; it will not be replayed',
        { intentId: intent.intentId },
      );
    }
  }

  private submit(intent: AutomationActionIntent): void {
    if (!intent.conversationId) return;
    const result = this.options.inbox()?.submit({
      conversationId: intent.conversationId,
      clientTurnId: startTurnKey(intent.intentId),
      payload: {
        message: automationIntentMessage(intent),
        serverAutomationIntentId: intent.intentId,
        actor: {
          userId: LOCAL_OPERATOR_PRINCIPAL_ID,
          ownerAttribution: UNATTRIBUTED_AGENT_OWNER_ATTRIBUTION,
        },
        clientOrigin: { ...UNKNOWN_CLIENT_ORIGIN, actor: { kind: 'internal' } },
      },
    });
    if (!result || result.outcome === 'capacity') return;
    if (result.outcome !== 'queued') {
      this.options.ledger().updateIntent(
        intent.intentId,
        {
          state: result.outcome === 'conflict' ? 'indeterminate' : 'refused',
          reason: intent.revocation
            ? 'policy_changed'
            : `inbox_${result.outcome}`,
        },
        Date.now(),
      );
      if (result.outcome !== 'conflict') this.releaseKnown(intent.intentId);
    }
  }

  private releaseKnown(intentId: string): void {
    this.supervisor.release(intentId);
    this.active.delete(intentId);
    for (const [sessionId, owner] of this.sessionIntents)
      if (owner === intentId) this.sessionIntents.delete(sessionId);
  }

  private arm(intent: AutomationActionIntent): void {
    if (!nativeIntent(intent)) return;
    if (!intent.sessionId || !intent.taskId || intent.deadlineAt === undefined)
      return;
    let controller = this.active.get(intent.intentId);
    if (!controller) {
      controller = new AbortController();
      this.active.set(intent.intentId, controller);
    }
    this.sessionIntents.set(intent.sessionId, intent.intentId);
    // #4511: a Session a person took over is theirs; no action budget applies.
    if (intent.personTakeoverAt) return;
    this.supervisor.arm({
      triggerId: intent.intentId,
      taskId: intent.taskId,
      sessionId: intent.sessionId,
      deadlineAt: intent.deadlineAt,
      limits: {
        maxTurns: intent.action.budget.maxTurns,
        maxTokens: intent.action.budget.maxTokens,
      },
      signal: controller.signal,
      ...(intent.turnId ? { initialTurnId: intent.turnId } : {}),
      onInitialTurnStarted: ({ turnId }) =>
        this.options
          .ledger()
          .updateIntent(intent.intentId, { turnId }, Date.now()),
    });
  }

  private async reconcile(
    intent: AutomationActionIntent,
    allowPlacement = true,
  ): Promise<void> {
    const ledger = this.options.ledger();
    intent = ledger.readIntent(intent.intentId) ?? intent;
    if (!nativeIntent(intent)) return;
    const sessionId = intent.sessionId;
    if (!sessionId) return;
    const entry = intent.conversationId
      ? this.options
          .inbox()
          ?.entry(intent.conversationId, `automation:${intent.intentId}`)
      : undefined;
    if (entry?.state === 'refused' || entry?.state === 'cancelled') {
      ledger.updateIntent(
        intent.intentId,
        {
          state: 'refused',
          reason: intent.revocation ? 'policy_changed' : `inbox_${entry.state}`,
        },
        Date.now(),
      );
      this.releaseKnown(intent.intentId);
      return;
    }
    if (
      entry?.state === 'sent' &&
      entry.turnId &&
      entry.sessionId === intent.sessionId
    ) {
      ledger.updateIntent(
        intent.intentId,
        { state: 'running', turnId: entry.turnId },
        Date.now(),
      );
      intent = ledger.readIntent(intent.intentId) ?? intent;
    }
    // A Session a person took over is theirs: nothing here may interrupt
    // their turn, whatever happens to the rule afterwards.
    const authority = intent.personTakeoverAt
      ? undefined
      : this.authority(intent);
    const deadlinePassed =
      intent.deadlineAt !== undefined && Date.now() >= intent.deadlineAt;
    if (authority && (authority.kind !== 'current' || deadlinePassed)) {
      this.active.get(intent.intentId)?.abort();
      await this.options.orchestration
        .interruptTurn(sessionId)
        .catch(() => undefined);
      if (authority.kind === 'revoked')
        await this.recordRevocation(
          ledger.readIntent(intent.intentId) ?? intent,
          authority.cause,
        );
    }
    intent = ledger.readIntent(intent.intentId) ?? intent;
    // An amendment notice is the action's next turn: once the turn before it
    // ends, follow the notice's turn instead of completing the action.
    const amendments = intent.amendments?.length ?? 0;
    const notice =
      amendments > 0 && intent.conversationId && !intent.personTakeoverAt
        ? this.options
            .inbox()
            ?.entry(
              intent.conversationId,
              amendmentTurnKey(intent.intentId, amendments),
            )
        : undefined;
    if (
      notice?.state === 'sent' &&
      notice.turnId &&
      notice.sessionId === intent.sessionId &&
      notice.turnId !== intent.turnId
    ) {
      ledger.updateIntent(
        intent.intentId,
        { state: 'running', turnId: notice.turnId },
        Date.now(),
      );
      intent = ledger.readIntent(intent.intentId) ?? intent;
    }
    const noticePending =
      !deadlinePassed &&
      authority?.kind === 'current' &&
      (notice?.state === 'queued' || notice?.state === 'sending');
    const events = this.options.eventStore
      .listEvents(sessionId)
      .map((event) => event.payload);
    const terminal = intent.turnId
      ? [...events]
          .reverse()
          .find(
            (event) =>
              event.turnId === intent.turnId &&
              canonicalTerminalOutcome(event) !== undefined,
          )
      : undefined;
    if (terminal && !noticePending) {
      ledger.updateIntent(
        intent.intentId,
        {
          state:
            terminal.method === 'turn.completed' &&
            terminal.finishReason !== 'cancelled'
              ? 'completed'
              : 'failed',
        },
        Date.now(),
      );
      this.releaseKnown(intent.intentId);
      return;
    }
    if (allowPlacement && intent.state === 'queued') this.submit(intent);
  }

  close(): void {
    this.closed = true;
    for (const controller of this.active.values()) controller.abort();
    this.active.clear();
    this.sessionIntents.clear();
    this.supervisor.close();
  }
}
