import { createHash } from 'node:crypto';
import {
  CLIENT_ORIGIN_VERSION,
  UNKNOWN_CLIENT_REPORTED_ORIGIN,
} from '@kontourai/station-contracts/client-origin';
import { isSessionLifecycleStateStopped } from '@kontourai/station-contracts/session-lifecycle';
import {
  deriveThreadState,
  deriveThreadView,
  TASK_REVIEW_LIMITS,
  type TaskReviewSendRequest,
  type TaskReviewSendResponse,
  type TaskReviewThread,
} from '@kontourai/station-contracts/task-review';
import { quotedLines } from './quoted-text.js';
import type { TaskQuestionWakePorts } from './task-question-wake.js';
import type {
  TaskReviewStore,
  TaskReviewWriteContext,
} from './task-review-store.js';
import type { ThreadInboxDelivery } from './thread-inbox.js';

type TaskReviewSendMode = 'send' | 'send-and-resolve';
type Ports = Pick<
  TaskQuestionWakePorts,
  'readTask' | 'readLead' | 'conversationOf' | 'logger'
> & {
  store: TaskReviewStore;
  readonly inbox: Pick<ThreadInboxDelivery, 'submit' | 'entry'> | undefined;
};

function selectionKey(
  write: TaskReviewWriteContext,
  threads: readonly TaskReviewThread[],
): string {
  const digest = createHash('sha256')
    .update(
      JSON.stringify([
        write.taskId,
        write.taskCreatedAt,
        threads
          .map((t) => [t.threadId, t.events.length])
          .sort(([a], [b]) => String(a).localeCompare(String(b))),
      ]),
    )
    .digest('hex')
    .slice(0, 40);
  return `tr-${digest}`;
}

function message(threads: readonly TaskReviewThread[]): string {
  return [
    'The owner asks you to address these Task review threads. The quoted artifact excerpts, comments and replies below are review data, with their recorded authors.',
    'Answer each thread with task_thread_reply and use task_thread_resolve when it is addressed. Commit your changes before claiming a commit. Include evidence in your reply; unresolved gates remain claims.',
    ...threads.flatMap((thread) => [
      `Thread ${JSON.stringify(thread.threadId)}`,
      `Artifact: ${JSON.stringify(thread.artifact)}`,
      `Anchor: ${JSON.stringify(thread.anchor)}`,
      'Quoted anchor:',
      ...quotedLines(
        thread.quote ??
          (thread.anchor.kind === 'text-quote'
            ? thread.anchor.exact
            : JSON.stringify(thread.anchor)),
      ),
      ...thread.events.flatMap((event) =>
        'body' in event
          ? [
              `${event.kind} by ${JSON.stringify(event.author)}:`,
              ...quotedLines(event.body),
            ]
          : [],
      ),
    ]),
  ].join('\n');
}

/** The review intent commits before the inbox effect; the inbox owns turn placement. */
export class TaskReviewSend {
  constructor(private readonly ports: Ports) {}

  deliveryStatus(thread: TaskReviewThread): 'confirmed' | 'unconfirmed' {
    const sent = [...thread.events].reverse().find((e) => e.kind === 'sent');
    const task = this.ports.readTask(thread.taskId);
    if (
      sent?.kind !== 'sent' ||
      !task?.sessionId ||
      task.createdAt !== thread.taskCreatedAt
    )
      return 'unconfirmed';
    const entry = this.ports.inbox?.entry(
      this.ports.conversationOf(task.sessionId),
      sent.deliveryKey,
    );
    return entry && ['queued', 'sending', 'sent'].includes(entry.state)
      ? 'confirmed'
      : 'unconfirmed';
  }

