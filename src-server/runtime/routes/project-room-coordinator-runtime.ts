/**
 * Runtime composition of the `#general` coordinator (#5063): binds the
 * coordinator to the real Task graph, dispatcher, conversation inbox, event
 * store and room store, and owns its lifetime (turn-event subscription,
 * boot reconciliation and one bounded periodic fallback).
 *
 * Background authority. A coordinator Task's result is posted after the
 * request that started it has ended, so no request authority exists then.
 * The row records who started it; every background post rechecks, inside the
 * room store's write transaction, that the Project is the same incarnation,
 * `#general` is the same room, and that person may still start work
 * (`execute`) in the Project. Any change posts nothing. The post is the
 * coordinator's fixed agent actor with a stable intent, so the room accepts
 * it once.
 */

import type { ProjectConfig } from '@kontourai/station-contracts/project';
import type { ProjectMembershipScope } from '@kontourai/station-contracts/project-membership';
import { effectiveProjectRoomCoordinatorSettings } from '@kontourai/station-contracts/project-room-coordinator';
import { SERVER_EVENTS } from '@kontourai/station-contracts/runtime-events';
import type { SessionReadAuthority } from '@kontourai/station-contracts/tenancy';
import type { FeaturePreviewSelector } from '../../services/feature-previews/feature-preview-registry.js';
import type { EventBus } from '../../services/orchestration/event-bus.js';
import type { EventStore } from '../../services/orchestration/event-store.js';
import type { OrchestrationService } from '../../services/orchestration/orchestration-service.js';
import { submitStationFramedTurn } from '../../services/orchestration/station-turn-handoff.js';
import type { ThreadInboxDelivery } from '../../services/orchestration/thread-inbox.js';
import {
  COORDINATOR_ACTOR,
  CoordinatorResultWithheld,
  ProjectRoomCoordinator,
} from '../../services/projects/project-room-coordinator.js';
import { openProjectRoomCoordinatorStore } from '../../services/projects/project-room-coordinator-store.js';
import type { ProjectRoomStore } from '../../services/projects/project-room-store.js';
import type { TaskDispatcher } from '../../services/projects/task-dispatcher.js';
import type { TaskGraphService } from '../../services/projects/task-graph-service.js';
import { readStoredScheduledTurnTerminal } from '../../services/scheduling/scheduled-conversation-runs.js';
import type { Logger } from '../../utils/logger.js';

/** How often a missed event is caught up: bounded, not a polling loop. */
const RECONCILE_INTERVAL_MS = 60_000;

export interface ProjectRoomCoordinatorRuntimeDeps {
  home: string;
  preview: FeaturePreviewSelector;
  rooms: Pick<ProjectRoomStore, 'append' | 'lookupRoom'>;
  getProject(slug: string): ProjectConfig | undefined;
  currentScope(slug: string): ProjectMembershipScope | undefined;
  mayStart(userId: string, localProjectId: string): boolean;
  agentName(agentId: string): Promise<string | undefined>;
  taskGraph: Pick<TaskGraphService, 'createTaskIdempotent' | 'readTaskView'>;
  dispatcher: TaskDispatcher;
  inbox: Pick<ThreadInboxDelivery, 'submit' | 'entry'>;
  eventStore: Pick<
    EventStore,
    'conversationForSession' | 'listTurnEventsByMethods'
  >;
  sessions: Pick<OrchestrationService, 'readSession' | 'sessionQueries'>;
  authorityFor(userId: string): SessionReadAuthority;
  eventBus: EventBus;
  logger: Logger;
}

function sameScope(a: ProjectMembershipScope, b: ProjectMembershipScope) {
  return (
    a.stationId === b.stationId &&
    a.localProjectId === b.localProjectId &&
    a.localProjectSlug === b.localProjectSlug &&
    a.portableProjectId === b.portableProjectId
  );
}

/**
 * The background post a settled Task's result takes. It holds no request;
 * the room store runs `current` inside its write transaction, so the post
 * lands only for the same Project incarnation, the same `#general` room and
 * a starter who may still start work there. The stable intent makes the
 * room accept it once.
 */
export function coordinatorRoomPublisher(
  deps: Pick<
    ProjectRoomCoordinatorRuntimeDeps,
    'rooms' | 'currentScope' | 'mayStart'
  >,
) {
  return (input: {
    scope: ProjectMembershipScope;
    roomId: string;
    starterId: string;
    intentId: string;
    text: string;
  }): string => {
    const { scope, roomId, starterId } = input;
    const current = () => {
      const now = deps.currentScope(scope.localProjectSlug);
      if (!now || !sameScope(now, scope))
        throw new CoordinatorResultWithheld('The Project or room changed.');
      if (deps.rooms.lookupRoom(scope)?.roomId !== roomId)
        throw new CoordinatorResultWithheld('The Project or room changed.');
      if (!deps.mayStart(starterId, scope.localProjectId))
        throw new CoordinatorResultWithheld('The starter lost access.');
    };
    current();
    return deps.rooms.append(
      scope,
      COORDINATOR_ACTOR,
      { intentId: input.intentId, text: input.text },
      current,
    ).messageId;
  };
}

