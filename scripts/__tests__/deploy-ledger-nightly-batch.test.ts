import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { load } from 'js-yaml';
import { describe, expect, it } from 'vitest';
import { trackTempDirs } from '../../src-server/__test-utils__/temp-dirs.js';
import { renderLedgerMarkdown } from '../deploy-ledger.mjs';
import { commitLedgerWithRetry } from '../lib/deploy-ledger-commit.mjs';
import { evaluateDocumentationReview } from '../lib/documentation-review.mjs';
import { GENERATED_LEDGER_SUBJECT } from '../normalize-deploy-ledger-head.mjs';
import { ledgerEquivalentSources } from '../qualification-evidence.mjs';
import { evaluateIf } from './helpers/github-if.js';

/**
 * One deploy-ledger commit per Nightly run. Every ledger push to main
 * discards the merge groups in flight, so the native record job writes the
 * run's npm, Android and desktop rows in ONE commit, and `record-cli-ledger`
 * records the npm row alone only when main does not hold it yet.
 *
 * These tests run the REAL workflow step scripts (parsed out of the YAML)
 * under bash against a fixture origin, with the real appender and commit
 * helper copied in, then run every ledger reader on the resulting history.
 * Only the provider edges are stubbed: `npm view` (the registry) and
 * `release-cohort-workflow.mjs` (the attested final receipt, whose own
 * behaviour release-cohort tests cover).
 */

const root = resolve(import.meta.dirname, '../..');
/** Every repository file this suite reads, anchored so the path-read scanner pins them. */
const WORKFLOW_URLS: Record<string, URL> = {
  'nightly.yml': new URL(
    '../../.github/workflows/nightly.yml',
    import.meta.url,
  ),
  'nightly-native-cohort.yml': new URL(
    '../../.github/workflows/nightly-native-cohort.yml',
    import.meta.url,
  ),
  'main-qualification.yml': new URL(
    '../../.github/workflows/main-qualification.yml',
    import.meta.url,
  ),
  'publish-packages.yml': new URL(
    '../../.github/workflows/publish-packages.yml',
    import.meta.url,
  ),
};
const LEDGER_JSON_URL = new URL(
  '../../docs/reference/deploy-ledger.json',
  import.meta.url,
);
const workflowText = (name: string) => {
  const url = WORKFLOW_URLS[name];
  expect(url, `anchored workflow: ${name}`).toBeDefined();
  return readFileSync(url as URL, 'utf8');
};
const makeTempDir = trackTempDirs();

const RUN_ID = '43700000001';
const CLI_VERSION = `0.11.0-nightly.20261114.${RUN_ID}`;
const NATIVE_VERSION = '0.1.11-nightly.20261114.3';
const CLI_RECORDED_AT = '2026-11-14T12:00:00Z';

/** The fixture runs these exact files, copied from this checkout. */
const LEDGER_SCRIPTS = [
  'scripts/deploy-changelog.mjs',
  'scripts/deploy-ledger.mjs',
  'scripts/lib/bounded-capture.mjs',
  'scripts/lib/deploy-ledger-commit.mjs',
  'scripts/lib/module-entry.mjs',
  'scripts/lib/nightly-cli-ledger-handoff.mjs',
  'scripts/lib/npm-registry-provenance.mjs',
  'scripts/normalize-deploy-ledger-head.mjs',
  'scripts/verify-npm-registry-provenance.mjs',
];

type Step = {
  id?: string;
  if?: string;
  name?: string;
  run?: string;
  env?: Record<string, string>;
};
type Job = {
  if?: string;
  needs?: string[];
  outputs?: Record<string, string>;
  steps?: Step[];
};
type Workflow = { jobs: Record<string, Job> };
const workflow = (name: string) => load(workflowText(name)) as Workflow;
const stepRun = (job: Job, name: string) => {
  const step = (job.steps ?? []).find((candidate) => candidate.name === name);
  expect(step, `step must exist: ${name}`).toBeDefined();
  return step?.run ?? '';
};
const nativeRecordScript = () =>
  stepRun(
    workflow('nightly-native-cohort.yml').jobs['record-native-completion'],
    'Record durable completion only after the verified final receipt',
  );
/** Whether the cohort's marker step runs after the ledger step ended so. */
function markerRuns(ledgerExit: number | null, output: string) {
  const marker = (
    workflow('nightly-native-cohort.yml').jobs['record-native-completion']
      .steps ?? []
  ).find(
    (step) =>
      step.name === 'Advance final Android marker with exact REST readback',
  ) as Step & { if?: string };
  expect(marker?.if).toBeDefined();
  const outputs = Object.fromEntries(
    output
      .split('\n')
      .filter((line) => line.includes('='))
      .map((line) => line.split('=') as [string, string]),
  );
  return evaluateIf(marker.if ?? '', {
    steps: { durable_ledger: { outputs } },
    priorSuccess: ledgerExit === 0,
  });
}

const fallbackScript = () =>
  stepRun(
    workflow('nightly.yml').jobs['record-cli-ledger'],
    'Record the independent CLI ship in the deploy ledger',
  );

type Entry = {
  timestampUtc: string;
  channel: string;
  version: string;
  sha: string;
  artifactBuiltAt: string | null;
  workflowRunUrl: string | null;
  artifacts: string[];
  gateResult: string;
  notes: string[] | null;
  changelog: {
    previousSha: string | null;
    commitCount?: number;
    note?: string | null;
    groups?: Record<string, string[]>;
  };
};

/** The newest real npm, Android and desktop rows the checked-in ledger holds. */
function realNightlyRows(): Entry[] {
  const entries = JSON.parse(readFileSync(LEDGER_JSON_URL, 'utf8')) as Entry[];
  return ['nightly-desktop', 'nightly-android', 'nightly-npm'].map(
    (channel) => {
      const row = entries.find((entry) => entry.channel === channel);
      expect(row, `main must record a ${channel} row`).toBeDefined();
      return row as Entry;
    },
  );
}

function makeGit(globalConfig: string) {
  /** Untrimmed stdout, for file bytes. */
  const raw = (cwd: string, ...args: string[]) => {
    const result = spawnSync('git', args, {
      cwd,
      encoding: 'utf8',
      windowsHide: true,
      maxBuffer: 1 << 26,
      env: { ...process.env, GIT_CONFIG_GLOBAL: globalConfig },
    });
    if (result.status !== 0)
      throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
    return result.stdout;
  };
  const git = (cwd: string, ...args: string[]) => raw(cwd, ...args).trim();
  return { git, raw };
}

