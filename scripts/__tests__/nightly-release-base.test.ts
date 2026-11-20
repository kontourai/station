import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { delimiter, join, resolve } from 'node:path';
import { load } from 'js-yaml';
import { describe, expect, test, vi } from 'vitest';
import { trackTempDirs } from '../../src-server/__test-utils__/temp-dirs.js';
import { spawnSyncBounded } from '../lib/bounded-capture.mjs';
import {
  assertNightlyReleaseBase,
  listPublishedReleases,
} from '../nightly-release-base.mjs';

const root = resolve(import.meta.dirname, '../..');
const temporary = trackTempDirs();
const published = (tag_name: string) => ({
  tag_name,
  draft: false,
  prerelease: tag_name.includes('-'),
});

test('Nightly base follows the highest published RC/final, not release-list order', () => {
  expect(
    assertNightlyReleaseBase('0.3.0', [
      published('v0.1.11'),
      published('v0.2.0-rc.2'),
    ]),
  ).toMatchObject({ state: 'ahead', latestPublishedTag: 'v0.2.0-rc.2' });
  expect(
    assertNightlyReleaseBase('0.2.0', [
      { ...published('v0.2.0-rc.1'), draft: true },
    ]),
  ).toMatchObject({ state: 'bootstrap' });
});

test.each(['v0.2.0', 'v0.2.0-rc.1', 'v0.3.0'])(
  'refuses Nightly base 0.2.0 behind frozen publication %s',
  (tag) => {
    expect(() => assertNightlyReleaseBase('0.2.0', [published(tag)])).toThrow(
      'must be greater',
    );
  },
);

test('refuses missing publication state instead of treating it as bootstrap', () => {
  expect(() =>
    assertNightlyReleaseBase('0.3.0', [{ tag_name: 'v0.2.0' }]),
  ).toThrow('publication state');
});

// The three Nightly steps that refuse a regressing product base. Each runs in
// a real bash against a stand-in `gh` that enforces gh's own flag rules, so a
// step that combines `--slurp` with `--jq` fails here as it did on the runner
// (run 43970814259) instead of passing a text pin.
const STEP = 'Refuse a Nightly base at or below a published RC or final';
const INVOCATION = 'node scripts/nightly-release-base.mjs';
const CALLERS = [
  ['nightly.yml', 'delivery-decide', ''],
  ['nightly-native-cohort.yml', 'admit-cohort', '0.2.0'],
  ['portable-nightly-publish.yml', 'plan', '0.2.0'],
] as const;

type Workflow = {
  jobs: Record<string, { steps?: Array<{ name?: string; run?: string }> }>;
};
function stepRun(file: string, job: string) {
  const workflow = load(
    readFileSync(resolve(root, '.github/workflows', file), 'utf8'),
  ) as Workflow;
  const steps = (workflow.jobs[job]?.steps ?? []).filter(
    (step) => step.name === STEP,
  );
  expect(steps, `${file} ${job}`).toHaveLength(1);
  const run = steps[0]!.run!;
  expect(run.split(INVOCATION), `${file} calls the script once`).toHaveLength(
    2,
  );
  return run;
}

// gh 2.103's own refusals for the flag combinations it rejects. It never
// evaluates --jq/--template, so any such step fails rather than passing.
const GH_STUB = String.raw`
const args = process.argv.slice(2);
const has = (...flags) => flags.some((flag) => args.includes(flag));
if (has('--slurp') && has('--jq', '-q', '--template', '-t')) {
  process.stderr.write('the \x60--slurp\x60 option is not supported with \x60--jq\x60 or \x60--template\x60\n');
  process.exit(1);
}
if (has('--slurp') && !has('--paginate')) {
  process.stderr.write('\x60--paginate\x60 required when passing \x60--slurp\x60\n');
  process.exit(1);
}
if (has('--jq', '-q', '--template', '-t')) {
  process.stderr.write('stand-in gh does not evaluate --jq/--template\n');
  process.exit(2);
}
const endpoint = args.find((arg) => arg.startsWith('repos/'));
if (args[0] !== 'api' || endpoint !== 'repos/' + process.env.GITHUB_REPOSITORY + '/releases?per_page=100') {
  process.stderr.write('unexpected gh call: ' + args.join(' ') + '\n');
  process.exit(2);
}
const pages = JSON.parse(require('node:fs').readFileSync(process.env.STUB_RELEASE_PAGES, 'utf8'));
if (process.env.STUB_FAIL_PAGE && has('--paginate')) {
  // gh streams the pages it has read, then exits non-zero on the failed one.
  process.stdout.write(has('--slurp') ? '[' + JSON.stringify(pages[0]) + ',' : JSON.stringify(pages[0]));
  process.stderr.write('gh: Server Error (HTTP 502)\n');
  process.exit(1);
}
const served = has('--paginate') ? pages : pages.slice(0, 1);
process.stdout.write(has('--slurp') ? JSON.stringify(served) : served.map((page) => JSON.stringify(page)).join(''));
`;

