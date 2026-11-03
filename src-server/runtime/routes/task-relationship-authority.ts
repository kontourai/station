import type { ProjectConfig } from '@kontourai/station-contracts/project';
import type { SessionReadAuthority } from '@kontourai/station-contracts/tenancy';
import type { TaskRelationshipRouteAdapters } from '../../routes/orchestration/task-relationships.js';
import type { EventStore } from '../../services/orchestration/event-store.js';
import type { OrchestrationService } from '../../services/orchestration/orchestration-service.js';
import type { TaskGraphService } from '../../services/projects/task-graph-service.js';
import type { TaskRelationshipAuthority } from '../../services/projects/task-relationship-state.js';

/** Compose request-local preparation with owner reads repeated under the graph lock. */
export function createTaskRelationshipAuthority(deps: {
  graph: TaskGraphService;
  projects(): readonly Pick<ProjectConfig, 'id' | 'slug' | 'createdAt'>[];
  sessions: Pick<
    OrchestrationService,
    | 'resolveConversationOpen'
    | 'currentConversationSessionId'
    | 'canUserReadConversation'
    | 'canUserReadSession'
  >;
  events?: Pick<
    EventStore,
    'conversationSessions' | 'conversationForSession' | 'latestEventByMethods'
  >;
  readAuthority(request: Request): SessionReadAuthority;
  current(request: Request): boolean;
  mayRead(request: Request, taskId: string): boolean;
  mayEdit(request: Request, taskId: string): boolean;
}): TaskRelationshipRouteAdapters {
  const canonical = (identity: string) => {
    const matches = deps
      .projects()
      .filter((p) => p.id === identity || p.slug === identity);
    return matches.length === 1 ? matches[0] : undefined;
  };
  const requests = new WeakMap<Request, () => boolean>();
  return {
    isCurrent: (request) => requests.get(request)?.() === true,
    async authorityForRequest(request, conversationId, target) {
      if (!deps.current(request)) return undefined;
      const path = new URL(request.url).pathname.match(
        /^\/api\/tasks\/([^/]+)\//,
      );
      if (!path && !target) return undefined;
      const taskId = target?.taskId ?? decodeURIComponent(path![1]!);
      const task = deps.graph.readTask(taskId);
      const project = task && canonical(task.projectId);
      if (!task || !project) return undefined;
      const current = () => {
        if (request.signal.aborted || !deps.current(request)) return false;
        const live = deps.graph.readTask(taskId);
        const owner = live && canonical(live.projectId);
        return (
          live?.createdAt === task.createdAt &&
          owner?.id === project.id &&
          owner.createdAt === project.createdAt
        );
      };
      requests.set(request, current);
      const reader = deps.readAuthority(request);
      const chats = new Map<string, () => boolean>();
      const access: TaskRelationshipAuthority = {
        expectedProject: { id: project.id, createdAt: project.createdAt },
        canonicalProject: canonical,
        canReadTask: (target) => current() && deps.mayRead(request, target.id),
        canMutateTask: (target) =>
          current() && deps.mayEdit(request, target.id),
        canReadConversation: (id, owner) =>
          current() &&
          owner.id === project.id &&
          owner.createdAt === project.createdAt &&
          chats.get(id)?.() === true,
      };
      // Capture each visible target's own admission before asynchronous reader
      // preparation. A shared parent never confers visibility on its children.
      access.canReadTask(task);
      deps.graph.listTaskChildren(
        { taskId, taskCreatedAt: task.createdAt },
        access,
      );
      const candidates = new Set<string>(target?.conversationIds);
      if (conversationId) candidates.add(conversationId);
      else if (
        request.method === 'GET' &&
        new URL(request.url).pathname.endsWith('/work-chats')
      ) {
        // Discovery only: collect stored targets without authorizing any of them.
        deps.graph.listTaskWorkChats(
          { taskId, taskCreatedAt: task.createdAt },
          {
            ...access,
            canReadConversation: (id) => {
              candidates.add(id);
              return false;
            },
          },
        );
      }
      for (const id of candidates) {
        const opened = await deps.sessions.resolveConversationOpen(id, reader);
        if (
          opened?.status !== 'resolved' ||
          opened.conversation.id !== id ||
          opened.conversation.source !== 'runtime'
        )
          continue;
        const conversationProject =
          opened.conversation.projectSlug &&
          canonical(opened.conversation.projectSlug);
        if (
          !conversationProject ||
          conversationProject.id !== project.id ||
          conversationProject.createdAt !== project.createdAt
        )
          continue;
        const child = deps.sessions.currentConversationSessionId(id);
        if (!deps.events) continue;
        const links = deps.events.conversationSessions(id);
        const tail = links.at(-1);
        // Conversation open may describe the authorized predecessor of an
        // unstarted continuation. Only that exact reserved tail lacks scope metadata.
        const reservedChild =
          opened.currentSessionId !== child &&
          tail?.sessionId === child &&
          tail.predecessorSessionId === opened.currentSessionId;
        if (opened.currentSessionId !== child && !reservedChild) continue;
        const lineage = JSON.stringify(links);
        const ownership = () => {
          if (
            deps.events!.conversationForSession(id)?.conversationId &&
            deps.events!.conversationForSession(id)!.conversationId !== id
          )
            return false;
          const ids = deps
            .events!.conversationSessions(id)
            .map((link) => link.sessionId);
          if (!ids.length) ids.push(id);
          return ids.every((sessionId) => {
            const event = deps.events!.latestEventByMethods(sessionId, [
              'session.started',
              'session.configured',
            ]);
            if (reservedChild && sessionId === child) return !event;
            const payload = event?.payload;
            if (
              !payload ||
              (payload.method !== 'session.started' &&
                payload.method !== 'session.configured')
            )
              return false;
            const metadata = payload.metadata;
            if (Date.parse(payload.createdAt) < Date.parse(project.createdAt))
              return false;
            if (
              metadata?.localProjectId !== undefined &&
              metadata.localProjectId !== project.id
            )
              return false;
            const ref = metadata?.projectSlug;
            const owner = typeof ref === 'string' ? canonical(ref) : undefined;
            return (
              owner?.id === project.id && owner.createdAt === project.createdAt
            );
          });
        };
        chats.set(
          id,
          () =>
            deps.sessions.currentConversationSessionId(id) === child &&
            JSON.stringify(deps.events!.conversationSessions(id)) === lineage &&
            ownership() &&
            (reservedChild
              ? links.every(
                  (link) =>
                    link.sessionId === child ||
                    deps.sessions.canUserReadSession(link.sessionId, reader),
                )
              : deps.sessions.canUserReadConversation(id, reader)),
        );
      }
      return current() ? access : undefined;
    },
  };
}