let scratchFiles = 0;

/**
 * origin/main: P (feature, carries the scripts) -> L0 (the real rows,
 * re-pointed at P) -> S (the source this night ships). A runner clone is
 * detached at S, as actions/checkout leaves the record jobs.
 */
function makeFixture() {
  const dir = makeTempDir('station-ledger-batch-');
  const globalConfig = join(dir, 'gitconfig');
  writeFileSync(
    globalConfig,
    '[user]\n\tname = test\n\temail = test@example.com\n[commit]\n\tgpgsign = false\n',
  );
  const { git, raw: gitRaw } = makeGit(globalConfig);
  const origin = join(dir, 'origin.git');
  const seed = join(dir, 'seed');
  git(dir, 'init', '-q', '--bare', '-b', 'main', 'origin.git');
  git(dir, 'clone', '-q', origin, 'seed');
  for (const path of LEDGER_SCRIPTS) {
    mkdirSync(dirname(join(seed, path)), { recursive: true });
    copyFileSync(resolve(root, path), join(seed, path));
  }
  // A record group that fails is the seam the record step's fallback
  // exists for. The real appender runs as `deploy-ledger-real.mjs`; this
  // front exits 1 for the channel FIXTURE_REFUSE_CHANNEL names, as a
  // validation refusal would, and is the real appender otherwise. With
  // FIXTURE_REFUSE_ONCE_FILE it refuses only the first time. With
  // FIXTURE_CONCURRENT_CLONE it also lands another writer's ledger commit
  // on main at the moment of the refusal, from that clone.
  copyFileSync(
    resolve(root, 'scripts/deploy-ledger.mjs'),
    join(seed, 'scripts/deploy-ledger-real.mjs'),
  );
  writeFileSync(
    join(seed, 'scripts/deploy-ledger.mjs'),
    [
      "import { main } from './deploy-ledger-real.mjs';",
      "export * from './deploy-ledger-real.mjs';",
      "import { existsSync, realpathSync, writeFileSync } from 'node:fs';",
      "import { execFileSync } from 'node:child_process';",
      "import { fileURLToPath } from 'node:url';",
      'if (realpathSync(process.argv[1] ?? "") === realpathSync(fileURLToPath(import.meta.url))) {',
      '  const argv = process.argv.slice(2);',
      '  const refused = process.env.FIXTURE_REFUSE_CHANNEL;',
      '  const once = process.env.FIXTURE_REFUSE_ONCE_FILE;',
      "  if (refused && argv[argv.indexOf('--channel') + 1] === refused && !(once && existsSync(once))) {",
      "    if (once) writeFileSync(once, 'refused');",
      '    const other = process.env.FIXTURE_CONCURRENT_CLONE;',
      '    if (other) {',
      "      const run = (cmd, args) => execFileSync(cmd, args, { cwd: other, stdio: 'ignore' });",
      "      run('git', ['fetch', '-q', 'origin']);",
      "      run('git', ['checkout', '-q', '--detach', 'origin/main']);",
      "      run(process.execPath, [other + '/scripts/deploy-ledger-real.mjs', '--channel', 'stable-npm', '--version', '0.12.0', '--sha', 'c'.repeat(40), '--timestamp', '2026-11-14T12:00:00Z', '--gate-result', 'concurrent writer', '--github-repo', 'kontourai/station', '--artifact', 'npm:concurrent']);",
      "      run('git', ['commit', '-q', '-am', 'docs(ledger): record stable-npm 0.12.0 from run 2']);",
      "      run('git', ['push', '-q', 'origin', 'HEAD:refs/heads/main']);",
      '    }',
      '    console.error(`::error::fixture refusal of ${refused}`);',
      '    process.exit(1);',
      '  }',
      '  process.exit(main(argv));',
      '}',
      '',
    ].join('\n'),
  );
  // The attested final receipt is release-cohort's contract; here it only
  // has to let the step reach its ledger writes.
  writeFileSync(
    join(seed, 'scripts/release-cohort-workflow.mjs'),
    "const [command] = process.argv.slice(2);\nif (command !== 'assert-final' && command !== 'final-platform-notes') process.exit(1);\n",
  );
  mkdirSync(join(seed, 'docs/reference'), { recursive: true });
  const ledgerJson = join(seed, 'docs/reference/deploy-ledger.json');
  const ledgerMd = join(seed, 'docs/reference/deploy-ledger.md');
  writeFileSync(ledgerJson, '[]\n');
  writeFileSync(ledgerMd, '# Deploy ledger\n');
  writeFileSync(join(seed, 'src.txt'), 'one\n');
  git(seed, 'add', '-A');
  git(seed, 'commit', '-q', '-m', 'feat: seed the fixture (#1)');
  const previousSha = git(seed, 'rev-parse', 'HEAD');
  const seedRows = realNightlyRows().map((row) => ({
    ...row,
    sha: previousSha,
  }));
  writeFileSync(ledgerJson, `${JSON.stringify(seedRows, null, 2)}\n`);
  writeFileSync(
    ledgerMd,
    renderLedgerMarkdown({
      entries: seedRows,
      githubRepo: 'kontourai/station',
    }),
  );
  git(seed, 'add', '-A');
  git(
    seed,
    'commit',
    '-q',
    '-m',
    'docs(ledger): record nightly-desktop 0.1.11-nightly.20261114.2 from run 43653046102',
  );
  const seedLedger = {
    json: readFileSync(ledgerJson, 'utf8'),
    md: readFileSync(ledgerMd, 'utf8'),
  };
  writeFileSync(join(seed, 'src.txt'), 'two\n');
  git(
    seed,
    'commit',
    '-q',
    '-am',
    'feat(cli): the change this night ships (#2)',
  );
  const sourceSha = git(seed, 'rev-parse', 'HEAD');
  git(seed, 'push', '-q', 'origin', 'HEAD:refs/heads/main');

  const stubBin = join(dir, 'bin');
  mkdirSync(stubBin);
  // `npm view <pkg>@<version> gitHead --json`: the registry's answer.
  writeFileSync(
    join(stubBin, 'npm'),
    '#!/usr/bin/env bash\n[ "$1" = view ] || exit 64\n[ "$STUB_NPM_HANG" = 1 ] && exec sleep 600\nprintf \'"%s"\\n\' "$STUB_REGISTRY_GITHEAD"\n',
  );
  chmodSync(join(stubBin, 'npm'), 0o755);
  // The record job's `timeout 120` is GNU coreutils on the runner. Here it
  // is shortened to two seconds (perl's alarm, so it also runs on hosts
  // without coreutils): the step must treat the bound's non-zero exit as
  // any other registry failure.
  writeFileSync(
    join(stubBin, 'timeout'),
    '#!/usr/bin/env bash\nshift\nexec perl -e \'alarm 2; exec @ARGV or exit 127\' "$@"\n',
  );
  chmodSync(join(stubBin, 'timeout'), 0o755);

  let runners = 0;
  /** A fresh job checkout at the source SHA, as actions/checkout leaves it. */
  const runner = () => {
    runners += 1;
    const clone = join(dir, `runner-${runners}`);
    git(dir, 'clone', '-q', origin, clone);
    git(clone, 'checkout', '-q', '--detach', sourceSha);
    return clone;
  };
  const env = (extra: Record<string, string>) => ({
    PATH: `${stubBin}:${process.env.PATH ?? ''}`,
    HOME: process.env.HOME ?? dir,
    GIT_CONFIG_GLOBAL: globalConfig,
    GITHUB_RUN_ID: RUN_ID,
    GITHUB_SERVER_URL: 'https://github.com',
    GITHUB_REPOSITORY: 'kontourai/station',
    // Non-empty like the app token; the extraheader it arms only applies
    // to https://github.com, never to this local origin.
    GITHUB_TOKEN: 'fixture-token',
    ...extra,
  });
  const bash = (cwd: string, script: string, extra: Record<string, string>) => {
    scratchFiles += 1;
    const file = join(dir, `step-${scratchFiles}.sh`);
    writeFileSync(file, script);
    return spawnSync(
      'bash',
      ['--noprofile', '--norc', '-eo', 'pipefail', file],
      {
        cwd,
        encoding: 'utf8',
        windowsHide: true,
        env: env(extra),
      },
    );
  };

  /** Run the cohort's real `durable_ledger` step in a fresh job checkout. */
  const runNativeRecord = ({
    receipt = cliReceipt(sourceSha),
    registryGitHead = sourceSha,
    android = 'complete',
    macos = 'complete',
    refuseChannel = '',
    refuseOnce = false,
    concurrentWriter = false,
    npmHangs = false,
  }: {
    receipt?: Record<string, unknown> | null;
    registryGitHead?: string;
    android?: string;
    macos?: string;
    refuseChannel?: string;
    refuseOnce?: boolean;
    concurrentWriter?: boolean;
    npmHangs?: boolean;
  } = {}) => {
    const clone = runner();
    const write = (path: string, value: unknown) => {
      mkdirSync(dirname(join(clone, path)), { recursive: true });
      writeFileSync(join(clone, path), `${JSON.stringify(value, null, 2)}\n`);
    };
    write('cohort/final-cohort-receipt.json', {
      state:
        android === 'complete' && macos === 'complete' ? 'complete' : 'partial',
      platforms: { android: { state: android }, macos: { state: macos } },
      versionIdentities: {
        android: { versionName: NATIVE_VERSION },
        desktop: { version: NATIVE_VERSION },
      },
    });
    for (const platform of ['android', 'macos'])
      write(`cohort/cohort-${platform}/station-client-build.json`, {
        sha: sourceSha,
        builtAt: '2026-11-14T12:30:00.000Z',
      });
    if (receipt !== null) write('cli-receipt/nightly-cli.json', receipt);
    scratchFiles += 1;
    const output = join(dir, `native-output-${scratchFiles}`);
    writeFileSync(output, '');
    const script = nativeRecordScript().replaceAll(
      '$' + '{{ inputs.source_sha }}',
      sourceSha,
    );
    expect(script).not.toContain('${{');
    const result = bash(clone, script, {
      IOS_DELIVERY_RESULT: 'success',
      SOURCE_SHA: sourceSha,
      GITHUB_OUTPUT: output,
      STUB_REGISTRY_GITHEAD: registryGitHead,
      FIXTURE_REFUSE_CHANNEL: refuseChannel,
      FIXTURE_REFUSE_ONCE_FILE: refuseOnce
        ? join(dir, `refused-${scratchFiles}`)
        : '',
      FIXTURE_CONCURRENT_CLONE: concurrentWriter ? runner() : '',
      STUB_NPM_HANG: npmHangs ? '1' : '',
    });
    return { ...result, output: readFileSync(output, 'utf8') };
  };

  /** Run nightly.yml's real record-cli-ledger step in a fresh job checkout. */
  const runFallback = (refuseChannel = '') => {
    const script = fallbackScript();
    expect(script).not.toContain('${{');
    return bash(runner(), script, {
      CLI_VERSION,
      CLI_RECORDED_AT,
      SOURCE_SHA: sourceSha,
      FIXTURE_REFUSE_CHANNEL: refuseChannel,
    });
  };

  const mainHead = () => git(origin, 'rev-parse', 'main');
  const ledgerAt = (ref: string) =>
    JSON.parse(
      git(origin, 'show', `${ref}:docs/reference/deploy-ledger.json`),
    ) as Entry[];
  const commitsSince = (base: string) =>
    git(origin, 'log', '--format=%H%x09%s', `${base}..main`)
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [sha, subject] = line.split('\t');
        const paths = git(
          origin,
          'diff-tree',
          '--no-commit-id',
          '--no-renames',
          '--name-only',
          '-r',
          sha,
        )
          .split('\n')
          .filter(Boolean);
        return { sha, subject, paths };
      })
      .reverse();
  return {
    dir,
    git,
    gitRaw,
    origin,
    sourceSha,
    previousSha,
    seedLedger,
    runner,
    env,
    runNativeRecord,
    runFallback,
    mainHead,
    ledgerAt,
    commitsSince,
  };
}