function fixture(pages: unknown[][], { failPage = false } = {}) {
  const dir = temporary('station-nightly-base-');
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  writeFileSync(join(dir, 'gh-stub.cjs'), GH_STUB);
  writeFileSync(
    join(bin, 'gh'),
    `#!/bin/sh\nexec '${process.execPath}' '${join(dir, 'gh-stub.cjs')}' "$@"\n`,
  );
  chmodSync(join(bin, 'gh'), 0o755);
  writeFileSync(join(dir, 'pages.json'), JSON.stringify(pages));
  // The step reads `package.json` from its working directory; pin the base.
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({ version: '0.2.0' }),
  );
  const env = {
    ...process.env,
    PATH: `${bin}${delimiter}${process.env.PATH}`,
    GITHUB_REPOSITORY: 'example-owner/example-repo',
    GH_TOKEN: 'stand-in',
    RUNNER_TEMP: dir,
    STUB_RELEASE_PAGES: join(dir, 'pages.json'),
    STUB_FAIL_PAGE: failPage ? '2' : '',
  };
  return { dir, env };
}

/** One full page of Nightlies, then the page that holds the product tags. */
const nightlies = Array.from({ length: 100 }, (_, n) =>
  published(`v0.1.11-nightly.${2400 + n}`),
);
const twoPages = (lastPage: unknown[]) => [nightlies, lastPage];

/** The step's own text in bash, the script addressed in this checkout. */
function runStep(
  file: string,
  job: string,
  expectedBase: string,
  setup: ReturnType<typeof fixture>,
) {
  const run = stepRun(file, job).replace(
    INVOCATION,
    `node ${JSON.stringify(resolve(root, 'scripts/nightly-release-base.mjs'))}`,
  );
  return spawnSyncBounded(
    'bash',
    ['--noprofile', '--norc', '-eo', 'pipefail', '-c', run],
    {
      cwd: setup.dir,
      env: { ...setup.env, EXPECTED_PRODUCT_BASE: expectedBase },
      encoding: 'utf8',
      timeout: 30_000,
    },
  );
}

describe.skipIf(process.platform === 'win32')(
  'Nightly base step, run as each workflow writes it',
  () => {
    test.each(CALLERS)(
      '%s reads every release page and refuses a base behind a page-two RC',
      (file, job, expectedBase) => {
        const ahead = runStep(
          file,
          job,
          expectedBase,
          fixture(twoPages([published('v0.1.11')])),
        );
        expect(ahead.stderr).toBe('');
        expect(ahead.status).toBe(0);
        expect(JSON.parse(ahead.stdout)).toEqual({
          version: '0.2.0',
          latestPublishedTag: 'v0.1.11',
          state: 'ahead',
        });

        const behind = runStep(
          file,
          job,
          expectedBase,
          fixture(twoPages([published('v0.2.0-rc.1')])),
        );
        expect(behind.stderr).toContain(
          'must be greater than published v0.2.0-rc.1',
        );
        expect(behind.status).toBe(1);
      },
    );

    test.each(CALLERS)(
      '%s fails when gh fails on page two, never reading it as bootstrap',
      (file, job, expectedBase) => {
        const result = runStep(
          file,
          job,
          expectedBase,
          fixture(twoPages([published('v0.1.11')]), { failPage: true }),
        );
        expect(result.stderr).toContain('gh release listing failed (exit 1)');
        expect(result.stderr).toContain('HTTP 502');
        expect(result.stdout).toBe('');
        expect(result.status).toBe(1);
      },
    );

    test.each(CALLERS)(
      '%s refuses an empty release listing',
      (file, job, expectedBase) => {
        const result = runStep(file, job, expectedBase, fixture([[]]));
        expect(result.stderr).toContain('Release listing is empty');
        expect(result.stdout).toBe('');
        expect(result.status).toBe(1);
      },
    );

    test('the listing is the flat array of every release across pages', () => {
      const setup = fixture(twoPages([published('v0.1.11')]));
      vi.stubEnv('PATH', setup.env.PATH);
      vi.stubEnv('STUB_RELEASE_PAGES', setup.env.STUB_RELEASE_PAGES);
      vi.stubEnv('STUB_FAIL_PAGE', '');
      vi.stubEnv('GITHUB_REPOSITORY', 'example-owner/example-repo');
      try {
        const releases = listPublishedReleases('example-owner/example-repo');
        expect(releases).toHaveLength(101);
        expect(releases[0]).toEqual(published('v0.1.11-nightly.2400'));
        expect(releases[100]).toEqual(published('v0.1.11'));
      } finally {
        vi.unstubAllEnvs();
      }
    });
  },
);
