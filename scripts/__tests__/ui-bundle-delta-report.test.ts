import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { trackTempDirs } from '../../src-server/__test-utils__/temp-dirs.js';
import {
  deltaBuildEnv,
  formatDeltaLine,
  formatSignedBytes,
  isUiBuildInput,
  noticeAnnotation,
  runDeltaReport,
  UI_BUILD_INPUT_PREFIXES,
} from '../ui-bundle-delta-report.mjs';

const bundle = (entryJsGzipBytes: number, entryCssGzipBytes: number) => ({
  entryJsGzipBytes,
  entryCssGzipBytes,
});

const baseSha = 'aa4920337cfd8e641f8a4b3b9119a929affc2d8e';

describe('delta formatting', () => {
  it('signs growth, shrinkage and no change', () => {
    expect(formatSignedBytes(1234)).toBe('+1,234');
    expect(formatSignedBytes(-12)).toBe('-12');
    expect(formatSignedBytes(-1234567)).toBe('-1,234,567');
    expect(formatSignedBytes(0)).toBe('+0');
  });

  it('reports candidate minus base for each field, with both measurements', () => {
    // JS grew and CSS shrank, so a swapped subtraction or a swapped field
    // produces a different line in both halves.
    expect(
      formatDeltaLine({
        base: bundle(359421, 45000),
        candidate: bundle(360655, 44900),
        baseSha,
      }),
    ).toBe(
      'UI entry bundle: JS +1,234 B (359,421 → 360,655), CSS -100 B (45,000 → 44,900) gzip vs merge-base aa4920337cfd',
    );
  });

  it('reports an unchanged bundle as +0, not as a skip', () => {
    expect(
      formatDeltaLine({
        base: bundle(1000, 2000),
        candidate: bundle(1000, 2000),
        baseSha,
      }),
    ).toContain('JS +0 B (1,000 → 1,000), CSS +0 B (2,000 → 2,000)');
  });

  it('escapes a multi-line reason so it cannot end the annotation', () => {
    expect(noticeAnnotation('a\nb 100%')).toBe(
      '::notice title=UI entry bundle::a%0Ab 100%25',
    );
  });
});

describe('build environment', () => {
  it('builds in observe mode into a non-served directory, overriding the caller', () => {
    const env = deltaBuildEnv({
      STATION_UI_BUNDLE_BUDGET: 'enforce',
      STATION_BUILD_UI_DIR: 'dist-ui',
      KEEP: '1',
    });
    expect(env.STATION_UI_BUNDLE_BUDGET).toBe('observe');
    expect(env.STATION_BUILD_UI_DIR).toBe('dist-ui-delta');
    expect(env.KEEP).toBe('1');
  });
});

describe('UI build input detection', () => {
  it('recognizes the sources, manifests and ceiling the build reads', () => {
    for (const path of [
      'src-ui/src/App.tsx',
      'src-shared/types.ts',
      'packages/sdk/src/index.ts',
      'packages/connect/src/core/healthProbe.ts',
      'packages/contracts/src/provider.ts',
      'patches/dependency.patch',
      'vite.config.ts',
      'package.json',
      'pnpm-lock.yaml',
      'scripts/ui-bundle-budget.json',
    ])
      expect(isUiBuildInput(path), path).toBe(true);
  });

  it('leaves server-only and look-alike paths alone', () => {
    for (const path of [
      'src-server/routes/operations/insights.ts',
      'docs/src-ui/notes.md',
      'src-uix/thing.ts',
      'packages/sdk/README.md',
      'packages/contracts/package.json',
      '',
    ])
      expect(isUiBuildInput(path), path).toBe(false);
  });

  it('normalizes Windows separators, and every prefix ends in a slash', () => {
    expect(isUiBuildInput('src-ui\\src\\App.tsx')).toBe(true);
    for (const prefix of UI_BUILD_INPUT_PREFIXES)
      expect(prefix.endsWith('/'), prefix).toBe(true);
  });
});

describe('report outcomes', () => {
  function deps(overrides: Record<string, unknown> = {}) {
    return {
      baseRef: 'origin/main',
      mergeBase: vi.fn(() => baseSha),
      changedPaths: vi.fn(() => ['src-ui/src/App.tsx', 'docs/x.md']),
      measureCandidate: vi.fn(() => bundle(360655, 45000)),
      measureBase: vi.fn(() => bundle(359421, 45000)),
      ...overrides,
    };
  }

  it('measures both sides and reports the delta with the matched inputs', () => {
    const subject = deps();
    const outcome = runDeltaReport(subject);
    expect(outcome.kind).toBe('delta');
    expect(outcome.line).toContain('JS +1,234 B (359,421 → 360,655)');
    expect(outcome.line).toContain('inputs: src-ui/src/App.tsx');
    expect(subject.measureBase).toHaveBeenCalledWith(baseSha);
  });

  it('skips the base build, and says so, when no UI build input changed', () => {
    const subject = deps({ changedPaths: vi.fn(() => ['docs/x.md']) });
    const outcome = runDeltaReport(subject);
    expect(outcome.kind).toBe('skipped');
    expect(outcome.line).toBe(
      'UI entry bundle delta not measured: this change touches no UI build input since merge-base aa4920337cfd',
    );
    expect(subject.measureBase).not.toHaveBeenCalled();
  });

  it.each([
    ['mergeBase', 'no merge base between origin/main and HEAD (bad ref)'],
    ['changedPaths', 'could not list the paths this change touches (bad ref)'],
    [
      'measureCandidate',
      'the candidate could not be built and measured (bad ref)',
    ],
    [
      'measureBase',
      'merge-base aa4920337cfd could not be built and measured (bad ref)',
    ],
  ])('reports why when %s fails, instead of throwing', (step, reason) => {
    const outcome = runDeltaReport(
      deps({
        [step]: vi.fn(() => {
          throw new Error('bad ref');
        }),
      }),
    );
    expect(outcome).toEqual({
      kind: 'unmeasured',
      line: `UI entry bundle delta could not be measured: ${reason}`,
    });
  });
});

/**
 * The outcome functions above cannot see the part that keeps the job green:
 * the entry point's exit status. Run it for real against a base that cannot
 * resolve, and assert both that it exits zero and that it says why.
 */
describe('entry point (executed, not inspected)', () => {
  const makeTempDir = trackTempDirs();

  it('exits zero with a could-not-measure notice and summary line', () => {
    const root = makeTempDir('station-ui-bundle-delta-');
    const summary = join(root, 'summary.md');
    const result = spawnSync(
      process.execPath,
      ['scripts/ui-bundle-delta-report.mjs'],
      {
        encoding: 'utf8',
        windowsHide: true,
        env: {
          ...process.env,
          STATION_UI_BUNDLE_DELTA_BASE: 'refs/heads/station-delta-no-such-ref',
          GITHUB_STEP_SUMMARY: summary,
        },
      },
    );
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain(
      '::notice title=UI entry bundle::UI entry bundle delta could not be measured: no merge base between refs/heads/station-delta-no-such-ref and HEAD',
    );
    expect(readFileSync(summary, 'utf8')).toContain(
      'UI entry bundle delta could not be measured: no merge base',
    );
  });
});
