import type { PrincipalRef } from '@kontourai/station-contracts/principal';
import type { CanonicalRuntimeEvent } from '@kontourai/station-contracts/runtime-events';
import type { TaskRoomWorkRecord } from '@kontourai/station-contracts/task-room-work';
import {
  INTERNAL_SESSION_READ_SCOPE,
  type SessionReadAuthority,
} from '@kontourai/station-contracts/tenancy';
import type { OrchestrationService } from '../orchestration/orchestration-service.js';
import type { ProjectTaskRoomRuntime } from '../orchestration/project-task-room-runtime.js';
import { ReceiverExecutionRefusal } from './project-contribution-service.js';
import type { TaskGraphService } from './task-graph-service.js';
import type {
  TaskRoomInvocationAdmission,
  TaskRoomWorkModule,
  TaskRoomWorkScope,
} from './task-room-work-module.js';

interface Dependencies {
  graph: Pick<TaskGraphService, 'startTaskRoomWork'>;
  work: TaskRoomWorkModule;
  room(): ProjectTaskRoomRuntime | undefined;
  authorize(
    taskId: string,
    request: Request,
    principal: PrincipalRef,
  ): Promise<TaskRoomWorkScope | undefined>;
  sessions: Pick<
    OrchestrationService,
    'readSession' | 'sessionQueries' | 'currentConversationSessionId'
  >;
  readBinding(
    sessionId: string,
  ): { taskId: string; projectId: string } | undefined | null;
  authorityForOwner(ownerId: string): SessionReadAuthority;
}

/** Room conversation effects compose TaskGraph, the request journal, and canonical Sessions. */
export class TaskRoomConversationModule {
  private readonly publications = new Map<
    string,
    { again: boolean; done: Promise<void> }
  >();
  constructor(private readonly deps: Dependencies) {}

  async waitForPublication(taskId: string): Promise<void> {
    await this.publications.get(taskId)?.done;
  }

  reconcile(taskId: string): Promise<void> {
    const current = this.publications.get(taskId);
    if (current) {
      current.again = true;
      return current.done;
    }
    const pending = { again: true, done: Promise.resolve() };
    pending.done = Promise.resolve().then(async () => {
      try {
        while (pending.again) {
          pending.again = false;
          await this.deps.room()?.reconcileAgentLifecycles([taskId]);
        }
      } finally {
        if (this.publications.get(taskId) === pending)
          this.publications.delete(taskId);
      }
    });
    this.publications.set(taskId, pending);
    return pending.done;
  }

  async observe(event: CanonicalRuntimeEvent): Promise<void> {
    if (!['turn.completed', 'turn.aborted'].includes(event.method)) return;
    const binding = this.deps.readBinding(event.threadId);
    if (binding) await this.reconcile(binding.taskId);
  }

  async recorded(
    record: TaskRoomWorkRecord,
    request: Request,
    principal: PrincipalRef,
  ): Promise<void> {
    await this.waitForPublication(record.taskId);
    const scope = await this.deps.authorize(record.taskId, request, principal);
    const room = this.deps.room();
    if (!scope || scope.taskCreatedAt !== record.taskCreatedAt || !room) return;
    await room.message({
      taskId: record.taskId,
      request,
      proposalId: `room-request:${record.operationId}:${record.requesterId}`,
      occurredAt: record.createdAt,
      expectedTaskCreatedAt: record.taskCreatedAt,
      text: `@${record.agentId} ${record.prompt}`,
    });
    const current = await this.deps.authorize(
      record.taskId,
      request,
      principal,
    );
    if (
      !current ||
      current.taskCreatedAt !== record.taskCreatedAt ||
      current.projectId !== scope.projectId ||
      current.requesterId !== scope.requesterId
    )
      return;
    const started = await this.deps.graph.startTaskRoomWork(
      record.taskId,
      record.taskCreatedAt,
    );
    if (started.changed)
      await room.message({
        taskId: record.taskId,
        request,
        expectedTaskCreatedAt: record.taskCreatedAt,
        proposalId: `room-status:${record.taskId}:${started.task.updatedAt}`,
        occurredAt: started.task.updatedAt,
        correlationId: 'room-status',
        text: 'Status → In progress',
      });
    await this.reconcile(record.taskId);
  }

