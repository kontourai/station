const STARTUP_DEADLINE_MS = 30_000;
const deadline = performance.now() + STARTUP_DEADLINE_MS;

export class NativeStartupTimeout extends Error {
  constructor(stage: string) {
    super(`Station stopped waiting for ${stage}.`);
  }
}

/** A single renderer startup budget. Late results cannot advance the boot. */
export async function beforeNativeStartupDeadline<T>(
  stage: string,
  pending: Promise<T>,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      pending,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new NativeStartupTimeout(stage)),
          Math.max(0, deadline - performance.now()),
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
