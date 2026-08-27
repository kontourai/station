import { afterEach, describe, expect, it } from 'vitest';
import { resolveE2ERunnerSelection } from '../lib/e2e-runner-options.mjs';

/**
 * station#4464 review: no test existed for `resolveE2ERunnerSelection` —
 * the runner's ONLY source of `--screens`. The docs/spec-comment bug the
 * review caught (claiming `STATION_E2E_SCREENS=... npm run test:e2e:screenshot`
 * works through the runner) would have been caught here: this function never
 * reads `process.env.STATION_E2E_SCREENS`, so `run-e2e-suite.mjs`'s spawned
 * Playwright env (`STATION_E2E_SCREENS: screens ? screens.join(',') : undefined`)
 * always clears an ambient value when no `--screens` flag is present.
 */
describe('resolveE2ERunnerSelection', () => {
  const suite = 'screenshot';
  const suiteSpecs = ['tests/screenshots.spec.ts'];
  const originalStationE2EScreens = process.env.STATION_E2E_SCREENS;

  afterEach(() => {
    if (originalStationE2EScreens === undefined) {
      delete process.env.STATION_E2E_SCREENS;
    } else {
      process.env.STATION_E2E_SCREENS = originalStationE2EScreens;
    }
  });

  it('parses --screens into a trimmed, comma-separated name list', () => {
    const { screens } = resolveE2ERunnerSelection(
      ['--screens= home , agents ,'],
      suite,
      suiteSpecs,
    );
    expect(screens).toEqual(['home', 'agents']);
  });

  it('leaves screens undefined when --screens is not passed at all', () => {
    const { screens } = resolveE2ERunnerSelection([], suite, suiteSpecs);
    expect(screens).toBeUndefined();
  });

  it('rejects a bare --screens with no value', () => {
    expect(() =>
      resolveE2ERunnerSelection(['--screens='], suite, suiteSpecs),
    ).toThrow(/--screens requires a value/);
  });

  it('rejects a --screens value that reduces to zero names after trimming', () => {
    expect(() =>
      resolveE2ERunnerSelection(['--screens=, ,'], suite, suiteSpecs),
    ).toThrow(/--screens requires at least one screen name/);
  });

  it('rejects --screens passed more than once', () => {
    expect(() =>
      resolveE2ERunnerSelection(
        ['--screens=a', '--screens=b'],
        suite,
        suiteSpecs,
      ),
    ).toThrow(/--screens may be provided only once/);
  });

  it('never reads STATION_E2E_SCREENS from the environment — argv is the only source, so the spawned env is always cleared when no flag is passed', () => {
    process.env.STATION_E2E_SCREENS = 'zzz-ambient-leak';
    const { screens } = resolveE2ERunnerSelection([], suite, suiteSpecs);
    expect(screens).toBeUndefined();
    // Mirrors the exact expression run-e2e-suite.mjs uses to build the
    // spawned Playwright process's env — pinned here so a future refactor
    // of that one-liner can't quietly start reading the ambient var again
    // and silently re-widen an unflagged run to a targeted one (or vice
    // versa).
    const spawnedStationE2EScreens = screens ? screens.join(',') : undefined;
    expect(spawnedStationE2EScreens).toBeUndefined();
  });
});
