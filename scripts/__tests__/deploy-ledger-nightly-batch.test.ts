import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
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

type Step = { name?: string; run?: string; env?: Record<string, string> };
type Job = {
  if?: string;
  needs?: string[];
  outputs?: Record<string, string>;
  steps?: Step[];
};
type Workflow = { jobs: Record<string, Job> };
const workflow = (name: string) =>
  load(
    readFileSync(resolve(root, '.github/workflows', name), 'utf8'),
  ) as Workflow;
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
  const entries = JSON.parse(
    readFileSync(resolve(root, 'docs/reference/deploy-ledger.json'), 'utf8'),
  ) as Entry[];
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
    '#!/usr/bin/env bash\n[ "$1" = view ] || exit 64\nprintf \'"%s"\\n\' "$STUB_REGISTRY_GITHEAD"\n',
  );
  chmodSync(join(stubBin, 'npm'), 0o755);

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
  }: {
    receipt?: Record<string, unknown> | null;
    registryGitHead?: string;
    android?: string;
    macos?: string;
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
    });
    return { ...result, output: readFileSync(output, 'utf8') };
  };

  /** Run nightly.yml's real record-cli-ledger step in a fresh job checkout. */
  const runFallback = () => {
    const script = fallbackScript();
    expect(script).not.toContain('${{');
    return bash(runner(), script, {
      CLI_VERSION,
      CLI_RECORDED_AT,
      SOURCE_SHA: sourceSha,
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
          expect(
            readFileSync(resolve(root, '.github/workflows', name), 'utf8'),
          ).toMatch(
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

describe('the workflow wiring of the one-commit Nightly ledger', () => {
  const nightly = workflow('nightly.yml');
  const fallback = nightly.jobs['record-cli-ledger'];
  const evaluate = (
    needs: Record<string, unknown>,
    { cancelled = false } = {},
  ) => {
    const expression = (fallback.if ?? '')
      .slice(3, -2)
      .replace(/needs\.([\w-]+)/g, 'needs["$1"]');
    return Function(
      'needs',
      'github',
      'always',
      'cancelled',
      `return (${expression})`,
    )(
      needs,
      { ref: 'refs/heads/main', sha: 'a'.repeat(40), event_name: 'schedule' },
      () => true,
      () => cancelled,
    ) as boolean;
  };
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
      const start = (line ?? '').indexOf(
        '--record node scripts/deploy-ledger.mjs',
      );
      expect(start).toBeGreaterThanOrEqual(0);
      return (line ?? '').slice(start).replace(/\)\s*$/, '');
    };
    expect(npmRecord(nativeRecordScript())).toBe(npmRecord(fallbackScript()));
    expect(npmRecord(fallbackScript())).toContain('--if-absent');
    for (const step of nightly.jobs['nightly-cli'].steps ?? [])
      expect(step.run ?? '', step.name).not.toContain('deploy-ledger');
  });
});
