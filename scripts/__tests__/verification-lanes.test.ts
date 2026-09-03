import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { e2eManifest } from '../../tests/e2e-manifest.mjs';
import { REQUIRED_STATIC_WORKSPACES } from '../prepare-verify-static.mjs';
import { PREPUSH_TEST_GROUPS } from '../prepush-test-manifest.mjs';
import { sweepInterruptedBuildDirs } from '../run-e2e-suite.mjs';
import { collectProvenance } from '../run-prepush-tier.mjs';
import { TEST_IMPACT_MANIFEST } from '../test-impact-manifest.mjs';
import {
  CANONICAL_COMPLETION_COMMAND,
  CANONICAL_COMPLETION_LANE,
  CI_FAST_TIMEOUT_MS,
  CLASS_LABELS,
  FULL_REGRESSION_PHASES,
  FULL_REGRESSION_TIMEOUT_MS,
  invalidationRule,
  LANE_CLASSES,
  LANE_IDS,
  LANES,
  laneManifestDigest,
  renderLaneCatalogTable,
  resolveLane,
  validateLaneCatalog,
} from '../verification-lanes.mjs';

const packageJson = JSON.parse(readFileSync('package.json', 'utf8')) as {
  scripts: Record<string, string>;
  'trust-reconcile-manifest': Array<{ id: string; command: string }>;
};

function lane(overrides: Record<string, unknown> = {}) {
  return {
    id: 'alpha',
    command: 'npm run alpha',
    publicScript: 'alpha',
    class: LANE_CLASSES.FOCUSED,
    completion: false,
    diagnostic: true,
    weight: 50,
    timeoutMs: 60_000,
    ownedOutputs: [],
    manifest: null,
    trigger: 'alpha trigger',
    scope: 'alpha scope',
    description: 'alpha lane',
    ...overrides,
  };
}

function catalogErrors(...lanes: object[]) {
  return validateLaneCatalog(lanes).errors;
}

