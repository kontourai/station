import { ACPStatus } from '@kontourai/station-contracts/acp';
import { getNotificationProviders } from '../../providers/registries/registry.js';
import { runtimeAgentKey } from '../../routes/agents/runtime-agent-identity.js';
import { getCachedUser } from '../../routes/system/auth.js';
import { readBootHistory } from '../../routes/system/boot-history.js';
import {
  ApprovalInboxNotificationProvider,
  wireApprovalInboxNotifications,
} from '../../services/approvals/approval-inbox.js';
import type { FlowRunService } from '../../services/flow/flow-run-service.js';
import { createEnvironmentRuntimeResourcePostureProbe } from '../../services/infra/resource-posture.js';
import { createServerLogReader } from '../../services/infra/server-log-reader.js';
import { NotificationService } from '../../services/notifications/notification-service.js';
import { VapidKeyService } from '../../services/notifications/vapid-key-service.js';
import { wireWebPushDelivery } from '../../services/notifications/web-push-delivery.js';
import { WebPushService } from '../../services/notifications/web-push-service.js';
import { FileConversationAcknowledgementStore } from '../../services/orchestration/conversation-acknowledgement-store.js';
import {
  wireInternalStopRedispatchFailureNotifications,
  wireTurnCompletionNotifications,
} from '../../services/orchestration/turn-completion-notifications.js';
import { AttentionProjectionService } from '../../services/projects/attention-projection.js';
import type { ScheduledTurnAdapter } from '../../services/scheduling/builtin-scheduler.js';
import { MonitorTaskTurnSupervisor } from '../../services/scheduling/monitor-task-supervisor.js';
import { SchedulerService } from '../../services/scheduling/scheduler-service.js';
import { DevicePairingNotificationProvider } from '../../services/ssh/device-pairing-notifications.js';
import { isExternalEngineBoundAgent } from '../agents/agent-engine-classification.js';
import { runWithScheduledPrincipal } from '../agents/scheduled-principal-context.js';
import { isHostedTenantExecutionRequired } from '../bootstrap/runtime-tenant-context.js';
import {
  createStationEngineAvailabilityReader,
  resolveManagedChatBinding,
} from '../plugins/runtime-provider-resolution.js';
import type { ConfigureRuntimeRoutesContext } from './runtime-routes.js';

const WEB_PUSH_FALLBACK_SUBJECT = 'mailto:push@station.local';

/**
 * The one production Adapter from a scheduler receipt to a runtime agent.
 * The scheduler owns its opaque job/run identity; this Adapter carries it in
 * the runtime's private invocation context rather than accepting caller
 * supplied unattended authority.
 */
export function createScheduledTurnAdapter(
  activeAgents: ReadonlyMap<
    string,
    {
      generateText(
        prompt: string,
        options?: unknown,
      ): Promise<{ text?: string }>;
    }
  >,
): ScheduledTurnAdapter {
  return {
    invoke: async ({ agentSlug, prompt, principal, signal }) => {
      if (signal.aborted) {
        return {
          kind: 'definitely-not-invoked' as const,
          error: 'Scheduler invocation was cancelled before dispatch',
        };
      }
      const resolvedSlug = runtimeAgentKey(agentSlug);
      const agent = activeAgents.get(resolvedSlug);
      if (!agent) {
        return {
          kind: 'definitely-not-invoked' as const,
          error: `Agent '${resolvedSlug}' not found`,
        };
      }
      try {
        const result = await runWithScheduledPrincipal(
          { kind: 'scheduled-job', jobId: principal.jobId },
          principal.runId,
          () => agent.generateText(prompt, { signal }),
        );
        return { kind: 'completed' as const, output: result.text ?? '' };
      } catch (error) {
        return {
          kind: 'indeterminate' as const,
          error:
            error instanceof Error ? error.message : 'Scheduler agent failed',
        };
      }
    },
  };
}

/**
 * VAPID subject: the RFC 8292 contact the push service can reach if it needs
 * to reach Station's operator about abuse. An https origin is preferred when
 * one is configured (the same ALLOWED_ORIGINS remote/tailnet origin used for
 * runtime CORS); otherwise a mailto fallback, which every push service also
 * accepts. NOT_VERIFIED: acceptance of the mailto fallback by every provider
 * is unconfirmed — revisit if a provider rejects it.
 */
