import {
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { load } from 'js-yaml';
import { describe, expect, it } from 'vitest';
import { PORTABLE_SERVER_TARGETS } from '../../packages/shared/src/portable-server-targets.mjs';
import { trackTempDirs } from '../../src-server/__test-utils__/temp-dirs.js';
import {
  assertOnlyExpectedAssets,
  HOST_MANIFEST_PAYLOAD_ASSET,
} from '../lib/release-artifacts.mjs';
import { releaseVariants } from '../lib/release-variants.mjs';
import { producerArtifactSources } from '../release-admit-producer-assets.mjs';
import {
  FIXTURE_TEST_TIMEOUT_MS,
  runBoundedFixture,
} from './helpers/bounded-fixture-process.mjs';

const root = resolve(import.meta.dirname, '../..');
const releaseText = readFileSync(
  resolve(root, '.github/workflows/release.yml'),
  'utf8',
);
const testFlightText = readFileSync(
  resolve(root, '.github/workflows/testflight-delivery.yml'),
  'utf8',
);

type Step = {
  name?: string;
  run?: string;
  uses?: string;
  with?: Record<string, unknown>;
};
type Job = {
  needs?: string[];
  steps?: Step[];
  uses?: string;
  with?: Record<string, unknown>;
  strategy?: { matrix?: { include?: Array<Record<string, string>> } };
};
type Workflow = { jobs: Record<string, Job> };

const release = load(releaseText) as Workflow;
/** A GitHub expression as written in workflow YAML. */
const expression = (body: string) => `$${'{{'} ${body} }}`;
const ADMIT_STEP = 'Admit only producer release assets, never scanner scratch';
const admitRun = release.jobs['assemble-draft']?.steps?.find(
  (step) => step.name === ADMIT_STEP,
)?.run;

const STABLE_TAG = 'v1.2.3';
const PREVIEW_TAG = 'v1.2.3-preview.1';
const IOS_BUNDLE_VERSION = '10203';

type Layout = Record<string, string[]>;

/** The five station-server archives, as portable-server-archives.yml names them. */
const HOST_ARCHIVES = PORTABLE_SERVER_TARGETS.map(
  ({ os, arch, format }) => `station-server-${os}-${arch}.${format}`,
);

/**
 * Producer artifacts exactly as `download-artifact` (no merge-multiple) lays
 * them out: `<root>/<artifact-name>/<path inside the artifact>`. A
 * `path: release-assets` upload keeps the directory's contents at the
 * artifact root; the multi-path TestFlight upload keeps `release-assets/`.
 */
function producerLayout(tag: string, channel: 'preview' | 'stable'): Layout {
  const desktop = (
    os: string,
    arch: string,
    primary: string,
    updater: string,
  ) => [
    `station-${tag}-${os}-${arch}.${primary}`,
    `station-${tag}-${os}-${arch}.${updater}`,
    `station-${tag}-${os}-${arch}.${updater}.sig`,
  ];
  const iosChannel = channel === 'stable' ? 'stable' : 'beta';
  const ipa = `release-assets/station-${tag}-ios-device.ipa`;
  const layout: Layout = {
    'station-desktop-macos-aarch64': desktop(
      'macos',
      'aarch64',
      'dmg',
      'app.tar.gz',
    ),
    'station-desktop-macos-x86_64': desktop(
      'macos',
      'x86_64',
      'dmg',
      'app.tar.gz',
    ),
    'station-desktop-windows-x86_64': desktop(
      'windows',
      'x86_64',
      'msi',
      'msi.zip',
    ),
    'station-desktop-linux-x86_64': desktop(
      'linux',
      'x86_64',
      'AppImage',
      'AppImage.tar.gz',
    ),
    'station-portable': [
      'station-portable.tar.gz',
      'station-portable.tar.gz.sha256',
      `station-release-ring-${channel}.json`,
    ],
    'station-android': [
      `station-${tag}-android-universal.apk`,
      `station-${tag}-android-universal.aab`,
    ],
    'station-container-release': ['station-container-release.json'],
    // release.yml host-manifest: `path: release-assets`, so the archives and
    // the payload sit at the artifact root.
    'station-host-stream': [...HOST_ARCHIVES, HOST_MANIFEST_PAYLOAD_ASSET],
    // Non-producer artifacts that share the download root.
    // portable-server-archives.yml: one build artifact per target, holding
    // the archive and the descriptor the builder writes beside it.
    ...Object.fromEntries(
      HOST_ARCHIVES.map((archive) => [
        archive.replace(/\.(tar\.gz|zip)$/, ''),
        [archive, `${archive}.json`],
      ]),
    ),
    'station-release-client-build-provenance-4242': [
      'station-client-build.json',
    ],
    'station-container-sbom-source': ['station-container-source.json'],
    [`station-${iosChannel}-ios-staged-${IOS_BUNDLE_VERSION}`]: [
      ipa,
      'provider-receipts/testflight-build.json',
      'src-desktop/station-client-build.json',
      'staged-identity/source-identity.json',
    ],
    [`station-${iosChannel}-ios-testflight-${IOS_BUNDLE_VERSION}`]: [
      ipa,
      'provider-receipts/testflight-internal-group-assignment.json',
      'staged-identity/source-identity.json',
    ],
    'full-regression-report': ['summary.json'],
  };
  if (channel === 'stable')
    layout['station-ios-simulator-verification'] = [
      `station-${tag}-ios-simulator.app.tar.gz`,
    ];
  return layout;
}

/** Every producer-made asset release-artifacts.mjs requires for the tag. */
function requiredProducerAssets(tag: string, channel: 'preview' | 'stable') {
  return [
    ...releaseVariants(tag).flatMap((variant) => variant.files as string[]),
    'station-portable.tar.gz.sha256',
    `station-release-ring-${channel}.json`,
    'station-container-release.json',
    ...HOST_ARCHIVES,
    HOST_MANIFEST_PAYLOAD_ASSET,
  ].sort();
}

const makeTempDir = trackTempDirs();

function workspace(layout: Layout) {
  const dir = makeTempDir('station-admit-producer-');
  const work = join(dir, 'work');
  const runnerTemp = join(dir, 'runner-temp');
  const artifacts = join(runnerTemp, 'station-release-producer-artifacts');
  mkdirSync(work, { recursive: true });
  symlinkSync(join(root, 'scripts'), join(work, 'scripts'), 'dir');
  for (const [artifact, files] of Object.entries(layout)) {
    mkdirSync(join(artifacts, artifact), { recursive: true });
    for (const file of files) {
      const path = join(artifacts, artifact, file);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, `${artifact}/${file}\n`);
    }
  }
  const step = join(dir, 'admit-step.sh');
  writeFileSync(step, admitRun ?? '');
  const scratch = join(dir, 'outside');
  mkdirSync(scratch);
  return { work, runnerTemp, artifacts, step, scratch };
}

