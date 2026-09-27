import { execFileSync, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
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

/**
 * The real dependencies, executed: a throwaway git repository with a base
 * commit and a head commit that changes a UI input, and a stub `npm` on PATH
 * that logs each call and writes a deterministic `index.html` plus assets
 * whose size is the content of `src-ui/app.js` in whichever tree it runs.
 * That proves the install/build commands, observe mode and the delta build
 * directory on BOTH sides, that the base builds in its own worktree, and that
 * the worktree is removed afterwards, including when the base build fails.
 */
describe.skipIf(process.platform === 'win32')(
  'real dependencies (stubbed npm, executed)',
  () => {
    const makeTempDir = trackTempDirs();
    const script = resolve(
      import.meta.dirname,
      '../ui-bundle-delta-report.mjs',
    );

    function git(cwd: string, args: string[]) {
      return execFileSync('git', args, {
        cwd,
        encoding: 'utf8',
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: 'Fixture',
          GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
          GIT_COMMITTER_NAME: 'Fixture',
          GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
        },
      }).trim();
    }

    function fixture({ failBaseBuild = false } = {}) {
      const root = realpathSync(makeTempDir('station-ui-delta-real-'));
      const repo = join(root, 'repo');
      const bin = join(root, 'bin');
      const runnerTemp = join(root, 'runner-temp');
      const log = join(root, 'npm-calls.log');
      mkdirSync(join(repo, 'src-ui'), { recursive: true });
      mkdirSync(bin);
      mkdirSync(runnerTemp);
      git(repo, ['init', '-q', '-b', 'main']);
      writeFileSync(join(repo, 'src-ui/app.js'), 'x'.repeat(10));
      git(repo, ['add', '.']);
      git(repo, ['commit', '-q', '-m', 'base']);
      const baseSha = git(repo, ['rev-parse', 'HEAD']);
      // Incompressible growth so the gzip delta is non-zero and signed +.
      writeFileSync(
        join(repo, 'src-ui/app.js'),
        Array.from({ length: 400 }, (_, index) =>
          ((index * 2654435761) >>> 0).toString(36),
        ).join(''),
      );
      git(repo, ['commit', '-q', '-am', 'head']);
      writeFileSync(
        join(bin, 'npm'),
        [
          '#!/bin/sh',
          `printf '%s|%s|%s|%s\\n' "$(pwd -P)" "$STATION_UI_BUNDLE_BUDGET" "$STATION_BUILD_UI_DIR" "$*" >> ${JSON.stringify(log)}`,
          'case "$*" in',
          '  *build:ui*)',
          ...(failBaseBuild
            ? [
                `    if [ "$(pwd -P)" != ${JSON.stringify(repo)} ]; then exit 7; fi`,
              ]
            : []),
          '    mkdir -p "$STATION_BUILD_UI_DIR/assets"',
          `    printf '%s' '<script type="module" src="/assets/app.js"></script><link rel="stylesheet" href="/assets/app.css">' > "$STATION_BUILD_UI_DIR/index.html"`,
          '    cp src-ui/app.js "$STATION_BUILD_UI_DIR/assets/app.js"',
          `    printf 'body{}' > "$STATION_BUILD_UI_DIR/assets/app.css"`,
          '    ;;',
          'esac',
          'exit 0',
          '',
        ].join('\n'),
        { mode: 0o755 },
      );
      const result = spawnSync(process.execPath, [script], {
        cwd: repo,
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH ?? ''}`,
          RUNNER_TEMP: runnerTemp,
          STATION_UI_BUNDLE_DELTA_BASE: baseSha,
          GITHUB_STEP_SUMMARY: join(root, 'summary.md'),
          STATION_UI_BUNDLE_BUDGET: 'enforce',
          STATION_BUILD_UI_DIR: 'dist-ui',
        },
      });
      const calls = readFileSync(log, 'utf8')
        .trim()
        .split('\n')
        .map((line) => {
          const [cwd, budget, dir, args] = line.split('|');
          return { cwd, budget, dir, args };
        });
      const baseRoot = join(
        runnerTemp,
        `station-ui-bundle-base-${baseSha.slice(0, 12)}`,
      );
      return { repo, result, calls, baseRoot, baseSha };
    }

    it('installs and builds both sides with build:ui in observe mode, base in its own worktree', () => {
      const { repo, result, calls, baseRoot } = fixture();
      expect(result.status, result.stderr).toBe(0);
      expect(calls).toEqual([
        {
          cwd: repo,
          budget: 'observe',
          dir: 'dist-ui-delta',
          args: 'run dependencies:ci',
        },
        {
          cwd: repo,
          budget: 'observe',
          dir: 'dist-ui-delta',
          args: 'run --silent build:ui',
        },
        {
          cwd: baseRoot,
          budget: 'observe',
          dir: 'dist-ui-delta',
          args: 'run dependencies:ci',
        },
        {
          cwd: baseRoot,
          budget: 'observe',
          dir: 'dist-ui-delta',
          args: 'run --silent build:ui',
        },
      ]);
      expect(result.stdout).toMatch(
        /::notice title=UI entry bundle::UI entry bundle: JS \+[1-9][\d,]* B \([\d,]+ → [\d,]+\), CSS \+0 B/,
      );
      expect(existsSync(baseRoot)).toBe(false);
      expect(git(repo, ['worktree', 'list', '--porcelain'])).not.toContain(
        baseRoot,
      );
    });

    it('removes the base worktree and reports why when the base build fails', () => {
      const { repo, result, baseRoot, baseSha } = fixture({
        failBaseBuild: true,
      });
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain(
        `UI entry bundle delta could not be measured: merge-base ${baseSha.slice(0, 12)} could not be built and measured`,
      );
      expect(result.stdout).toContain('exited 7');
      expect(existsSync(baseRoot)).toBe(false);
      expect(git(repo, ['worktree', 'list', '--porcelain'])).not.toContain(
        baseRoot,
      );
    });
  },
);
