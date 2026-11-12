import {
  type IntegrationViewModel,
  useReconnectIntegrationMutation,
} from '@kontourai/station-sdk';
import { useCallback, useState } from 'react';
import {
  CHECK_ALL_CONCURRENCY,
  planCheckAll,
  runBounded,
} from './tool-server-status';

export interface CheckAllResult {
  checked: number;
  /** Names of servers whose check failed or could not run. */
  failed: string[];
  /** Names of servers left out because a check could ask to sign in. */
  skipped: string[];
}

const nameOf = (server: IntegrationViewModel) =>
  server.displayName || server.id;

/**
 * Check all: probes the configured tool servers through the same check as
 * each server's own button, at most `CHECK_ALL_CONCURRENCY` at a time, and
 * never one that could start a sign-in (`planCheckAll`).
 */
export function useCheckAllToolServers(
  servers: readonly IntegrationViewModel[],
) {
  const reconnect = useReconnectIntegrationMutation();
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<CheckAllResult | null>(null);
  const { mutateAsync } = reconnect;
  const run = useCallback(async () => {
    const plan = planCheckAll(servers);
    setRunning(true);
    setResult(null);
    const settled = await runBounded(
      plan.probe,
      CHECK_ALL_CONCURRENCY,
      (server) => mutateAsync(server.id),
    );
    setRunning(false);
    setResult({
      checked: plan.probe.length,
      failed: plan.probe
        .filter((_, index) => {
          const outcome = settled[index];
          return (
            outcome?.status !== 'fulfilled' || outcome.value.probe?.ok !== true
          );
        })
        .map(nameOf),
      skipped: plan.skipped.map(nameOf),
    });
  }, [mutateAsync, servers]);
  return {
    run,
    running,
    result,
    /** Nothing to check: no server Check all would probe. */
    nothingToCheck: planCheckAll(servers).probe.length === 0,
  };
}

/** One short sentence per fact, for the notice under the list. */
export function checkAllSummary(result: CheckAllResult): string[] {
  const lines = [
    result.failed.length === 0
      ? `Checked ${result.checked}.`
      : `Checked ${result.checked}; ${result.failed.length} failed: ${result.failed.join(', ')}.`,
  ];
  if (result.skipped.length > 0)
    lines.push(
      `Skipped ${result.skipped.length} that may ask you to sign in: ${result.skipped.join(', ')}.`,
    );
  return lines;
}
