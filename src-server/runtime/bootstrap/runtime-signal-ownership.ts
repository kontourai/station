/** Station's entry point owns process exit after all runtime services drain. */
export function withStationShutdownOwnership<T>(construct: () => T): T {
  const signals = ['SIGINT', 'SIGTERM'] as const;
  const before = new Map(
    signals.map((signal) => [signal, new Set(process.rawListeners(signal))]),
  );
  try {
    return construct();
  } finally {
    // VoltAgent installs one-shot process-exiting handlers synchronously in
    // its constructor. Remove only those additions, preserving the supervisor
    // and other existing owners. Runtime shutdown explicitly stops VoltAgent.
    for (const signal of signals) {
      for (const listener of process.rawListeners(signal)) {
        if (!before.get(signal)?.has(listener))
          process.removeListener(signal, listener);
      }
    }
  }
}