export function composeProjectRoomCoordinatorRuntime(
  deps: ProjectRoomCoordinatorRuntimeDeps,
) {
  const opened = openProjectRoomCoordinatorStore(deps.home);
  const enabled = () =>
    deps.preview.select({ enabled: () => true, disabled: () => false });
  const assistantText = async (input: {
    sessionId: string;
    turnId?: string;
    ownerUserId: string;
  }) => {
    const authority = deps.authorityFor(input.ownerUserId);
    let turnId = input.turnId;
    if (!turnId) {
      const session = await deps.sessions.readSession(
        input.sessionId,
        authority,
      );
      turnId = session?.events
        .filter(
          (event) =>
            event.method === 'turn.completed' &&
            event.finishReason !== 'cancelled',
        )
        .at(-1)?.turnId;
    }
    if (!turnId) return undefined;
    const answer = await deps.sessions.sessionQueries.readAssistantTurn(
      { type: 'assistant-turn', threadId: input.sessionId, turnId },
      authority,
    );
    if (answer.status !== 'found') return undefined;
    const text = answer.message.parts
      .flatMap((part) => (part.type === 'text' ? [part.text] : []))
      .join('\n')
      .trim();
    return text || undefined;
  };
  const coordinator = new ProjectRoomCoordinator(opened.store, {
    enabled,
    settings: (slug) =>
      effectiveProjectRoomCoordinatorSettings(
        deps.getProject(slug)?.roomCoordinator,
      ),
    placement: (slug) =>
      deps.getProject(slug)?.defaultWorkspaceIsolation === 'worktree'
        ? 'worktree'
        : 'project',
    agentLabel: deps.agentName,
    currentScope: deps.currentScope,
    mayStart: deps.mayStart,
    createTask: (input, key, authorize) =>
      deps.taskGraph.createTaskIdempotent(
        { ...input, createdBy: 'project-room-coordinator' },
        'project-room-coordinator',
        key,
        undefined,
        authorize,
      ),
    dispatchTask: ({ taskId, agentId, ownerUserId }) =>
      deps.dispatcher.dispatch(taskId, {
        agentId,
        sourceSurface: 'project-room-coordinator',
        // Started by a person's Start, never with full access.
        fullAccessGrant: null,
        ownerUserId,
      }),
    readTask: (taskId) => {
      const task = deps.taskGraph.readTaskView(taskId);
      return task
        ? {
            status: task.status,
            ...(task.sessionId ? { sessionId: task.sessionId } : {}),
          }
        : undefined;
    },
    conversationForSession: (sessionId) =>
      deps.eventStore.conversationForSession(sessionId)?.conversationId,
    submitTurn: ({ conversationId, clientTurnId, message, userId }) =>
      submitStationFramedTurn((input) => deps.inbox.submit(input), {
        conversationId,
        clientTurnId,
        message,
        actor: { userId },
      }).outcome,
    turnEntry: (conversationId, clientTurnId) =>
      deps.inbox.entry(conversationId, clientTurnId),
    turnTerminal: (sessionId, turnId) => {
      const terminal = readStoredScheduledTurnTerminal(
        deps.eventStore,
        sessionId,
        turnId,
      );
      return terminal?.kind === 'failed'
        ? { kind: 'failed', reason: terminal.reason }
        : terminal
          ? { kind: 'completed' }
          : undefined;
    },
    assistantText,
    publishForStarter: coordinatorRoomPublisher(deps),
  });
  const unsubscribe = deps.eventBus.subscribe((frame) => {
    if (frame.event !== SERVER_EVENTS.ORCHESTRATION_EVENT) return;
    const event = frame.data?.event;
    if (
      !event ||
      typeof event !== 'object' ||
      !('method' in event) ||
      !['turn.completed', 'turn.aborted', 'runtime.error'].includes(
        String(event.method),
      ) ||
      !('threadId' in event) ||
      typeof event.threadId !== 'string'
    )
      return;
    coordinator.observe(event.threadId);
  });
  const reconcile = () =>
    coordinator.reconcile().catch((error: unknown) => {
      deps.logger.warn('Project Room coordinator reconciliation failed', {
        error,
      });
    });
  // Boot: resume rows a restart interrupted, then catch up on a cadence.
  void reconcile();
  const interval = setInterval(() => void reconcile(), RECONCILE_INTERVAL_MS);
  interval.unref();
  return {
    coordinator,
    enabled,
    async close(): Promise<void> {
      clearInterval(interval);
      unsubscribe();
      try {
        await coordinator.close();
      } finally {
        opened.close();
      }
    },
  };
}
