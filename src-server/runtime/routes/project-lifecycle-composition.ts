/**
 * #5069 / #5070: composes Project lifecycle (Pause, Archive) and Project
 * schedules from the runtime's own services.
 *
 * - The lifecycle service is registered as an orchestration turn admission,
 *   so every turn in a paused or archived Project's chats is refused, and it
 *   interrupts through `OrchestrationService.interruptTurn`.
 * - The scheduler reads which Projects hold their schedules from the same
 *   records (`projectHold`).
 * - A Project job's run becomes a Task in its Project (`ScheduledProjectRuns`),
 *   acting as the job's creator (#5126).
 */
import type {
  FeaturePreviewRegistry,
  FeaturePreviewSelector,
} from '../../services/feature-previews/feature-preview-registry.js';
import type { EventStore } from '../../services/orchestration/event-store.js';
import type { OrchestrationService } from '../../services/orchestration/orchestration-service.js';
import { ProjectLifecycleService } from '../../services/projects/project-lifecycle-service.js';
import type { ProjectService } from '../../services/projects/project-service.js';
import type { TaskDispatcher } from '../../services/projects/task-dispatcher.js';
import type { TaskGraphService } from '../../services/projects/task-graph-service.js';
import type { ScheduledProjectHold } from '../../services/scheduling/builtin-scheduler.js';
import type { ScheduledConversationRunner } from '../../services/scheduling/scheduled-conversation-runs.js';
import { ScheduledProjectRuns } from '../../services/scheduling/scheduled-project-runs.js';
import type { Logger } from '../../utils/logger.js';
import { runWithUnattendedPrincipal } from '../agents/unattended-principal-context.js';

const enabled = (preview: FeaturePreviewSelector) =>
  preview.select({ enabled: () => true, disabled: () => false });

export function composeProjectLifecycle(context: {
  featurePreviews: FeaturePreviewRegistry;
  projectService: Pick<
    ProjectService,
    'getProject' | 'listProjects' | 'setProjectLifecycle'
  >;
  orchestrationService: Pick<
    OrchestrationService,
    | 'listActiveTurnThreadIds'
    | 'resolveSessionProjectSlug'
    | 'interruptTurn'
    | 'registerTurnAdmission'
  >;
}): {
  lifecycle: ProjectLifecycleService;
  projectHold: ScheduledProjectHold;
  /** Gates starting a Pause or Archive; Resume and Unarchive stay open. */
  pauseArchivePreview: FeaturePreviewSelector;
  /** Gates creating, proposing and running Project schedules. */
  schedulesPreview: FeaturePreviewSelector;
} {
  const pauseArchivePreview = context.featurePreviews.bind({
    id: 'project-pause-archive',
    label: 'Pause and archive Projects',
    description:
      'Pause or archive a Project: stops its running chats and holds its schedules until you resume it.',
  });
  const schedulesPreview = context.featurePreviews.bind({
    id: 'project-schedules',
    label: 'Project schedules',
    description:
      'Schedules that run as a new Task in a Project. Each run starts an agent and can spend model credits.',
  });
  const service = context.orchestrationService;
  const lifecycle = new ProjectLifecycleService({
    readProject: (slug) => context.projectService.getProject(slug),
    listProjects: () => context.projectService.listProjects(),
    writeLifecycle: (slug, next) =>
      context.projectService.setProjectLifecycle(slug, next),
    listActiveTurnThreadIds: () => service.listActiveTurnThreadIds(),
    resolveSessionProjectSlug: (threadId) =>
      service.resolveSessionProjectSlug(threadId),
    interruptTurn: (threadId) => service.interruptTurn(threadId),
  });
  service.registerTurnAdmission((input) => lifecycle.admitTurn(input));
  const projectHold: ScheduledProjectHold = {
    heldProjectIds: () => lifecycle.heldProjectIds(),
    heldProjectSlugs: () =>
      new Set(
        context.projectService
          .listProjects()
          .filter((project) => lifecycle.heldProjectIds().has(project.id))
          .map((project) => project.slug),
      ),
    projectExists: (projectId) =>
      context.projectService
        .listProjects()
        .some((project) => project.id === projectId),
    // Read at each claim: turning the preview off holds every Project job
    // (none is claimed, and Run now is refused) until it is on again.
    projectRunsEnabled: () => enabled(schedulesPreview),
  };
  return { lifecycle, projectHold, pauseArchivePreview, schedulesPreview };
}

export function composeScheduledProjectRuns(context: {
  taskGraphService: Pick<TaskGraphService, 'createTaskIdempotent'>;
  taskDispatcher: TaskDispatcher;
  eventStore: Pick<EventStore, 'conversationForSession' | 'taskMemoryStore'>;
  conversationRuns: ScheduledConversationRunner;
  /** #5126: whether a job's creator holds `execute` in the Project now. */
  creatorMayRunInProject(creatorId: string, projectId: string): boolean;
  logger: Logger;
}): ScheduledProjectRuns {
  return new ScheduledProjectRuns({
    createTask: (input, key) =>
      context.taskGraphService.createTaskIdempotent(
        { ...input, createdBy: 'scheduled-job' },
        'scheduled-job',
        key,
      ),
    dispatchTask: ({ taskId, agentId, principal, owner, signal }) =>
      runWithUnattendedPrincipal(principal, principal.runId, () =>
        context.taskDispatcher.dispatch(taskId, {
          agentId,
          sourceSurface: 'scheduled-job',
          // A schedule acts for no request: it may not grant full access.
          fullAccessGrant: null,
          // #5126: the Session belongs to the job's creator and acts as
          // recorded: a person's job for that person, a verified agent's
          // for its owner (`verified-bound`), an unverified agent's for no
          // one (`unattributed-agent`). Its Station-control caller, Project
          // role and scope follow from that owner.
          ownerUserId: owner.userId,
          ...(owner.ownerAttribution
            ? { ownerAttribution: owner.ownerAttribution }
            : {}),
          signal,
          runtimeConfig: { modelOptions: { approvalMode: 'ask' } },
        }),
      ),
    creatorMayRunInProject: context.creatorMayRunInProject,
    conversationForSession: (sessionId) =>
      context.eventStore.conversationForSession(sessionId)?.conversationId,
    conversationRuns: context.conversationRuns,
    recordSummary: ({ projectId, taskId, taskCreatedAt, sessionId, text }) => {
      const store = context.eventStore.taskMemoryStore();
      const current = store.readSummary({ taskId, taskCreatedAt });
      const result = store.updateSummary({
        taskId,
        taskCreatedAt,
        projectId,
        author: { kind: 'session', sessionId },
        text,
        baseRevision: current?.revision ?? 0,
      });
      if (result.kind !== 'updated')
        context.logger.warn('Scheduled run summary was not recorded', {
          taskId,
          outcome: result.kind,
        });
    },
  });
}
