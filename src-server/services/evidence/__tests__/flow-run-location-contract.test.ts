import { join } from 'node:path';
import { flowRoot, flowRuntimeRoot, runDir } from '@kontourai/flow';
import { describe, expect, test } from 'vitest';
import {
  flowRunArtifactReference,
  flowRunDir,
  flowRunsRoot,
  STATION_ARTIFACT_ROOTS,
  STATION_LEGACY_ROOTS,
} from '../local-artifact-paths.js';

/**
 * archive#290 pins Station's generated-run location to Flow's, and the ONLY thing
 * that made that true was Station spelling `.kontourai/flow/runs` in its own
 * source. That is a mirror of an upstream contract with no trip-wire: if Flow
 * moved its runtime root, Station would keep computing the old directory and
 * discovery would quietly return nothing — a silent empty list, not a failure.
 * Flow publishes `runDir()`/`flowRuntimeRoot()`/`flowRoot()`, so these tests
 * assert Station's paths ARE Flow's, and fail the build if they ever diverge.
 */
describe('Flow run location contract (#290)', () => {
  const cwd = '/tmp/example-workspace';

  /*
   * There is deliberately NO `expect(flowRunDir(cwd, id)).toBe(runDir(id,
   * cwd))` here, nor the subtler `.toBe(join(flowRuntimeRoot(cwd), 'runs',
   * id))`. Both restate `runDir`'s own implementation, so they hold by
   * construction for any Flow version. Injection proved it: patching Flow's
   * `flowRuntimeRoot` to a different directory left both green while the two
   * tests below went red. An assertion only has power here when it compares
   * STATION's own spelling of the layout against a Flow helper — which is
   * exactly what the next two do, and why `flowRunsRoot` is kept.
   *
   * The revert-to-a-local-join regression is owned by the unsafe-run-id test
   * further down (also injection-proven): a bare `join` cannot refuse an id.
   */
  test("Station's runs root is Flow's runtime root, not its durable .flow root", () => {
    expect(flowRunsRoot(cwd)).toBe(join(flowRuntimeRoot(cwd), 'runs'));
    // The durable authored root is a DIFFERENT contract that archive#290 leaves
    // alone; generated state must never resolve underneath it.
    expect(flowRunsRoot(cwd).startsWith(flowRoot(cwd))).toBe(false);
  });

  test('the workspace-relative reference used in event payloads agrees with Flow', () => {
    // Derived, not spelled: the relative constant must be exactly what Flow's
    // absolute path yields under a workspace. Both sides normalize through
    // `path.join`, so this holds on win32 too — a POSIX string literal here
    // would fail there, which would be a poor look for a portability pin.
    expect(join(cwd, flowRunArtifactReference('run-1', 'report.json'))).toBe(
      join(runDir('run-1', cwd), 'report.json'),
    );
    expect(STATION_ARTIFACT_ROOTS.flowRuns).toBe(
      join('.kontourai', 'flow', 'runs'),
    );
  });

  test('an unsafe run id is refused rather than joined into a traversing path', () => {
    // `discardRun` feeds this path to a recursive `rm`. Flow's runDir()
    // asserts the id is a single safe segment; a bare join() would not.
    for (const unsafe of ['../escape', 'a/b', '..', '', 'x\0y']) {
      expect(() => flowRunDir(cwd, unsafe)).toThrow();
    }
    expect(flowRunDir(cwd, 'safe-run.1_x')).toBe(runDir('safe-run.1_x', cwd));
  });

  /*
   * Narrow by design, and titled for what it actually enforces. This checks
   * ONE constant; it is not the guard against a reintroduced legacy read,
   * because nothing in the flow-run resolution path consults
   * `STATION_LEGACY_ROOTS` — a fallback would be written in
   * `flow-run-service.ts` and would sail past this. That regression is owned
   * by "a run present only under the legacy .flow/runs is not discovered" in
   * `src-server/services/flow/__tests__/flow-run-service.test.ts`, whose
   * fixture is a real Flow-resolvable run precisely so it can catch one.
   */
  test('STATION_LEGACY_ROOTS does not name .flow/runs', () => {
    const legacy = Object.values(STATION_LEGACY_ROOTS) as string[];
    expect(
      legacy.some((root) => root.replace(/\\/g, '/') === '.flow/runs'),
    ).toBe(false);
  });
});
