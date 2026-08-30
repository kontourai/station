# Station Nightly

Station Nightly is the main-edge dogfood channel. Its configured macOS and
Android legs consume one SHA from the shared Nightly test gate and use separate
platform delivery authorities while sharing one channel identifier:

| Platform | Artifact | Identifier | Built by | Delivered by |
| --- | --- | --- | --- | --- |
| macOS | notarized app, DMG, updater archive | `io.kontourai.station.nightly` | `.github/workflows/nightly.yml#nightly-desktop` | rolling GitHub prerelease and signed Tauri feed |
| Android | signed AAB/APK | `io.kontourai.station.nightly` | `.github/workflows/nightly.yml#nightly` | Play internal testing track |

Because the nightly uses its own identifier, both lanes install alongside a
stable Station install (`io.kontourai.station`) and never touch it.

## Android nightly (Play internal testing)

`.github/workflows/nightly.yml` builds and publishes the Android nightly.

**Cadence: at most one scheduled build per day, and only on days `main`
moved.** The single schedule trigger fires at 09:00 UTC — early morning in the
maintainer's timezone, so a day's work starts against a build of the previous
day's merges. The scheduled job compares `HEAD` against the rolling `nightly`
tag (the commit the last published nightly was cut from) and builds nothing
when they match: a new version number over identical content is a version
number that lies. A quiet day therefore produces no update on a tester's
device, by design. Manual same-day rebuilds are the one exception, below.

**What a tester should expect.** The job has a 90-minute timeout (plus
possible queueing for fleet capacity), and Play typically processes an
internal-track upload within minutes, so on an active day expect the new build
within a few hours of 09:00 UTC — and query Play Console, not this doc or the
workflow's exit code, for actual delivery state. When it reaches a given
device after that is the device's Play auto-update policy, not this pipeline;
opening the Play Store listing and updating manually is always current. The
nightly appears as its own app ("Station Nightly", with the nightly launcher
icon) side by side with any production Station install.

