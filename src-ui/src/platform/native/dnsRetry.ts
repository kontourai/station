/** Retry only a host resolver failure, which occurs before HTTP dispatch. */
export async function withNativeDnsRetry<T>(
  attempt: () => Promise<T>,
  options: {
    signal?: AbortSignal | null;
    disabled?: boolean;
    beforeRetry?: () => void;
  } = {},
): Promise<T> {
  const { signal } = options;
  for (let retry = 0; ; retry += 1) {
    try {
      return await attempt();
    } catch (error) {
      if (
        retry >= 2 ||
        options.disabled ||
        signal?.aborted ||
        !(error instanceof Error) ||
        !('code' in error) ||
        error.code !== 'transport_dns'
      )
        throw error;
      options.beforeRetry?.();
      await new Promise<void>((resolve, reject) => {
        const abort = () => {
          clearTimeout(timer);
          signal?.removeEventListener('abort', abort);
          reject(new DOMException('Aborted', 'AbortError'));
        };
        const timer = setTimeout(
          () => {
            signal?.removeEventListener('abort', abort);
            resolve();
          },
          250 * 2 ** retry,
        );
        signal?.addEventListener('abort', abort, { once: true });
        if (signal?.aborted) abort();
      });
    }
  }
}
