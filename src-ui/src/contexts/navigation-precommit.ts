/** Action-only admission state. The NavigationStore still owns guards and route commit. */
export function runNavigationPrecommit(
  admission: {
    current: () => boolean;
    prepare: () => Promise<boolean>;
    signal: AbortSignal;
  },
  runGuards: (proceed: () => void, cancel: () => void) => void,
  commit: () => boolean,
): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (committed: boolean) => {
      if (settled) return;
      settled = true;
      admission.signal.removeEventListener('abort', abort);
      resolve(committed);
    };
    const abort = () => finish(false);
    const current = () => {
      try {
        return (
          !settled && !admission.signal.aborted && admission.current() === true
        );
      } catch {
        return false;
      }
    };
    admission.signal.addEventListener('abort', abort, { once: true });
    if (!current()) return finish(false);
    let started = false;
    try {
      runGuards(
        () => {
          if (started || !current()) {
            if (!started) finish(false);
            return;
          }
          started = true;
          void (async () => {
            try {
              finish((await admission.prepare()) && current() && commit());
            } catch {
              finish(false);
            }
          })();
        },
        () => finish(false),
      );
    } catch {
      finish(false);
    }
  });
}
