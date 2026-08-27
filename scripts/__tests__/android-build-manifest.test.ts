import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { load } from 'js-yaml';
import { afterEach, describe, expect, test } from 'vitest';
import {
  ANDROID_ASSETS_DIR,
  ANDROID_PROJECT_DIR,
  writeAndroidBuildManifest,
} from '../lib/android-build-manifest.mjs';
import { BUILD_MANIFEST_FILENAME } from '../lib/desktop-build-manifest.mjs';
import {
  APK_BUILD_MANIFEST_ENTRY,
  parseAndroidBuildProvenance,
} from '../read-android-build-provenance.mjs';

const repoRoot = resolve(import.meta.dirname, '../..');
const roots: string[] = [];

const SHA = 'abcdef0123456789abcdef0123456789abcdef01';

/**
 * Pinned here rather than imported, deliberately. An earlier revision asserted
 * the written path against the module's own `ANDROID_ASSETS_DIR`, so mutating
 * that constant moved the expectation with it and the test stayed green — it
 * proved the module agreed with itself, not that it wrote where Gradle looks.
 *
 * These two paths are not the module's to choose: `app/src/main/assets/` is
 * Android's asset source set (Tauri reaches the APK through the very same
 * directory with `tauri.conf.json`), and `src-desktop/gen/android` is where
 * `tauri android init` generates the project. The final test in this file
 * anchors the first path to the real checkout.
 */
const ANDROID_GENERATED_PROJECT = join('src-desktop', 'gen', 'android');
const ANDROID_ASSET_SOURCE_SET = join(
  ANDROID_GENERATED_PROJECT,
  'app',
  'src',
  'main',
  'assets',
);

/**
 * A throwaway checkout whose provenance comes from `.station-release.json`
 * rather than a real `git init`, so this file starts no child processes and
 * stays in the ordinary Vitest worker pool.
 */
function makeRoot({
  initialized = true,
}: {
  initialized?: boolean;
} = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'station-android-manifest-'));
  roots.push(root);
  if (initialized) {
    mkdirSync(join(root, ANDROID_GENERATED_PROJECT), { recursive: true });
  }
  return root;
}

function withReleaseManifest(root: string, ref = 'v9.9.9'): string {
  writeFileSync(
    join(root, '.station-release.json'),
    JSON.stringify({ schemaVersion: 1, sha: SHA, ref }),
  );
  return root;
}

afterEach(() => {
  while (roots.length > 0) {
    rmSync(roots.pop() as string, { recursive: true, force: true });
  }
});

interface WorkflowStep {
  name?: string;
  run?: string;
}
interface Workflow {
  jobs?: Record<string, { steps?: WorkflowStep[] } | undefined>;
}

function workflowSteps(path: string, jobName: string): WorkflowStep[] {
  const parsed = load(
    readFileSync(resolve(repoRoot, path), 'utf8'),
  ) as Workflow;
  const steps = parsed.jobs?.[jobName]?.steps;
  expect(steps, `${path}: job '${jobName}' has no steps`).toBeDefined();
  return steps as WorkflowStep[];
}