/** The receipt exactly as nightly-cli's provenance step writes it. */
function cliReceipt(
  sourceSha: string,
  overrides: Record<string, unknown> = {},
) {
  return {
    schemaVersion: 1,
    kind: 'station.npm-publish-receipt',
    package: '@kontourai/station-cli',
    version: CLI_VERSION,
    sourceSha,
    registryGitHead: sourceSha,
    verifiedAt: CLI_RECORDED_AT,
    artifactBuiltAt: null,
    artifactBuiltAtReason: 'npm package has no native artifact manifest',
    sourceBinding: 'npm registry gitHead',
    ...overrides,
  };
}

const LEDGER_PATHS = [
  'docs/reference/deploy-ledger.json',
  'docs/reference/deploy-ledger.md',
];
const rowIds = (entries: Entry[]) =>
  entries.map((entry) => `${entry.channel} ${entry.version}`);
const BATCH_SUBJECT = `docs(ledger): record nightly-npm ${CLI_VERSION}, nightly-android ${NATIVE_VERSION}, nightly-desktop ${NATIVE_VERSION} from run ${RUN_ID}`;

describe.skipIf(process.platform === 'win32')(
  'one deploy-ledger commit per Nightly run',
  () => {
    it('writes npm, Android and desktop in ONE ledger-only commit, and the fallback then finds nothing to do', () => {
      const f = makeFixture();
      const before = f.mainHead();
      const native = f.runNativeRecord();
      expect(native.status, native.stderr).toBe(0);
      expect(native.output).toContain('android=complete');
      const afterNative = f.mainHead();
      const commits = f.commitsSince(before);
      expect(commits).toHaveLength(1);
      expect(commits[0].subject).toBe(BATCH_SUBJECT);
      expect(commits[0].subject).toMatch(GENERATED_LEDGER_SUBJECT);
      expect(commits[0].paths.sort()).toEqual(LEDGER_PATHS);
      const ledger = f.ledgerAt('main');
      expect(rowIds(ledger.slice(0, 3))).toEqual([
        `nightly-desktop ${NATIVE_VERSION}`,
        `nightly-android ${NATIVE_VERSION}`,
        `nightly-npm ${CLI_VERSION}`,
      ]);
      // The npm row is the one nightly-cli would have written itself: the
      // verification moment, its own gate sentence, no iOS note.
      const npm = ledger[2];
      expect(npm).toMatchObject({
        timestampUtc: CLI_RECORDED_AT,
        sha: f.sourceSha,
        artifactBuiltAt: null,
        workflowRunUrl: `https://github.com/kontourai/station/actions/runs/${RUN_ID}`,
        artifacts: [
          `npm:@kontourai/station-cli@${CLI_VERSION} (dist-tag nightly; artifactBuiltAt unknown)`,
        ],
        gateResult:
          'Nightly exact gates success; npm registry gitHead equals source SHA',
        notes: [
          'artifactBuiltAt is null: npm package has no native artifact manifest',
        ],
      });
      expect(npm.changelog.previousSha).toBe(f.previousSha);
      expect(npm.changelog.commitCount).toBe(1);

      const fallback = f.runFallback();
      expect(fallback.status, fallback.stderr).toBe(0);
      expect(fallback.stdout).toContain('nothing committed');
      expect(f.mainHead()).toBe(afterNative);
      expect(
        f
          .ledgerAt('main')
          .filter(
            (entry) =>
              entry.channel === 'nightly-npm' && entry.version === CLI_VERSION,
          ),
      ).toHaveLength(1);
    });

    it('when the npm group is refused, records Android and desktop in their own commits as main did, moves the marker, and leaves npm to the fallback', () => {
      const f = makeFixture();
      const before = f.mainHead();
      const native = f.runNativeRecord({ refuseChannel: 'nightly-npm' });
      expect(native.status, native.stderr).toBe(0);
      expect(native.stdout).toContain(
        'The combined ledger commit failed; recording each native row in its own commit',
      );
      expect(f.commitsSince(before).map((commit) => commit.subject)).toEqual([
        `docs(ledger): record nightly-android ${NATIVE_VERSION} from run ${RUN_ID}`,
        `docs(ledger): record nightly-desktop ${NATIVE_VERSION} from run ${RUN_ID}`,
      ]);
      expect(markerRuns(native.status, native.output)).toBe(true);
      // The fallback then refuses on its own (same cause), or records it.
      expect(f.runFallback('nightly-npm').status).toBe(1);
      expect(f.commitsSince(before)).toHaveLength(2);
      expect(f.runFallback().status).toBe(0);
      expect(f.commitsSince(before).map((commit) => commit.subject)).toEqual([
        `docs(ledger): record nightly-android ${NATIVE_VERSION} from run ${RUN_ID}`,
        `docs(ledger): record nightly-desktop ${NATIVE_VERSION} from run ${RUN_ID}`,
        `docs(ledger): record nightly-npm ${CLI_VERSION} from run ${RUN_ID}`,
      ]);
    });

    it('when the desktop group is refused, records Android as main did and holds the marker as main did', () => {
      const f = makeFixture();
      const before = f.mainHead();
      const native = f.runNativeRecord({ refuseChannel: 'nightly-desktop' });
      expect(native.status).not.toBe(0);
      expect(f.commitsSince(before).map((commit) => commit.subject)).toEqual([
        `docs(ledger): record nightly-android ${NATIVE_VERSION} from run ${RUN_ID}`,
      ]);
      // On main the Android commit lands, the desktop record fails the step,
      // and the marker's implicit success() keeps it behind.
      expect(native.output).toContain('android=complete');
      expect(markerRuns(native.status, native.output)).toBe(false);
      expect(f.runFallback().status).toBe(0);
      expect(
        f.ledgerAt('main').filter((entry) => entry.version === CLI_VERSION),
      ).toHaveLength(1);
    });

    it('still records the native rows when main moves a ledger file between the failed combined commit and the per-row fallback', () => {
      // Desktop refused inside the combined commit leaves Android's row
      // appended but uncommitted; another writer lands on main right then.
      const f = makeFixture();
      const before = f.mainHead();
      const once = f.runNativeRecord({
        refuseChannel: 'nightly-desktop',
        refuseOnce: true,
        concurrentWriter: true,
      });
      expect(once.status, once.stderr).toBe(0);
      expect(once.stderr).not.toContain('would be overwritten by checkout');
      expect(f.commitsSince(before).map((commit) => commit.subject)).toEqual([
        'docs(ledger): record stable-npm 0.12.0 from run 2',
        `docs(ledger): record nightly-android ${NATIVE_VERSION} from run ${RUN_ID}`,
        `docs(ledger): record nightly-desktop ${NATIVE_VERSION} from run ${RUN_ID}`,
      ]);
      expect(markerRuns(once.status, once.output)).toBe(true);

      const g = makeFixture();
      const gBefore = g.mainHead();
      const always = g.runNativeRecord({
        refuseChannel: 'nightly-desktop',
        concurrentWriter: true,
      });
      expect(always.status).not.toBe(0);
      expect(always.stderr).not.toContain('would be overwritten by checkout');
      expect(g.commitsSince(gBefore).map((commit) => commit.subject)).toEqual([
        'docs(ledger): record stable-npm 0.12.0 from run 2',
        `docs(ledger): record nightly-android ${NATIVE_VERSION} from run ${RUN_ID}`,
      ]);
      expect(markerRuns(always.status, always.output)).toBe(false);
    });

    it('treats a registry read that hits its hard bound like any other failure', () => {
      const f = makeFixture();
      const before = f.mainHead();
      const native = f.runNativeRecord({ npmHangs: true });
      expect(native.status, native.stderr).toBe(0);
      expect(native.stdout).toContain(
        'The CLI receipt did not verify here; record-cli-ledger records the npm row on its own.',
      );
      expect(f.commitsSince(before).map((commit) => commit.subject)).toEqual([
        `docs(ledger): record nightly-android ${NATIVE_VERSION}, nightly-desktop ${NATIVE_VERSION} from run ${RUN_ID}`,
      ]);
      expect(markerRuns(native.status, native.output)).toBe(true);
      expect(f.runFallback().status).toBe(0);
      expect(
        f.ledgerAt('main').filter((entry) => entry.version === CLI_VERSION),
      ).toHaveLength(1);
    });

    it('refuses rather than writes duplicates when the step runs again after its combined commit landed', () => {
      const f = makeFixture();
      const before = f.mainHead();
      const first = f.runNativeRecord();
      expect(first.status, first.stderr).toBe(0);
      expect(first.stdout).toContain("recorded this run's rows in one commit");
      expect(first.stdout).not.toContain('combined ledger commit failed');
      expect(markerRuns(first.status, first.output)).toBe(true);
      const landed = f.mainHead();
      const again = f.runNativeRecord();
      expect(again.status).not.toBe(0);
      expect(again.stderr).toContain('already records this ship');
      expect(f.mainHead()).toBe(landed);
      const ledger = f.ledgerAt('main');
      for (const channel of [
        'nightly-npm',
        'nightly-android',
        'nightly-desktop',
      ])
        expect(
          ledger.filter(
            (entry) => entry.channel === channel && entry.sha === f.sourceSha,
          ),
          channel,
        ).toHaveLength(1);
      expect(f.commitsSince(before)).toHaveLength(1);
    });

    it('records the npm row alone when the cohort never reaches its record job', () => {
      const f = makeFixture();
      const before = f.mainHead();
      const fallback = f.runFallback();
      expect(fallback.status, fallback.stderr).toBe(0);
      const commits = f.commitsSince(before);
      expect(commits).toHaveLength(1);
      expect(commits[0].subject).toBe(
        `docs(ledger): record nightly-npm ${CLI_VERSION} from run ${RUN_ID}`,
      );
      expect(commits[0].paths.sort()).toEqual(LEDGER_PATHS);
      expect(rowIds(f.ledgerAt('main').slice(0, 1))).toEqual([
        `nightly-npm ${CLI_VERSION}`,
      ]);
    });

    it('a re-run record job after the fallback wrote npm adds only the native rows, in one commit', () => {
      const f = makeFixture();
      const before = f.mainHead();
      expect(f.runFallback().status).toBe(0);
      const native = f.runNativeRecord();
      expect(native.status, native.stderr).toBe(0);
      const commits = f.commitsSince(before);
      expect(commits.map((commit) => commit.subject)).toEqual([
        `docs(ledger): record nightly-npm ${CLI_VERSION} from run ${RUN_ID}`,
        `docs(ledger): record nightly-android ${NATIVE_VERSION}, nightly-desktop ${NATIVE_VERSION} from run ${RUN_ID}`,
      ]);
      const npmRows = f
        .ledgerAt('main')
        .filter(
          (entry) =>
            entry.channel === 'nightly-npm' && entry.version === CLI_VERSION,
        );
      expect(npmRows).toHaveLength(1);
    });

    it('leaves the npm row to the fallback when the receipt does not verify, and still records the native rows', () => {
      const cases: Array<
        [
          string,
          (
            sourceSha: string,
          ) => Parameters<ReturnType<typeof makeFixture>['runNativeRecord']>[0],
        ]
      > = [
        [
          'another run’s version',
          (sha) => ({
            receipt: cliReceipt(sha, { version: '0.11.0-nightly.20261114.99' }),
          }),
        ],
        [
          'a different source',
          (sha) => ({
            receipt: cliReceipt(sha, { sourceSha: 'e'.repeat(40) }),
          }),
        ],
        ['the registry disagrees', () => ({ registryGitHead: 'f'.repeat(40) })],
        [
          'a verifiedAt in the future',
          (sha) => ({
            receipt: cliReceipt(sha, { verifiedAt: '2099-01-01T00:00:00Z' }),
          }),
        ],
        [
          'a seven-digit date',
          (sha) => ({
            receipt: cliReceipt(sha, {
              version: `0.11.0-nightly.2026111.${RUN_ID}`,
            }),
          }),
        ],
        [
          'an extra segment before the run id',
          (sha) => ({
            receipt: cliReceipt(sha, {
              version: `0.11.0-nightly.20261114.1.${RUN_ID}`,
            }),
          }),
        ],
        [
          'a non-numeric core',
          (sha) => ({
            receipt: cliReceipt(sha, {
              version: `0.x.0-nightly.20261114.${RUN_ID}`,
            }),
          }),
        ],
        [
          'a version that only ends in the run id',
          (sha) => ({
            receipt: cliReceipt(sha, {
              version: `0.11.0-nightly.20261114.x.${RUN_ID}`,
            }),
          }),
        ],
        ['no receipt in this run', () => ({ receipt: null })],
      ];
      for (const [label, options] of cases) {
        const f = makeFixture();
        const before = f.mainHead();
        const native = f.runNativeRecord(options(f.sourceSha));
        expect(native.status, `${label}: ${native.stderr}`).toBe(0);
        expect(
          f.commitsSince(before).map((commit) => commit.subject),
          label,
        ).toEqual([
          `docs(ledger): record nightly-android ${NATIVE_VERSION}, nightly-desktop ${NATIVE_VERSION} from run ${RUN_ID}`,
        ]);
        expect(f.runFallback().status, label).toBe(0);
        expect(f.commitsSince(before), label).toHaveLength(2);
        expect(
          f
            .ledgerAt('main')
            .filter(
              (entry) =>
                entry.channel === 'nightly-npm' &&
                entry.version === CLI_VERSION,
            ),
          label,
        ).toHaveLength(1);
      }
    }, 120_000);

    it('re-derives all three rows and converges when another writer lands between derive and push', () => {
      const f = makeFixture();
      const writer = f.runner();
      const other = f.runner();
      const appender = (
        clone: string,
        channel: string,
        version: string,
        sha: string,
      ) => [
        process.execPath,
        join(clone, 'scripts/deploy-ledger.mjs'),
        '--channel',
        channel,
        '--version',
        version,
        '--sha',
        sha,
        '--timestamp',
        CLI_RECORDED_AT,
        '--gate-result',
        'fixture gate',
        '--github-repo',
        'kontourai/station',
        '--artifact',
        `${channel}:${version}`,
      ];
      const before = f.mainHead();
      const env = { ...f.env({}), GITHUB_TOKEN: '' };
      const result = commitLedgerWithRetry({
        repoRoot: writer,
        recordArgvs: [
          [
            ...appender(writer, 'nightly-npm', CLI_VERSION, f.sourceSha),
            '--if-absent',
          ],
          appender(writer, 'nightly-android', NATIVE_VERSION, f.sourceSha),
          appender(writer, 'nightly-desktop', NATIVE_VERSION, f.sourceSha),
        ],
        subjectRunId: RUN_ID,
        env,
        onBeforePush: (attempt) => {
          if (attempt !== 1) return;
          const landed = commitLedgerWithRetry({
            repoRoot: other,
            recordArgv: appender(other, 'stable-npm', '0.11.0', f.previousSha),
            commitSubject: 'docs(ledger): record stable-npm 0.11.0 from run 1',
            env,
          });
          expect(landed.pushed).toBe(true);
        },
      });
      expect(result).toMatchObject({ pushed: true, attempts: 2 });
      const commits = f.commitsSince(before);
      expect(commits.map((commit) => commit.subject)).toEqual([
        'docs(ledger): record stable-npm 0.11.0 from run 1',
        BATCH_SUBJECT,
      ]);
      expect(rowIds(f.ledgerAt('main').slice(0, 4))).toEqual([
        `nightly-desktop ${NATIVE_VERSION}`,
        `nightly-android ${NATIVE_VERSION}`,
        `nightly-npm ${CLI_VERSION}`,
        'stable-npm 0.11.0',
      ]);
    });

    it('every ledger reader accepts the batched history and a later npm-only commit', async () => {
      const f = makeFixture();
      // History: S -> fallback npm-only commit -> native two-row commit,
      // then (second fixture) S -> one three-row commit.
      const checks = async (fixture: ReturnType<typeof makeFixture>) => {
        const head = fixture.mainHead();
        const clone = fixture.runner();
        fixture.git(clone, 'fetch', '-q', 'origin');
        const env = fixture.env({});
        const run = (
          script: string,
          args: string[],
          extra: Record<string, string> = {},
        ) => {
          scratchFiles += 1;
          const output = join(fixture.dir, `reader-${scratchFiles}`);
          writeFileSync(output, '');
          const result = spawnSync(
            process.execPath,
            [resolve(root, script), ...args],
            {
              cwd: clone,
              encoding: 'utf8',
              windowsHide: true,
              env: { ...env, GITHUB_OUTPUT: output, ...extra },
            },
          );
          expect(result.status, `${script}: ${result.stderr}`).toBe(0);
          return readFileSync(output, 'utf8') || result.stdout;
        };
        // normalize-deploy-ledger-head: every generated commit peels back
        // to the shipped source (the stage and release-pipeline input).
        expect(
          run('scripts/normalize-deploy-ledger-head.mjs', [
            '--head-sha',
            head,
            '--stop-sha',
            fixture.sourceSha,
            '--repo-root',
            clone,
          ]).trim(),
        ).toBe(fixture.sourceSha);
        // nightly-native-stage's decision: markers at the source plus rows
        // on origin/main means no rebuild (#1780, #1802).
        expect(
          run('scripts/nightly-cohort-decide.mjs', [
            '--head-sha',
            head,
            '--android-marker',
            fixture.sourceSha,
            '--android-candidate',
            fixture.sourceSha,
            '--desktop-marker',
            fixture.sourceSha,
            '--desktop-candidate',
            fixture.sourceSha,
            '--ledger-ref',
            'origin/main',
            '--repo-root',
            clone,
          ]),
        ).toContain('build=false');
        // nightly.yml's delivery decision on the next schedule.
        const reservations = join(fixture.dir, 'reservations.txt');
        writeFileSync(reservations, '');
        expect(
          run('scripts/nightly-qualification-decide.mjs', [
            '--source-sha',
            head,
            '--reservation-refs',
            reservations,
            '--ledger-ref',
            'origin/main',
            '--repo-root',
            clone,
          ]),
        ).toContain('publish=false');
        // qualification-evidence: ledger-only ancestors are equivalent.
        expect(ledgerEquivalentSources(head, { cwd: clone })).toContain(
          fixture.sourceSha,
        );
        // main-qualification and publish-packages ignore exactly the paths
        // every generated commit touches.
        for (const commit of fixture.commitsSince(fixture.sourceSha))
          expect(commit.paths.sort()).toEqual(LEDGER_PATHS);
        for (const name of ['main-qualification.yml', 'publish-packages.yml'])
          expect(workflowText(name)).toMatch(
            /paths-ignore:\n\s+- docs\/reference\/deploy-ledger\.json\n\s+- docs\/reference\/deploy-ledger\.md\n/,
          );
        // The documentation review's generated-output contract.
        const hash = (bytes: string) =>
          createHash('sha256').update(bytes).digest('hex');
        const document = 'docs/reference/deploy-ledger.md';
        const dataPath = 'docs/reference/deploy-ledger.json';
        const owners = [
          'scripts/deploy-ledger.mjs',
          'scripts/lib/documentation-review.mjs',
        ];
        const sources = new Map<string, string>([
          [
            dataPath,
            fixture.gitRaw(fixture.origin, 'show', `main:${dataPath}`),
          ],
          [
            document,
            fixture.gitRaw(fixture.origin, 'show', `main:${document}`),
          ],
          ...owners.map(
            (path) => [path, `reviewed ${path}`] as [string, string],
          ),
        ]);
        const record = {
          path: document,
          kind: 'generated',
          state: 'source-reviewed',
          documentDigest: hash(fixture.seedLedger.md),
          documentRevision: 'b'.repeat(40),
          summary: 'Reviewed the generation contract.',
          limits: 'Does not independently verify a publication.',
          sources: [
            {
              path: dataPath,
              digest: hash(fixture.seedLedger.json),
              revision: 'b'.repeat(40),
            },
            ...owners.map((path) => ({
              path,
              digest: hash(`reviewed ${path}`),
              revision: 'b'.repeat(40),
            })),
          ],
          checks: ['Historical generation review.'],
        };
        const review = await evaluateDocumentationReview(
          record,
          new Map([[document, hash(sources.get(document) ?? '')]]),
          new Set(sources.keys()),
          async (path: string) => {
            const bytes = sources.get(path);
            if (bytes === undefined) throw new Error(`missing ${path}`);
            return bytes;
          },
          { requireFresh: true },
        );
        expect(review).toMatchObject({
          state: 'generated-validated',
          validation: { kind: 'deploy-ledger-projection' },
        });
        // deploy-changelog: the next ship's slice excludes every generated
        // commit, whatever rows it carried.
        const later = fixture.runner();
        fixture.git(later, 'checkout', '-q', '--detach', 'origin/main');
        writeFileSync(join(later, 'src.txt'), 'three\n');
        fixture.git(
          later,
          'commit',
          '-q',
          '-am',
          'fix(cli): the next night’s change (#3)',
        );
        const nextSha = fixture.git(later, 'rev-parse', 'HEAD');
        const appended = spawnSync(
          process.execPath,
          [
            join(later, 'scripts/deploy-ledger.mjs'),
            '--channel',
            'nightly-npm',
            '--version',
            '0.11.0-nightly.20261114.43700000002',
            '--sha',
            nextSha,
            '--timestamp',
            CLI_RECORDED_AT,
            '--gate-result',
            'fixture gate',
            '--github-repo',
            'kontourai/station',
            '--artifact',
            'npm:next',
          ],
          { cwd: later, encoding: 'utf8', windowsHide: true, env },
        );
        expect(appended.status, appended.stderr).toBe(0);
        const next = (
          JSON.parse(
            readFileSync(
              join(later, 'docs/reference/deploy-ledger.json'),
              'utf8',
            ),
          ) as Entry[]
        )[0];
        expect(next.changelog.previousSha).toBe(fixture.sourceSha);
        expect(next.changelog.commitCount).toBe(1);
        expect(next.changelog.groups?.fix).toEqual([
          '[#3](https://github.com/kontourai/station/pull/3) fix(cli): the next night’s change',
        ]);
      };

      expect(f.runFallback().status).toBe(0);
      expect(f.runNativeRecord().status).toBe(0);
      expect(f.commitsSince(f.sourceSha)).toHaveLength(2);
      await checks(f);

      const g = makeFixture();
      expect(g.runNativeRecord().status).toBe(0);
      expect(g.runFallback().status).toBe(0);
      expect(
        g.commitsSince(g.sourceSha).map((commit) => commit.subject),
      ).toEqual([BATCH_SUBJECT]);
      await checks(g);
    }, 120_000);
  },
);