type StepOptions = {
  /** Alter the laid-out download root before the step runs. */
  mutate?: (artifacts: string, scratch: string) => void;
  iosBundleVersion?: string;
};

/** Run the workflow step's own `run:` text the way a bash step runs it. */
async function runAdmitStep(
  layout: Layout,
  channel: 'preview' | 'stable',
  { mutate, iosBundleVersion = IOS_BUNDLE_VERSION }: StepOptions = {},
) {
  expect(admitRun, `missing ${ADMIT_STEP} step`).toBeTypeOf('string');
  const ws = workspace(layout);
  mutate?.(ws.artifacts, ws.scratch);
  const result = await runBoundedFixture(
    'bash',
    ['--noprofile', '--norc', '-eo', 'pipefail', ws.step],
    {
      cwd: ws.work,
      env: {
        PATH: process.env.PATH,
        RUNNER_TEMP: ws.runnerTemp,
        RELEASE_CHANNEL: channel,
        IOS_BUNDLE_VERSION: iosBundleVersion,
      },
    },
  );
  let admitted: string[] | undefined;
  try {
    admitted = readdirSync(join(ws.work, 'release-assets')).sort();
  } catch {
    admitted = undefined;
  }
  return { ...result, admitted, ws };
}

/** A refusal exits 1 with one message line and no stack trace. */
function expectRefusal(
  result: { status: number | null; stderr: string },
  message: string,
) {
  expect(result.status, result.stderr).toBe(1);
  expect(result.stderr).toContain(message);
  expect(result.stderr).not.toMatch(/^\s+at /m);
}

