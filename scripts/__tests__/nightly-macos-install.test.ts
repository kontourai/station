import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  STATION_DEV_MAX_OFFSET,
  STATION_DEV_SERVER_PORT_BASE,
  STATION_DEV_UI_PORT_BASE,
} from '../../packages/cli/src/commands/dev-ports.js';

const root = resolve(import.meta.dirname, '../..');
const configPath = resolve(root, 'src-desktop/tauri.nightly.conf.json');
const infoPlistPath = resolve(root, 'src-desktop/Info.nightly.plist');
const installerPath = resolve(root, 'ops/nightly/install-macos.zsh');
const signingIdentityPath = resolve(
  root,
  'ops/nightly/macos-signing-identity.mjs',
);
const dogfoodConfigPath = resolve(
  root,
  'ops/dogfood/station-dogfood.json.example',
);

const NIGHTLY_PORT = 38141;

describe('macOS nightly lane', () => {
  it('uses an identity, app name, and app-specific port profile distinct from stable Station', () => {
    const config = JSON.parse(readFileSync(configPath, 'utf8'));
    const infoPlist = readFileSync(infoPlistPath, 'utf8');

    expect(config.productName).toBe('Station Nightly');
    expect(config.identifier).toBe('io.kontourai.station.nightly');
    expect(config.app.windows[0].title).toBe('Station Nightly');
    expect(config.bundle.macOS).toEqual({ infoPlist: 'Info.nightly.plist' });
    expect(config.bundle.resources).toEqual({
      '../dist-server': 'dist-server',
      '../dist-desktop-runtime/node_modules': 'node_modules',
      '../schemas': 'schemas',
    });
    expect(config.plugins).toBeUndefined();
    expect(
      [...infoPlist.matchAll(/<key>([^<]+)<\/key>/g)].map((match) => match[1]),
    ).toEqual([
      'CFBundleIdentifier',
      'StationChannel',
      'StationServerPort',
      'LSEnvironment',
      'STATION_DESKTOP_CHANNEL',
      'STATION_DESKTOP_PORT',
    ]);
    expect(infoPlist).toContain('<key>LSEnvironment</key>');
    expect(infoPlist).toContain('<key>STATION_DESKTOP_CHANNEL</key>');
    expect(infoPlist).toContain('<string>nightly</string>');
    expect(infoPlist).toContain('<key>STATION_DESKTOP_PORT</key>');
    expect(infoPlist).toContain(`<string>${NIGHTLY_PORT}</string>`);
  });

  it('reserves a Nightly backend block disjoint from dogfood and station dev', () => {
    const dogfood = JSON.parse(readFileSync(dogfoodConfigPath, 'utf8'));
    const nightlyPorts = [
      NIGHTLY_PORT,
      NIGHTLY_PORT + 1,
      NIGHTLY_PORT + 2,
      NIGHTLY_PORT + 3,
    ];
    const dogfoodPorts = [
      dogfood.serverPort,
      dogfood.serverPort + 1,
      dogfood.serverPort + 2,
      dogfood.serverPort + 3,
      dogfood.uiPort,
    ];
    const devServerFirst = STATION_DEV_SERVER_PORT_BASE;
    const devServerLast =
      STATION_DEV_SERVER_PORT_BASE + STATION_DEV_MAX_OFFSET + 3;
    const devUiFirst = STATION_DEV_UI_PORT_BASE;
    const devUiLast = STATION_DEV_UI_PORT_BASE + STATION_DEV_MAX_OFFSET;

    expect(dogfoodPorts).toEqual([3141, 3142, 3143, 3144, 3000]);
    expect(nightlyPorts).toEqual([38141, 38142, 38143, 38144]);
    expect(Math.max(...dogfoodPorts)).toBeLessThan(Math.min(...nightlyPorts));
    expect(Math.max(...nightlyPorts)).toBeLessThan(devServerFirst);
    expect(devServerLast).toBeLessThan(devUiFirst);
    expect([devServerFirst, devServerLast]).toEqual([39140, 39643]);
    expect([devUiFirst, devUiLast]).toEqual([40140, 40640]);
  });

  it('installs only exact origin/main with a verified receipt and rollback boundary', () => {
    const installer = readFileSync(installerPath, 'utf8');

    expect(statSync(installerPath).mode & 0o111).not.toBe(0);
    expect(installer).not.toContain('git fetch origin main');
    expect(installer).not.toContain('Switch to the exact latest origin/main');
    expect(installer).toContain(
      'Refusing to build Station Nightly from a dirty tracked checkout.',
    );
    expect(installer).toContain("'/Applications/Station Nightly.app'");
    expect(installer).not.toContain("'/Applications/Station.app'");
    expect(installer).toContain('station-nightly-source.json');
    expect(installer).toContain('channel: "nightly"');
    expect(installer).toContain('ref: "origin/main"');
    // Git-based self-update (#1624): the stamp records the build checkout and
    // the installer supports the in-app updater's quit-and-reopen flag.
    expect(installer).toContain('writeNightlySourceStamp');
    expect(installer).toContain('"$repo_root"');
    expect(installer).toContain(
      'A newly built app does not replace that checkout',
    );
    expect(installer).toContain('--relaunch');
    // The lock must cover the build, not just the swap: npm ci is not
    // concurrency-safe, and the self-updater can trigger this script over
    // HTTP (#1624). Assert ORDER, not mere presence.
    expect(installer.indexOf('if ! mkdir "$lock_dir"')).toBeGreaterThan(0);
    expect(installer.indexOf('if ! mkdir "$lock_dir"')).toBeLessThan(
      installer.indexOf('\nnpm run dependencies:ci\n'),
    );
    expect(installer).toContain('to quit');
    expect(installer).toContain("arm64) target='aarch64-apple-darwin'");
    expect(installer).toContain("x86_64) target='x86_64-apple-darwin'");
    expect(installer).toContain('--target "$target"');
    expect(readFileSync(signingIdentityPath, 'utf8')).toContain(
      'STATION_NIGHTLY_CODESIGN_IDENTITY',
    );
    expect(readFileSync(signingIdentityPath, 'utf8')).toContain(
      'Developer ID Application: Kontour AI LLC',
    );
    expect(readFileSync(signingIdentityPath, 'utf8')).toContain(
      'Apple Distribution and ad-hoc signing (-) are not allowed',
    );
    expect(installer).toContain(
      'node "$build_root/ops/nightly/macos-signing-identity.mjs"',
    );
    expect(installer).toContain(
      'node "$build_root/ops/nightly/macos-embedded-signing.mjs" "$candidate" "$signing_identity"',
    );
    expect(installer).toContain(
      'codesign --force --sign "$signing_identity" --options runtime --timestamp "$candidate"',
    );
    expect(installer).not.toContain(
      'codesign --force --deep --sign "$signing_identity" --options runtime',
    );
    expect(installer).toContain('flags=0x10000(runtime)');
    expect(installer).toContain(
      'signing did not enable the hardened runtime; refusing the atomic swap.',
    );
    expect(installer).not.toContain('codesign --force --deep --sign -');
    expect(installer).toContain('--candidate-designated-requirement');
    expect(installer).toContain('--raw-designated-requirement');
    expect(installer).not.toContain("sed -n 's/^designated => //p'");
    expect(readFileSync(signingIdentityPath, 'utf8')).toContain(
      'CDHash-only/ad-hoc signing is refused',
    );
    expect(installer).toContain(
      'stable certificate-backed designated requirement',
    );
    expect(installer).toContain(
      'Migrating the existing ad-hoc Station Nightly signature',
    );
    expect(installer).toContain(
      'Existing Station Nightly has a different stable designated requirement',
    );
    expect(installer).toContain(
      'codesign --verify --deep --strict --verbose=2 "$candidate"',
    );
    expect(installer).toContain("expected_nightly_port='38141'");
    expect(installer).toContain(
      'Print :LSEnvironment:STATION_DESKTOP_PORT\' "$built_app/Contents/Info.plist"',
    );
    expect(installer).toContain(
      'if [[ "$built_port" != "$expected_nightly_port" ]]',
    );
    expect(installer).toContain('Nightly built app STATION_DESKTOP_PORT is ');
    expect(installer).toContain('expected $expected_nightly_port.');
    expect(installer).toContain('bundle.macOS.bundleVersion');
    expect(installer).toContain('Print :CFBundleShortVersionString');
    expect(installer).toContain('Print :CFBundleVersion');
    expect(installer).toContain(
      'Nightly built app build number does not match its generated identity',
    );
    expect(
      installer.indexOf('if [[ "$built_port" != "$expected_nightly_port" ]]'),
    ).toBeLessThan(installer.indexOf('if [[ -e "$destination" ]]'));
    expect(installer).toContain('if [[ -e "$backup" && ! -e "$destination" ]]');
    expect(installer).toContain(
      'Another Station Nightly installation is already running.',
    );
    expect(installer).toContain(
      'A stale Station Nightly installation candidate or backup needs inspection.',
    );
  });

  it('builds in an isolated checkout, never the primary one (#1849)', () => {
    const installer = readFileSync(installerPath, 'utf8');

    // The isolated build root lives under the machine-owned cache dir —
    // outside any repo — and the script fails closed if it would overlap the
    // primary checkout. npm ci must never tear down node_modules under a
    // Station service running from the primary tree.
    expect(installer).toContain('lock_root="$station_root/cache/nightly"');
    expect(installer).toContain('build_root="$lock_root/build-checkout-v2"');
    expect(installer).toContain('Leave legacy build-checkout intact');
    expect(installer).toContain(
      'Isolated build checkout must live outside the primary checkout.',
    );

    // The bundle is produced from the isolated checkout, not the primary tree.
    expect(installer).toContain(
      'built_app="$build_root/src-desktop/target/$target/release/bundle/macos/Station Nightly.app"',
    );
    expect(installer).not.toContain('built_app="$repo_root');

    // npm ci and the tauri build run with the isolated checkout as cwd: the
    // single cd into $build_root precedes the single npm ci / tauri build,
    // and nothing cds back into the primary checkout afterwards.
    const cdBuild = installer.indexOf('\ncd "$build_root"\n');
    const npmCi = installer.indexOf('\nnpm run dependencies:ci\n');
    const tauriBuild = installer.indexOf(
      '\nSTATION_BUILD_VERSION="$nightly_version" npx tauri build \\\n',
    );
    expect(cdBuild).toBeGreaterThan(0);
    expect(npmCi).toBeGreaterThan(cdBuild);
    expect(tauriBuild).toBeGreaterThan(npmCi);
    expect(installer.lastIndexOf('\nnpm run dependencies:ci\n')).toBe(npmCi);
    expect(
      installer.lastIndexOf(
        '\nSTATION_BUILD_VERSION="$nightly_version" npx tauri build \\\n',
      ),
    ).toBe(tauriBuild);
    expect(installer.lastIndexOf('cd "$build_root"')).toBe(cdBuild + 1);
    expect(installer.lastIndexOf('cd "$repo_root"')).toBe(
      installer.indexOf('cd "$repo_root"'),
    );
    expect(installer.indexOf('cd "$repo_root"')).toBeLessThan(cdBuild);

    // The owned checkout fetches and pins exact origin/main without advancing
    // the checkout that recorded install provenance.
    expect(installer).toContain('owned-source-checkout.mjs');
    expect(installer).toContain(
      'const raw = (process.env.STATION_ROOT ?? "").trim()',
    );
    expect(installer).toContain(
      'resolve(process.argv[1], raw || join(homedir(), ".station"))',
    );
    expect(installer).toContain('export STATION_ROOT="$station_root"');
    expect(installer).toContain(
      'the recorded source checkout was left unchanged.',
    );
    expect(installer).toContain(
      'build_sha="$(git -C "$build_root" rev-parse HEAD)"',
    );
    expect(installer).toContain('if [[ "$build_sha" != "$source_sha" ]]');
    expect(installer).toContain('expected $source_sha.');
    expect(installer).toContain(
      'Isolated build checkout has dirty tracked files after refresh.',
    );

    // The stamp still records the PRIMARY checkout: the origin URL and
    // sourceCheckout come from $repo_root, not the disposable build checkout,
    // so install-provenance self-update eligibility (path existence + git
    // origin identity + installer path) keeps working after builds move.
    expect(installer).toContain(
      '"$(git -C "$repo_root" remote get-url origin)"',
    );
    expect(installer).not.toContain('"$(git remote get-url origin)"');

    // The lock still covers the whole operation, including the owned checkout
    // refresh. The installer must never recursively delete the recorded
    // provenance checkout.
    const lock = installer.indexOf('if ! mkdir "$lock_dir"');
    expect(lock).toBeGreaterThan(0);
    expect(lock).toBeLessThan(installer.indexOf('prepare_build_checkout'));
    expect(installer).not.toContain('rm -rf "$build_root"');
    expect(lock).toBeLessThan(cdBuild);
  });

  it('can archive a signed Nightly without touching the installed app', () => {
    const installer = readFileSync(installerPath, 'utf8');
    const buildOnly = installer.indexOf('if (( build_only )); then');
    const install = installer.indexOf('if [[ -e "$destination" ]]; then');

    expect(installer).toContain('--build-only requires --output-dir');
    expect(installer).toContain('--relaunch cannot be used with --build-only');
    expect(installer).toContain(
      '--notary-profile requires an existing named Keychain profile.',
    );
    expect(buildOnly).toBeGreaterThan(0);
    expect(buildOnly).toBeLessThan(install);
    expect(installer.slice(buildOnly, install)).not.toContain(
      'open "$destination"',
    );
    expect(installer.slice(buildOnly, install)).not.toContain('osascript');
    expect(installer).toContain(
      'Build-only output directory already exists: $output_dir. Refusing to overwrite',
    );
    expect(installer).toContain('ditto -c -k --sequesterRsrc --keepParent');
    expect(installer).toContain(
      'archive_sha="$(shasum -a 256 "$archive_path" | awk',
    );
    expect(installer).toContain(
      'codesign --verify --deep --strict --verbose=2 "$artifact_app"',
    );
    expect(installer).toContain('assertSafeArchiveFile');
    expect(installer).toContain("source_checkout=''");
    expect(installer).toContain('schemaVersion: 1');
    expect(installer).toContain('signing: { identity, status: "verified" }');
    expect(installer).toContain('notarization: { status: notarization }');
    const publicationSuccess = installer.slice(
      installer.lastIndexOf('if (( build_only )); then'),
      installer.lastIndexOf('if [[ -e "$destination" ]]; then'),
    );
    const clearsOwnershipBeforeRelease = (block: string) => {
      const clear = block.indexOf('lock_owned=0');
      const release = block.indexOf('rmdir "$lock_dir"');
      return clear >= 0 && release >= 0 && clear < release;
    };
    expect(clearsOwnershipBeforeRelease(publicationSuccess)).toBe(true);
    const regressedPublication = publicationSuccess.replace(
      '\n  lock_owned=0\n  rmdir "$lock_dir"',
      '\n  rmdir "$lock_dir"',
    );
    expect(regressedPublication).not.toBe(publicationSuccess);
    expect(clearsOwnershipBeforeRelease(regressedPublication)).toBe(false);
  });

  it('reports only honest notarization outcomes from an existing Keychain profile', () => {
    const installer = readFileSync(installerPath, 'utf8');

    expect(installer).toContain(
      'xcrun notarytool submit "$archive_path" --keychain-profile "$notary_profile" --wait',
    );
    expect(installer).toContain("notarization_status='not-requested'");
    expect(installer).toContain("notarization_status='notarized'");
    expect(installer).toContain("notarization_status='failed'");
    expect(installer).toContain('receipt records notarization as failed');
    expect(installer).not.toContain('notarytool store-credentials');
  });
});
