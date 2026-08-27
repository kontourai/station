import type { Logger } from '../../utils/logger.js';

/** One total allowance for best-effort network delivery during teardown. */
export const OPTIONAL_NETWORK_SHUTDOWN_BUDGET_MS = 1_500;

export type OptionalNetworkShutdownTask = {
  name: string;
  shutdown: (signal: AbortSignal) => void | Promise<void>;
};

export async function shutdownOptionalNetworkWork(
  tasks: readonly OptionalNetworkShutdownTask[],
  options: {
    budgetMs?: number;
    logger: Pick<Logger, 'warn'>;
  },
): Promise<void> {
  if (tasks.length === 0) return;
  const controller = new AbortController();
  const budgetMs = options.budgetMs ?? OPTIONAL_NETWORK_SHUTDOWN_BUDGET_MS;
  const timeout = setTimeout(() => controller.abort(), budgetMs);
  const expired = new Promise<'expired'>((resolve) => {
    controller.signal.addEventListener('abort', () => resolve('expired'), {
      once: true,
    });
  });
  const settled = Promise.allSettled(
    tasks.map(async ({ name, shutdown }) => {
      try {
        await shutdown(controller.signal);
      } catch (error) {
        options.logger.warn(`Optional network shutdown failed: ${name}`, error);
      }
    }),
  );
  const result = await Promise.race([settled, expired]);
  clearTimeout(timeout);
  if (result === 'expired')
    options.logger.warn(
      'Optional network shutdown budget expired; discarding pending work.',
    );
}
