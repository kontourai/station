import { afterEach, beforeEach, vi } from 'vitest';
import { jobEventEnvironment } from '../../lib/ci-event-environment.mjs';
import { withoutFreshnessEnv } from '../../lib/documentation-freshness.mjs';

/**
 * #2934: freshness mode follows the job's environment (scoped on a pull
 * request, advisory in the merge queue and repo-scans job). A fixture test
 * that reads that ambient mode instead of pinning its own passes on one host
 * and fails in the queue. Tests that call this set an INVALID ambient mode,
 * so any unpinned read throws in every environment, deterministically.
 */
export const LEAKED_FRESHNESS_MODE = 'ambient-mode-leaked-into-a-fixture';

/**
 * The real job environment, for tests over the real ledger: the worker's
 * environment plus the event variables `vitest.setup.ts` scrubbed from it
 * (#2922). Without them `GITHUB_ACTIONS=true` alone reads as an unknown event
 * and the pull request's only freshness enforcement turns advisory.
 */
export const JOB_ENV: NodeJS.ProcessEnv = Object.freeze({
  ...process.env,
  ...jobEventEnvironment(),
});

export function forbidAmbientFreshnessMode() {
  beforeEach(() => {
    vi.stubEnv('STATION_DOCS_FRESHNESS', LEAKED_FRESHNESS_MODE);
    vi.stubEnv('GITHUB_ACTIONS', 'true');
    vi.stubEnv('GITHUB_EVENT_NAME', 'merge_group');
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });
}

/**
 * Environment for a spawned check or record command: the current process
 * environment without Git location or freshness variables, plus `pins`.
 * Built at call time so a missing scrub leaks the forbidden ambient mode.
 */
export function pinnedFreshnessEnv(
  pins: Record<string, string> = {},
): Record<string, string> {
  const scrubbed = withoutFreshnessEnv(process.env) as Record<string, string>;
  return {
    ...Object.fromEntries(
      Object.entries(scrubbed).filter(([key]) => !key.startsWith('GIT_')),
    ),
    ...pins,
  };
}
