# Android Build Guide

Station's Android client is built with [Tauri v2](https://tauri.app/) mobile
support. This guide describes the checked-in build paths. A successful compile,
packaged-artifact check, emulator launch, physical-device journey and Play
delivery are separate evidence; this documentation review did not run them.

## Architecture

The Android build wraps the shared Vite/React UI in an Android WebView.
The Rust host and maintained Kotlin/plugin bridges supply native credentials,
pairing, media permissions, window geometry and other platform capabilities.
Tauri generates the Android project; repository bootstrap scripts restore the
owned customizations after generation. Android connects to a Station server;
it does not embed the desktop Node server.

### Key directories

| Path | Purpose | Committed? |
|------|---------|------------|
| `src-desktop/` | Tauri config, Rust code, icons | Yes |
| `src-desktop/tauri.conf.json` | Tauri configuration | Yes |
| `src-desktop/src/lib.rs` | Rust entry point (desktop + mobile) | Yes |
| `src-desktop/gen/android/` | Reproducible Android project | A seed is tracked; builds regenerate and customize it |

### Important: `gen/android/` is ephemeral

The `gen/android/` directory contains a tracked seed, but channel initialization
can replace it. Put durable native customization in the owning configuration,
template, or post-init script, and verify that a regenerated project retains it.

`apply-android-native-bootstrap.mjs` restores the camera/voice permissions and optional
camera/microphone features after initialization for every channel. Rear-camera
and autofocus requirements implied by Camera are explicitly optional too. The in-app QR scanner
uses WebView `getUserMedia`; Android cannot show its runtime permission prompt
unless the packaged manifest declares Camera. The Nightly staging job checks
the resulting APK’s camera and microphone permission list before publication. Editing only the
tracked seed does not repair generated release builds. The same bootstrap restores
`allowBackup="false"`, `fullBackupContent="false"`, and the maintained
`data_extraction_rules.xml` resource so credentials and local app data retain
their existing cloud-backup and device-transfer exclusions.

## CI Pipeline

**This section describes [build-android.yml](../../.github/workflows/build-android.yml),
a debug verification lane triggered manually or by path-filtered `main`
pushes. It has no tag or pull-request trigger and produces debug APK/AAB
artifacts, not upload-key-signed release artifacts.** The signed Android release
build/sign/upload pipeline is the `android` job in
`.github/workflows/release.yml`, triggered by pushing a `v*` tag; see
[Native release operations](./native-releases.md) and
[Mobile store distribution](./mobile-release.md) for that path, including the
OIDC/Secret Manager signing boundary. `TAURI_SIGNING_PRIVATE_KEY` signs desktop
updater payloads; it is not the Android upload key.

### Pipeline steps

1. **Setup** — the Node version in `.nvmrc`, Rust with Android targets, and the Java/SDK/NDK versions pinned in the workflow
2. **Build frontend** — `npm run dependencies:ci`, then the SDK, Connect, and desktop resources
3. **Tauri Android Init** — `node scripts/reset-android-generated-project.mjs`
   first removes the tracked seed, as the Nightly and beta lanes do, so the
   project comes entirely from the pinned CLI's templates. Init then runs from
   `src-desktop` with the base and Dev overlays, `--ci` and
   `--skip-targets-install`. Running discovery from the repository root can
   select an experimental Tauri app instead.
4. **Apply native bootstrap** — `node scripts/apply-android-native-bootstrap.mjs`
   keeps the activity's `onCreate` hook and the window-inset bridge in the
   generated namespace. It never initializes `ndk_context`: tao owns that
   initialization, and a second one aborts the app at launch. The channel icon and network-policy helpers also run
   before compilation. See the workflow for their exact ordering.
5. **Stage build provenance** — `node scripts/write-android-build-manifest.mjs`
   writes `station-build.json` into the generated project's asset source set,
   after init (which would otherwise replace it) and before the build that
   packages it.
6. **Build debug APK/AAB** — runs from `src-desktop` with the same overlays
   and `tauri android build --debug --apk --aab`.

   The workflow sets the 16 KB page-alignment linker flags directly via
   `RUSTFLAGS` (an environment `RUSTFLAGS` replaces target rustflags instead of
   merging with `src-desktop/.cargo/config.toml`, so the flags must be set this
   way for CI). Verify the result with
   `node scripts/check-android-16kb-alignment.mjs <apk>` — the build succeeds
   either way, so only the artefact proves it.
7. **Verify provenance** — `node scripts/read-android-build-provenance.mjs <apk>`
   reads the stamp back out of the APK for the same reason: staging can succeed
   without the file reaching the artefact.
8. **Upload** — debug APK/AAB uploaded as a workflow artifact

### Triggers

