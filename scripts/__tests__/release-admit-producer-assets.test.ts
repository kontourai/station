import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { load } from 'js-yaml';
import { afterEach, describe, expect, it } from 'vitest';
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
    // Non-producer artifacts that share the download root.
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
    ...releaseVariants(tag).flatMap(
      (variant: { files: string[] }) => variant.files,
    ),
    'station-portable.tar.gz.sha256',
    `station-release-ring-${channel}.json`,
    'station-container-release.json',
  ].sort();
}

const workspaces: string[] = [];
afterEach(() => {
  for (const dir of workspaces.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

function workspace(layout: Layout) {
  const dir = mkdtempSync(join(tmpdir(), 'station-admit-producer-'));
  workspaces.push(dir);
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
  return { work, runnerTemp, artifacts, step };
}

/** Run the workflow step's own `run:` text the way a bash step runs it. */
async function runAdmitStep(layout: Layout, channel: 'preview' | 'stable') {
  expect(admitRun, `missing ${ADMIT_STEP} step`).toBeTypeOf('string');
  const ws = workspace(layout);
  const result = await runBoundedFixture(
    'bash',
    ['--noprofile', '--norc', '-eo', 'pipefail', ws.step],
    {
      cwd: ws.work,
      env: {
        PATH: process.env.PATH,
        RUNNER_TEMP: ws.runnerTemp,
        RELEASE_CHANNEL: channel,
        IOS_BUNDLE_VERSION,
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
    'refuses two producers that emit the same file name and copies nothing',
    async () => {
      const layout = producerLayout(STABLE_TAG, 'stable');
      layout['station-android'] = [
        ...(layout['station-android'] ?? []),
        'station-portable.tar.gz',
      ];
      const result = await runAdmitStep(layout, 'stable');
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain(
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
      expect(missingResult.status).not.toBe(0);
      expect(missingResult.stderr).toContain(
        'producer artifact station-desktop-linux-x86_64 is missing',
      );
      expect(missingResult.admitted).toEqual([]);

      const empty = producerLayout(STABLE_TAG, 'stable');
      empty['station-container-release'] = [];
      const emptyResult = await runAdmitStep(empty, 'stable');
      expect(emptyResult.status).not.toBe(0);
      expect(emptyResult.stderr).toContain(
        'producer artifact station-container-release is empty',
      );

      const noIpa = producerLayout(STABLE_TAG, 'stable');
      noIpa[`station-stable-ios-staged-${IOS_BUNDLE_VERSION}`] = [
        'staged-identity/source-identity.json',
      ];
      const noIpaResult = await runAdmitStep(noIpa, 'stable');
      expect(noIpaResult.status).not.toBe(0);
      expect(noIpaResult.stderr).toContain(
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
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('unknown release channel "nightly"');
    },
    FIXTURE_TEST_TIMEOUT_MS,
  );

  it('allowlists exactly the release-assets uploads of the jobs assemble-draft needs', () => {
    const assemble = release.jobs['assemble-draft'];
    const uploaded = new Set<string>();
    for (const jobName of assemble?.needs ?? []) {
      const job = release.jobs[jobName];
      for (const step of job?.steps ?? []) {
        if (!step.uses?.startsWith('actions/upload-artifact@')) continue;
        if (step.with?.path !== 'release-assets') continue;
        const name = String(step.with?.name);
        if (name === expression('matrix.artifact'))
          for (const entry of job?.strategy?.matrix?.include ?? [])
            uploaded.add(String(entry.artifact));
        else uploaded.add(name);
      }
    }
    const stable = producerArtifactSources({
      channel: 'stable',
      iosBundleVersion: IOS_BUNDLE_VERSION,
    });
    const flat = stable
      .filter((source: { directory: string }) => source.directory === '.')
      .map((source: { artifact: string }) => source.artifact)
      .sort();
    expect(flat).toEqual([...uploaded].sort());

    // The iOS device IPA comes from the reusable TestFlight workflow's staged
    // multi-path upload, which keeps its `release-assets/` directory.
    const nested = stable.filter(
      (source: { directory: string }) => source.directory !== '.',
    );
    expect(nested).toEqual([
      {
        artifact: `station-stable-ios-staged-${IOS_BUNDLE_VERSION}`,
        directory: 'release-assets',
      },
    ]);
    const iosDevice = release.jobs['ios-device'];
    expect(assemble?.needs).toContain('ios-device');
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
    expect(String(staged?.with?.path).split('\n')).toContain('release-assets');
  });
});
