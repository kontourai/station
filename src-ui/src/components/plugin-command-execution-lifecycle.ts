interface PluginCommandExecutionClaim {
  readonly signal: AbortSignal;
  isCurrent(): boolean;
  release(): void;
}

let epoch = 0;
const active = new Set<AbortController>();

/** Bind one pending local effect to the currently installed plugin inventory. */
export function beginPluginCommandExecution(): PluginCommandExecutionClaim {
  const admittedEpoch = epoch;
  const controller = new AbortController();
  active.add(controller);
  let released = false;
  return Object.freeze({
    signal: controller.signal,
    isCurrent: () =>
      !released && !controller.signal.aborted && epoch === admittedEpoch,
    release: () => {
      if (released) return;
      released = true;
      active.delete(controller);
    },
  });
}

/** Withdraw pending effects before a replacement plugin projection can appear. */
export function retirePluginCommandExecutions(): void {
  epoch += 1;
  for (const controller of active) controller.abort();
  active.clear();
}
