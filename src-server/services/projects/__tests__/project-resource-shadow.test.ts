/**
 * station#1501 slice 3a — the migration shadow at the session-cwd seam.
 *
 * These tests exist to make the divergence record TRUSTWORTHY, because slice
 * 3c is gated on it being empty. A shadow whose agreement rules are wrong
 * produces an empty log for the wrong reason, and that empty log would then
 * be used to justify flipping the highest-risk seam in the arc.
 *
 * So the coverage is deliberately shaped around TRANSITIONS rather than
 * snapshots (the slice-0 blockers were both already-persisted state that no
 * later write could correct, and every test there walked a monotone path):
 * A -> B -> A on the project's working directory, a resolver rebuilt from
 * disk after a write, and the upgrade path from an install that predates
 * manifests entirely.
 */

import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { ProjectConfig } from '@kontourai/station-contracts/project';
import type { ResourceResolutionResult } from '@kontourai/station-contracts/project-identity';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { putProject } from '../../../domain/__tests__/file-storage-test-helpers.js';
import { FileStorageAdapter } from '../../../domain/file-storage-adapter.js';
import { projectResourceShadowComparisons } from '../../../telemetry/metrics.js';
import { expandTilde } from '../../../utils/paths.js';
import type { CheckoutRemoteReader } from '../checkout-remote-reader.js';
import { ProjectBindingsStore } from '../project-binding-store.js';
import {
  type ProjectManifestRecord,
  projectManifestPath,
} from '../project-manifest-store.js';
import { ProjectResourceResolver } from '../project-resource-resolver.js';
import {
  baselineCwdOutcome,
  CONFLATED_UNBOUND_NOTE,
  type CwdShadowSample,
  compareCwdShadow,
  dispatchCwdShadow,
  observeCwdShadow,
  SHADOW_LOG_DEDUPE,
  SHADOW_RECORD_FAILURE_LATCH,
} from '../project-resource-shadow.js';

const tmpRoots: string[] = [];

/**
 * The Station home these tests hand the observer.
 *
 * `homeDir` is mandatory on `CwdShadowDeps` so that forgetting it in the
 * production wiring is a type error rather than a fabricated divergence
 * record. Tests that inject `resolve` never reach it for RESOLUTION — but
 * since station#1686 the observer also appends its durable observation record
 * there, so it has to be a real writable directory. Pointing it at a
 * throwaway per-test home means every test below exercises the PRODUCTION
 * record path (`deps.record` left unset) instead of a stub, which is what
 * makes the record's own failure mode observable at all.
 */
let observerHome: string;

beforeEach(() => {
  observerHome = tempDir('station-1686-observer-home-');
  SHADOW_RECORD_FAILURE_LATCH.warned = false;
});