describe.skipIf(process.platform === 'win32')(
  'Nightly CLI receipt recovery for its original run',
  () => {
    it.each([
      {
        registryHead: 'a'.repeat(40),
        publishedRunId: RUN_ID,
        expectedReceipt: true,
      },
      { registryHead: null, publishedRunId: RUN_ID, expectedReceipt: false },
      {
        registryHead: 'b'.repeat(40),
        publishedRunId: RUN_ID,
        expectedReceipt: false,
      },
      {
        registryHead: 'a'.repeat(40),
        publishedRunId: `${RUN_ID}1`,
        expectedReceipt: false,
      },
    ])(
      'recovers only exact published provenance: $registryHead from run $publishedRunId',
      ({ registryHead, publishedRunId, expectedReceipt }) => {
        const directory = makeTempDir('nightly-cli-receipt-');
        const bin = join(directory, 'bin');
        mkdirSync(bin);
        for (const file of [
          ...LEDGER_SCRIPTS,
          'scripts/lib/nightly-build-identity.mjs',
          'scripts/channel-platform-matrix.mjs',
          'scripts/product-version.mjs',
          'scripts/lib/native-release-config.mjs',
          'scripts/lib/release-tag.mjs',
          'packages/cli/package.json',
        ]) {
          const destination = join(directory, file);
          mkdirSync(dirname(destination), { recursive: true });
          copyFileSync(join(root, file), destination);
        }
        const packageVersion = JSON.parse(
          readFileSync(join(directory, 'packages/cli/package.json'), 'utf8'),
        ).version;
        const version = `${packageVersion}-nightly.20261114.${RUN_ID}`;
        const publishedVersion = `${packageVersion}-nightly.20261114.${publishedRunId}`;
        writeFileSync(
          join(bin, 'gh'),
          `#!/bin/sh
case "$*" in
  'api repos/kontourai/station/actions/runs/${RUN_ID} --jq .created_at') printf '2026-11-14T12:00:00Z\\n' ;;
  *) printf 'unexpected gh invocation: %s\\n' "$*" >&2; exit 92 ;;
esac
`,
        );
        writeFileSync(
          join(bin, 'npm'),
          `#!/bin/sh
case "$*" in
  'view @kontourai/station-cli@nightly gitHead --json') printf '"${'a'.repeat(40)}"\\n' ;;
  'view @kontourai/station-cli@${publishedVersion} gitHead --json'|'view --prefer-online @kontourai/station-cli@${publishedVersion} gitHead --json') ${registryHead === null ? 'printf \'{"code":"E404"}\\n\'; exit 1' : `printf '"${registryHead}"\\n'`} ;;
  'view @kontourai/station-cli@${version} gitHead --json') printf '{"code":"E404"}\\n'; exit 1 ;;
  *) printf 'unexpected npm invocation: %s\\n' "$*" >&2; exit 91 ;;
esac
`,
        );
        for (const executable of ['gh', 'npm'])
          chmodSync(join(bin, executable), 0o755);
        const cli = workflow('nightly.yml').jobs['nightly-cli'];
        const steps: Record<
          string,
          { outcome: string; outputs: Record<string, string> }
        > = {};
        for (const id of [
          'cli_source_decide',
          'identity',
          'npm_idempotency',
          'cli_registry_provenance',
        ]) {
          const step = cli.steps?.find((candidate) => candidate.id === id);
          expect(step?.run, id).toBeTruthy();
          steps.cli_npm_publish = { outcome: 'skipped', outputs: {} };
          const priorSuccess = Object.values(steps).every(
            (result) => result.outcome !== 'failure',
          );
          if (!evaluateIf(step?.if ?? 'success()', { steps, priorSuccess })) {
            steps[id] = { outcome: 'skipped', outputs: {} };
            continue;
          }
          const outputPath = join(directory, `${id}.output`);
          writeFileSync(outputPath, '');
          const bindings: Record<string, string> = {
            'needs.test-gate.outputs.source_sha': 'a'.repeat(40),
            'github.token': 'fixture-token',
          };
          for (const [stepId, result] of Object.entries(steps)) {
            for (const [name, value] of Object.entries(result.outputs))
              bindings[`steps.${stepId}.outputs.${name}`] = value;
          }
          const environment = Object.fromEntries(
            Object.entries(step?.env ?? {}).map(([name, value]) => [
              name,
              value.replace(
                /\$\{\{\s*([^}]+?)\s*\}\}/g,
                (_, expression: string) => {
                  expect(
                    bindings[expression],
                    `${id}: ${expression}`,
                  ).toBeDefined();
                  return bindings[expression];
                },
              ),
            ]),
          );
          if (id === 'npm_idempotency' || id === 'cli_registry_provenance')
            expect(environment.CLI_VERSION, `${id}: original run version`).toBe(
              steps.identity.outputs.version,
            );
          const result = spawnSync(
            'bash',
            ['-e', '-o', 'pipefail', '-c', step?.run ?? ''],
            {
              cwd: directory,
              encoding: 'utf8',
              windowsHide: true,
              timeout: 15_000,
              env: {
                ...process.env,
                PATH: `${bin}:${process.env.PATH}`,
                GITHUB_OUTPUT: outputPath,
                GITHUB_RUN_ID: RUN_ID,
                GITHUB_REPOSITORY: 'kontourai/station',
                SOURCE_SHA: '',
                BUILD_CLI: '',
                CLI_VERSION: '',
                RUNNER_TEMP: directory,
                ...environment,
              },
            },
          );
          if (id !== 'npm_idempotency' || registryHead !== 'b'.repeat(40))
            expect(result.status, `${id}: ${result.stderr}`).toBe(0);
          else {
            expect(result.status).not.toBe(0);
            expect(result.stderr).toContain(
              'already published from a different source',
            );
          }
          steps[id] = {
            outcome: result.status === 0 ? 'success' : 'failure',
            outputs: Object.fromEntries(
              readFileSync(outputPath, 'utf8')
                .trim()
                .split('\n')
                .filter(Boolean)
                .map((line) => line.split('=')),
            ),
          };
        }
        expect(steps.cli_registry_provenance.outcome).toBe(
          expectedReceipt ? 'success' : 'skipped',
        );
        expect(steps.identity.outputs.version).toBe(version);
        expect(
          existsSync(join(directory, 'provider-receipts/nightly-cli.json')),
        ).toBe(expectedReceipt);
        if (expectedReceipt) {
          const receipt = JSON.parse(
            readFileSync(
              join(directory, 'provider-receipts/nightly-cli.json'),
              'utf8',
            ),
          );
          expect(receipt).toMatchObject({
            sourceSha: 'a'.repeat(40),
            registryGitHead: 'a'.repeat(40),
            version,
            artifactBuiltAt: null,
          });
        }
      },
    );
  },
);

