/**
 * #5070: a scheduled job that belongs to a Project runs as a Task in it.
 *
 * Each run:
 *
 * 1. creates a Task in the Project, keyed by the run id, so a restarted run
 *    finds the same Task instead of making a second one;
 * 2. dispatches it for the job's Agent through the ordinary Task dispatcher,
 *    so the Session starts in the Project's workspace with the Task brief
 *    stamped for its first turn;
 * 3. queues the job's prompt as that first turn on the Task's chat, through
 *    the same conversation run a chat-targeted automation uses (one framed
 *    Station turn under the key `scheduler:<runId>`), and waits for it;
 * 4. writes a run summary as the Task's summary.
 *
 * The run acts for no one (`unattributed-agent`) and is owned by the local
 * operator, like an automation rule's Task. A held Project (paused or
 * archived, #5069) refuses the turn at admission; the scheduler does not
 * claim its occurrences in the first place.
 */
import { automationRunClientTurnId } from '@kontourai/station-contracts/scheduler';
import type { TaskRecord } from '@kontourai/station-contracts/task-graph';
import { errorMessage } from '../../utils/error-message.js';
import type { DispatchOutcome } from '../projects/task-dispatcher.js';
import type {
  ScheduledProjectRunner,
  ScheduledTurnOutcome,
} from './builtin-scheduler.js';
import type {
  ScheduledConversationRunner,
  ScheduledConversationRunOutcome,
} from './scheduled-conversation-runs.js';

export interface ScheduledProjectRunsPorts {
  createTask(
    input: {
      projectId: string;
      title: string;
      description: string;
      agentId: string;
    },
    idempotencyKey: string,
  ): Promise<Pick<TaskRecord, 'id' | 'createdAt' | 'projectId'>>;
  /** Dispatches the Task for its Agent under the run's unattended principal. */
  dispatchTask(input: {
    taskId: string;
    agentId: string;
    principal: { kind: 'scheduled-job'; jobId: string; runId: string };
    signal: AbortSignal;
  }): Promise<DispatchOutcome>;
  /** The conversation a dispatched Session belongs to. */
  conversationForSession(sessionId: string): string | undefined;
  /** Queues and awaits the framed turn, as for a chat-targeted automation. */
  conversationRuns: ScheduledConversationRunner;
  /** The actor the queued turn is sent as (the Task's recorded owner). */
  actor: { userId: string; ownerAttribution?: 'unattributed-agent' };
  /** Records the run summary on the Task. Failures are logged, not fatal. */
  recordSummary(input: {
    projectId: string;
    taskId: string;
    taskCreatedAt: string;
    sessionId: string;
    text: string;
  }): void;
  now?: () => Date;
}

/**
 * The Task title a run creates. Stable for the run: a retried attempt finds
 * the same Task by its run key, and the Task store refuses a changed title.
 */
export function scheduledProjectTaskTitle(jobName: string): string {
  return `Scheduled: ${jobName}`;
}

/** The summary a finished run leaves on its Task. */
export function scheduledProjectRunSummary(input: {
  jobName: string;
  outcome: ScheduledConversationRunOutcome;
  at: Date;
}): string {
  const when = input.at.toISOString();
  switch (input.outcome.kind) {
    case 'completed':
      return `Scheduled run of "${input.jobName}" finished at ${when}. Its answer is in this Task's chat.`;
    case 'failed':
      return `Scheduled run of "${input.jobName}" failed at ${when}: ${input.outcome.error}`;
    case 'definitely-not-invoked':
      return `Scheduled run of "${input.jobName}" did not start: ${input.outcome.error}`;
    case 'indeterminate':
      return `Scheduled run of "${input.jobName}" did not report an outcome by ${when}: ${input.outcome.error}`;
  }
}

export class ScheduledProjectRuns implements ScheduledProjectRunner {
  constructor(private readonly ports: ScheduledProjectRunsPorts) {}

  async invoke(
    input: Parameters<ScheduledProjectRunner['invoke']>[0],
  ): Promise<ScheduledTurnOutcome> {
    if (input.signal.aborted)
      return { kind: 'definitely-not-invoked', error: 'Scheduler is stopping' };
    const runId = input.principal.runId;
    let task: Pick<TaskRecord, 'id' | 'createdAt' | 'projectId'>;
    try {
      task = await this.ports.createTask(
        {
          projectId: input.projectId,
          title: scheduledProjectTaskTitle(input.jobName),
          description: input.prompt,
          agentId: input.agentSlug,
        },
        runId,
      );
    } catch (error) {
      return {
        kind: 'definitely-not-invoked',
        error: `Could not create the run's Task: ${errorMessage(error)}`,
      };
    }
    let dispatched: DispatchOutcome;
    try {
      dispatched = await this.ports.dispatchTask({
        taskId: task.id,
        agentId: input.agentSlug,
        principal: input.principal,
        signal: input.signal,
      });
    } catch (error) {
      return {
        kind: 'indeterminate',
        error: `Starting the run's Task may have begun: ${errorMessage(error)}`,
      };
    }
    if (dispatched.kind === 'indeterminate')
      return {
        kind: 'indeterminate',
        error: `Starting the run's Task may have begun: ${dispatched.reason}`,
      };
    if (dispatched.kind !== 'dispatched')
      return {
        kind: 'definitely-not-invoked',
        error: `The run's Task did not start: ${dispatched.reason}`,
      };
    const sessionId = dispatched.result.session.threadId;
    const conversationId = this.ports.conversationForSession(sessionId);
    if (!conversationId)
      return {
        kind: 'indeterminate',
        error: "The run's Task started but its chat could not be found.",
      };
    const outcome = await this.ports.conversationRuns.run({
      jobId: input.principal.jobId,
      jobName: input.jobName,
      runId,
      prompt: input.prompt,
      target: { kind: 'conversation', conversationId },
      createdBy: {
        userId: this.ports.actor.userId,
        ...(this.ports.actor.ownerAttribution
          ? { ownerAttribution: this.ports.actor.ownerAttribution }
          : {}),
      },
      lastSuccessAt: undefined,
      onConversationStarted: () => undefined,
      onHandedOff: () => undefined,
      signal: input.signal,
    });
    try {
      this.ports.recordSummary({
        projectId: task.projectId,
        taskId: task.id,
        taskCreatedAt: task.createdAt,
        sessionId,
        text: scheduledProjectRunSummary({
          jobName: input.jobName,
          outcome,
          at: this.now(),
        }),
      });
    } catch {
      // The run's outcome stands; the Task chat still holds its answer.
    }
    const output = JSON.stringify({
      projectId: task.projectId,
      taskId: task.id,
      conversationId,
      sessionId,
      clientTurnId: automationRunClientTurnId(runId),
    });
    switch (outcome.kind) {
      case 'completed':
        return { kind: 'completed', output };
      case 'failed':
        return { kind: 'failed', error: outcome.error };
      case 'definitely-not-invoked':
        // The Task's Session started; a retry would start another. Report it
        // as a failure of this run, never as "nothing happened".
        return { kind: 'failed', error: outcome.error };
      case 'indeterminate':
        return { kind: 'indeterminate', error: outcome.error };
    }
  }

  private now(): Date {
    return this.ports.now?.() ?? new Date();
  }
}