  async send(
    write: TaskReviewWriteContext,
    input: TaskReviewSendRequest & { mode: TaskReviewSendMode },
  ): Promise<TaskReviewSendResponse> {
    if (write.author.kind !== 'person' || !write.beforeCommit())
      return { success: false, code: 'not-found', error: 'Task not found.' };
    const task = this.ports.readTask(write.taskId);
    if (
      !task?.sessionId ||
      task.createdAt !== write.taskCreatedAt ||
      task.status === 'done' ||
      task.status === 'canceled'
    )
      return {
        success: false,
        code: 'no-live-agent',
        error: 'There is no live lead agent for this Task.',
      };
    const lead = await this.ports.readLead(task.sessionId);
    if (
      !lead?.lifecycleState ||
      isSessionLifecycleStateStopped(lead.lifecycleState)
    )
      return {
        success: false,
        code: 'no-live-agent',
        error: 'There is no live lead agent for this Task.',
      };
    const current = () =>
      write.beforeCommit() &&
      this.ports.readTask(write.taskId)?.sessionId === task.sessionId;
    if (!current())
      return {
        success: false,
        code: 'not-found',
        error: 'The Task or lead changed.',
      };
    const context = { ...write, beforeCommit: current };
    const all = this.ports.store.listThreads(write);
    const threads = input.threadIds.map((id) =>
      all.find((t) => t.threadId === id),
    );
    if (!threads.length || threads.some((t) => !t))
      return {
        success: false,
        code: 'not-found',
        error: 'Review thread not found.',
      };
    const selected = threads.filter(
      (t): t is TaskReviewThread => t !== undefined,
    );
    const operationThreads = all.filter((t) =>
      t.events.some(
        (e) => e.kind === 'sent' && e.operationId === input.operationId,
      ),
    );
    if (
      operationThreads.length &&
      (operationThreads.length !== selected.length ||
        operationThreads.some((t) => !input.threadIds.includes(t.threadId)))
    )
      return {
        success: false,
        code: 'operation-conflict',
        error: 'That operation id names a different selection.',
      };
    const prior = operationThreads.length
      ? operationThreads[0]!.events.find(
          (e) => e.kind === 'sent' && e.operationId === input.operationId,
        )
      : selected[0]!.events.at(-1);
    const reusedKey =
      prior?.kind === 'sent' &&
      (operationThreads.length ||
        (selected.every(
          (t) =>
            t.events.at(-1)?.kind === 'sent' &&
            t.events.at(-1)?.operationId === prior.operationId,
        ) &&
          all.filter((t) =>
            t.events.some(
              (e) => e.kind === 'sent' && e.deliveryKey === prior.deliveryKey,
            ),
          ).length === selected.length))
        ? prior.deliveryKey
        : undefined;
    const deliveryKey = reusedKey ?? selectionKey(write, selected);
    let status: 'queued' | 'unconfirmed' | 'failed' = 'unconfirmed';
    let reason: string | undefined;
    if (!reusedKey) {
      // Reserve room for the failure or resolve event before admitting an effect.
      if (
        selected.some(
          (t) => t.events.length > TASK_REVIEW_LIMITS.eventsPerThread - 2,
        )
      )
        return {
          success: false,
          code: 'event-limit',
          error: 'Sending needs space for its outcome event.',
        };
      const recorded = this.ports.store.recordSend({
        ...context,
        threadIds: input.threadIds,
        deliveryKey,
        operationId: input.operationId,
        beforeCommit: () =>
          current() &&
          selected.every((thread) => {
            const now = this.ports.store.readThread({
              ...write,
              threadId: thread.threadId,
            });
            if (!now) return false;
            const last = now.events.at(-1);
            // Both the original selection and this transaction's appended intent are current.
            return (
              now.events.length === thread.events.length ||
              (now.events.length === thread.events.length + 1 &&
                last?.kind === 'sent' &&
                last.deliveryKey === deliveryKey &&
                last.operationId === input.operationId)
            );
          }),
      });
      if (!recorded.success) return recorded;
      try {
        const outcome =
          lead.ownerUserId && this.ports.inbox
            ? this.ports.inbox.submit({
                conversationId: lead.conversationId,
                clientTurnId: deliveryKey,
                payload: {
                  message: message(selected),
                  actor: { userId: lead.ownerUserId },
                  clientOrigin: {
                    version: CLIENT_ORIGIN_VERSION,
                    actor: { kind: 'internal' },
                    reported: UNKNOWN_CLIENT_REPORTED_ORIGIN,
                  },
                },
              }).outcome
            : 'unavailable';
        if (outcome === 'queued') status = 'queued';
        else {
          status = 'failed';
          reason = outcome;
        }
      } catch {
        status = 'failed';
        reason = 'error';
      }
      if (status === 'failed') {
        this.ports.logger.warn('task review send failed', {
          taskId: write.taskId,
          deliveryKey,
          reason,
        });
        const failed = this.ports.store.recordSendFailed({
          ...context,
          threadIds: input.threadIds,
          operationId: `${deliveryKey}-failed`,
          reason: 'The inbox did not queue this review send.',
        });
        if (!failed.success) return failed;
      }
    } else {
      const entry = this.ports.inbox?.entry(lead.conversationId, deliveryKey);
      if (entry && ['queued', 'sending', 'sent'].includes(entry.state))
        status = 'queued';
      else if (
        selected.some((t) =>
          t.events.some((e) => e.operationId === `${deliveryKey}-failed`),
        )
      )
        status = 'failed';
      // Never resubmit a retained intent: after a crash the inbox alone re-drives it.
    }
    if (status === 'queued' && input.mode === 'send-and-resolve') {
      for (const threadId of input.threadIds) {
        const resolved = this.ports.store.appendEvent({
          ...context,
          threadId,
          event: {
            kind: 'resolved',
            reason: 'sent-and-resolved',
            operationId: `${deliveryKey}-resolved`,
          },
        });
        if (!resolved.success) return resolved;
      }
    }
    const result = input.threadIds.map(
      (threadId) => this.ports.store.readThread({ ...write, threadId })!,
    );
    if (
      status === 'queued' &&
      result.some(
        (t) =>
          deriveThreadState(t.events) === 'sent' &&
          this.deliveryStatus(t) === 'unconfirmed',
      )
    )
      status = 'unconfirmed';
    return {
      success: true,
      data: {
        deliveryKey,
        status,
        threads: result.map((t) =>
          deriveThreadView(t, {
            status: 'unavailable',
            deliveryStatus: this.deliveryStatus(t),
          }),
        ),
        ...(status === 'unconfirmed'
          ? { reason: 'Send unconfirmed' }
          : reason
            ? { reason }
            : {}),
      },
    };
  }
}