describe('the workflow wiring of the one-commit Nightly ledger', () => {
  const nightly = workflow('nightly.yml');
  const fallback = nightly.jobs['record-cli-ledger'];
  const evaluate = (
    needs: Record<string, { result: string; outputs?: Record<string, string> }>,
    { cancelled = false } = {},
  ) => evaluateIf(fallback.if ?? '', { needs, cancelled });
  const needsFor = (
    cohort: string,
    ledgerReady = 'success',
    gate = 'success',
  ) => ({
    'test-gate': { result: gate, outputs: { source_sha: 'a'.repeat(40) } },
    'nightly-cli': {
      result: 'success',
      outputs: { ledger_ready: ledgerReady },
    },
    'native-cohort': { result: cohort },
  });

  it('runs the fallback after the cohort however the cohort ended, and on a cancelled run', () => {
    expect(fallback.needs).toEqual([
      'test-gate',
      'nightly-cli',
      'native-cohort',
    ]);
    for (const cohort of ['success', 'failure', 'cancelled', 'skipped'])
      expect(evaluate(needsFor(cohort)), cohort).toBe(true);
    expect(evaluate(needsFor('cancelled'), { cancelled: true })).toBe(true);
  });

  it('runs the fallback only for a registry-verified CLI publish of the gated source', () => {
    for (const ready of ['skipped', 'failure', 'cancelled', ''])
      expect(evaluate(needsFor('skipped', ready)), ready).toBe(false);
    expect(evaluate(needsFor('skipped', 'success', 'failure'))).toBe(false);
    expect(
      evaluate({
        ...needsFor('skipped'),
        'test-gate': {
          result: 'success',
          outputs: { source_sha: 'b'.repeat(40) },
        },
      }),
    ).toBe(false);
    expect(nightly.jobs['nightly-cli'].outputs).toEqual({
      ledger_ready: '$' + '{{ steps.cli_registry_provenance.outcome }}',
      version: '$' + '{{ steps.identity.outputs.version }}',
      recorded_at:
        '$' + '{{ steps.cli_registry_provenance.outputs.recorded_at }}',
    });
  });

  it('offers the same npm row from both jobs, and only the CLI job publishes it', () => {
    const npmRecord = (script: string) => {
      const line = script
        .split('\n')
        .find((candidate) => candidate.includes('--channel nightly-npm'));
      expect(line).toBeDefined();
      const start = (line ?? '').indexOf('node scripts/deploy-ledger.mjs');
      expect(start).toBeGreaterThanOrEqual(0);
      return (line ?? '').slice(start).replace(/\)\s*$/, '');
    };
    expect(npmRecord(nativeRecordScript())).toBe(npmRecord(fallbackScript()));
    expect(npmRecord(fallbackScript())).toContain('--if-absent');
    // A registry stall must not eat the job: npm's own bounded fetch, and a
    // failure only defers the row to record-cli-ledger.
    const registryRead = nativeRecordScript()
      .split('\n')
      .find((line) => line.includes('npm view'));
    expect(registryRead).toContain(
      'timeout 120 npm view --prefer-online --fetch-timeout=30000 --fetch-retries=2 --fetch-retry-maxtimeout=10000',
    );
    expect(registryRead).toMatch(/^\s*if handoff=/);
    for (const step of nightly.jobs['nightly-cli'].steps ?? [])
      expect(step.run ?? '', step.name).not.toContain('deploy-ledger');
  });
});
