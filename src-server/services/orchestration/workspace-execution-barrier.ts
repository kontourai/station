type WorkspaceState = {
  activeThreads: Set<string>;
  terminalDuringStart: Set<string>;
  starting: number;
  exclusive: boolean;
  waiters: Array<() => void>;
};

/** Serializes destructive workspace operations against every turn using that workspace. */
export class WorkspaceExecutionBarrier {
  private readonly states = new Map<string, WorkspaceState>();
  private readonly workspaceByThread = new Map<string, string>();

  async runTurnStart<T>(
    workspaceKey: string,
    threadId: string,
    operation: () => Promise<T>,
    retain: () => boolean,
  ): Promise<T> {
    const state = this.state(workspaceKey);
    while (state.exclusive) await this.wait(state);
    state.starting += 1;
    this.workspaceByThread.set(threadId, workspaceKey);
    try {
      const result = await operation();
      if (!state.terminalDuringStart.delete(threadId) && retain())
        state.activeThreads.add(threadId);
      else this.workspaceByThread.delete(threadId);
      return result;
    } catch (error) {
      this.releaseThread(threadId);
      throw error;
    } finally {
      state.starting -= 1;
      this.drain(workspaceKey, state);
    }
  }

  async runExclusive<T>(
    workspaceKey: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const state = this.state(workspaceKey);
    if (state.exclusive || state.starting > 0 || state.activeThreads.size > 0)
      throw new WorkspaceExecutionBusyError();
    state.exclusive = true;
    try {
      return await operation();
    } finally {
      state.exclusive = false;
      this.drain(workspaceKey, state);
    }
  }

  releaseThread(threadId: string): void {
    const workspaceKey = this.workspaceByThread.get(threadId);
    if (!workspaceKey) return;
    this.workspaceByThread.delete(threadId);
    const state = this.states.get(workspaceKey);
    if (!state) return;
    if (!state.activeThreads.delete(threadId) && state.starting > 0)
      state.terminalDuringStart.add(threadId);
    this.drain(workspaceKey, state);
  }

  private wait(state: WorkspaceState): Promise<void> {
    return new Promise((resolve) => state.waiters.push(resolve));
  }

  private drain(key: string, state: WorkspaceState): void {
    if (state.exclusive || state.starting > 0 || state.activeThreads.size > 0)
      return;
    const waiters = state.waiters.splice(0);
    for (const resolve of waiters) resolve();
    if (waiters.length === 0) this.states.delete(key);
  }

  private state(key: string): WorkspaceState {
    let state = this.states.get(key);
    if (!state) {
      state = {
        activeThreads: new Set(),
        terminalDuringStart: new Set(),
        starting: 0,
        exclusive: false,
        waiters: [],
      };
      this.states.set(key, state);
    }
    return state;
  }
}

export class WorkspaceExecutionBusyError extends Error {
  constructor() {
    super('workspace_has_active_turn');
    this.name = 'WorkspaceExecutionBusyError';
  }
}