describe('android build manifest', () => {
  test('stages the desktop artifact, unchanged, where Gradle packages APK assets', () => {
    const root = withReleaseManifest(makeRoot());

    const manifestPath = writeAndroidBuildManifest(root, {
      builtAt: '2026-08-20T18:00:00.000Z',
      env: {},
    });

    // Same filename as the desktop bundle's stamp, because it is the same
    // artifact: `assets/station-build.json` inside the APK is what the reader
    // and the documented device one-liner both look for.
    expect(manifestPath).toBe(
      join(root, ANDROID_ASSET_SOURCE_SET, BUILD_MANIFEST_FILENAME),
    );
    const written = readFileSync(manifestPath as string, 'utf8');
    expect(Object.keys(JSON.parse(written)).sort()).toEqual([
      'branch',
      'builtAt',
      'sha',
    ]);
    // The bytes the writer emits must survive the reader that a device
    // interrogation runs; a stamp only one half of the pair understands is a
    // stamp nobody can read.
    expect(parseAndroidBuildProvenance(written)).toEqual({
      sha: SHA,
      branch: 'v9.9.9',
      builtAt: '2026-08-20T18:00:00.000Z',
    });
  });

  test('the packaged entry path is derived from the staged filename, not restated', () => {
    // If either side is edited alone the stamp becomes unfindable while both
    // halves still pass their own tests.
    expect(APK_BUILD_MANIFEST_ENTRY).toBe(`assets/${BUILD_MANIFEST_FILENAME}`);
    // And the writer must still be aiming at the source set Gradle packages
    // into `assets/` — checked against the pinned path, not against itself.
    expect(ANDROID_ASSETS_DIR).toBe(ANDROID_ASSET_SOURCE_SET);
    expect(ANDROID_PROJECT_DIR).toBe(ANDROID_GENERATED_PROJECT);
  });

  test('no checkout and no release manifest degrades instead of failing the build', () => {
    expect(writeAndroidBuildManifest(makeRoot(), { env: {} })).toBeNull();
  });

  test('refuses to stage a stamp into an Android project that was never generated', () => {
    expect(() =>
      writeAndroidBuildManifest(
        withReleaseManifest(makeRoot({ initialized: false })),
        {
          env: {},
        },
      ),
    ).toThrow(/tauri android init/);
  });

  test('every Android build script stages provenance before packaging', () => {
    // The whole fix is inert if nothing runs the writer — the same reason the
    // desktop wiring is pinned in desktop-build-manifest.test.ts.
    const pkg = JSON.parse(
      readFileSync(resolve(repoRoot, 'package.json'), 'utf8'),
    ) as { scripts: Record<string, string> };

    const androidScripts = Object.entries(pkg.scripts).filter(([, command]) =>
      command.includes('tauri android build'),
    );
    expect(androidScripts.length).toBeGreaterThan(0);

    for (const [name, command] of androidScripts) {
      expect(command, `${name} must stage build provenance`).toContain(
        'node scripts/write-android-build-manifest.mjs',
      );
      expect(
        command.indexOf('write-android-build-manifest'),
        `${name} must stage provenance before the APK is packaged`,
      ).toBeLessThan(command.indexOf('tauri android build'));
    }
  });

  test('both Android CI jobs stage provenance after init and verify it in the artefact', () => {
    const jobs: Array<[string, string]> = [
      ['.github/workflows/build-android.yml', 'build-android-verification'],
      ['.github/workflows/release.yml', 'android'],
    ];

    for (const [path, jobName] of jobs) {
      const steps = workflowSteps(path, jobName);
      const indexOf = (needle: string) =>
        steps.findIndex((step) => step.run?.includes(needle));

      const initIdx = indexOf('tauri android init');
      const stageIdx = indexOf('write-android-build-manifest.mjs');
      const buildIdx = indexOf('tauri android build');
      const verifyIdx = indexOf('read-android-build-provenance.mjs');

      expect(initIdx, `${path}: no init step`).toBeGreaterThanOrEqual(0);
      expect(
        stageIdx,
        `${path}: no provenance staging step`,
      ).toBeGreaterThanOrEqual(0);
      expect(buildIdx, `${path}: no Android build step`).toBeGreaterThanOrEqual(
        0,
      );
      expect(
        verifyIdx,
        `${path}: no provenance readback step`,
      ).toBeGreaterThanOrEqual(0);

      // `tauri android init` generates gen/android, so staging earlier writes
      // into a tree the init then replaces.
      expect(stageIdx, `${path}: staging must follow init`).toBeGreaterThan(
        initIdx,
      );
      expect(stageIdx, `${path}: staging must precede the build`).toBeLessThan(
        buildIdx,
      );
      // Reading the stamp back out of the built APK is the only step that
      // derives that it reached the artefact rather than asserting it.
      expect(
        verifyIdx,
        `${path}: readback must follow the build`,
      ).toBeGreaterThan(buildIdx);
    }
  });

  test('the staged asset is ignored, so a build never dirties the checkout', () => {
    // Reading this file also anchors ANDROID_ASSET_SOURCE_SET to the real
    // checkout: the Gradle project it belongs to is tracked, and its sibling
    // `tauri.conf.json` entry is the proof that this directory is the one that
    // reaches the APK.
    const ignore = readFileSync(
      resolve(repoRoot, ANDROID_GENERATED_PROJECT, 'app', '.gitignore'),
      'utf8',
    );
    expect(ignore).toContain('/src/main/assets/tauri.conf.json');
    expect(ignore).toContain(`/src/main/assets/${BUILD_MANIFEST_FILENAME}`);
  });
});

describe('android build provenance readback', () => {
  test('rejects every shape that is not a fully-determined provenance record', () => {
    const cases: Array<[string, string, RegExp]> = [
      ['not JSON at all', 'not json', /not valid JSON/],
      ['a JSON array', '[]', /not a JSON object/],
      ['a JSON null', 'null', /not a JSON object/],
      [
        'an abbreviated sha',
        JSON.stringify({
          sha: SHA.slice(0, 12),
          branch: 'main',
          builtAt: '2026-08-20T18:00:00.000Z',
        }),
        /40-character commit sha/,
      ],
      [
        'a blank branch',
        JSON.stringify({
          sha: SHA,
          branch: '   ',
          builtAt: '2026-08-20T18:00:00.000Z',
        }),
        /no branch/,
      ],
      [
        'an unparseable timestamp',
        JSON.stringify({ sha: SHA, branch: 'main', builtAt: 'whenever' }),
        /builtAt/,
      ],
    ];

    for (const [label, text, message] of cases) {
      expect(
        () => parseAndroidBuildProvenance(text),
        `${label} must not read as provenance`,
      ).toThrow(message);
    }
  });
});
