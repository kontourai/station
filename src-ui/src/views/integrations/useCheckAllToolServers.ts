import type { ToolServerCheckAll } from '@kontourai/station-contracts/tool';
import {
  type IntegrationViewModel,
  useCheckAllIntegrationsMutation,
} from '@kontourai/station-sdk';
import { useCallback, useEffect, useRef, useState } from 'react';
import { userFacingErrorMessage } from '../../utils/errorText';

export interface CheckAllResult {
  checked: number;
  /** Names of servers whose check failed or could not run. */
  failed: string[];
  /** Names of servers that want a sign-in, which Check all never begins. */
  signIn: string[];
  /** Names of servers signed in per person, which Check all leaves out. */
  skipped: string[];
  /** Why the batch itself could not run. */
  error?: string;
}

/** The servers Check all probes: those Station does not run, turned on. */
const checkable = (servers: readonly IntegrationViewModel[]) =>
  servers.filter((server) => !server.builtin && server.enabled !== false);

function summarize(
  data: ToolServerCheckAll,
  servers: readonly IntegrationViewModel[],
): CheckAllResult {
  const names = new Map(
    servers.map((server) => [server.id, server.displayName || server.id]),
  );
  const named = (outcome: ToolServerCheckAll['results'][number]['outcome']) =>
    data.results
      .filter((result) => result.outcome === outcome)
      .map((result) => names.get(result.id) ?? result.id);
  const skipped = named('skipped');
  return {
    checked: data.results.length - skipped.length,
    failed: named('failed'),
    signIn: named('sign-in-required'),
    skipped,
  };
}

/**
 * Check all: one server batch (`POST /integrations/check-all`) that probes
 * the configured tool servers three at a time and never begins a sign-in.
 * One batch at a time from here; another surface's request joins the batch
 * on the server. Leaving does not cancel the request: its answer still
 * refreshes the tool server list (the mutation's own invalidation), and only
 * this view's state stops updating.
 */
export function useCheckAllToolServers(
  servers: readonly IntegrationViewModel[],
) {
  const { mutateAsync } = useCheckAllIntegrationsMutation();
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<CheckAllResult | null>(null);
  const pending = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const run = useCallback(async () => {
    if (pending.current) return;
    pending.current = true;
    setRunning(true);
    setResult(null);
    try {
      const data = await mutateAsync({});
      if (mounted.current) setResult(summarize(data, servers));
    } catch (error: unknown) {
      if (mounted.current)
        setResult({
          checked: 0,
          failed: [],
          signIn: [],
          skipped: [],
          error: `Check all could not run: ${userFacingErrorMessage(error)}`,
        });
    } finally {
      pending.current = false;
      if (mounted.current) setRunning(false);
    }
  }, [mutateAsync, servers]);
  return {
    run,
    running,
    result,
    /** Nothing to check: no server Check all would probe. */
    nothingToCheck: checkable(servers).length === 0,
  };
}

/** One short sentence per fact, for the notice under the list. */
export function checkAllSummary(result: CheckAllResult): string[] {
  if (result.error) return [result.error];
  const lines = [
    result.failed.length === 0
      ? `Checked ${result.checked}.`
      : `Checked ${result.checked}; ${result.failed.length} failed: ${result.failed.join(', ')}.`,
  ];
  if (result.signIn.length > 0)
    lines.push(
      `${result.signIn.length} need you to sign in: ${result.signIn.join(', ')}.`,
    );
  if (result.skipped.length > 0)
    lines.push(
      `Skipped ${result.skipped.length} signed in per person: ${result.skipped.join(', ')}.`,
    );
  return lines;
}
