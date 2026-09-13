import type { BrowserContext } from '@playwright/test';

/** Provisioning is finished before the measured browsers own the workload. */
export function referenceBrowserProvisioningOwner(
  context: Pick<BrowserContext, 'close'>,
  releaseHandlers: () => void | Promise<void>,
) {
  let closing: Promise<void> | undefined;
  const close = () => {
    closing ??= (async () => {
      const failures: unknown[] = [];
      try {
        await releaseHandlers();
      } catch (error) {
        failures.push(error);
      }
      try {
        await context.close();
      } catch (error) {
        failures.push(error);
      }
      if (failures.length) throw failures[0];
    })();
    return closing;
  };
  return {
    close,
    async run<T>(operation: () => Promise<T>): Promise<T> {
      await close();
      return operation();
    },
  };
}