afterEach(() => {
  while (tmpRoots.length > 0) {
    const dir = tmpRoots.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
  delete process.env.STATION_PROJECT_RESOURCE_SHADOW;
  // Process-wide, so it leaks between tests: without this, a test asserting a
  // warn line for a (slug, outcome) an earlier test already logged silently
  // observes zero. Found by a fault injection that narrowed the dedupe key.
  SHADOW_LOG_DEDUPE.clear();
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tmpRoots.push(dir);
  return dir;
}

async function saveProject(
  adapter: FileStorageAdapter,
  overrides: Partial<ProjectConfig> & { slug: string },
): Promise<ProjectConfig> {
  const now = new Date().toISOString();
  const project: ProjectConfig = {
    id: randomUUID(),
    name: 'Acme',
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
  await putProject(adapter, project);
  return project;
}

/** A single-git-resource manifest sidecar, written straight to disk. */
function writeManifestRecord(
  home: string,
  slug: string,
  manifestId: string,
  canonicalRemote: string,
): void {
  const record: ProjectManifestRecord = {
    schemaVersion: 1,
    id: manifestId,
    repos: [
      { kind: 'git', id: canonicalRemote, canonicalRemote, role: 'primary' },
    ],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  mkdirSync(join(home, 'projects', slug), { recursive: true });
  writeFileSync(
    projectManifestPath(home, slug),
    JSON.stringify(record, null, 2),
  );
}

function sample(overrides: Partial<CwdShadowSample> = {}): CwdShadowSample {
  return {
    projectSlug: 'acme',
    provider: 'claude',
    baseline: { kind: 'no-directory' },
    ...overrides,
  };
}

describe('baselineCwdOutcome — the seam projected onto its own three outcomes', () => {
  test('an absent project directory is the deliberate no-directory terminus, not a failure', () => {
    expect(baselineCwdOutcome(undefined)).toEqual({ kind: 'no-directory' });
  });

  test('a declared directory that exists is where the session launches', () => {
    const dir = tempDir('station-1501-baseline-');
    expect(baselineCwdOutcome(dir)).toEqual({ kind: 'directory', path: dir });
  });

  test('a declared directory that is gone is the #791 fail-closed branch', () => {
    const dir = join(tempDir('station-1501-baseline-'), 'gone');
    expect(baselineCwdOutcome(dir)).toEqual({
      kind: 'missing-directory',
      path: dir,
    });
  });

  test('existence is asked of the injected probe, so the shadow can never disagree with the seam about the path itself', () => {
    const exists = vi.fn().mockReturnValue(true);
    expect(baselineCwdOutcome('/x/y', exists)).toEqual({
      kind: 'directory',
      path: '/x/y',
    });
    // The seam already absolutized and tilde-expanded; re-deriving here is
    // exactly how a shadow acquires divergences of its own.
    expect(exists).toHaveBeenCalledWith('/x/y');
  });
});

describe('dispatchCwdShadow — the observer never runs on the caller stack', () => {
  test('the observer has NOT been called when dispatch returns, and IS called a check-phase turn later', async () => {
    // The discriminating assertion for the deferral. Draining the check phase
    // before an assertion can only POSTPONE it, never make it fail, so a
    // seam-level test that awaits and then asserts the sample cannot tell a
    // deferred dispatch from a direct call. This can: it asserts the negative
    // at the instant the helper returns.
    const calls: CwdShadowSample[] = [];
    dispatchCwdShadow(
      (received) => {
        calls.push(received);
      },
      { projectSlug: 'acme', provider: 'claude', projectCwd: undefined },
    );
    expect(calls).toEqual([]);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(calls).toEqual([
      {
        projectSlug: 'acme',
        provider: 'claude',
        baseline: { kind: 'no-directory' },
      },
    ]);
  });

  test('the baseline existence probe runs in the deferred turn, not on the caller stack', () => {
    // The seam stats `suppliedCwd ?? projectCwd`, so with a caller-supplied
    // cwd it never touches the project's own directory. Building the sample
    // at the seam would add a stat the seam had no reason to perform — on a
    // stale network mount, an unbounded one.
    //
    // Asserting only "the observer has not been called yet" would NOT catch a
    // sample built eagerly and merely delivered late (a fault injection that
    // did exactly that stayed green). So the directory is created BETWEEN the
    // dispatch and the deferred turn: an eager probe reports
    // `missing-directory`, a deferred one reports `directory`.
    const parent = tempDir('station-1501-defer-');
    const dir = join(parent, 'appears-later');
    const deferred: (() => void)[] = [];
    let observed: CwdShadowSample | undefined;
    dispatchCwdShadow(
      (received) => {
        observed = received;
      },
      { projectSlug: 'acme', provider: 'claude', projectCwd: dir },
      (callback) => deferred.push(callback),
    );
    expect(observed).toBeUndefined();
    expect(deferred).toHaveLength(1);
    mkdirSync(dir, { recursive: true });
    deferred[0]?.();
    expect(observed?.baseline).toEqual({ kind: 'directory', path: dir });
  });

  test('an unwired observer is a no-op and schedules nothing', () => {
    const deferred: (() => void)[] = [];
    dispatchCwdShadow(
      undefined,
      { projectSlug: 'acme', provider: 'claude', projectCwd: undefined },
      (callback) => deferred.push(callback),
    );
    expect(deferred).toEqual([]);
  });

  test('a throwing observer is contained inside the deferred turn', () => {
    const deferred: (() => void)[] = [];
    dispatchCwdShadow(
      () => {
        throw new Error('hostile observer');
      },
      { projectSlug: 'acme', provider: 'claude', projectNotFound: true },
      (callback) => deferred.push(callback),
    );
    expect(() => deferred[0]?.()).not.toThrow();
  });
});

describe('compareCwdShadow — the agreement rules', () => {
  const bound = (path: string): ResourceResolutionResult => ({
    state: 'bound',
    resourceId: 'local:acme',
    path,
  });
  const unbound: ResourceResolutionResult = {
    state: 'unbound',
    resourceId: 'local:acme',
    reason: 'no binding',
  };
  /** station#1594: a RECORD exists and its path is gone. */
  const missing = (declaredPath: string): ResourceResolutionResult => ({
    state: 'missing',
    resourceId: 'local:acme',
    reason: `the working directory "${declaredPath}" does not exist`,
    record: 'working-directory',
    declaredPath,
  });
  /** station#1594: the directory was observed; whose repo it is was not. */
  const unverified = (
    state: 'stale' | 'drifted',
    unverifiedPath: string,
  ): ResourceResolutionResult => ({
    state,
    resourceId: 'github.com/acme/api',
    reason: `could not verify ${unverifiedPath}`,
    unverifiedPath,
  });

  test('same directory on both sides agrees', () => {
    const result = compareCwdShadow(
      sample({ baseline: { kind: 'directory', path: '/repo' } }),
      { ok: true, result: bound('/repo') },
    );
    expect(result.outcome).toBe('agree');
    expect(result.shadowPath).toBe('/repo');
  });

  test('a different directory is path-mismatch, never rounded to agreement', () => {
    const result = compareCwdShadow(
      sample({ baseline: { kind: 'directory', path: '/repo' } }),
      { ok: true, result: bound('/elsewhere') },
    );
    expect(result.outcome).toBe('path-mismatch');
  });

  test('baseline resolves but the shadow names nothing: shadow-unresolved', () => {
    const result = compareCwdShadow(
      sample({ baseline: { kind: 'directory', path: '/repo' } }),
      { ok: true, result: unbound },
    );
    expect(result.outcome).toBe('shadow-unresolved');
    expect(result.detail).toBe('no binding');
  });

  test('a directory-less project resolving `unbound` agrees — #1023 is a valid outcome, not a divergence', () => {
    // This is the rule that decides whether the divergence log is readable
    // at all: `default` (and every organizational-scope project) takes this
    // branch on EVERY session start.
    const comparison = compareCwdShadow(
      sample({ baseline: { kind: 'no-directory' } }),
      { ok: true, result: unbound },
    );
    expect(comparison.outcome).toBe('agree');
    expect(comparison.shadowState).toBe('unbound');
  });

  test('station#1594: a directory-less project DISagrees when the shadow names a directory through `unverifiedPath` too — not only through `bound`', () => {
    // Before #1594 `stale`/`drifted` could carry no directory at all, so this
    // pair folded into `agree`. Now they can, and a resolver naming one where
    // the project declares none means a binding row the seam cannot see. That
    // is a real divergence and it must not be rounded away by the same fold
    // that made #1594's own conflation invisible.
    for (const state of ['stale', 'drifted'] as const) {
      const comparison = compareCwdShadow(
        sample({ baseline: { kind: 'no-directory' } }),
        { ok: true, result: unverified(state, '/bound/elsewhere') },
      );
      expect(comparison.outcome).toBe('shadow-resolved');
      expect(comparison.shadowPath).toBe('/bound/elsewhere');
    }
  });

  test('station#1594: baseline and shadow name the SAME directory from `unverifiedPath` — an agreement, and NOT a divergence', () => {
    // The manifested-git population on a host where `git` cannot be run. The
    // baseline seam never identity-checked anything, so "the directory is there,
    // I could not confirm whose repo it is" is exactly as strong a claim as
    // the baseline seam ever made. Calling it a divergence would fabricate a
    // record that reads as "do not flip" — the mirror of the emptiness trap.
    //
    // `stale` and `drifted` get DIFFERENT outcome names (review round 1):
    // folded together, a `drifted` sample could satisfy #1501's gate clause
    // written for the `stale` leg, and the gate would read as covered by a
    // population it never observed.
    expect(
      compareCwdShadow(
        sample({ baseline: { kind: 'directory', path: '/repo' } }),
        { ok: true, result: unverified('stale', '/repo') },
      ),
    ).toMatchObject({
      outcome: 'agree-unverified',
      shadowPath: '/repo',
      shadowState: 'stale',
    });
    expect(
      compareCwdShadow(
        sample({ baseline: { kind: 'directory', path: '/repo' } }),
        { ok: true, result: unverified('drifted', '/repo') },
      ),
    ).toMatchObject({
      outcome: 'agree-drifted',
      shadowPath: '/repo',
      shadowState: 'drifted',
    });
  });

  test('station#1594: baseline `no-directory` AGREES only with `unbound` — the one state the flip sends to $HOME', () => {
    // Review round 1, MEDIUM: this branch used to fold on "did the resolver
    // name a directory", which is the wrong axis now that the flip mapping is
    // per state. Baseline `no-directory` defaults to $HOME; shadow `missing`
    // would THROW naming project + declaredPath. Recording that as `agree`
    // empties the record for a population whose flip behaviour changes — the
    // emptiness trap the 3a review caught, mirrored.
    expect(
      compareCwdShadow(sample({ baseline: { kind: 'no-directory' } }), {
        ok: true,
        result: unbound,
      }).outcome,
    ).toBe('agree');
    for (const result of [
      missing('/gone'),
      {
        state: 'ambiguous',
        resourceId: '',
        reason: 'two primaries',
      } as ResourceResolutionResult,
    ]) {
      const comparison = compareCwdShadow(
        sample({ baseline: { kind: 'no-directory' } }),
        { ok: true, result },
      );
      expect(comparison.outcome).toBe('shadow-unresolved');
      expect(comparison.outcome).not.toBe('agree');
    }
  });

  test('station#1594: an `unverifiedPath` that points somewhere ELSE is still `path-mismatch` — the weaker claim is not a weaker comparison', () => {
    for (const state of ['stale', 'drifted'] as const) {
      expect(
        compareCwdShadow(
          sample({ baseline: { kind: 'directory', path: '/repo' } }),
          { ok: true, result: unverified(state, '/elsewhere') },
        ).outcome,
      ).toBe('path-mismatch');
    }
  });

  test('a directory-less project DISagrees when the shadow names a path — that flip would send a session somewhere the seam never would', () => {
    const result = compareCwdShadow(
      sample({ baseline: { kind: 'no-directory' } }),
      {
        ok: true,
        result: bound('/somewhere'),
      },
    );
    expect(result.outcome).toBe('shadow-resolved');
    expect(result.shadowPath).toBe('/somewhere');
  });

  test('station#1594: the #791 missing-directory branch now AGREES with `missing` — the honest agreement this comparison could not previously express', () => {
    // Before the split, both sides said "no usable directory" and the
    // resolver could only say `unbound` — which also meant "this project is
    // an organizational scope" (#1023, must terminate at $HOME). One state,
    // two opposite contracts, so the comparison had to record a non-agreement
    // (`conflated-unbound`) to keep the record honest. `missing` is the
    // discriminator, and this is the population it was created for.
    const baseline = { kind: 'missing-directory' as const, path: '/gone' };
    const comparison = compareCwdShadow(sample({ baseline }), {
      ok: true,
      result: missing('/gone'),
    });
    expect(comparison.outcome).toBe('agree');
    expect(comparison.shadowState).toBe('missing');
    // An agreement, so no note and no log line — the note names a regression.
    expect(comparison.detail).not.toContain(CONFLATED_UNBOUND_NOTE);
  });

  test('station#1594: `conflated-unbound` is now a FAIL-OPEN TRIPWIRE — it must read zero before the flip, and it watches two causes', () => {
    // Kept rather than deleted. A tripwire removed once it stops firing
    // cannot tell you when it starts again — and the thing it watches for is
    // precisely the defect #1594 existed to fix.
    const baseline = { kind: 'missing-directory' as const, path: '/gone' };
    const conflated = compareCwdShadow(sample({ baseline }), {
      ok: true,
      result: unbound,
    });
    expect(conflated.outcome).toBe('conflated-unbound');
    // The resolver's own sentence survives, with the note appended.
    expect(conflated.detail).toContain('no binding');
    expect(conflated.detail).toContain(CONFLATED_UNBOUND_NOTE);
    expect(
      compareCwdShadow(sample({ baseline }), {
        ok: true,
        result: bound('/gone'),
      }).outcome,
    ).toBe('shadow-resolved');
  });

  test('station#1594: a declared-and-gone directory the resolver answers with neither a path nor `missing` is `shadow-unresolved`, and carries no note', () => {
    // The note asserts a specific fact about re-conflation. `ambiguous` and
    // the access states are distinguishable answers with different repairs;
    // telling their reader that the #791/#1023 discriminator is missing would
    // bury a real finding under the wrong prescription.
    const baseline = { kind: 'missing-directory' as const, path: '/gone' };
    for (const state of [
      'ambiguous',
      'unresolvable',
      'not-portable',
    ] as const) {
      const result = compareCwdShadow(sample({ baseline }), {
        ok: true,
        result: {
          state,
          resourceId: state === 'ambiguous' ? '' : 'r',
          reason: 'a distinguishable fact',
        } as ResourceResolutionResult,
      });
      expect(result.outcome).toBe('shadow-unresolved');
      expect(result.detail).toBe('a distinguishable fact');
      expect(result.detail).not.toContain(CONFLATED_UNBOUND_NOTE);
    }
    // …and a `stale`/`drifted` answer names a directory, so it is the
    // resolved-where-baseline-found-nothing case instead.
    expect(
      compareCwdShadow(sample({ baseline }), {
        ok: true,
        result: unverified('stale', '/gone'),
      }).outcome,
    ).toBe('shadow-resolved');
  });

  test('a resolver throw is shadow-threw, and is NOT folded into agreement', () => {
    // Decision 4: otherwise slice 3c could be justified by a log that is
    // empty because the shadow never successfully ran.
    const result = compareCwdShadow(
      sample({ baseline: { kind: 'directory', path: '/repo' } }),
      { ok: false, error: new Error('manifest unreadable') },
    );
    expect(result.outcome).toBe('shadow-threw');
    expect(result.detail).toBe('manifest unreadable');
    expect(result.shadowState).toBeUndefined();
  });

  test('both sides failing closed on an unknown project is `both-failed-closed`, which does not claim a shared cause', () => {
    // The resolver also throws for an unreadable manifest and a corrupt
    // bindings store. Labelling those `agree` would assert a cause the
    // comparison never checked; the detail carries the real one.
    const result = compareCwdShadow(
      sample({ baseline: { kind: 'project-not-found' } }),
      {
        ok: false,
        error: new Error('Project not found: acme'),
      },
    );
    expect(result.outcome).toBe('both-failed-closed');
    expect(result.detail).toBe('Project not found: acme');
  });

  test('the seam has no such project but the resolver answers for one: shadow-found-project', () => {
    // The two sides read the project store through different APIs
    // (`listProjects()` vs `FileStorageAdapter.getProject`). This is the one
    // divergence a flip could not paper over.
    const result = compareCwdShadow(
      sample({ baseline: { kind: 'project-not-found' } }),
      {
        ok: true,
        result: unbound,
      },
    );
    expect(result.outcome).toBe('shadow-found-project');
  });
});

describe('observeCwdShadow — reporting, containment, and the kill switch', () => {
  test('every comparison lands a counter point carrying BOTH sides of the record', async () => {
    // The counter's `baseline` + `shadow` attributes are the only machine
    // channel in which `conflated-unbound` is distinguishable from an
    // ordinary agreement, so an unasserted attribute set is a real gap: the
    // whole slice-3c gate reads this dimensioning.
    const add = vi.spyOn(projectResourceShadowComparisons, 'add');
    try {
      await observeCwdShadow(
        sample({ baseline: { kind: 'missing-directory', path: '/gone' } }),
        {
          homeDir: observerHome,
          logged: new Set(),
          resolve: async () => ({
            state: 'unbound',
            resourceId: 'r',
            reason: 'gone',
          }),
        },
      );
      expect(add).toHaveBeenCalledWith(1, {
        seam: 'start_session_cwd',
        provider: 'claude',
        outcome: 'conflated-unbound',
        baseline: 'missing-directory',
        shadow: 'unbound',
      });
    } finally {
      add.mockRestore();
    }
  });

  test('the kill switch counts `disabled` so a quiet record can never be mistaken for a quiet shadow', async () => {
    process.env.STATION_PROJECT_RESOURCE_SHADOW = 'off';
    const add = vi.spyOn(projectResourceShadowComparisons, 'add');
    try {
      await observeCwdShadow(sample(), { homeDir: observerHome });
      expect(add).toHaveBeenCalledWith(1, {
        seam: 'start_session_cwd',
        provider: 'claude',
        outcome: 'disabled',
        baseline: 'no-directory',
      });
    } finally {
      add.mockRestore();
    }
  });

  test('a repeated divergence is logged ONCE per (project, outcome) but counted every time', async () => {
    // One misconfigured project on a busy Station otherwise emits a warn line
    // per session start forever, and a second, genuinely distinct divergence
    // drowns in it. The gate needs the SET of projects, not the count.
    const logger = { warn: vi.fn() };
    const logged = new Set<string>();
    const add = vi.spyOn(projectResourceShadowComparisons, 'add');
    const deps = {
      homeDir: observerHome,
      logger,
      logged,
      resolve: async (): Promise<ResourceResolutionResult> => ({
        state: 'drifted',
        resourceId: 'r',
        reason: 'elsewhere',
        unverifiedPath: '/elsewhere',
      }),
    };
    try {
      const baseline = { kind: 'directory' as const, path: '/repo' };
      await observeCwdShadow(sample({ baseline }), deps);
      await observeCwdShadow(sample({ baseline }), deps);
      await observeCwdShadow(sample({ baseline }), deps);
      expect(logger.warn).toHaveBeenCalledTimes(1);
      expect(add).toHaveBeenCalledTimes(3);
      // A DIFFERENT project is a different entry in the record.
      await observeCwdShadow(sample({ projectSlug: 'other', baseline }), deps);
      expect(logger.warn).toHaveBeenCalledTimes(2);
    } finally {
      add.mockRestore();
    }
  });

  test('the PRODUCTION dedupe channel works with no `logged` injected', async () => {
    // Every other dedupe assertion injects its own Set, so swapping the
    // module-level default for a fresh Set per call would leave them all
    // green and restore the per-session-start log flood the dedupe exists to
    // stop. `afterEach` clears SHADOW_LOG_DEDUPE, so this is deterministic.
    const logger = { warn: vi.fn() };
    const deps = {
      homeDir: observerHome,
      logger,
      resolve: async (): Promise<ResourceResolutionResult> => ({
        state: 'drifted',
        resourceId: 'r',
        reason: 'elsewhere',
        unverifiedPath: '/elsewhere',
      }),
    };
    const baseline = { kind: 'directory' as const, path: '/repo' };
    await observeCwdShadow(sample({ baseline }), deps);
    await observeCwdShadow(sample({ baseline }), deps);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect([...SHADOW_LOG_DEDUPE]).toEqual(['acme path-mismatch']);
  });

  test('station#1594: `agree-unverified` and `agree-drifted` are COUNTED but NOT LOGGED', async () => {
    // Verifier round 1 caught this gap by fault injection: dropping
    // `agree-unverified` from NON_DIVERGENT_OUTCOMES passed all 40 shadow
    // tests, while in production it would emit a warn line for EVERY
    // manifested-git project that is stale or drifted — precisely the
    // fabricated "do not flip" record this module exists to prevent. The
    // metric is emitted before the gate, so the log is the only observable
    // and nothing asserted it.
    for (const [state, outcome] of [
      ['stale', 'agree-unverified'],
      ['drifted', 'agree-drifted'],
    ] as const) {
      const logger = { warn: vi.fn() };
      const add = vi.spyOn(projectResourceShadowComparisons, 'add');
      try {
        const comparison = await observeCwdShadow(
          sample({ baseline: { kind: 'directory', path: '/repo' } }),
          {
            homeDir: observerHome,
            logger,
            logged: new Set(),
            resolve: async (): Promise<ResourceResolutionResult> => ({
              state,
              resourceId: 'github.com/acme/api',
              reason: 'could not verify',
              unverifiedPath: '/repo',
            }),
          },
        );
        expect(comparison.outcome).toBe(outcome);
        expect(logger.warn).not.toHaveBeenCalled();
        // …and it IS counted, with the outcome distinguishable from `agree`:
        // slice 3c reads this counter for population coverage.
        expect(add).toHaveBeenCalledWith(1, {
          seam: 'start_session_cwd',
          provider: 'claude',
          outcome,
          baseline: 'directory',
          shadow: state,
        });
      } finally {
        add.mockRestore();
      }
    }
  });

  test('`both-failed-closed` is not logged as a divergence: it is the seam working', async () => {
    const logger = { warn: vi.fn() };
    const comparison = await observeCwdShadow(
      sample({ baseline: { kind: 'project-not-found' } }),
      {
        homeDir: observerHome,
        logger,
        logged: new Set(),
        resolve: async () => {
          throw new Error('Project not found: acme');
        },
      },
    );
    expect(comparison.outcome).toBe('both-failed-closed');
    expect(logger.warn).not.toHaveBeenCalled();
  });

  test('an agreement logs nothing', async () => {
    const logger = { warn: vi.fn() };
    const comparison = await observeCwdShadow(
      sample({ baseline: { kind: 'directory', path: '/repo' } }),
      {
        homeDir: observerHome,
        logger,
        resolve: async () => ({
          state: 'bound',
          resourceId: 'r',
          path: '/repo',
        }),
      },
    );
    expect(comparison.outcome).toBe('agree');
    expect(logger.warn).not.toHaveBeenCalled();
  });

  test('with NO injected resolver it reads the home it was given, not the ambient STATION_HOME default', async () => {
    // The `resolveProjectResource` convenience wrapper defaults to
    // `resolveHomeDir()`; the runtime's project store is
    // `configLoader.getProjectHomeDir()`. On any instance with a custom home
    // those differ, and a shadow reading the wrong store reports EVERY
    // project as a divergence — an entirely fabricated record, and one that
    // would be read as a reason not to flip.
    const home = tempDir('station-1501-home-');
    const checkout = tempDir('station-1501-home-checkout-');
    await saveProject(new FileStorageAdapter(home), {
      slug: 'homed',
      workingDirectory: checkout,
    });
    // Point the ambient default somewhere with no such project, so the only
    // way to resolve `homed` is through the supplied `homeDir`.
    const previousStationHome = process.env.STATION_HOME;
    process.env.STATION_HOME = tempDir('station-1501-decoy-home-');
    try {
      const comparison = await observeCwdShadow(
        {
          projectSlug: 'homed',
          provider: 'claude',
          baseline: { kind: 'directory', path: checkout },
        },
        { homeDir: home },
      );
      expect(comparison.outcome).toBe('agree');
      expect(comparison.shadowPath).toBe(checkout);
    } finally {
      if (previousStationHome === undefined) delete process.env.STATION_HOME;
      else process.env.STATION_HOME = previousStationHome;
    }
  });

  test('a divergence logs one line naming both sides and the resolver reason', async () => {
    const logger = { warn: vi.fn() };
    const comparison = await observeCwdShadow(
      sample({ baseline: { kind: 'directory', path: '/repo' } }),
      {
        homeDir: observerHome,
        logger,
        resolve: async (): Promise<ResourceResolutionResult> => ({
          state: 'drifted',
          resourceId: 'github.com/acme/api',
          reason: 'the checkout advertises [github.com/acme/other]',
          // station#1594: `drifted` now REPORTS the directory it observed, so
          // a divergence at this seam is a path mismatch rather than the
          // shadow naming nothing at all.
          unverifiedPath: '/elsewhere',
        }),
      },
    );
    expect(comparison.outcome).toBe('path-mismatch');
    expect(logger.warn).toHaveBeenCalledTimes(1);
    const meta = logger.warn.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(meta).toMatchObject({
      seam: 'start_session_cwd',
      projectSlug: 'acme',
      outcome: 'path-mismatch',
      baselineKind: 'directory',
      baselinePath: '/repo',
      shadowState: 'drifted',
      // station#1594: the line names the directory the shadow would have used,
      // which is the whole reason the mismatch is actionable.
      shadowPath: '/elsewhere',
      detail: 'the checkout advertises [github.com/acme/other]',
    });
  });

  test('a throwing resolver is contained and reported, never rethrown', async () => {
    const logger = { warn: vi.fn() };
    const comparison = await observeCwdShadow(
      sample({ baseline: { kind: 'directory', path: '/repo' } }),
      {
        homeDir: observerHome,
        logger,
        resolve: async () => {
          throw new Error('unknown manifest schemaVersion 99');
        },
      },
    );
    expect(comparison.outcome).toBe('shadow-threw');
    expect(comparison.detail).toContain('schemaVersion 99');
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  test('STATION_PROJECT_RESOURCE_SHADOW=off records `disabled` and never resolves — silence from the kill switch is not silence from agreement', async () => {
    process.env.STATION_PROJECT_RESOURCE_SHADOW = 'OFF';
    const resolve = vi.fn();
    const logger = { warn: vi.fn() };
    const comparison = await observeCwdShadow(
      sample({ baseline: { kind: 'directory', path: '/repo' } }),
      { homeDir: observerHome, logger, resolve },
    );
    expect(comparison.outcome).toBe('disabled');
    expect(resolve).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
  });

  test('any other value of the kill switch leaves the shadow on', async () => {
    process.env.STATION_PROJECT_RESOURCE_SHADOW = 'on';
    const resolve = vi
      .fn()
      .mockResolvedValue({ state: 'bound', resourceId: 'r', path: '/repo' });
    const comparison = await observeCwdShadow(
      sample({ baseline: { kind: 'directory', path: '/repo' } }),
      { homeDir: observerHome, resolve },
    );
    expect(comparison.outcome).toBe('agree');
    expect(resolve).toHaveBeenCalledTimes(1);
  });
});

/**
 * The transitions. Each of these drives the REAL resolver against a real
 * on-disk store, because the agreement rules above are only worth as much as
 * their contact with what `resolveProjectResource` actually returns.
 */
describe('observeCwdShadow against the real resolver — transitions, not snapshots', () => {
  interface Harness {
    home: string;
    adapter: FileStorageAdapter;
    bindings: ProjectBindingsStore;
    /** A fresh resolver every call: nothing may be carried in memory. */
    resolve: (slug: string) => Promise<ResourceResolutionResult>;
  }

  function createHarness(readRemotes?: CheckoutRemoteReader): Harness {
    const home = tempDir('station-1501-shadow-home-');
    const adapter = new FileStorageAdapter(home);
    const bindings = new ProjectBindingsStore(home);
    return {
      home,
      adapter,
      bindings,
      resolve: (slug) =>
        // Constructed per call on purpose — this is the "restart" in
        // restart-after-write: every resolution re-reads the store from disk.
        new ProjectResourceResolver({
          homeDir: home,
          source: new FileStorageAdapter(home),
          bindings: new ProjectBindingsStore(home),
          ...(readRemotes ? { readRemotes } : {}),
        }).resolveProjectResource(slug),
    };
  }

  async function observe(
    harness: Harness,
    slug: string,
    projectCwd: string | undefined,
  ) {
    return observeCwdShadow(
      {
        projectSlug: slug,
        provider: 'claude',
        baseline: baselineCwdOutcome(projectCwd),
      },
      { homeDir: observerHome, resolve: harness.resolve },
    );
  }

  test('PINNED: a whitespace-only workingDirectory trips `conflated-unbound` — a real fail-open hazard for the flip, not tripwire noise', async () => {
    // Found by review round 1. The seam does
    // `resolve(expandTilde(project.workingDirectory))` with NO trim
    // (`orchestration-service.ts`), the resolver does
    // `project.workingDirectory?.trim()`, and the route schema accepts an
    // untrimmed string. So the two sides disagree about whether a directory
    // was DECLARED at all: seam says declared-and-gone (throws today, #791),
    // resolver says nothing-recorded (would default to $HOME post-flip).
    //
    // Pinned rather than repaired here: the repair is either the resolver's
    // trim (slice 2 behaviour) or the seam itself (slice 3c's surface), and
    // both are somebody else's slice to review.
    //
    // DISCLOSED TEST-POWER GAP (delta review): this pins the RESOLVER leg —
    // removing `project.workingDirectory?.trim()` reds it — but the seam leg
    // is REPRODUCED here, not executed. `resolveStartSessionCwd` is not
    // exported, so a future change that adds `?.trim()` there would silently
    // leave this test green while the hazard it names has gone. That is
    // acceptable in this direction (the test would over-report, not
    // under-report) and slice 3c owns the seam, but it is not the full
    // both-sided pin the wording above might suggest.
    const harness = createHarness();
    await saveProject(harness.adapter, {
      slug: 'blank',
      workingDirectory: '   ',
    });
    // Reproduce the seam's own derivation verbatim — it does not trim.
    const seamCwd = resolve(expandTilde('   '));
    const comparison = await observe(harness, 'blank', seamCwd);
    expect(comparison.baseline.kind).toBe('missing-directory');
    expect(comparison.shadowState).toBe('unbound');
    expect(comparison.outcome).toBe('conflated-unbound');
    expect(comparison.detail).toContain('FAIL-OPEN TRIPWIRE');
  });

  test('UPGRADE PATH: an install predating manifests agrees on the baseline branch', async () => {
    // No manifest sidecar is ever written here, which is the state of every
    // project created before slice 2 shipped.
    const harness = createHarness();
    const dir = tempDir('station-1501-baseline-repo-');
    await saveProject(harness.adapter, {
      slug: 'baseline',
      workingDirectory: dir,
    });

    const comparison = await observe(harness, 'baseline', dir);
    expect(comparison.outcome).toBe('agree');
    expect(comparison.shadowState).toBe('bound');
    expect(comparison.shadowPath).toBe(dir);
  });

  test('A -> B -> A: a project loses its working directory and gets it back, and the shadow agrees at every step', async () => {
    const harness = createHarness();
    const dir = tempDir('station-1501-ab-repo-');
    const project = await saveProject(harness.adapter, {
      slug: 'ab',
      workingDirectory: dir,
    });

    // A: bound to a real directory.
    expect((await observe(harness, 'ab', dir)).outcome).toBe('agree');

    // B: the directory is cleared. The seam's #1023 terminus; the resolver's
    // `unbound`. Agreement here is the rule the whole log depends on.
    await putProject(harness.adapter, {
      ...project,
      workingDirectory: undefined,
    });
    const cleared = await observe(harness, 'ab', undefined);
    expect(cleared.outcome).toBe('agree');
    expect(cleared.shadowState).toBe('unbound');

    // A again: re-pointed at the same directory. A stale in-memory read would
    // surface here, and a resolver that had cached `unbound` would report a
    // divergence that does not exist.
    await putProject(harness.adapter, { ...project, workingDirectory: dir });
    const restored = await observe(harness, 'ab', dir);
    expect(restored.outcome).toBe('agree');
    expect(restored.shadowPath).toBe(dir);
  });

  test('A -> B -> A on the DIRECTORY itself: deleted and recreated under the same path', async () => {
    const harness = createHarness();
    const parent = tempDir('station-1501-dir-ab-');
    const dir = join(parent, 'repo');
    mkdirSync(dir, { recursive: true });
    await saveProject(harness.adapter, {
      slug: 'dir-ab',
      workingDirectory: dir,
    });

    expect((await observe(harness, 'dir-ab', dir)).outcome).toBe('agree');

    // The #791 branch: the seam will throw, and — since station#1594 — the
    // resolver reports `missing` with `record: 'working-directory'`. That is
    // the honest AGREEMENT this comparison could not previously express: it
    // had to record `conflated-unbound`, because `unbound` also meant "this is
    // a scope-only project" and the two need opposite behavior after the flip.
    //
    // This assertion is the end-to-end proof of the #1594 fix — through the
    // REAL resolver, not a double — and `conflated-unbound` is now the
    // regression tripwire that fires if the split is ever undone.
    rmSync(dir, { recursive: true, force: true });
    const gone = await observe(harness, 'dir-ab', dir);
    expect(gone.outcome).toBe('agree');
    expect(gone.shadowState).toBe('missing');
    expect(gone.outcome).not.toBe('conflated-unbound');

    mkdirSync(dir, { recursive: true });
    const back = await observe(harness, 'dir-ab', dir);
    expect(back.outcome).toBe('agree');
    expect(back.shadowState).toBe('bound');
  });

  test('RESTART AFTER WRITE: a manifest written after the first resolution is picked up by the next one', async () => {
    // A resolver instance that had cached "no manifest" would keep resolving
    // through the compat branch forever, and the divergence log would be
    // empty for a reason that has nothing to do with the two paths agreeing.
    const harness = createHarness(async () => ({
      ok: true,
      remotes: [{ name: 'origin', url: 'git@github.com:acme/api.git' }],
    }));
    const dir = tempDir('station-1501-restart-repo-');
    await saveProject(harness.adapter, {
      slug: 'restart',
      workingDirectory: dir,
    });

    const before = await observe(harness, 'restart', dir);
    expect(before.outcome).toBe('agree');
    expect(before.shadowState).toBe('bound');
    expect(before.detail).toBeUndefined();

    writeManifestRecord(
      harness.home,
      'restart',
      'proj_restart',
      'github.com/acme/api',
    );

    const after = await observe(harness, 'restart', dir);
    expect(after.outcome).toBe('agree');
    expect(after.shadowState).toBe('bound');
    // The resource id moved from the compat `local:` id to the canonical
    // remote, which is exactly the DISCLOSED GAP slice 2 recorded — and it
    // does not change where the session launches, so it is not a divergence.
    expect(after.shadowPath).toBe(dir);
  });

  test('station#1594: DRIFT at the SAME directory is `agree-drifted`, not a divergence — and the drift itself is still recorded', async () => {
    // Re-derived by station#1594, and the reasoning matters because the
    // previous name of this test asserted the opposite.
    //
    // The working directory is a checkout of a DIFFERENT repository than the
    // manifest names. Before #1594 the resolver could name no directory at
    // all here, so the comparison read `shadow-unresolved` — a divergence,
    // and a correct one AT THE TIME: flipping would have turned "chat works"
    // into "chat fails" for this project.
    //
    // With `unverifiedPath`, the flip hands the seam the same directory the
    // baseline path would have used, so there is no behavior difference left to
    // diverge about. The baseline seam NEVER identity-checked anything; calling
    // this a divergence would fabricate a record that reads as "do not flip"
    // for a population the flip does not change.
    //
    // What is NOT lost: `shadowState` carries `drifted`, and the counter
    // dimensions it, so drift stays countable and separable from `stale`. What
    // IS lost, deliberately and disclosed: drift no longer produces a warn
    // line. Drift is a real operator concern, but it is a RESOURCE-STATUS
    // concern (§3.6's repair prompt, slice 4's surface) rather than a
    // migration divergence, and a migration shadow that logs it would make the
    // slice-3c record unreadable for a fact the flip does not affect.
    const harness = createHarness(async () => ({
      ok: true,
      remotes: [{ name: 'origin', url: 'git@github.com:acme/other.git' }],
    }));
    const dir = tempDir('station-1501-drift-repo-');
    await saveProject(harness.adapter, {
      slug: 'drift',
      workingDirectory: dir,
    });
    writeManifestRecord(
      harness.home,
      'drift',
      'proj_drift',
      'github.com/acme/api',
    );

    const comparison = await observe(harness, 'drift', dir);
    expect(comparison.outcome).toBe('agree-drifted');
    expect(comparison.shadowState).toBe('drifted');
    expect(comparison.shadowPath).toBe(dir);
    expect(comparison.detail).toContain('acme/other');
  });

  test('station#1594: an UNVERIFIABLE checkout — no `git` on the host — is `agree-unverified` too, which is the S2-revert population', async () => {
    // The population that grows with every `createProject` backfill: a
    // manifested git resource on a host where `git` cannot be run (absent from
    // a service PATH, an unreadable `.git`, an `index.lock` race). Before
    // #1594 this resolved `stale` with no path, so a flip would have sent the
    // session to $HOME or thrown — the S2 404 shape applied to every engine
    // session. This is the leg slice 3c's gate requires evidence for.
    const harness = createHarness(async () => ({
      ok: false,
      reason: 'git executable not found',
    }));
    const dir = tempDir('station-1501-nogit-repo-');
    await saveProject(harness.adapter, {
      slug: 'nogit',
      workingDirectory: dir,
    });
    writeManifestRecord(
      harness.home,
      'nogit',
      'proj_nogit',
      'github.com/acme/api',
    );

    const comparison = await observe(harness, 'nogit', dir);
    expect(comparison.outcome).toBe('agree-unverified');
    expect(comparison.shadowState).toBe('stale');
    expect(comparison.shadowPath).toBe(dir);
  });

  test('an unknown project fails closed on both sides', async () => {
    const harness = createHarness();
    const comparison = await observeCwdShadow(
      {
        projectSlug: 'nope',
        provider: 'claude',
        baseline: { kind: 'project-not-found' },
      },
      { homeDir: observerHome, resolve: harness.resolve },
    );
    expect(comparison.outcome).toBe('both-failed-closed');
  });
});
