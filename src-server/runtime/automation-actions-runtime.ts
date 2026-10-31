import type { SessionStartResult } from '@kontourai/monument';
import {
  AUTOMATION_EXECUTION_LIMITS,
  type AutomationActionIntent,
  type AutomationRule,
} from '@kontourai/station-contracts/automation';
import { UNKNOWN_CLIENT_ORIGIN } from '@kontourai/station-contracts/client-origin';
import { PROVIDER_SESSION_START_FAILED_CODE } from '@kontourai/station-contracts/provider';
import { SessionStartRefusedError } from '../providers/adapter-shape.js';
import { sourceGrantsRuleAction } from '../services/automation/automation-config-validation.js';
import {
  automationIntentMessage,
  automationPolicyFingerprint,
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
  taskGraph: Pick<TaskGraphService, 'createTaskIdempotent' | 'readTaskView'>;
  taskDispatcher: TaskDispatcher;
  orchestration: Pick<
    OrchestrationService,
    'registerTurnAdmission' | 'interruptTurn'
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
              if (
                !intent ||
                (intent.state !== 'queued' && intent.state !== 'running') ||
                !this.currentRule(intent)
              )
                return {
                  allowed: false,
                  reason: 'Automation authority changed before turn dispatch.',
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

  private currentRule(
    intent: AutomationActionIntent,
  ): AutomationRule | undefined {
    const occurredAt = Date.parse(intent.event.occurredAt);
    const now = Date.now();
    if (
      !this.enabled() ||
      !this.options.isProjectCurrent(intent.action.projectId) ||
      !Number.isFinite(occurredAt) ||
      occurredAt > now ||
      occurredAt < now - AUTOMATION_EXECUTION_LIMITS.maxEventAgeMs
    )
      return undefined;
    if (intent.taskId) {
      const task = this.options.taskGraph.readTaskView(intent.taskId);
      if (
        !task ||
        task.createdAt !== intent.taskCreatedAt ||
        task.projectId !== intent.action.projectId ||
        task.status === 'done' ||
        task.status === 'canceled'
      )
        return undefined;
    }
    const config = this.options.store.read();
    const source = config.sources.find(
      (source) => source.id === intent.sourceId,
    );
    const rule = config.rules.find((rule) => rule.id === intent.ruleId);
    if (
      !source ||
      !rule?.enabled ||
      rule.action.kind !== 'dispatch-task' ||
      !sourceGrantsRuleAction(source, rule) ||
      automationPolicyFingerprint(source, rule) !== intent.policyFingerprint ||
      automationPolicyFingerprint(source, {
        ...rule,
        action: intent.action,
      }) !== intent.policyFingerprint ||
      source.repository !== intent.event.fields.repository ||
      this.options.ledger().episode(intent.episodeKey)?.episodeId !==
        intent.episodeId
    )
      return undefined;
    return rule;
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
      if (
        intent &&
        (intent.state === 'queued' || intent.state === 'running') &&
        intent.conversationId === input.conversationId &&
        input.clientTurnId === `automation:${intent.intentId}` &&
        input.payload.message === automationIntentMessage(intent) &&
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
    if (!intent || intent.sessionId !== input.threadId)
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
        const rule = this.currentRule(intent);
        if (!rule) {
          ledger.updateIntent(
            intent.intentId,
            { state: 'refused', reason: 'policy_changed' },
            Date.now(),
          );
          continue;
        }
        const claim = ledger.claimAction({
          episodeKey: intent.episodeKey,
          expectedEpisodeId: intent.episodeId,
          deliveryKey: intent.deliveryKey,
          now: Date.now(),
          maxStartsPerHour: rule.rateLimit.maxStartsPerHour,
          maxConcurrentActions:
            AUTOMATION_EXECUTION_LIMITS.maxConcurrentActions,
        });
        if (claim.kind !== 'claimed') continue;
        await this.dispatch(intent, claim.receipt);
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
    intent: AutomationActionIntent,
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
        { taskId: task.id, taskCreatedAt: task.createdAt },
        Date.now(),
      );
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
      clientTurnId: `automation:${intent.intentId}`,
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
          reason: `inbox_${result.outcome}`,
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
    if (!intent.sessionId || !intent.taskId || intent.deadlineAt === undefined)
      return;
    let controller = this.active.get(intent.intentId);
    if (!controller) {
      controller = new AbortController();
      this.active.set(intent.intentId, controller);
    }
    this.sessionIntents.set(intent.sessionId, intent.intentId);
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
        { state: 'refused', reason: `inbox_${entry.state}` },
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
    if (
      !this.currentRule(intent) ||
      (intent.deadlineAt !== undefined && Date.now() >= intent.deadlineAt)
    ) {
      this.active.get(intent.intentId)?.abort();
      await this.options.orchestration
        .interruptTurn(sessionId)
        .catch(() => undefined);
    }
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
    if (terminal) {
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