type Source = { artifact: string; directory: string };

function stableSources(): Source[] {
  return producerArtifactSources({
    channel: 'stable',
    iosBundleVersion: IOS_BUNDLE_VERSION,
  });
}

type Upload = { job: string; name: string; paths: string[] };

/** `release-assets/`, `./release-assets` and `release-assets` are one path. */
const normalizePath = (path: string) =>
  path.trim().replace(/^\.\//, '').replace(/\/+$/, '');

/**
 * Uploads in the jobs `assemble-draft` downloads from that are deliberately
 * not release assets, keyed by the `name:` as written in the workflow.
 */
const KNOWN_NON_RELEASE_UPLOADS: Record<string, string> = {
  [`station-release-client-build-provenance-${expression('github.run_id')}`]:
    'build descriptor consumed by the native producers',
  'station-container-sbom-source':
    'scanner scratch; assemble-draft downloads it separately as SBOM input',
  [`station-${expression('inputs.channel')}-ios-verification-failure-${expression('inputs.bundle_version')}`]:
    'failure-only diagnostic IPA',
  [`station-${expression('inputs.channel')}-ios-testflight-${expression('inputs.bundle_version')}`]:
    'TestFlight upload receipts; the IPA is admitted from the staged artifact',
};

function jobUploads(jobLabel: string, job: Job | undefined): Upload[] {
  const uploads: Upload[] = [];
  const matrix = job?.strategy?.matrix?.include ?? [];
  for (const step of job?.steps ?? []) {
    if (!step.uses?.startsWith('actions/upload-artifact@')) continue;
    // upload-artifact names an unnamed upload `artifact`.
    const name =
      step.with?.name === undefined ? 'artifact' : String(step.with.name);
    const paths = String(step.with?.path ?? '')
      .split('\n')
      .map(normalizePath)
      .filter(Boolean);
    const names =
      name === expression('matrix.artifact')
        ? matrix.map((entry) => String(entry.artifact))
        : [name];
    for (const each of names)
      uploads.push({ job: jobLabel, name: each, paths });
  }
  return uploads;
}

/** Every upload-artifact step in a job assemble-draft needs, including called workflows. */
function neededUploads(): Upload[] {
  return (release.jobs['assemble-draft']?.needs ?? []).flatMap((jobName) => {
    const job = release.jobs[jobName];
    const called = job?.uses?.match(
      /^\.\/(\.github\/workflows\/[\w.-]+\.ya?ml)$/,
    )?.[1];
    if (!called) return jobUploads(jobName, job);
    const workflow = load(
      readFileSync(resolve(root, called), 'utf8'),
    ) as Workflow;
    return Object.entries(workflow.jobs).flatMap(([name, calledJob]) =>
      jobUploads(`${jobName} -> ${name}`, calledJob),
    );
  });
}

/**
 * Where download-artifact puts an upload's files inside `<root>/<name>/`:
 * a single directory path stores its contents at the artifact root; several
 * top-level paths keep their paths relative to the workspace.
 */
function downloadedDirectory(paths: string[]): string {
  if (paths.length === 1 && paths[0] === 'release-assets') return '.';
  const tops = new Set(paths.map((path) => path.split('/')[0]));
  if (paths.includes('release-assets') && tops.size > 1)
    return 'release-assets';
  return `unrecognized upload paths ${JSON.stringify(paths)}`;
}

/** Resolve the TestFlight caller's inputs for a Stable tag (pinned below). */
const stableName = (name: string) =>
  name
    .replace(expression('inputs.channel'), 'stable')
    .replace(expression('inputs.bundle_version'), IOS_BUNDLE_VERSION);

describe('assemble-draft producer asset admission (#2977)', () => {
  it(
    'admits every stable producer asset from the real download-artifact layout',
    async () => {
      const result = await runAdmitStep(
        producerLayout(STABLE_TAG, 'stable'),
        'stable',
      );
      expect(result.status, result.stderr).toBe(0);
      expect(result.admitted).toEqual(
        requiredProducerAssets(STABLE_TAG, 'stable'),
      );
      expect(result.admitted).toContain(`station-${STABLE_TAG}-ios-device.ipa`);
      for (const excluded of [
        'station-client-build.json',
        'station-container-source.json',
        'source-identity.json',
        'testflight-build.json',
        'summary.json',
      ])
        expect(result.admitted).not.toContain(excluded);
    },
    FIXTURE_TEST_TIMEOUT_MS,
  );

  it(
    'admits no iOS asset for a preview tag, whose variants exclude iOS',
    async () => {
      const result = await runAdmitStep(
        producerLayout(PREVIEW_TAG, 'preview'),
        'preview',
      );
      expect(result.status, result.stderr).toBe(0);
      expect(result.admitted).toEqual(
        requiredProducerAssets(PREVIEW_TAG, 'preview'),
      );
      expect(result.admitted?.some((name) => name.includes('-ios-'))).toBe(
        false,
      );
    },
    FIXTURE_TEST_TIMEOUT_MS,
  );

  it(
    'admits the host-stream archives and payload for both rings, never the per-target build artifacts',
    async () => {
      for (const [tag, channel] of [
        [STABLE_TAG, 'stable'],
        [PREVIEW_TAG, 'preview'],
      ] as const) {
        const result = await runAdmitStep(
          producerLayout(tag, channel),
          channel,
        );
        expect(result.status, result.stderr).toBe(0);
        expect(result.admitted).toEqual(
          expect.arrayContaining([
            ...HOST_ARCHIVES,
            HOST_MANIFEST_PAYLOAD_ASSET,
          ]),
        );
        // The bytes are host-stream's, not a station-server-<target> copy.
        for (const archive of HOST_ARCHIVES)
          expect(
            readFileSync(
              join(result.ws.work, 'release-assets', archive),
              'utf8',
            ),
          ).toBe(`station-host-stream/${archive}\n`);
        // Descriptors live only in the build artifacts and are not admitted.
        expect(
          result.admitted?.some((name) => name.endsWith('.json.json')),
        ).toBe(false);
        expect(
          result.admitted?.filter((name) =>
            /^station-server-.*\.(tar\.gz|zip)\.json$/.test(name),
          ),
        ).toEqual([]);
      }
    },
    FIXTURE_TEST_TIMEOUT_MS,
  );

  it(
    'refuses a missing host-stream artifact and a nested directory inside it',
    async () => {
      const missing = producerLayout(STABLE_TAG, 'stable');
      delete missing['station-host-stream'];
      const missingResult = await runAdmitStep(missing, 'stable');
      expectRefusal(
        missingResult,
        'producer artifact station-host-stream is missing',
      );
      expect(missingResult.admitted).toEqual([]);

      const nested = producerLayout(STABLE_TAG, 'stable');
      nested['station-host-stream'] = [
        ...(nested['station-host-stream'] ?? []),
        'descriptors/station-server-linux-x64.tar.gz.json',
      ];
      const nestedResult = await runAdmitStep(nested, 'stable');
      expectRefusal(
        nestedResult,
        'station-host-stream/descriptors is not a regular file',
      );
      expect(nestedResult.admitted).toEqual([]);
    },
    FIXTURE_TEST_TIMEOUT_MS,
  );

  it(
    'leaves an unexpected flat file in host-stream to the inventory, which refuses it',
    async () => {
      // Admission is an artifact allowlist: it copies every regular file of
      // an allowlisted artifact. The file-name authority is the inventory,
      // which release.yml runs next over the admitted directory.
      const layout = producerLayout(STABLE_TAG, 'stable');
      layout['station-host-stream'] = [
        ...(layout['station-host-stream'] ?? []),
        'station-server-linux-x64.tar.gz.json',
      ];
      const result = await runAdmitStep(layout, 'stable');
      expect(result.status, result.stderr).toBe(0);
      expect(result.admitted).toContain('station-server-linux-x64.tar.gz.json');
      expect(() =>
        assertOnlyExpectedAssets(
          join(result.ws.work, 'release-assets'),
          STABLE_TAG,
        ),
      ).toThrow('unexpected asset station-server-linux-x64.tar.gz.json');
    },
    FIXTURE_TEST_TIMEOUT_MS,
  );

  it(
    'refuses two producers that emit the same file name and copies nothing',
    async () => {
      const layout = producerLayout(STABLE_TAG, 'stable');
      layout['station-android'] = [
        ...(layout['station-android'] ?? []),
        'station-portable.tar.gz',
      ];
      const result = await runAdmitStep(layout, 'stable');
      expectRefusal(
        result,
        'station-portable.tar.gz is produced by both station-portable and station-android',
      );
      expect(result.admitted).toEqual([]);
    },
    FIXTURE_TEST_TIMEOUT_MS,
  );

  it(
    'refuses a missing or empty allowlisted producer artifact',
    async () => {
      const missing = producerLayout(STABLE_TAG, 'stable');
      delete missing['station-desktop-linux-x86_64'];
      const missingResult = await runAdmitStep(missing, 'stable');
      expectRefusal(
        missingResult,
        'producer artifact station-desktop-linux-x86_64 is missing',
      );
      expect(missingResult.admitted).toEqual([]);

      const empty = producerLayout(STABLE_TAG, 'stable');
      empty['station-container-release'] = [];
      const emptyResult = await runAdmitStep(empty, 'stable');
      expectRefusal(
        emptyResult,
        'producer artifact station-container-release is empty',
      );

      const noIpa = producerLayout(STABLE_TAG, 'stable');
      noIpa[`station-stable-ios-staged-${IOS_BUNDLE_VERSION}`] = [
        'staged-identity/source-identity.json',
      ];
      const noIpaResult = await runAdmitStep(noIpa, 'stable');
      expectRefusal(
        noIpaResult,
        `producer artifact station-stable-ios-staged-${IOS_BUNDLE_VERSION}/release-assets is missing`,
      );
    },
    FIXTURE_TEST_TIMEOUT_MS,
  );

  it(
    'refuses an unknown channel instead of guessing the iOS set',
    async () => {
      const result = await runAdmitStep(
        producerLayout(STABLE_TAG, 'stable'),
        'nightly' as 'stable',
      );
      expectRefusal(result, 'unknown release channel "nightly"');
    },
    FIXTURE_TEST_TIMEOUT_MS,
  );

  it(
    'refuses a nested directory in a flat producer artifact and copies nothing',
    async () => {
      const layout = producerLayout(STABLE_TAG, 'stable');
      layout['station-android'] = [
        ...(layout['station-android'] ?? []),
        'release-assets/extra.apk',
      ];
      const result = await runAdmitStep(layout, 'stable');
      expectRefusal(
        result,
        'station-android/release-assets is not a regular file',
      );
      expect(result.admitted).toEqual([]);
    },
    FIXTURE_TEST_TIMEOUT_MS,
  );

  it(
    'refuses a symlinked producer file and copies nothing',
    async () => {
      const result = await runAdmitStep(
        producerLayout(STABLE_TAG, 'stable'),
        'stable',
        {
          mutate: (artifacts, scratch) => {
            const target = join(scratch, 'elsewhere.tar.gz');
            writeFileSync(target, 'outside\n');
            const link = join(
              artifacts,
              'station-portable',
              'station-portable.tar.gz',
            );
            rmSync(link);
            symlinkSync(target, link);
          },
        },
      );
      expectRefusal(
        result,
        'station-portable/station-portable.tar.gz is not a regular file',
      );
      expect(result.admitted).toEqual([]);
    },
    FIXTURE_TEST_TIMEOUT_MS,
  );

  it(
    'refuses a symlinked producer artifact directory and copies nothing',
    async () => {
      const result = await runAdmitStep(
        producerLayout(STABLE_TAG, 'stable'),
        'stable',
        {
          mutate: (artifacts, scratch) => {
            const real = join(scratch, 'station-android');
            renameSync(join(artifacts, 'station-android'), real);
            symlinkSync(real, join(artifacts, 'station-android'), 'dir');
          },
        },
      );
      expectRefusal(
        result,
        'producer artifact station-android is not a directory',
      );
      expect(result.admitted).toEqual([]);
    },
    FIXTURE_TEST_TIMEOUT_MS,
  );

  it(
    'refuses an invalid stable iOS bundle version and copies nothing',
    async () => {
      for (const iosBundleVersion of ['', '../10203']) {
        const result = await runAdmitStep(
          producerLayout(STABLE_TAG, 'stable'),
          'stable',
          { iosBundleVersion },
        );
        expectRefusal(
          result,
          `invalid iOS bundle version ${JSON.stringify(iosBundleVersion)}`,
        );
        expect(result.admitted).toEqual([]);
      }
    },
    FIXTURE_TEST_TIMEOUT_MS,
  );

  it(
    'refuses unknown, repeated and valueless CLI options with a one-line message',
    async () => {
      const script = join(root, 'scripts/release-admit-producer-assets.mjs');
      const cases: Array<[string[], string]> = [
        [['--artifact-root', 'x'], 'unknown option "--artifact-root"'],
        [
          ['--channel', 'stable', '--channel', 'preview'],
          'option --channel is repeated',
        ],
        [['--channel'], 'option --channel needs a value'],
      ];
      for (const [args, message] of cases) {
        const result = await runBoundedFixture(
          process.execPath,
          [script, ...args],
          {
            env: { PATH: process.env.PATH },
          },
        );
        expectRefusal(result, message);
        expect(result.stderr.trim().split('\n')).toHaveLength(1);
      }
    },
    FIXTURE_TEST_TIMEOUT_MS,
  );

  it('classifies every upload in the jobs assemble-draft needs and derives each allowlisted directory', () => {
    const allowlist = new Map(
      stableSources().map((source) => [source.artifact, source.directory]),
    );
    const derived = new Map<string, string>();
    const unclassified: string[] = [];
    for (const upload of neededUploads()) {
      const name = stableName(upload.name);
      if (allowlist.has(name))
        derived.set(name, downloadedDirectory(upload.paths));
      else if (!(upload.name in KNOWN_NON_RELEASE_UPLOADS))
        unclassified.push(`${upload.job}: ${upload.name}`);
    }
    expect(unclassified).toEqual([]);
    expect(Object.fromEntries(derived)).toEqual(Object.fromEntries(allowlist));
  });

  it('reads the stable iOS device IPA from the multi-path staged TestFlight upload', () => {
    const iosDevice = release.jobs['ios-device'];
    expect(release.jobs['assemble-draft']?.needs).toContain('ios-device');
    expect(iosDevice?.uses).toBe('./.github/workflows/testflight-delivery.yml');
    expect(iosDevice?.with?.bundle_version).toBe(
      expression('needs.preflight.outputs.ios_bundle_version'),
    );
    expect(iosDevice?.with?.channel).toBe(
      expression(
        "needs.preflight.outputs.channel == 'preview' && 'beta' || 'stable'",
      ),
    );
    const staged = (load(testFlightText) as Workflow).jobs.deliver?.steps?.find(
      (step) =>
        step.name ===
        'Retain the audited IPA and receipts as the staged run artifact',
    );
    expect(staged?.with?.name).toBe(
      `station-${expression('inputs.channel')}-ios-staged-${expression('inputs.bundle_version')}`,
    );
    // A single `release-assets` path would store the IPA at the artifact
    // root, and the allowlisted `release-assets/` directory would be missing.
    const paths = String(staged?.with?.path)
      .split('\n')
      .map(normalizePath)
      .filter(Boolean);
    expect(paths).toContain('release-assets');
    expect(paths.length).toBeGreaterThan(1);
  });
});