  async reply(
    input: {
      taskId: string;
      sessionId: string;
      taskCreatedAt: string;
      operationId: string;
      message: string;
    },
    request: Request,
    principal: PrincipalRef,
  ): Promise<boolean> {
    await this.waitForPublication(input.taskId);
    const authorize = () =>
      this.deps.authorize(input.taskId, request, principal);
    const scope = await authorize();
    const room = this.deps.room();
    if (!scope || scope.taskCreatedAt !== input.taskCreatedAt || !room)
      return false;
    const binding = this.deps.readBinding(input.sessionId);
    if (
      !binding ||
      binding.taskId !== input.taskId ||
      binding.projectId !== scope.roomProjectId
    )
      return false;
    const list = await this.deps.work.list(input.taskId, authorize);
    if (
      list.kind !== 'available' ||
      !list.records.some(
        (record) =>
          record.sessionId === input.sessionId &&
          record.taskCreatedAt === input.taskCreatedAt,
      )
    )
      return false;
    const result = await room.message({
      taskId: input.taskId,
      request,
      proposalId: `room-thread:${input.operationId}`,
      text: input.message,
      expectedTaskCreatedAt: input.taskCreatedAt,
      correlationId: `room-thread:${input.sessionId}`,
    });
    return result.kind === 'committed' || result.kind === 'duplicate';
  }

  async admission(
    input: { taskId: string; taskCreatedAt: string; sessionId: string },
    request: Request,
    principal: PrincipalRef,
  ): Promise<TaskRoomInvocationAdmission | undefined> {
    await this.waitForPublication(input.taskId);
    const admitted = await this.deps.authorize(
      input.taskId,
      request,
      principal,
    );
    if (!admitted || admitted.taskCreatedAt !== input.taskCreatedAt)
      return undefined;
    const recheck = async () => {
      const current = await this.deps.authorize(
        input.taskId,
        request,
        principal,
      );
      const binding = this.deps.readBinding(input.sessionId);
      if (
        !current ||
        current.taskCreatedAt !== admitted.taskCreatedAt ||
        current.projectId !== admitted.projectId ||
        current.roomProjectId !== admitted.roomProjectId ||
        current.projectSlug !== admitted.projectSlug ||
        current.requesterId !== admitted.requesterId ||
        !binding ||
        binding.projectId !== admitted.roomProjectId ||
        binding.taskId !== input.taskId ||
        this.deps.sessions.currentConversationSessionId(input.sessionId) !==
          input.sessionId
      )
        throw new ReceiverExecutionRefusal(
          'receiver_execution_authority_changed',
          'Task authority or agent Session changed before reply invocation.',
        );
      const session = await this.deps.sessions.readSession(
        input.sessionId,
        this.deps.authorityForOwner(principal.id),
      );
      if (!session)
        throw new ReceiverExecutionRefusal(
          'receiver_execution_authority_changed',
          'Agent Session access changed before reply invocation.',
        );
    };
    await recheck();
    return {
      expectedSessionId: input.sessionId,
      roomBinding: { projectId: admitted.roomProjectId, taskId: input.taskId },
      recheck,
    };
  }

  async answers({
    sessionId,
    ownerOperatorId,
  }: {
    sessionId: string;
    ownerOperatorId: string;
  }) {
    const detail = await this.deps.sessions.readSession(
      sessionId,
      INTERNAL_SESSION_READ_SCOPE,
    );
    if (!detail) return [];
    const completions = detail.events.filter(
      (event) =>
        event.method === 'turn.completed' &&
        event.turnId &&
        event.finishReason !== 'cancelled',
    );
    const answers = [];
    for (const event of completions) {
      const answer = await this.deps.sessions.sessionQueries.readAssistantTurn(
        { type: 'assistant-turn', threadId: sessionId, turnId: event.turnId! },
        this.deps.authorityForOwner(ownerOperatorId),
      );
      if (answer.status !== 'found') continue;
      const text = answer.message.parts
        .flatMap((part) => (part.type === 'text' ? [part.text] : []))
        .join('\n');
      if (text.trim())
        answers.push({
          turnId: answer.turnId,
          text,
          occurredAt: event.createdAt,
        });
    }
    return answers;
  }
}