function e2eAssignmentIdentity() {
  return e2eManifest
    .map((entry) => ({ path: entry.path, bucket: entry.bucket }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

describe('canonical completion lane literal', () => {
  it('pins the exact canonical lane id and command string', () => {
    expect(CANONICAL_COMPLETION_LANE).toBe('full-regression');
    expect(CANONICAL_COMPLETION_COMMAND).toBe('npm run full:regression');
  });

  it('exposes exactly one completion lane whose command is the literal', () => {
    const completion = LANES.filter((entry) => entry.completion);
    expect(completion).toHaveLength(1);
    expect(completion[0]).toBe(resolveLane(CANONICAL_COMPLETION_LANE));
    expect(completion[0].command).toBe(CANONICAL_COMPLETION_COMMAND);
    expect(completion[0].class).toBe(LANE_CLASSES.COMPLETION);
    expect(completion[0].completion).toBe(true);
    expect(completion[0].diagnostic).toBe(false);
  });

  it('keeps full-regression public while declaring bounded internal scheduling phases', () => {
    expect(resolveLane('full-regression').weight).toBe(1);
    expect(FULL_REGRESSION_PHASES).toEqual([
      expect.objectContaining({ id: 'repo-governance', weight: 20 }),
      expect.objectContaining({ id: 'sdk-builds', weight: 50 }),
      expect.objectContaining({ id: 'verify-static', weight: 60 }),
      ...Array.from({ length: 8 }, (_, index) =>
        expect.objectContaining({
          id: `test-full-ordinary-${index + 1}-of-8`,
          weight: 80,
        }),
      ),
      expect.objectContaining({ id: 'test-full-process-heavy', weight: 60 }),
      expect.objectContaining({
        id: 'test-full-process-exclusive',
        weight: 60,
      }),
      expect.objectContaining({
        id: 'test-full-credential-ledger-exclusive',
        weight: 60,
      }),
      expect.objectContaining({ id: 'test-full-shared-output', weight: 60 }),
      expect.objectContaining({
        id: 'test-full-dogfood-reconcile',
        weight: 60,
      }),
      expect.objectContaining({ id: 'app-builds', weight: 60 }),
    ]);
    for (const phase of FULL_REGRESSION_PHASES)
      expect(phase.timeoutMs).toBeGreaterThan(0);
    for (const shard of Array.from({ length: 8 }, (_, index) => index + 1))
      expect(
        FULL_REGRESSION_PHASES.find(
          (phase) => phase.id === `test-full-ordinary-${shard}-of-8`,
        ),
      ).toMatchObject({
        command: `npm run test:full:ordinary:${shard}:raw`,
        privateScript: `test:full:ordinary:${shard}:raw`,
        timeoutMs: 20 * 60_000,
        weight: 80,
      });
    expect(
      FULL_REGRESSION_PHASES.find(
        (phase) => phase.id === 'test-full-process-heavy',
      )?.timeoutMs,
    ).toBe(30 * 60_000);
    expect(resolveLane('full-regression').phases).toBe(FULL_REGRESSION_PHASES);
    expect(FULL_REGRESSION_TIMEOUT_MS).toBe(
      FULL_REGRESSION_PHASES.reduce(
        (total, phase) => total + phase.timeoutMs,
        0,
      ),
    );
    expect(FULL_REGRESSION_TIMEOUT_MS).toBe(249 * 60_000);
    expect(resolveLane('full-regression').timeoutMs).toBe(
      FULL_REGRESSION_TIMEOUT_MS,
    );
    expect(resolveLane('ci-fast')).toMatchObject({
      completion: false,
      diagnostic: true,
      timeoutMs: CI_FAST_TIMEOUT_MS,
      weight: 20,
    });
    for (const phase of FULL_REGRESSION_PHASES.filter((entry) =>
      entry.id.startsWith('test-full-ordinary-'),
    ))
      expect(resolveLane('ci-fast').weight + phase.weight).toBe(100);
  });

  it('keeps every other lane diagnostic and non-completion', () => {
    for (const entry of LANES) {
      if (entry.id === CANONICAL_COMPLETION_LANE) continue;
      expect(entry.completion).toBe(false);
      expect(entry.diagnostic).toBe(true);
    }
  });

  it('declares an explicit deadline for every lane and completion phase', () => {
    for (const entry of LANES) expect(entry.timeoutMs).toBeGreaterThan(0);
    for (const phase of FULL_REGRESSION_PHASES)
      expect(phase.timeoutMs).toBeGreaterThan(0);
  });
});

describe('lane catalog identity', () => {
  it('exposes the stable intentional lane id set', () => {
    expect(LANE_IDS).toEqual([
      'full-regression',
      'ci-fast',
      'test-changed',
      'prepush',
      'test-full',
      'test-coverage',
      'verify-static',
      'verify-local',
      'verify-e2e-full',
    ]);
  });

  it('resolves a known lane and rejects an unknown one', () => {
    expect(resolveLane('prepush').id).toBe('prepush');
    expect(() => resolveLane('unsafe')).toThrow('unknown verification lane');
    expect(() => resolveLane('does-not-exist')).toThrow(
      'unknown verification lane',
    );
  });

  it('gives every lane a unique literal command', () => {
    const commands = LANES.map((entry) => entry.command);
    expect(new Set(commands).size).toBe(commands.length);
    for (const command of commands) {
      expect(command.length).toBeGreaterThan(0);
    }
  });

  it('declares a public coordinator wrapper for every catalog lane', () => {
    for (const entry of LANES) {
      expect(entry.publicScript).toMatch(/^[a-z0-9][a-z0-9:-]*$/);
      if (entry.id === 'test-changed') continue;
      expect(packageJson.scripts[entry.publicScript]).toBe(
        `node scripts/run-verification.mjs request ${entry.id}`,
      );
    }
    expect(packageJson.scripts['ci:extended']).toBe(
      'npm run full:regression && npm run test:coverage && npm run verify:e2e:full',
    );
  });

  it('classifies lanes through the closed class vocabulary', () => {
    const allowed = new Set(Object.values(LANE_CLASSES));
    for (const entry of LANES) {
      expect(allowed.has(entry.class)).toBe(true);
      expect(/unsafe/i.test(entry.class)).toBe(false);
      expect(/unsafe/i.test(entry.id)).toBe(false);
    }
  });

  it('declares test-changed as the bounded diagnostic checkpoint', () => {
    expect(resolveLane('test-changed')).toMatchObject({
      command: 'npm run test:changed',
      class: LANE_CLASSES.CHANGED,
      completion: false,
      diagnostic: true,
      weight: 20,
      ownedOutputs: ['.kontourai/test-impact/'],
    });
    expect(resolveLane('test-changed')).not.toBe(
      resolveLane(CANONICAL_COMPLETION_LANE),
    );
  });
});

describe('lane manifest digest', () => {
  it('digests the command string for command-only lanes', () => {
    const expected = createHash('sha256')
      .update(resolveLane(CANONICAL_COMPLETION_LANE).command)
      .digest('hex');
    expect(laneManifestDigest(CANONICAL_COMPLETION_LANE)).toBe(expected);
  });

  it('digests the consumed prepush manifest content byte-for-byte', () => {
    const expected = createHash('sha256')
      .update(JSON.stringify(PREPUSH_TEST_GROUPS))
      .digest('hex');
    expect(laneManifestDigest('prepush')).toBe(expected);
  });

  it('is sensitive to prepush manifest content, so a content change invalidates', () => {
    const baseline = laneManifestDigest('prepush');
    const mutated = createHash('sha256')
      .update(
        JSON.stringify({
          ...PREPUSH_TEST_GROUPS,
          guardrails: [
            ...PREPUSH_TEST_GROUPS.guardrails,
            'scripts/__tests__/added.test.ts',
          ],
        }),
      )
      .digest('hex');
    expect(mutated).not.toBe(baseline);
  });

  it('digests the actual tests/e2e-manifest.mjs spec→bucket assignment', () => {
    const expected = createHash('sha256')
      .update(JSON.stringify(e2eAssignmentIdentity()))
      .digest('hex');
    expect(laneManifestDigest('verify-e2e-full')).toBe(expected);
  });

  it('is sensitive to the E2E assignment, so a bucket change invalidates', () => {
    const baseline = laneManifestDigest('verify-e2e-full');
    const shifted = [...e2eManifest];
    shifted[0] = { ...shifted[0], bucket: 'quarantine' };
    const shiftedIdentity = shifted
      .map((entry) => ({ path: entry.path, bucket: entry.bucket }))
      .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    const mutated = createHash('sha256')
      .update(JSON.stringify(shiftedIdentity))
      .digest('hex');
    expect(mutated).not.toBe(baseline);
  });

  it('does not invalidate on a rationale-only edit (assignment is the scope signal)', () => {
    const baseline = laneManifestDigest('verify-e2e-full');
    const reworded = e2eManifest.map((entry) => ({
      ...entry,
      rationale: 'changed wording that does not affect what runs',
    }));
    const rewordedIdentity = reworded
      .map((entry) => ({ path: entry.path, bucket: entry.bucket }))
      .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    const mutated = createHash('sha256')
      .update(JSON.stringify(rewordedIdentity))
      .digest('hex');
    expect(mutated).toBe(baseline);
  });

  it('distinguishes manifest-bearing lanes from command-only lanes', () => {
    expect(laneManifestDigest('prepush')).not.toBe(
      laneManifestDigest(CANONICAL_COMPLETION_LANE),
    );
    expect(laneManifestDigest('verify-e2e-full')).not.toBe(
      laneManifestDigest(CANONICAL_COMPLETION_LANE),
    );
  });
});

describe('lane ownedOutputs truthfulness', () => {
  it('declares the mutable build outputs the completion lane creates', () => {
    expect(resolveLane('full-regression').ownedOutputs).toEqual([
      'dist-server/',
      'dist-ui/',
      'packages/sdk/dist',
      'packages/connect/dist',
      'packages/cli/dist/',
      '.kontourai/veritas/evidence/proof-families/',
    ]);
  });

  it('declares the prepush runner outputs including the connect rebuild', () => {
    // test:prepush's literal script is `npm run prepare:verify-static && node
    // scripts/run-prepush-tier.mjs`. prepare:verify-static rebuilds every
    // REQUIRED_STATIC_WORKSPACES dist (packages/connect/dist, and since
    // station#1813 packages/cli/dist — its `bin` is a git-ignored bundle on the
    // freshness gate's path), so the lane must own each one plus the two
    // reliability receipts.
    const preparedDists = REQUIRED_STATIC_WORKSPACES.map((w) => w.distDir);
    expect(resolveLane('prepush').ownedOutputs).toEqual([
      'packages/connect/dist',
      'packages/cli/dist/',
      '.kontourai/test-reliability/prepush-latest.json',
      '.kontourai/test-reliability/prepush-repeat-latest.json',
    ]);
    for (const dist of preparedDists) {
      expect(resolveLane('prepush').ownedOutputs).toContain(dist);
    }
  });

  it('declares the coverage report output produced by the coverage lane', () => {
    expect(resolveLane('test-coverage').ownedOutputs).toEqual([
      'coverage/',
      'packages/cli/dist/',
    ]);
  });

  it('declares the mutable outputs the local/native lane creates', () => {
    expect(resolveLane('verify-local').ownedOutputs).toEqual([
      'dist-server/',
      'dist-desktop-runtime/',
      'packages/connect/dist',
      'packages/cli/dist/',
      'src-desktop/target/',
    ]);
  });

  it('declares the mutable outputs the E2E lane creates', () => {
    // verify:e2e:full's literal script is `node scripts/run-e2e-coverage.mjs`,
    // which runs each bucket via run-e2e-suite.mjs. That runner starts a
    // per-run `./station start --instance=e2e-<suite>-<suffix>`, which builds
    // into instance-named dist-server-e2e-* / dist-ui-e2e-* dirs (the same dirs
    // sweepInterruptedBuildDirs reclaims), plus Playwright's test-results/ and
    // playwright-report/. The patterns are conservative: scoped to e2e-* so
    // they cannot match another lane's dist-server/ or dist-ui/.
    expect(resolveLane('verify-e2e-full').ownedOutputs).toEqual([
      'dist-server-e2e-*/',
      'dist-ui-e2e-*/',
      'test-results/',
      'playwright-report/',
      'gallery/',
      '.kontourai/e2e-latest/',
      '.kontourai/e2e-runs/',
    ]);
  });

  it('keeps Starter clean-install in the canonical full-E2E scope', () => {
    expect(resolveLane('verify-e2e-full').scope).toBe(
      'product, first-run, starter-clean-install, smoke-live, extended, screenshot, Android buckets',
    );
    expect(resolveLane('verify-e2e-full').description).toContain(
      'starter-clean-install',
    );
  });

  it('ties the e2e dist patterns to the runner own instance-named dirs', () => {
    // Recovery is lease-safe, not age-only: an old E2E output is reclaimable
    // only when its root-bound v2 lease proves both daemon identities dead.
    const tmp = mkdtempSync(join(tmpdir(), 'station-e2e-owned-'));
    const recognized = ['dist-server-e2e-x', 'dist-ui-e2e-x'];
    const decoy = ['dist-server', 'dist-ui', 'dist-server-other'];
    for (const dir of [...recognized, ...decoy]) mkdirSync(join(tmp, dir));
    // An old mtime permits recovery only with the exact lease below.
    const past = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    for (const dir of [...recognized, ...decoy]) {
      utimesSync(join(tmp, dir), past, past);
    }
    mkdirSync(join(tmp, '.kontourai/e2e-runs'), { recursive: true });
    writeFileSync(
      join(tmp, '.kontourai/e2e-runs/e2e-x.json'),
      JSON.stringify({
        version: 2,
        root: tmp,
        instance: 'e2e-x',
        state: 'running',
        outputDirs: recognized,
        daemon: {
          server: { pid: 999_999, processStart: 'dead', pgid: 999_999 },
          ui: { pid: 999_998, processStart: 'dead', pgid: 999_998 },
          instanceId: 'e2e-x',
          bootId: 'dead-boot',
        },
      }),
    );
    const reclaimed = sweepInterruptedBuildDirs(tmp);
    // The sweep reclaims only the e2e instance-named dirs, never the canonical
    // dist-server/dist-ui owned by other lanes.
    expect(reclaimed).toBe(recognized.length);
    for (const dir of recognized)
      expect(existsSync(join(tmp, dir))).toBe(false);
    for (const dir of decoy) expect(existsSync(join(tmp, dir))).toBe(true);
    // An unleased old E2E dir has no exact ownership proof and is retained.
    const unleased = 'dist-ui-e2e-unleased';
    mkdirSync(join(tmp, unleased));
    utimesSync(join(tmp, unleased), past, past);
    expect(sweepInterruptedBuildDirs(tmp)).toBe(0);
    expect(existsSync(join(tmp, unleased))).toBe(true);
    // The lane's e2e dist patterns name exactly those reclaimed prefixes.
    const e2ePatterns = resolveLane('verify-e2e-full').ownedOutputs.filter(
      (o) => o.startsWith('dist-') && o.endsWith('-e2e-*/'),
    );
    expect(e2ePatterns).toEqual(['dist-server-e2e-*/', 'dist-ui-e2e-*/']);
    for (const kind of ['server', 'ui']) {
      expect(e2ePatterns).toContain(`dist-${kind}-e2e-*/`);
    }
  });

  it('declares the CLI bundle output produced by the full corpus', () => {
    expect(resolveLane('test-full').ownedOutputs).toEqual([
      'packages/cli/dist/',
    ]);
  });

  it('verify-static owns the connect dist its private raw adapter rebuilds', () => {
    // The coordinator runs verify:static:raw, whose bootstrap begins with
    // prepare:verify-static — the same script that rebuilds every
    // REQUIRED_STATIC_WORKSPACES dist. So verify-static mutates the connect
    // dist and must declare it, exactly like the prepush lane does.
    const preparedDists = REQUIRED_STATIC_WORKSPACES.map((w) => w.distDir);
    expect(resolveLane('verify-static').ownedOutputs).toEqual([
      'packages/connect/dist',
      'packages/cli/dist/',
    ]);
    for (const dist of preparedDists) {
      expect(resolveLane('verify-static').ownedOutputs).toContain(dist);
    }
  });

  it('keeps every owned output a safe repo-local relative path', () => {
    for (const entry of LANES) {
      for (const output of entry.ownedOutputs) {
        expect(output.startsWith('/') || output.startsWith('\\')).toBe(false);
        expect(/^[A-Za-z]:[\\/]/.test(output)).toBe(false);
        expect(/(?:^|[/\\])\.\.(?:[/\\]|$)/.test(output)).toBe(false);
      }
    }
  });
});

describe('ownedOutputs trace to the literal rebuild script', () => {
  // The connect dist ownership declared by prepush and verify-static is not an
  // assertion about intent — it is pinned to the literal package.json scripts
  // that actually rebuild packages/connect/dist. If a script rewires away from
  // prepare:verify-static, these tests force a conscious ownedOutputs update
  // rather than a silent drift.

  it('prepush public wrapper delegates once to its private raw chain', () => {
    expect(packageJson.scripts['test:prepush']).toBe(
      'node scripts/run-verification.mjs request prepush',
    );
    expect(packageJson.scripts['test:prepush:raw']).toBe(
      'npm run prepare:verify-static && node scripts/run-prepush-tier.mjs',
    );
    // prepare:verify-static rebuilds every REQUIRED_STATIC_WORKSPACES dist.
    expect(packageJson.scripts['prepare:verify-static']).toBe(
      'node scripts/prepare-verify-static.mjs',
    );
    for (const workspace of REQUIRED_STATIC_WORKSPACES) {
      expect(resolveLane('prepush').ownedOutputs).toContain(workspace.distDir);
    }
  });

  it('verify:static wrapper moves bootstrap exactly once into its private raw chain', () => {
    expect(packageJson.scripts['verify:static']).toBe(
      'node scripts/run-verification.mjs request verify-static',
    );
    expect(packageJson.scripts['preverify:static']).toBe('node -e ""');
    expect(packageJson.scripts['verify:static:raw']).toContain(
      'npm run verify:static:bootstrap',
    );
    expect(packageJson.scripts['verify:static:raw']).not.toContain(
      'npm run test:full:raw',
    );
    expect(packageJson.scripts['full:regression:raw']).toContain(
      'npm run test:full:raw',
    );
    expect(packageJson.scripts['verify:static:bootstrap']).toContain(
      'npm run prepare:verify-static',
    );
    for (const workspace of REQUIRED_STATIC_WORKSPACES) {
      expect(resolveLane('verify-static').ownedOutputs).toContain(
        workspace.distDir,
      );
    }
  });

  it('verify:local wrapper invokes a private raw chain without nested coordination', () => {
    expect(packageJson.scripts['verify:local']).toBe(
      'node scripts/run-verification.mjs request verify-local',
    );
    expect(packageJson.scripts['verify:local:raw']).toBe(
      'node scripts/run-local-verification.mjs -- npm run verify:static:raw && npm run verify:desktop-rust && npm run check:mobile-compile',
    );
    expect(packageJson.scripts['ci:fast']).toBe(
      'node scripts/run-verification.mjs request ci-fast',
    );

    // Cargo writes `target/` relative to its working directory. Both the host
    // test script and the mobile compiler use src-desktop as that directory,
    // so their shared durable output is src-desktop/target/.
    expect(packageJson.scripts['verify:desktop-rust']).toBe(
      'mkdir -p dist-server dist-desktop-runtime/node_modules && cd src-desktop && cargo test',
    );
    const mobileCompileSource = readFileSync(
      'scripts/check-mobile-compile.mjs',
      'utf8',
    );
    expect(mobileCompileSource).toContain(
      "new URL('../src-desktop/', import.meta.url)",
    );
    expect(mobileCompileSource).toContain("execFileSync('cargo'");
    expect(mobileCompileSource).toContain('cwd: DESKTOP_DIR');
    expect(resolveLane('verify-local').ownedOutputs).toEqual(
      expect.arrayContaining(['packages/connect/dist', 'src-desktop/target/']),
    );
  });
});

describe('validateLaneCatalog strictness', () => {
  it('accepts the canonical catalog against the live repository', () => {
    const result = validateLaneCatalog();
    expect(result.errors).toEqual([]);
    expect(result.valid).toBe(true);
  });

  it('rejects a duplicate lane id', () => {
    const errors = catalogErrors(
      lane({ id: 'dup', command: 'npm run a' }),
      lane({ id: 'dup', command: 'npm run b' }),
    );
    expect(errors).toContain('duplicate lane id: dup');
  });

  it('rejects a shared lane command', () => {
    const errors = catalogErrors(
      lane({ id: 'one', command: 'npm run shared' }),
      lane({ id: 'two', command: 'npm run shared' }),
    );
    expect(errors.some((e) => e.startsWith('duplicate lane command'))).toBe(
      true,
    );
  });

  it('rejects more than one completion lane', () => {
    const errors = catalogErrors(
      lane({
        id: CANONICAL_COMPLETION_LANE,
        command: CANONICAL_COMPLETION_COMMAND,
        class: LANE_CLASSES.COMPLETION,
        completion: true,
        diagnostic: false,
      }),
      lane({
        id: 'other',
        command: 'npm run other',
        completion: true,
        diagnostic: false,
      }),
    );
    expect(
      errors.some((e) => e.includes('expected exactly one completion')),
    ).toBe(true);
    expect(errors).toContain(
      "lane 'other' is marked completion but is not the canonical lane",
    );
  });

  it('rejects a lane that is neither completion nor diagnostic', () => {
    const errors = catalogErrors(
      lane({ completion: false, diagnostic: false }),
    );
    expect(errors).toContain(
      "lane 'alpha' must be either completion or diagnostic",
    );
  });

  it('rejects a lane flagged both completion and diagnostic', () => {
    const errors = catalogErrors(lane({ completion: true, diagnostic: true }));
    expect(errors).toContain(
      "lane 'alpha' must be either completion or diagnostic",
    );
  });

  it('rejects an out-of-range weight', () => {
    expect(
      catalogErrors(lane({ weight: 0 })).some((e) =>
        e.includes('invalid weight'),
      ),
    ).toBe(true);
    expect(
      catalogErrors(lane({ weight: 101 })).some((e) =>
        e.includes('invalid weight'),
      ),
    ).toBe(true);
    expect(
      catalogErrors(lane({ weight: 12.5 })).some((e) =>
        e.includes('invalid weight'),
      ),
    ).toBe(true);
  });

  it('rejects a ci:fast phase command that does not bind its executed script', () => {
    const mismatched = LANES.map((entry) =>
      entry.id === CANONICAL_COMPLETION_LANE
        ? {
            ...entry,
            phases: entry.phases.map((phase, index) =>
              index === 0
                ? { ...phase, command: 'npm run proof:unexpected' }
                : phase,
            ),
          }
        : entry,
    );
    expect(validateLaneCatalog(mismatched).errors).toContain(
      "canonical lane 'full-regression' phase 'repo-governance' command must exactly equal npm run proof:repo-governance",
    );
  });

  it('rejects an unknown class', () => {
    expect(catalogErrors(lane({ class: 'unsafe' }))).toContain(
      "lane 'alpha' has an unsafe classification",
    );
    expect(catalogErrors(lane({ class: 'mystery' }))).toContain(
      "lane 'alpha' has unknown class 'mystery'",
    );
  });

  it('rejects a missing or malformed command', () => {
    expect(
      catalogErrors(lane({ command: '' })).some((e) =>
        e.includes('missing a literal command'),
      ),
    ).toBe(true);
  });

  it('rejects a missing public script', () => {
    expect(catalogErrors(lane({ publicScript: '' }))).toContain(
      "lane 'alpha' has invalid public script ''",
    );
  });

  it('rejects an invalid lane id', () => {
    expect(catalogErrors(lane({ id: 'UPPER' }))).toContain(
      "lane has invalid id 'UPPER'",
    );
    expect(catalogErrors(lane({ id: 'has space' }))).toContain(
      "lane has invalid id 'has space'",
    );
  });

  it('rejects a missing description', () => {
    expect(catalogErrors(lane({ description: '' }))).toContain(
      "lane 'alpha' is missing a description",
    );
  });

  it('rejects a missing trigger phrase for the rendered table', () => {
    expect(catalogErrors(lane({ trigger: '' }))).toContain(
      "lane 'alpha' is missing a trigger phrase",
    );
  });

  it('rejects a missing expected-scope phrase for the rendered table', () => {
    expect(catalogErrors(lane({ scope: '' }))).toContain(
      "lane 'alpha' is missing an expected-scope phrase",
    );
  });

  it('rejects a multi-line trigger phrase (would forge a row)', () => {
    expect(
      catalogErrors(lane({ trigger: 'line one\nline two' })).some((e) =>
        e.includes('trigger must be a single line'),
      ),
    ).toBe(true);
  });

  it('rejects a multi-line scope phrase (would forge a row)', () => {
    expect(
      catalogErrors(lane({ scope: 'line one\nline two' })).some((e) =>
        e.includes('scope must be a single line'),
      ),
    ).toBe(true);
  });

  it('rejects invalid owned outputs', () => {
    expect(
      catalogErrors(lane({ ownedOutputs: ['ok', ''] })).some((e) =>
        e.includes('invalid owned outputs'),
      ),
    ).toBe(true);
    expect(
      catalogErrors(lane({ ownedOutputs: 'nope' })).some((e) =>
        e.includes('invalid owned outputs'),
      ),
    ).toBe(true);
  });

  it('rejects an absolute owned output path', () => {
    expect(
      catalogErrors(lane({ ownedOutputs: ['/etc/passwd'] })).some((e) =>
        e.includes('owned output must be relative'),
      ),
    ).toBe(true);
  });

  it('rejects a traversal owned output path', () => {
    expect(
      catalogErrors(lane({ ownedOutputs: ['../secret'] })).some((e) =>
        e.includes('owned output must not traverse'),
      ),
    ).toBe(true);
  });

  it('rejects a canonical lane whose command drifted from the literal', () => {
    const errors = catalogErrors(
      lane({
        id: CANONICAL_COMPLETION_LANE,
        command: 'npm run ci:extended',
        class: LANE_CLASSES.COMPLETION,
        completion: true,
        diagnostic: false,
      }),
    );
    expect(
      errors.some((e) =>
        e.includes("canonical lane command is 'npm run ci:extended'"),
      ),
    ).toBe(true);
  });
});

describe('trust-reconcile alignment with public contracts', () => {
  it('keeps the canonical command in package.json and the CI workflow', () => {
    expect(packageJson.scripts['full:regression']).toBeTruthy();
    expect(
      packageJson['trust-reconcile-manifest'].map((entry) => entry.command),
    ).toContain(CANONICAL_COMPLETION_COMMAND);
    expect(existsSync('.github/workflows/ci.yml')).toBe(true);
    const workflow = readFileSync('.github/workflows/ci.yml', 'utf8');
    expect(workflow).toContain('npm run ci:fast');
  });
});

describe('prepush lane compatibility', () => {
  it('declares the prepush runner outputs and matches its manifest digest', () => {
    expect(resolveLane('prepush').ownedOutputs).toEqual([
      'packages/connect/dist',
      'packages/cli/dist/',
      '.kontourai/test-reliability/prepush-latest.json',
      '.kontourai/test-reliability/prepush-repeat-latest.json',
    ]);
    // The catalog consumes — it does not fork — the prepush manifest. The
    // live runner's receipt manifestDigest is byte-identical to the lane's.
    expect(collectProvenance().manifestDigest).toBe(
      laneManifestDigest('prepush'),
    );
  });

  it('does not regress the prepush runner public surface', () => {
    // collectProvenance reaches the schema-v2 neutral workspace helper that
    // verification receipts extend rather than replace; resolving it here
    // proves Wave 1 left the prepush provenance projection intact.
    const provenance = collectProvenance();
    expect(provenance.manifestDigest).toBe(
      createHash('sha256')
        .update(JSON.stringify(PREPUSH_TEST_GROUPS))
        .digest('hex'),
    );
    for (const key of [
      'headSha',
      'dirty',
      'workspaceDigest',
      'nodeVersion',
      'platform',
      'arch',
    ]) {
      expect(provenance[key]).toBeDefined();
    }
  });
});

describe('changed-test manifest identity', () => {
  it('binds both selector consumers to the exact test-impact manifest', () => {
    const expected = createHash('sha256')
      .update(JSON.stringify(TEST_IMPACT_MANIFEST))
      .digest('hex');
    expect(laneManifestDigest('test-changed')).toBe(expected);
    expect(laneManifestDigest('ci-fast')).toBe(expected);
  });
});

describe('rendered lane catalog table', () => {
  it('renders one row per lane with its literal command and resource-class label', () => {
    const table = renderLaneCatalogTable();
    for (const lane of LANES) {
      expect(table).toContain(`\`${lane.id}\``);
      expect(table).toContain(`\`${lane.command}\``);
      expect(table).toContain(CLASS_LABELS[lane.class]);
      expect(table).toContain(lane.trigger);
      expect(table).toContain(lane.scope);
    }
  });

  it('derives evidence and invalidation columns from catalog fields, not prose', () => {
    const table = renderLaneCatalogTable();
    expect(table).toContain('completion (trust floor)');
    expect(table).toContain(invalidationRule(resolveLane('prepush').manifest));
    expect(table).toContain(
      invalidationRule(resolveLane('verify-e2e-full').manifest),
    );
    expect(table).toContain(invalidationRule(resolveLane('ci-fast').manifest));
  });

  it('changes when a lane command drifts, so a stale doc table fails the gate', () => {
    const baseline = renderLaneCatalogTable();
    const drifted = LANES.map((lane) =>
      lane.id === 'ci-fast' ? { ...lane, command: 'npm run ci:fast-x' } : lane,
    );
    expect(renderLaneCatalogTable(drifted)).not.toBe(baseline);
  });
});

describe('rendered lane catalog table Markdown escaping', () => {
  // A pipe forges an extra column and a line break forges an extra row in a
  // GFM table. Every rendered dynamic cell must be escaped so no field value
  // can alter the table structure. These tests inject hostile values that the
  // canonical catalog can never hold (validation rejects newlines; ids/commands
  // are regex-locked) to prove the renderer is safe even for adversarial input.

  it('escapes a pipe so it cannot forge an extra column', () => {
    const hostile = LANES.map((l) =>
      l.id === 'ci-fast' ? { ...l, scope: 'repo|scope' } : l,
    );
    const table = renderLaneCatalogTable(hostile);
    const rows = table.split('\n');
    // Row count is stable: header + separator + one per lane.
    expect(rows).toHaveLength(LANES.length + 2);
    const ciFastRow = rows.find((r) => r.includes('`ci-fast`'));
    expect(ciFastRow).toBeDefined();
    // The pipe is backslash-escaped; the raw unescaped pair is gone.
    expect(ciFastRow).toContain('repo\\|scope');
    expect(ciFastRow).not.toContain('repo|scope');
  });

  it('collapses a line break so it cannot forge an extra row', () => {
    const hostile = LANES.map((l) =>
      l.id === 'ci-fast' ? { ...l, trigger: 'pre-merge\n/final' } : l,
    );
    const table = renderLaneCatalogTable(hostile);
    // Still exactly one row per lane plus header and separator — no extra row.
    expect(table.split('\n')).toHaveLength(LANES.length + 2);
    // The line break became a single space.
    expect(table).toContain('pre-merge /final');
    expect(table).not.toContain('pre-merge\n/final');
  });

  it('escapes a backslash before escaping a pipe (ordering invariant)', () => {
    // Input backslash-pipe: escaping must double the backslash first, then
    // escape the pipe, so the pipe cannot ride a trailing backslash into a
    // column split.
    const hostile = LANES.map((l) =>
      l.id === 'ci-fast' ? { ...l, scope: 'a\\|b' } : l,
    );
    const table = renderLaneCatalogTable(hostile);
    const ciFastRow = table.split('\n').find((r) => r.includes('`ci-fast`'));
    expect(ciFastRow).toBeDefined();
    // a + doubled backslash + escaped pipe + b
    expect(ciFastRow).toContain('a\\\\\\|b');
    expect(ciFastRow).not.toContain('a\\|b');
  });

  it('escapes backslashes and pipes in every dynamic cell, not just scope', () => {
    const hostile = [
      {
        ...lane(),
        id: 'with|id',
        command: 'npm run x|y',
        trigger: 't|r',
        scope: 's|c',
      },
    ];
    const table = renderLaneCatalogTable(hostile);
    const rows = table.split('\n');
    expect(rows).toHaveLength(3);
    const dataRow = rows[2];
    // The id and command are inside backticks; their pipes are escaped too.
    expect(dataRow).toContain('`with\\|id`');
    expect(dataRow).toContain('`npm run x\\|y`');
    expect(dataRow).toContain('t\\|r');
    expect(dataRow).toContain('s\\|c');
  });

  it('leaves the clean canonical catalog byte-identical (no escape artifacts)', () => {
    // The canonical catalog values contain no pipes, backslashes, or line
    // breaks, so escaping must not introduce any escape sequences — proving the
    // AGENTS.md table render is unchanged.
    const table = renderLaneCatalogTable();
    expect(table).not.toContain('\\|');
    expect(table).not.toContain('\\\\');
    expect(table).not.toContain('\r');
  });
});
