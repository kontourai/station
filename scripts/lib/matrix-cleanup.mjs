export function createMatrixCleanup() {
  let interrupted = false;
  const pending = new Map();
  const owned = new Set();
  const trackCleanup = (label, operation) => {
    let promise;
    const once = () => {
      if (!promise)
        promise = Promise.resolve()
          .then(operation)
          .then((value) => {
            pending.delete(once);
            return value;
          });
      return promise;
    };
    pending.set(once, label);
    owned.add(label);
    return once;
  };
  const onSignal = (signal) => {
    if (interrupted) return;
    interrupted = true;
    const finish = () => {
      console.error(
        `Interrupted (${signal}); cleanup unconfirmed: ${[...pending.values()].join(', ') || 'none'}. Run-owned ids: ${[...owned].join(', ')}`,
      );
      process.exit(signal === 'SIGINT' ? 130 : 143);
    };
    // Attempt every compensation concurrently: a stalled stop must not block DELETEs.
    const deadline = setTimeout(finish, 5000);
    void Promise.allSettled(
      [...pending.keys()].reverse().map((run) => run()),
    ).then(() => {
      clearTimeout(deadline);
      finish();
    });
  };
  const onInterrupt = () => onSignal('SIGINT');
  const onTerminate = () => onSignal('SIGTERM');
  process.on('SIGINT', onInterrupt);
  process.on('SIGTERM', onTerminate);
  return {
    trackCleanup,
    get interrupted() {
      return interrupted;
    },
    dispose() {
      process.off('SIGINT', onInterrupt);
      process.off('SIGTERM', onTerminate);
    },
  };
}
