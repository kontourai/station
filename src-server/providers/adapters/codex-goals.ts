import {
  parseSessionGoal,
  parseSessionGoalCommand,
  SESSION_GOAL_OBJECTIVE_MAX_CHARS,
  type SessionGoal,
  type SessionGoalCommand,
  type SessionGoalControlResult,
  type SessionGoalRead,
} from '@kontourai/station-contracts/session-goal';
import type { CodexSessionRecord } from './codex-adapter-types.js';
import { CodexRpcError } from './codex-rpc-error.js';

const NATIVE_STATUSES: Record<string, SessionGoal['status']> = {
  active: 'active',
  paused: 'paused',
  blocked: 'blocked',
  usageLimited: 'usage-limited',
  budgetLimited: 'budget-limited',
  complete: 'complete',
};

function observedGoal(
  value: unknown,
  nativeThreadId: string,
): SessionGoal | null {
  if (value === null) return null;
  if (!value || typeof value !== 'object') throw Error('Invalid goal response');
  const data = value as Record<string, unknown>;
  if (data.threadId !== nativeThreadId) throw Error('Goal identity mismatch');
  const goal = parseSessionGoal({
    ...data,
    status:
      typeof data.status === 'string' ? NATIVE_STATUSES[data.status] : null,
    tokenBudget: data.tokenBudget ?? null,
  });
  if (!goal) throw Error('Invalid goal response');
  return goal;
}

export interface CodexGoalTransport {
  getSession(threadId: string): CodexSessionRecord | undefined;
  sendRequest(
    record: CodexSessionRecord,
    method: string,
    params: unknown,
  ): Promise<unknown>;
}

/** Native RPC stays private to the adapter; callers use the shared Goal contract. */
export class CodexGoals {
  private readonly pending = new WeakSet<CodexSessionRecord>();
  private readonly reading = new WeakSet<CodexSessionRecord>();

  constructor(
    private readonly transport: CodexGoalTransport,
    private readonly timeoutMs = 10_000,
  ) {}

  private live(threadId: string) {
    const record = this.transport.getSession(threadId);
    return record &&
      !record.stopped &&
      record.codexThreadId &&
      record.process.exitCode === null &&
      record.process.signalCode === null
      ? record
      : undefined;
  }

  private async request(
    record: CodexSessionRecord,
    method: string,
    params: unknown,
    onSettled?: () => void,
  ) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const request = (async () => {
        try {
          return await this.transport.sendRequest(record, method, params);
        } finally {
          onSettled?.();
        }
      })();
      const response = await Promise.race([
        request,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(Error('Goal request timed out')),
            this.timeoutMs,
          );
        }),
      ]);
      if (
        method === 'thread/goal/clear' &&
        response &&
        typeof response === 'object' &&
        'cleared' in response &&
        typeof response.cleared === 'boolean'
      )
        return null;
      if (!response || typeof response !== 'object' || !('goal' in response))
        throw Error('Invalid goal response');
      return observedGoal(response.goal, record.codexThreadId);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async read(threadId: string): Promise<SessionGoalRead> {
    const record = this.live(threadId);
    if (!record) return { state: 'unavailable', reason: 'session-not-live' };
    if (this.reading.has(record))
      return { state: 'unavailable', reason: 'provider-unavailable' };
    this.reading.add(record);
    try {
      const goal = await this.request(
        record,
        'thread/goal/get',
        {
          threadId: record.codexThreadId,
        },
        () => this.reading.delete(record),
      );
      if (this.live(threadId) !== record)
        return { state: 'unavailable', reason: 'session-not-live' };
      return {
        state: 'available',
        capability: {
          implementation: 'engine',
          operations: ['read', 'set', 'pause', 'clear'],
          maxObjectiveChars: SESSION_GOAL_OBJECTIVE_MAX_CHARS,
          tokenBudget: 'enforced-by-implementation',
          completion: 'implementation-reported',
          saveState: 'paused',
        },
        goal,
      };
    } catch (error) {
      if (error instanceof CodexRpcError && error.code === -32601)
        return { state: 'unsupported' };
      return { state: 'unavailable', reason: 'provider-unavailable' };
    }
  }

  async control(
    threadId: string,
    input: SessionGoalCommand,
  ): Promise<SessionGoalControlResult> {
    const command = parseSessionGoalCommand(input);
    if (!command) return { state: 'refused', reason: 'invalid-command' };
    // Native continuation must join Station's execution admission before activation.
    if (command.operation === 'resume') return { state: 'unsupported' };
    const record = this.live(threadId);
    if (!record) return { state: 'refused', reason: 'session-not-live' };
    if (this.pending.has(record)) return { state: 'refused', reason: 'busy' };
    this.pending.add(record);
    const method =
      command.operation === 'clear' ? 'thread/goal/clear' : 'thread/goal/set';
    const params = {
      threadId: record.codexThreadId,
      origin: 'user',
      ...(command.operation === 'set'
        ? {
            objective: command.objective,
            tokenBudget: command.tokenBudget,
            status: 'paused',
          }
        : command.operation === 'clear'
          ? {}
          : { status: 'paused' }),
    };
    try {
      const goal = await this.request(record, method, params, () =>
        this.pending.delete(record),
      );
      if (
        (command.operation === 'set' &&
          (!goal ||
            goal.objective !== command.objective ||
            goal.status !== 'paused' ||
            goal.tokenBudget !== command.tokenBudget)) ||
        (command.operation === 'pause' && goal?.status !== 'paused')
      )
        return { state: 'indeterminate' };
      return this.live(threadId) === record
        ? { state: 'applied', goal }
        : { state: 'indeterminate' };
    } catch (error) {
      if (error instanceof CodexRpcError && error.code === -32601)
        return { state: 'unsupported' };
      return { state: 'indeterminate' };
    }
  }
}