function resolveWebPushSubject(): string {
  const httpsOrigin = (process.env.ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .find((origin) => origin.startsWith('https://'));
  return httpsOrigin ?? WEB_PUSH_FALLBACK_SUBJECT;
}

export function createRuntimeSystemRouteDeps(
  context: ConfigureRuntimeRoutesContext,
) {
  return {
    getBootHistory: () =>
      readBootHistory(
        createServerLogReader({
          directory: `${context.configLoader.getProjectHomeDir()}/logs/server`,
        }),
        Number(process.env.STATION_PROCESS_STARTED_AT ?? Date.now()),
      ),
    getACPStatus: () => {
      const status = context.acpBridge.getStatus();
      return {
        connected: status.connections.some(
          (connection: any) => connection.status === ACPStatus.AVAILABLE,
        ),
        connections: status.connections,
      };
    },
    listProviderConnections: () => {
      // Review H1: one derivation. `ConnectionService` owns the bound check
      // receipts, and chat readiness / the setup recommendation read them
      // here rather than each re-deriving an optimistic answer.
      const gated = context.connectionService.checkGatedModelConnectionIds();
      return context.providerService
        .listProviderConnections()
        .map((connection) => ({
          id: connection.id,
          type: connection.type,
          enabled: connection.enabled,
          capabilities: connection.capabilities,
          ...(gated.has(connection.id) ? { checkGated: true } : {}),
        }));
    },
    isManagedChatReady: () => context.activeAgents.has('default'),
    // Delta review H2: WHICH connection the managed engine would select for
    // the default agent, using the selection resolver itself rather than a
    // second guess.
    //
    // Delta2 review H2: through `getLiveAppConfig()`, not `context.appConfig`.
    // That field is the route-construction snapshot; changing the default
    // model connection replaces the runtime's own `appConfig` and rebuilds the
    // default agent, and status has to follow the agent that now exists rather
    // than keep answering for the one that booted.
    resolveManagedChatBinding: () =>
      resolveManagedChatBinding(
        { execution: context.agentMetadataMap.get('default')?.execution },
        {
          appConfig: context.getLiveAppConfig(),
          listProviderConnections: () =>
            context.providerService.listProviderConnections(),
        },
      ),
    checkOllamaAvailability: context.checkOllamaAvailability,
    // Also live: `defaultModel` and `region` are settings a user can change
    // while Station runs, and a status route reporting the boot-time values
    // would contradict the runtime that has already adopted the new ones.
    getAppConfig: () => context.getLiveAppConfig(),
    // station#3677 review MED 4: the runtime's own consent availability for
    // the `/api/system/instance` self-report — live, so a listener that
    // failed to bind reads unavailable no matter what answers its port.
    getConsentAvailability: () => {
      const state = context.consentChannel.state();
      return state.status === 'listening'
        ? { status: 'listening' as const, port: state.port }
        : { status: 'unavailable' as const };
    },
    // Live, not the boot-time `context.appConfig` snapshot — and deliberately
    // the SAME call `enriched-agents.ts` uses to decide whether to manufacture
    // a selectable agent, so chat readiness and agent availability cannot
    // disagree (station#1194).
    listEngineConnectionStates: () =>
      context.connectionService.listEngineConnectionStates(),
    eventBus: context.eventBus,
    appConfig: context.appConfig,
    port: context.port,
    host: context.host,
    publicOrigins: (process.env.ALLOWED_ORIGINS ?? '')
      .split(',')
      .map((origin) => origin.trim())
      .filter(Boolean),
    skillService: context.skillService,
    resourcePosture:
      context.resourcePosture ?? createEnvironmentRuntimeResourcePostureProbe(),
    // #1244: the terminal surface's live PTY capability, so a Station whose
    // node-pty never built reports a specific degraded reason on the same
    // readiness record that carries chat/runtime/acp.
    probeTerminalCapability: () => context.terminalService.probeCapability(),
  };
}

/**
 * Ceiling on how long a setup-requirement observation is reused across
 * `/api/attention` reads. The inbox polls every 10s, and each read costs an
 * agent-directory listing plus a spec read for every candidate up to the first
 * Station-engine one — N spec reads, not one, since an external-engine binding
 * is only visible in the spec — plus the provider-connection list. The
 * projection bounds `readSessionFlowRun` the same way and for the same reason.
 * Short enough that configuring a connection clears the item within one poll.
 */
const STATION_SETUP_REQUIREMENT_CACHE_TTL_MS = 5_000;

/**
 * Reuses a setup-requirement observation for {@link
 * STATION_SETUP_REQUIREMENT_CACHE_TTL_MS}. Concurrent reads share one
 * in-flight read rather than each starting their own.
 */
export function memoizeStationSetupRequirement<T>(
  read: () => Promise<T>,
  ttlMs: number = STATION_SETUP_REQUIREMENT_CACHE_TTL_MS,
  now: () => number = Date.now,
): () => Promise<T> {
  let cached: { at: number; value: Promise<T> } | undefined;
  return () => {
    const observedAt = now();
    if (cached && observedAt - cached.at < ttlMs) return cached.value;
    const value = read();
    cached = { at: observedAt, value };
    // A read that rejected must not be cached as an answer.
    void value.catch(() => {
      if (cached?.value === value) cached = undefined;
    });
    return value;
  };
}

/**
 * #1536 D8: the one thing standing between this Station and a working chat on
 * its own engine, or `null` when nothing is.
 *
 * `createStationEngineAvailabilityReader` is the authority — the same function
 * with the same inputs the agents route reads for
 * `available: false`/`unavailableReason` — so the attention item's body is the
 * picker's sentence rather than a second wording of the same requirement, and
 * the two cannot disagree about which app config they read. An agent
 * bound to an EXTERNAL engine has no managed-model concept, so it is skipped:
 * asking a model-resolution probe about Claude Code reports a working Agent as
 * broken (the `deriveAgentCatalog` lesson).
 */
export async function readStationSetupRequirement(
  context: ConfigureRuntimeRoutesContext,
): Promise<{ agentSlug: string; agentName: string; reason: string } | null> {
  try {
    const agents = await context.agentService.listAgents();
    // Review L4: the subject has to be DETERMINISTIC — the item's id embeds
    // this slug, and its first-observed timestamp is keyed by it, so a subject
    // that varied with store order would re-mint the row. And taking
    // `agents[0]` unconditionally silenced the notice whenever the agent that
    // happened to sort first was external-engine bound, even with a blocked
    // Station-engine agent right behind it. Station's own Agent first; then the
    // first Station-engine candidate by slug.
    const candidates = [...agents].sort((left, right) =>
      left.slug.localeCompare(right.slug),
    );
    const station = candidates.find((agent) => agent.slug === 'station');
    const readAvailability = createStationEngineAvailabilityReader(context);
    const ordered = station
      ? [station, ...candidates.filter((agent) => agent.slug !== 'station')]
      : candidates;
    for (const metadata of ordered) {
      const spec = await context.agentService.getAgent(metadata.slug);
      if (isExternalEngineBoundAgent(spec)) continue;
      const reason = readAvailability(spec);
      if (!reason) return null;
      return {
        agentSlug: metadata.slug,
        agentName: metadata.name ?? spec.name ?? metadata.slug,
        reason,
      };
    }
    return null;
  } catch (error) {
    // A read that could not answer is not a claim that setup is incomplete.
    context.logger.warn('Station setup requirement probe failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

export function configureRuntimeSupportServices(
  context: ConfigureRuntimeRoutesContext,
  flowRunService: Pick<FlowRunService, 'getRunConsole'>,
  options: { webPushEnabled?: boolean } = {},
) {
  // The hosted registry is immutable deployment configuration. Until pairing
  // records have durable tenant ownership, Web Push delivery is off by
  // default there; callers can inject the same resolved boolean when they
  // compose the public Push routes.
  const webPushEnabled =
    options.webPushEnabled ?? !isHostedTenantExecutionRequired();
  const notificationService = new NotificationService(
    context.eventBus,
    context.configLoader.getProjectHomeDir(),
    60_000,
    {
      onAsyncDispatchError: (operation, error) =>
        context.logger.warn('Notification async adapter failed', {
          operation,
          error: error instanceof Error ? error.message : String(error),
        }),
    },
  );
  const approvalInboxProvider = new ApprovalInboxNotificationProvider({
    approvalRegistry: context.approvalRegistry,
    orchestrationService: context.orchestrationService,
  });
  notificationService.addProvider(approvalInboxProvider);
  // An inbound pairing request used to surface only inside the Connections
  // modal, so a device could sit waiting with nothing telling the operator.
  // Shared with the attention projection below (#765 D5): same source, so
  // the activity notification and the needs-attention item cannot disagree
  // about which requests exist.
  const resolveDevicePairing = () => {
    try {
      return context.environmentSecurityService.devicePairing;
    } catch {
      // Environment not initialised yet; nothing is pending by definition.
      return null;
    }
  };
  notificationService.addProvider(
    new DevicePairingNotificationProvider(resolveDevicePairing),
  );
  for (const { provider } of getNotificationProviders()) {
    notificationService.addProvider(provider);
  }
  wireApprovalInboxNotifications(
    context.eventBus,
    approvalInboxProvider,
    notificationService,
    context.logger,
  );
  // station#1225 (offline slice 3): push-on-completion — schedules a
  // notification (and, via the existing `wireWebPushDelivery` fan-out
  // below, a Web Push send) when a turn completes/fails for a session
  // whose owning user has no live `/events` stream open.
  // `context.orchestrationStreamPresence` is the SAME instance
  // `createOrchestrationRoutes` registers connect/disconnect against
  // (`runtime-routes.ts`), so this always observes real connection state.
  wireTurnCompletionNotifications(
    context.eventBus,
    context.orchestrationService,
    context.orchestrationStreamPresence,
    notificationService,
    context.logger,
  );
  // station#3525 fix round FIX 1: the corrective half — see that function's
  // own docblock. Must be wired alongside `wireTurnCompletionNotifications`
  // or a credential-profile restart that itself fails leaves its stopped
  // turn's "needs attention" push silently swallowed with nothing to
  // deliver it.
  wireInternalStopRedispatchFailureNotifications(
    context.eventBus,
    context.orchestrationService,
    context.orchestrationStreamPresence,
    notificationService,
    context.logger,
  );
  notificationService.dispatch('service-start', () =>
    notificationService.start(),
  );
  const monitorTurns = new MonitorTaskTurnSupervisor({
    eventBus: context.eventBus,
    registerTurnAdmission: (admission) =>
      context.orchestrationService.registerTurnAdmission(admission),
    interruptTurn: (sessionId) =>
      context.orchestrationService.interruptTurn(sessionId),
    listEvents: (sessionId) =>
      (context.orchestrationEventStore?.listEvents(sessionId) ?? []).map(
        (event) => event.payload,
      ),
  });
  const schedulerService = new SchedulerService({
    logger: context.logger,
    builtin: {
      notificationService,
      turnAdapter: createScheduledTurnAdapter(context.activeAgents),
      integrationSecretResolver:
        context.secretBindingAdministration as unknown as import('../../services/secrets/secret-binding-administration.js').IntegrationSecretResolver,
      onActionableMonitor: async (input) => {
        const task = await context.taskGraphService.createTaskIdempotent(
          {
            projectId: input.projectId,
            title: `Review ready: ${input.jobName}`,
            description: input.prompt,
            agentId: input.agentId,
            createdBy: 'external-monitor',
          },
          'external-monitor',
          `${input.jobId}:${input.fingerprint}`,
        );
        const dispatched = await runWithScheduledPrincipal(
          input.principal,
          input.principal.runId,
          () =>
            context.taskDispatcher.dispatch(task.id, {
              agentId: input.agentId,
              sourceSurface: 'external-monitor',
              monitor: {
                agentId: input.agentId,
                signal: input.monitor.signal,
                deadlineAt: input.monitor.deadlineAt,
                maxCompletedTurns: input.monitor.maxCompletedTurns,
                maxTokens: input.monitor.maxTokens,
                onSessionReserved: ({ taskId, sessionId }) => {
                  monitorTurns.arm({
                    triggerId: input.triggerId,
                    taskId,
                    sessionId,
                    deadlineAt: input.monitor.deadlineAt,
                    limits: {
                      maxTurns: input.monitor.maxCompletedTurns,
                      maxTokens: input.monitor.maxTokens,
                    },
                    signal: input.monitor.signal,
                    onInitialTurnStarted: input.monitor.onInitialTurnStarted,
                  });
                },
                onSessionAbandoned: (sessionId) =>
                  monitorTurns.abandon(sessionId),
              },
            }),
        );
        if (dispatched.kind === 'dispatched') {
          const sessionId = dispatched.result.session.threadId;
          // The monitor envelope survives Task dispatch.  A wall deadline or
          // scheduler stop therefore stops the actual running session too;
          // turn identity is deliberately omitted until the orchestration
          // event seam has authoritatively observed it.
          input.monitor.signal.addEventListener(
            'abort',
            () => {
              void context.orchestrationService
                .interruptTurn(sessionId)
                .catch(() => undefined);
            },
            { once: true },
          );
        }
        return {
          task: {
            taskId: task.id,
            ...(dispatched.kind === 'dispatched'
              ? {
                  sessionId: dispatched.result.session.threadId,
                }
              : dispatched.kind === 'indeterminate' && dispatched.sessionId
                ? { sessionId: dispatched.sessionId }
                : {}),
          },
          outcome:
            dispatched.kind === 'dispatched'
              ? 'started'
              : dispatched.kind === 'indeterminate'
                ? 'possible-start'
                : dispatched.kind === 'terminal'
                  ? 'terminal'
                  : dispatched.kind === 'contended'
                    ? 'contended'
                    : 'definitely-not-started',
        };
      },
      readMonitorTerminals: async (triggers) =>
        triggers.flatMap((trigger) => {
          const task = context.taskGraphService.readTaskView(
            trigger.task.taskId,
          );
          if (!task || !['done', 'canceled'].includes(task.status)) return [];
          const usage = monitorTurns.receipt(trigger);
          return [
            {
              triggerId: trigger.triggerId,
              terminal:
                task.status === 'done'
                  ? ('completed' as const)
                  : ('failed' as const),
              ...(usage ? { usage } : {}),
            },
          ];
        }),
      enforceMonitorLimits: async (triggers) => monitorTurns.enforce(triggers),
      adoptMonitorTasks: ({ triggers, signal, onInitialTurnStarted }) => {
        for (const trigger of triggers)
          monitorTurns.adopt(trigger, signal, (task) =>
            onInitialTurnStarted(trigger.triggerId, task),
          );
      },
      onMonitorTerminal: (triggerId) => monitorTurns.release(triggerId),
      disposeMonitorTasks: () => monitorTurns.close(),
    },
  });

  const vapidKeyService = new VapidKeyService(
    context.configLoader.getProjectHomeDir(),
  );
  const webPushService = new WebPushService(
    vapidKeyService.loadOrCreate(),
    resolveWebPushSubject(),
  );
  wireWebPushDelivery(
    context.eventBus,
    context.environmentSecurityService.devicePairing,
    webPushService,
    context.logger,
    { enabled: webPushEnabled },
  );

  const attentionProjection = new AttentionProjectionService(
    notificationService,
    context.orchestrationService,
    flowRunService,
    context.approvalRegistry,
    // station#1914: a fresh instance over the SAME file
    // (`conversation-acknowledgements.json`) `createGlobalConversationRoutes`
    // already persists to — `JsonFileStore` is stateless per call, so a
    // second reader/writer over one path is the established pattern here
    // (mirrors every other per-consumer store instance in this function),
    // not a new storage mechanism.
    new FileConversationAcknowledgementStore(
      context.configLoader.getProjectHomeDir(),
    ),
    () => getCachedUser().alias,
    // #765 D5: pending pairing requests project as needs-attention items,
    // from the same resolver the notification provider polls.
    resolveDevicePairing,
    // #1536 D8: whether Station's own Agent can run, through
    // `createStationEngineAvailabilityReader` — the same function with the
    // same inputs the New Chat picker's Station row and `/api/boot`'s catalog
    // now read. An inbox that reads "Nothing needs you right now" while that
    // row says "Needs: No enabled LLM provider connection is configured" is
    // reading a fact nobody projected, not a quiet Station; the two reading
    // different app configs (review H2) is that same disagreement inverted.
    memoizeStationSetupRequirement(() => readStationSetupRequirement(context)),
  );
  return {
    schedulerService,
    notificationService,
    approvalInboxProvider,
    attentionProjection,
    webPushService,
    webPushEnabled,
  };
}
