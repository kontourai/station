import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  applyAndroidReleaseSigning,
  gradleWithAndroidReleaseSigning,
} from '../apply-android-release-signing.mjs';
import { resetAndroidGeneratedProject } from '../reset-android-generated-project.mjs';

function generatedFixture(namespace = 'io.kontourai.station.beta') {
  const root = mkdtempSync(join(tmpdir(), 'station-channel-generation-'));
  const android = join(root, 'src-desktop', 'gen', 'android');
  const gradlePath = join(android, 'app', 'build.gradle.kts');
  mkdirSync(dirname(gradlePath), { recursive: true });
  writeFileSync(
    gradlePath,
    `plugins { id("rust") }
android {
    namespace = "${namespace}"
    defaultConfig {
        applicationId = "${namespace}"
    }
    buildTypes {
        getByName("release") {
            isMinifyEnabled = true
        }
    }
}
`,
  );
  writeFileSync(join(android, 'settings.gradle'), 'include(":app")\n');
  return { android, gradlePath, root };
}

describe('clean Android channel release generation', () => {
  it.each([
    'io.kontourai.station',
    'io.kontourai.station.beta',
    'io.kontourai.station.nightly',
  ])(
    'applies one complete signing contract without changing %s',
    (namespace) => {
      const { gradlePath, root } = generatedFixture(namespace);
      applyAndroidReleaseSigning({ root });
      const once = readFileSync(gradlePath, 'utf8');
      applyAndroidReleaseSigning({ root });
      const twice = readFileSync(gradlePath, 'utf8');

      expect(twice).toBe(once);
      expect(once).toContain(`namespace = "${namespace}"`);
      expect(once.match(/TAURI_ANDROID_KEYSTORE_PATH/g)).toHaveLength(1);
      expect(once).toContain('TAURI_ANDROID_KEYSTORE_PASSWORD');
      expect(once).toContain('TAURI_ANDROID_KEY_ALIAS');
      expect(once).toContain('TAURI_ANDROID_KEY_PASSWORD');
      expect(once).toContain(
        'signingConfig = signingConfigs.getByName("release")',
      );
    },
  );

  it('fails closed on a partial pre-existing signing contract', () => {
    expect(() =>
      gradleWithAndroidReleaseSigning(
        'val path = System.getenv("TAURI_ANDROID_KEYSTORE_PATH")',
      ),
    ).toThrow(/missing TAURI_ANDROID_KEYSTORE_PASSWORD/);
  });

  it('removes only a recognized generated project', () => {
    const { android, root } = generatedFixture();
    resetAndroidGeneratedProject({ root });
    expect(existsSync(android)).toBe(false);

    const unknown = generatedFixture();
    writeFileSync(
      unknown.gradlePath,
      'plugins { id("com.android.application") }',
    );
    expect(() => resetAndroidGeneratedProject({ root: unknown.root })).toThrow(
      /unrecognized/,
    );
    expect(existsSync(unknown.android)).toBe(true);
  });

  it('refuses a symlinked generated-project target', () => {
    const root = mkdtempSync(join(tmpdir(), 'station-channel-symlink-'));
    const generatedParent = join(root, 'src-desktop', 'gen');
    const target = mkdtempSync(join(tmpdir(), 'station-channel-target-'));
    mkdirSync(generatedParent, { recursive: true });
    symlinkSync(target, join(generatedParent, 'android'));
    expect(() => resetAndroidGeneratedProject({ root })).toThrow(/symlinked/);
    expect(existsSync(target)).toBe(true);
  });

  it('refuses symlinked gen and src-desktop ancestors without touching their external targets', () => {
    const externalGen = generatedFixture();
    const genRoot = mkdtempSync(join(tmpdir(), 'station-channel-gen-link-'));
    const genSrc = join(genRoot, 'src-desktop');
    mkdirSync(genSrc, { recursive: true });
    symlinkSync(dirname(externalGen.android), join(genSrc, 'gen'));
    expect(() => resetAndroidGeneratedProject({ root: genRoot })).toThrow(
      /symlinked.*ancestor/,
    );
    expect(existsSync(externalGen.android)).toBe(true);

    const externalSrc = generatedFixture();
    const srcRoot = mkdtempSync(join(tmpdir(), 'station-channel-src-link-'));
    symlinkSync(
      join(externalSrc.root, 'src-desktop'),
      join(srcRoot, 'src-desktop'),
    );
    expect(() => resetAndroidGeneratedProject({ root: srcRoot })).toThrow(
      /symlinked.*ancestor/,
    );
    expect(existsSync(externalSrc.android)).toBe(true);
  });

  it.each([
    ['release', '.github/workflows/release.yml'],
    ['nightly', '.github/workflows/nightly-native-stage.yml'],
  ])(
    'orders %s reset, init, signing, bootstrap, build, and signature proof',
    (_lane, path) => {
      const workflow = readFileSync(path, 'utf8');
      const reset = workflow.indexOf('reset-android-generated-project.mjs');
      const init = workflow.indexOf('tauri android init');
      const signing = workflow.indexOf(
        'node scripts/apply-android-release-signing.mjs',
      );
      const bootstrap = workflow.indexOf(
        'node scripts/apply-android-native-bootstrap.mjs',
      );
      const build = workflow.indexOf('tauri android build');
      // The release lane names the signature proof by its flags rather than by
      // `apksigner verify`. This assertion is about ORDER; matching the binary
      // coupled it to that binary being reached through PATH, so resolving it
      // by path instead — the only way it resolves at all — broke an ordering
      // test with no stake in the question.
      const verify = workflow.indexOf(
        _lane === 'nightly'
          ? 'node scripts/verify-android-apk-signature.mjs'
          : 'verify --verbose --print-certs',
        build,
      );
      expect(reset).toBeGreaterThanOrEqual(0);
      expect(init).toBeGreaterThan(reset);
      expect(signing).toBeGreaterThan(init);
      expect(bootstrap).toBeGreaterThan(signing);
      expect(build).toBeGreaterThan(bootstrap);
      expect(verify).toBeGreaterThan(build);
      expect(
        workflow.indexOf(
          _lane === 'nightly'
            ? 'node scripts/verify-android-aab-signature.mjs'
            : 'jarsigner -verify',
          build,
        ),
      ).toBeGreaterThan(build);
    },
  );

  // `aapt` and `apksigner` ship in `$ANDROID_HOME/build-tools/<version>/`, and
  // `android-actions/setup-android` puts only cmdline-tools and platform-tools
  // on PATH. A bare invocation therefore does not fail at review time or at
  // build time — it fails as `aapt: command not found` in the last step of a
  // ~50-minute Android job, after the artefact it was going to verify already
  // exists. #1795 shipped exactly that into build-android.yml and reddened
  // main for a day; release.yml carried the same shape unexercised, because
  // no tagged release has ever reached that step (#1243). Assert the property
  // across every workflow rather than per call site, so the next one is caught
  // where it is written.
  it('never invokes a build-tools binary through PATH in any workflow', () => {
    // Not anchored to `aapt`: `zipalign` and `apksigner` sit in the same
    // directory and are equally absent from PATH.
    const buildTools = /(?<![\w/"$.-])(aapt2?|apksigner|zipalign)(?![\w.-])/;
    const boundToAPath = /(?:aapt2?|apksigner|zipalign)=/;
    const names = readdirSync('.github/workflows').filter((name) =>
      name.endsWith('.yml'),
    );
    expect(names.length).toBeGreaterThan(0);

    const offenders = names.flatMap((name) =>
      readFileSync(`.github/workflows/${name}`, 'utf8')
        .split('\n')
        .map((line, index) => ({ line, lineNumber: index + 1 }))
        .filter(
          ({ line }) =>
            !/^\s*#/.test(line) &&
            // An assignment is how the resolved path gets bound; every use
            // after it reads `"$aapt"`, which the lookbehind already excludes.
            !boundToAPath.test(line) &&
            buildTools.test(line),
        )
        .map(({ line, lineNumber }) => `${name}:${lineNumber}: ${line.trim()}`),
    );
    expect(offenders).toEqual([]);
  });

  it('installs and resolves pinned Android build tools for nightly artifact verification', () => {
    const nightly = readFileSync(
      '.github/workflows/nightly-native-stage.yml',
      'utf8',
    );
    expect(nightly).toContain("ANDROID_BUILD_TOOLS_VERSION: '36.0.0'");
    expect(nightly).toContain(
      `ANDROID_UPLOAD_CERT_SHA256: \${{ vars.ANDROID_UPLOAD_CERT_SHA256 }}`,
    );
    expect(nightly).toContain(
      `sdkmanager "ndk;27.0.12077973" "build-tools;\${ANDROID_BUILD_TOOLS_VERSION}"`,
    );

    const verify = nightly.slice(
      nightly.indexOf('Build and verify the signed Android staging bytes'),
      nightly.indexOf('Bind the exact staged Android inventory into a receipt'),
    );
    expect(verify).toContain(
      'aapt="$ANDROID_HOME/build-tools/$ANDROID_BUILD_TOOLS_VERSION/aapt"',
    );
    expect(verify).toContain(
      'apksigner="$ANDROID_HOME/build-tools/$ANDROID_BUILD_TOOLS_VERSION/apksigner"',
    );
    expect(verify).toContain('"$aapt" dump badging "$apk"');
    expect(nightly).toContain('ANDROID_UPLOAD_CERT_SHA256');
    expect(verify).toContain(
      'node scripts/verify-android-apk-signature.mjs "$apk" "$ANDROID_UPLOAD_CERT_SHA256" "$apksigner"',
    );
    expect(verify).not.toContain('badging=$(aapt dump badging "$apk")');
    expect(verify).not.toContain('apksigner verify --verbose --print-certs');
  });

  it('applies the Dev channel identity after init and before every local or CI Android build', () => {
    const workflow = readFileSync(
      '.github/workflows/build-android.yml',
      'utf8',
    );
    const init = workflow.indexOf('tauri android init');
    const overlay = workflow.indexOf(
      'node scripts/apply-android-channel-icons.mjs dev',
    );
    const bootstrap = workflow.indexOf(
      'node scripts/apply-android-native-bootstrap.mjs',
    );
    const build = workflow.indexOf('tauri android build');
    expect(overlay).toBeGreaterThan(init);
    expect(bootstrap).toBeGreaterThan(overlay);
    expect(build).toBeGreaterThan(bootstrap);

    const scripts = JSON.parse(readFileSync('package.json', 'utf8')).scripts;
    for (const command of [
      scripts['build:android'],
      scripts['build:android:release'],
      scripts['build:android:arm64'],
    ]) {
      expect(command).toContain(
        'node scripts/apply-android-channel-icons.mjs dev',
      );
      expect(
        command.indexOf('apply-android-channel-icons.mjs dev'),
      ).toBeLessThan(command.indexOf('apply-android-native-bootstrap.mjs'));
      expect(
        command.indexOf('apply-android-native-bootstrap.mjs'),
      ).toBeLessThan(command.indexOf('tauri android build'));
    }
  });

  it('uploads signed nightly artifacts before strict AAB signature verification', () => {
    const nightly = readFileSync(
      '.github/workflows/nightly-native-stage.yml',
      'utf8',
    );
    const build = nightly.indexOf(
      'Build and verify the signed Android staging bytes',
    );
    const artifactUpload = nightly.indexOf('actions/upload-artifact@', build);
    const verify = nightly.indexOf(
      'Bind the exact staged Android inventory into a receipt',
      build,
    );

    expect(artifactUpload).toBeGreaterThan(build);
    expect(artifactUpload).toBeGreaterThan(verify);

    const verification = nightly.slice(build, verify);
    expect(verification).toContain(
      'cohort-android/station-nightly-universal.aab',
    );
    expect(verification).toContain(
      'node scripts/verify-android-aab-signature.mjs cohort-android/station-nightly-universal.aab "$ANDROID_UPLOAD_CERT_SHA256"',
    );
    expect(verification).not.toContain('aab_verification=');
    expect(verification).not.toContain('jarsigner -verify');
  });
});
