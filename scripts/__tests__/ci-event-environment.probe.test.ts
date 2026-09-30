/**
 * Runs inside an ordinary test worker, in every lane: a pull request's
 * fast-checks, the merge queue and a local run. Wherever it runs, the worker
 * must not see the triggering event (#2922). Locally the variables are simply
 * absent; `ci-event-environment.test.ts` starts this file under a simulated
 * merge-queue environment so the scrub is proven off CI too.
 */
import { describe, expect, it } from 'vitest';
import { isEventScopedVariable } from '../lib/ci-event-environment.mjs';

describe('a test worker never inherits the triggering event', () => {
  it('sees no event-scoped variable', () => {
    expect(Object.keys(process.env).filter(isEventScopedVariable)).toEqual([]);
  });

  it('still sees whether it runs on CI', () => {
    // The parent sets this to prove the scrub is selective; on an ordinary
    // run it is whatever the host provides.
    if (process.env.STATION_EVENT_PROBE_EXPECT_ACTIONS === '1')
      expect(process.env.GITHUB_ACTIONS).toBe('true');
    expect(process.env.GITHUB_ACTIONS ?? 'unset').not.toBe('');
  });
});