- Manual dispatch and path-filtered pushes to `main`; no tag or PR trigger.

## Status Bar / Safe Area

Android WebView does not reliably support CSS `env(safe-area-inset-*)` variables. On Android 15+ with edge-to-edge enforcement, the WebView content can render behind the status bar, making toolbar buttons unclickable.

### How we fix it

Android's WebView reports `env(safe-area-inset-*)` as **0 for system bars**
(it only populates them for display cutouts in short-edges mode), so CSS
alone cannot know the status-bar height — that is why the app used to draw
under the clock (station#2617). `MainActivity` therefore bridges the real
`WindowInsets` (systemBars ∪ displayCutout, in CSS px) to the page through a
`StationAndroidInsets` JavascriptInterface installed in wry's
`onWebViewCreate` hook, dispatching `station-android-insets` on change.
The durable owner is
[`StationAndroidInsetsBridge.kt`](../../scripts/templates/android/StationAndroidInsetsBridge.kt),
installed by the native bootstrap after project generation.
`src-ui/src/platform/androidSafeArea.ts` projects that bridge onto the
`--safe-*` custom properties at boot and on each event; iOS and desktop PWA
keep the `env()`-derived `:root` defaults.

The bridge also reports the WebView bounds and its visible bottom during IME
changes and layout/rotation. Android can show the keyboard without shrinking
`visualViewport`; `useMobileVisualViewport` intersects the native visible bounds
with browser geometry so the chat composer and fixed sheets move above it.
Already resized WebViews retain their existing geometry without subtracting the
keyboard twice. Native dimensions are scaled to CSS pixels, and malformed or
older bridge payloads fall back to browser geometry. The keyboard inset is
separate from the system-bar `--safe-bottom` value.

On the CSS side, `--safe-top` carries the inset and the toolbar pads itself down
by it. Fixed overlays should anchor to `--app-toolbar-total-height` (inset plus
nominal height). Read `var(--safe-*)` rather than raw `env(safe-area-inset-*)`
so the Android bridge override reaches the surface. This is the shared rule,
not a claim that every current overlay was physically verified.

Getting that wrong is not theoretical: overlays that offset by `--app-toolbar-height` alone landed `--safe-top` too high, which rendered the mobile coding tabs *above* the header and put the fixed tab strip over the header controls, so the overflow menu could not be tapped at all. Desktop never showed it, because the inset is 0 there.

If native layout policy changes, recheck both bridge geometry and CSS offsets
on the target device. Do not assume adding native padding makes the reported
inset zero or that both layers can consume the same inset without duplication.

The CSS layer also defines safe area variables as a belt-and-suspenders approach (primarily for iOS PWA support):

```css
:root {
  --safe-top: env(safe-area-inset-top, 0px);
  --safe-bottom: env(safe-area-inset-bottom, 0px);
}
```

## Local Development

### Prerequisites

- Android Studio (for SDK, NDK, emulator)
- Node 24 and the managed pnpm version from `package.json`
- Java 17, matching the verification workflow
- Rust with Android targets: `rustup target add aarch64-linux-android armv7-linux-androideabi i686-linux-android x86_64-linux-android`
- NDK 27: install via Android Studio SDK Manager or `sdkmanager "ndk;27.0.12077973"`

### Build locally

```bash
# Set NDK path
export NDK_HOME="$ANDROID_HOME/ndk/27.0.12077973"

# Install through the managed workspace boundary
npm run dependencies:ci

# Initialize the actual app, with its Dev pairing identity
npm run tauri -- android init --ci --skip-targets-install --config tauri.android.dev.conf.json

# Restore the maintained inputs after initialization
node scripts/write-native-client-build-manifest.mjs --refresh
node scripts/apply-android-channel-icons.mjs dev
node scripts/apply-android-native-bootstrap.mjs
node scripts/apply-android-pairing-scheme.mjs dev
node scripts/apply-android-network-policy.mjs
node scripts/write-android-build-manifest.mjs

# Build in src-desktop through the owning wrapper, with 16 KB linker flags
STATION_CLIENT_BUILD_REUSE=1 \
RUSTFLAGS="-C link-arg=-Wl,-z,max-page-size=16384 -C link-arg=-Wl,-z,common-page-size=16384" \
  npm run tauri -- android build --debug --apk --config tauri.android.dev.conf.json

# Check ELF alignment/congruence and stored native-library ZIP data offsets.
# A successful compilation alone proves neither.
node scripts/check-android-16kb-alignment.mjs \
  src-desktop/gen/android/app/build/outputs/apk/universal/debug/app-universal-debug.apk
```

The APK will be at `src-desktop/gen/android/app/build/outputs/apk/universal/debug/`.
The repository also exposes `build:android` and `build:android:arm64` in
[package.json](../../package.json). The expanded recipe above makes app-directory
selection explicit and includes the network-policy helper used by CI.
Tauri's `beforeBuildCommand` builds the native-client frontend; a standalone
`build:ui` is not a substitute for that provenance/build sequence.
This recipe was source-reviewed, not built in this audit. Keep generated
customizations under their script owners and inspect regeneration changes.

## Build provenance: what commit is on this device?

The maintained build paths stage `assets/station-build.json` — the source-derived
artifact that the desktop bundle has carried
at `Station.app/Contents/Resources/dist-server/station-build.json` since
station#1085. `npm run build:android` stages it via
`node scripts/write-android-build-manifest.mjs` before packaging, and CI
Android workflows stage it after `tauri android init`. The writer can return
without a stamp when neither checkout nor valid release provenance exists;
the artifact reader, not the staging command alone, establishes its presence.

The original rationale was a static `versionName` that could not identify the
installed commit (archive#3592). Current release workflows set version identity
as well; the stamp records source revision and build time. It is not a digest
of every compiled input or proof that a working tree was clean.

### Read it back off a connected device

```bash
pkg=io.kontourai.station.debug   # select the exact installed channel package
adb pull "$(adb shell pm path "$pkg" | tr -d '\r' | sed 's/^package://')" /tmp/station-device.apk
node scripts/read-android-build-provenance.mjs /tmp/station-device.apk
```

It prints the sha, branch and build time, and exits non-zero if the APK carries
no readable provenance — which for a build made before this change is the
honest answer, not a bug.

Against a locally built APK, the same command reads the artefact you are about
to install, so you can compare the two before deciding to overwrite anything:

```bash
node scripts/read-android-build-provenance.mjs \
  src-desktop/gen/android/app/build/outputs/apk/universal/debug/app-universal-debug.apk
```

Settings → System now shows **Installed app build** from the native capability
report, separately from the connected server's build. The owner chain is
[`build.rs`](../../src-desktop/build.rs) → native capability report →
[`InstalledAppBuildProvenance`](../../src-ui/src/views/settings/BuildProvenance.tsx).
Missing provenance remains unavailable. A displayed revision/build timestamp
does not establish upload, installation time, or provider acceptance.

### Run on emulator

```bash
# Start emulator (or connect a device)
adb devices

# Install and launch
adb install src-desktop/gen/android/app/build/outputs/apk/universal/debug/app-universal-debug.apk
adb shell am start -n io.kontourai.station.debug/io.kontourai.station.MainActivity
```

That component is for the base Dev build. For a channel APK, derive the
package and launchable activity from `aapt dump badging` as the emulator
workflow does; do not launch Stable after installing another channel.

## Testing

Android-specific tests run via `.github/workflows/android-test.yml`:

- **Mobile Playwright** — checks out the exact source SHA from the successful
  Android build selected by the trigger or required manual run ID, installs Chromium through the
  public Playwright installer, then runs `npm run test:android`. That public
  launcher owns the isolated Station instance, build, ports, reports, and
  cleanup for the Pixel 7 viewport tests in `tests/android/`.
- **Emulator smoke test** — installs the exact selected APK on an Android 34
  emulator, launches its artifact-derived component, checks process presence
  after five seconds and scans crash output. It does not exercise pairing,
  credentials, capture, background behavior or a complete user journey.

Run Playwright mobile tests locally:

```bash
npm run install:playwright
npm run test:android
```

## Release Signing

This file's `build-android.yml` workflow never produces a signed release
build. The signed release APK/AAB is built and signed in a different
workflow — the `android` job of `.github/workflows/release.yml`, triggered by
a `v*` tag push — using the Android upload keystore, not the Tauri updater
key. The protected `native-release` job authenticates through Google workload
identity, fetches the keystore and password from Secret Manager, and supplies
`TAURI_ANDROID_KEYSTORE_PATH`, `TAURI_ANDROID_KEYSTORE_PASSWORD`,
`TAURI_ANDROID_KEY_ALIAS` and `TAURI_ANDROID_KEY_PASSWORD` to the generated
signing configuration. The alias comes from `ANDROID_UPLOAD_KEY_ALIAS`.
Do not infer that the older four GitHub-secret recipe still owns this path. See
[Native release operations](./native-releases.md) for the full secret set and
[Mobile store distribution](./mobile-release.md) for how to also push that
signed build to Play's internal testing track.

The scheduled Nightly workflow (`.github/workflows/nightly.yml`) is a
third, separate lane:
release-signed with keystore material fetched from Google Cloud Secret Manager
via OIDC, published to Play internal testing under
`io.kontourai.station.nightly` — see
[nightly.md](./nightly.md#android-nightly-play-internal-testing).