**Identity.** The version is `X.Y.Z-nightly.<day>`, where `<day>` is a
monotonic day counter (whole UTC days since 2020-01-01, deliberately not a
calendar date), with an Android `versionCode` derived from the same counter —
both from `scripts/lib/nightly-build-identity.mjs`. Since the reservation
ledger was introduced, every code is reserved before the build via an
immutable `nightly-version-code/<code>` tag, so a failed or repeated run can
never reuse a code that might already be installed somewhere (the one
pre-ledger published code is pinned as a permanent floor in the same module).
See [native-releases.md](./native-releases.md) for the ledger and its
[Manually dispatching Nightly](./native-releases.md#manually-dispatching-nightly)
section for an exceptional same-day rebuild (`rebuild_index`).

A manual cross-platform promotion may also pass `source_sha`. The source and
browser gate validates that exact commit is still on `main`; the reusable
hosted full-regression gate then proves the same SHA before Android or desktop
can start. Both producers check out the source gate's one output instead of
independently resolving a moving branch. This is the supported way to make
both Nightly artifacts companions of a specific Stable/TestFlight candidate.

**Signing and upload.** The job authenticates to Google Cloud with GitHub
OIDC, fetches the upload keystore from Secret Manager, verifies the built APK
and AAB signatures against the pinned upload-certificate fingerprint
(`ANDROID_UPLOAD_CERT_SHA256`) along with the nightly package identity, and
only then uploads the AAB to the internal testing track (transient Play API
failures are retried). When the Google Cloud or keystore configuration is
absent, the run skips publication with a notice instead of failing. The
workflow also attempts to archive the signed APK/AAB as a 7-day workflow
artifact, but archival is best-effort and happens before verification — its
outcome is reported separately, and an artifact must not be assumed present
or treated as verified output.

**The rolling `nightly` tag advances only after a successful publish.** A
failed run leaves the tag alone, so the next scheduled run retries the same
content instead of silently skipping a day.

Trust boundary: this is an internal testing track for invited testers, not a
public release ring. Unlike tag releases, the scheduled job does not pause for
the approval-gated `native-release` environment — it runs unattended, and its
Play credential is provisioned per [mobile-release.md](./mobile-release.md)
with only the release-to-testing-tracks permission, not production release.
Public distribution remains stable and preview only.

## macOS nightly (local install)

The macOS nightly is the local, main-edge macOS lane. It installs alongside
the stable application:

| Lane | Application | Bundle identifier | Source |
| --- | --- | --- | --- |
| Stable | `/Applications/Station.app` | `io.kontourai.station` | Signed release tag |
| Nightly | `/Applications/Station Nightly.app` | `io.kontourai.station.nightly` | Exact latest `origin/main` |

## Listener ownership

Installed targets and worktree development have separate, stable listener
reservations. Do not change one target's ports to recover another target.

| Target | Reserved listeners | Owner |
| --- | --- | --- |
| Station Dogfood | Server `3141-3143`; UI `3000` | Dogfood reconciler |
| Station Nightly | Server `38141-38143` | Nightly app bundle |
| `station dev` | Server/terminal/voice band `39140-39642`; UI band `40140-40640` | Per-worktree allocator |

Nightly's `Info.nightly.plist` is merged into its macOS app bundle through
Tauri's supported `bundle.macOS.infoPlist` configuration. Its app-specific
`LSEnvironment.STATION_DESKTOP_PORT=38141` owns the server base at launch;
the bundled runtime derives terminal and voice ports `38142` and `38143`.
This prevents an ambient `STATION_DESKTOP_PORT=3141` from selecting Dogfood's
reservation for Nightly. Stable Station continues to own its existing optional
`STATION_DESKTOP_PORT` behavior.

The nightly lane is for contributor dogfooding. It is locally signed on the Mac
that builds it and is not a public, notarized release ring. Stable and preview
remain the only public distribution rings.

## Install or refresh

Use Node 24 from a clean checkout with the intended `origin` remote:

```sh
export PATH="$HOME/.local/share/mise/installs/node/24.18.0/bin:$PATH"
./ops/nightly/install-macos.zsh
```

The installer fails closed when tracked files are dirty, Node is not version 24,
another nightly installation is running, the app bundle has the stable identifier,
or the completed signature does not verify. It fetches exact `origin/main`
into its machine-owned cache checkout without switching or cleaning the recorded
source checkout. Before it replaces the installed app, it reads the final built
app's `Contents/Info.plist` and requires
`LSEnvironment.STATION_DESKTOP_PORT` to be exactly `38141`.

An installed app invokes the installer recorded in its `sourceCheckout`; it
does not replace that checkout's installer merely by installing newer app code.
Before the first automatic update after this mechanism changes, update the
recorded checkout through its normal, user-controlled workflow to a revision
containing the new installer. The versioned machine-owned cache
`${STATION_ROOT:-$HOME/.station}/cache/nightly/build-checkout-v2` is created
fresh for this protocol. The legacy
`${STATION_ROOT:-$HOME/.station}/cache/nightly/build-checkout` is preserved and
never adopted or deleted automatically. These are updater-only disposable
caches; no runtime home, service state, installed app, or credentials move.
Never point either cache path at a personal checkout or worktree.

It builds the full embedded desktop runtime, copies it to a candidate under
`/Applications`, writes
`Contents/Resources/station-nightly-source.json` with the exact source SHA,
signs and verifies the complete candidate, and only then replaces Station
Nightly. A failed replacement restores the prior nightly app. It never writes
to `/Applications/Station.app`.

## Build a local archive without installing

To retain the installed Nightly unchanged, use the same guarded installer in
build-only mode with a new, explicit output directory. It builds from exact
`origin/main`, signs and verifies the app, then writes a ZIP archive, SHA-256
file, and `station-nightly-build-receipt.json` to that directory. The command
does not quit, install, or launch an app.

```sh
./ops/nightly/install-macos.zsh --build-only \
  --output-dir /absolute/path/to/station-nightly-archive
```

The output directory must not already exist; this refuses accidental archive
or receipt replacement. The archive is checked for user-home and private-key
paths before it is retained. Its receipt records the exact source SHA, channel,
verified signing identity, archive checksum path, and notarization state.

An optional notarization request is available only with an existing named
Keychain profile—this command never creates, exports, or stores credentials:

```sh
./ops/nightly/install-macos.zsh --build-only \
  --output-dir /absolute/path/to/station-nightly-archive \
  --notary-profile ExistingNotaryProfile
```

The receipt says `not-requested`, `notarized`, or `failed`; a notarization
failure exits non-zero and is not represented as a notarized artifact.

## Verify

```sh
codesign --verify --deep --strict --verbose=2 \
  "/Applications/Station Nightly.app"

plutil -p \
  "/Applications/Station Nightly.app/Contents/Resources/station-nightly-source.json"

/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' \
  "/Applications/Station Nightly.app/Contents/Info.plist"
```

The receipt SHA must equal the current `origin/main` commit, and the bundle
identifier must be `io.kontourai.station.nightly`.

To inspect the packaged listener profile directly:

```sh
/usr/libexec/PlistBuddy -c 'Print :LSEnvironment:STATION_DESKTOP_PORT' \
  "/Applications/Station Nightly.app/Contents/Info.plist"
```

It must print `38141`. If a Nightly update needs rollback, reinstall the prior
Nightly app bundle (or revert this Nightly-only packaging change and rebuild),
then relaunch it. Do not alter Dogfood's `3141-3143`/`3000` reservation or
unrelated Tailscale Serve handlers; Dogfood recovery remains the responsibility
of its supported reconciler.

## Distribution boundary (macOS)

Do not upload this locally signed macOS app or represent it as a notarized
nightly release. The Android nightly above is different: it is store-delivered
under the release upload keystore, but only to an invite-only internal testing
track — the distinction is notarization and distribution, not signing. A
future *public* nightly ring on any platform must go through the protected
native release environment, produce immutable provenance-attested artifacts,
use a separate updater channel, and preserve the existing stable and preview
trust contracts.
