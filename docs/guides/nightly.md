# Station Nightly

Station Nightly is the main-edge dogfood channel. Its macOS, Windows, Android
and iOS builds consume one SHA from the shared Nightly test gate and use separate
platform delivery authorities while sharing one channel identifier:

| Platform | Artifact | Identifier | Built by | Delivered by |
| --- | --- | --- | --- | --- |
| macOS | notarized app, DMG, updater archive | `io.kontourai.station.nightly` | `.github/workflows/nightly-native-stage.yml#stage-macos` | rolling GitHub prerelease and shared signed Tauri feed |
| Windows | NSIS installer and Tauri updater signature | `io.kontourai.station.nightly` | `.github/workflows/nightly-native-stage.yml#stage-windows` | shared rolling GitHub prerelease and signed Tauri feed |
| Android | signed arm64 AAB/APK | `io.kontourai.station.nightly` | `.github/workflows/nightly-native-stage.yml#stage-android` | Play internal testing track |
| iOS | signed App Store IPA | `io.kontourai.station.nightly` | reusable TestFlight delivery in build mode | TestFlight delivery in upload mode |

Distinct application identifiers support coexistence with Stable. That is an
identity contract, not proof of every installer, shared-resource or physical
update journey. This guide describes source wiring; inspect exact provider and
device receipts for current availability.

## Android nightly (Play internal testing)

`.github/workflows/nightly.yml` builds and publishes the Android nightly.

**Cadence: a configurable minimum interval, six hours by default.**
Nightly checks eligibility hourly at minute 47 UTC under its serialized delivery
lease. The default minimum publication spacing is six hours; unchanged or recent
ships skip before source tests and builds. Eligible candidates must pass lint,
all typecheck lanes, native boundary checks and real browser smoke on the exact
event SHA. Full qualification runs separately every six hours; Nightly's gate
does not produce that receipt. Manual dispatch retains the same source and
artifact gates for recovery.
The hourly qualification-health watchdog reports stale or missing qualification
and failed delivery; see [the release procedure](releasing.md#release-procedure).
The cohort decision compares its source
against the rolling `nightly` tag (the commit the last published nightly was
cut from) and builds nothing when they match and the deploy ledger records
that ship: a new version number over identical content is a version number
that lies. A quiet interval therefore produces no update on a tester's device,
by design. The tag alone is not the evidence — the macOS marker moves before
its publish is verified, so the decision also requires a ledger row per
platform at the tag's commit
(see [Native Nightly cohort](./native-releases.md#native-nightly-cohort)).
Admitted ships of new content take the next reserved version code. Manual `rebuild_index` remains the exception for rebuilding a
commit that already shipped, below.

**What a tester should expect.** Queueing, separate stage timeouts, signing and
provider processing determine delivery time. The eligibility schedule is not a
promise that a build reaches a phone within a few hours. Play auto-update and
tester eligibility are separate device/provider conditions. Read the final
per-platform receipt and Play state; a job exit alone is not installation proof.

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

A manual `source_sha` may only echo the current workflow event SHA. It cannot
select an older Stable/TestFlight candidate. Native staging needs the successful exact-SHA source usability gate; promotion
requires that gate and completed staging. Full regression runs independently.

**Signing and upload.** `nightly-native-stage.yml` authenticates through Google
OIDC, fetches the upload key from Secret Manager, and checks the APK/AAB package,
provenance, upload-certificate fingerprint and ABI inventory. It retains required
14-day staged artifacts; missing signing inputs or required artifacts fail the
stage. `nightly-native-cohort.yml` separately admits those bytes and uploads to
Play internal testing. It does not silently skip missing credentials as success.

The Android and desktop jobs declare the protected `native-release` environment;
iOS uses `ios-nightly`. Whether those environments currently require manual
approval is live GitHub configuration, not determined by the schedule trigger.
Their provider credentials and permissions have distinct scopes.

After required TestFlight upload and internal delivery, Nightly attempts
external-group assignment and beta-review submission. This step is non-blocking:
failures appear in the workflow summary and external-distribution receipt.
Set `TESTFLIGHT_EXTERNAL_GROUP_ID` in `ios-nightly` and complete Apple's beta
review information first. See [external TestFlight distribution](mobile-release.md#nightly-external-testflight-distribution)
for setup, review states and tester automatic updates.

The rolling `nightly` marker moves only after Android is verified and recorded.
Desktop has its own `nightly-desktop` publication marker. Partial or ambiguous
provider outcomes retain their own status; a failed overall run can already have
published a subset. See the [cohort and recovery contract](native-releases.md#native-nightly-cohort)
before retrying or changing a marker.

## Portable server nightly

`.github/workflows/portable-nightly-publish.yml`, called by `nightly.yml` as
`portable-nightly` after source usability succeeds, builds the five
`station-server-<os>-<arch>` archives through the reusable
`portable-server-archives.yml` under version `X.Y.Z-nightly.<code>`, where
`<code>` is the native Nightly's reserved version code (re-checked against the
`nightly-version-code/<code>` tag). It assembles the schema v2 manifest from
the archive descriptors, signs it with a throwaway key, verifies it, and
confirms the pinned key table refuses that envelope. Publication is enabled:
the owner set `STATION_PORTABLE_NIGHTLY_PUBLISH=enabled`, and Nightlies
publish versioned `vX.Y.Z-nightly.<code>` releases and replace the rolling
`portable-nightly` manifest (as read on 2026-10-12, the newest was
`v0.1.11-nightly.247504`). Without the gate, or on a direct dispatch, the run
stops after the dry run and uploads only short-lived run artifacts.

This is the platform-array schema v2 manifest. On macOS and Linux, `install.sh`
selects the host's archive, verifies its signed size and digest, and installs
it under `versions/<version>` with its bundled Node.js and a forwarding
launcher. On Windows, `install.ps1` installs it the same way under a
`current` junction with a `station-nightly.cmd` launcher (see
[Windows archive installs](release-channel-ports.md#windows-archive-installs)).
`STATION_CHANNEL=nightly` alone installs from the rolling
`portable-nightly/station-portable-nightly-manifest.json`, which both
installers carry as a generated default; an explicit
`STATION_INSTALL_PUBLIC_MANIFEST_URL` overrides it, with the same pinned-key
verification:

```bash
curl -fsSL https://raw.githubusercontent.com/kontourai/station/main/install.sh | STATION_CHANNEL=nightly sh
```

```powershell
$env:STATION_CHANNEL = 'nightly'; irm https://raw.githubusercontent.com/kontourai/station/main/install.ps1 | iex
```

The installer is not otherwise part of the signed release. Each versioned
release also carries the `install.sh` and `install.ps1` of its source SHA,
which the publish job reads back byte for byte. See the
[archive install contract](release-channel-ports.md#prebuilt-archives-and-source-releases).

The `publish` job is the only one with `contents: write` and the only one that
reads a secret. The Nightly caller passes `secrets: inherit`; the called
`publish` job separately names the protected `portable-nightly-signing`
environment. A retained earlier call without inheritance reported an empty
signing key. Keep that incident's receipt separate from the
[GitHub environment-secret contract](https://docs.github.com/en/actions/how-tos/reuse-automations/reuse-workflows#using-inputs-and-secrets-in-a-reusable-workflow):
a called job's environment supplies its secrets independently of caller-passed
secrets. The job runs
only when the repository variable `STATION_PORTABLE_NIGHTLY_PUBLISH` is exactly
`enabled`, the run came from `nightly.yml` on `main`, and the version is a
reservation. A direct dispatch of the publication workflow is always a dry
run, on any branch:

```bash
gh workflow run portable-nightly-publish.yml --repo kontourai/station --ref <branch>
```

When enabled, it signs in the `portable-nightly-signing` environment with the
pinned `station-portable-nightly-2026-09` key, refuses a version that is not
newer than the rolling manifest, uploads the archives, the manifest,
`install.sh` and `install.ps1` to the immutable prerelease `v<version>`
(never marked latest), re-downloads them and compares digests (the archives
against the signed manifest, the installers against the checkout), replaces `station-portable-nightly-manifest.json` on the
rolling `portable-nightly` release last, and re-fetches and re-verifies it.
Unlike the stable and preview host pointers, Nightly checks "newer than the
rolling manifest" against the cacheable download URL only and does not plan
again against the release's own bytes before replacing, so a stale cached
copy can let an older Nightly replace a newer one. Nightly also has no
restore if the replace or re-verification fails.

While the gate is off, the dry run cannot turn Nightly red: its jobs are
`continue-on-error`, so a failed dry-run job shows red in the run but the run
(and main-health, which reads the run's conclusion) stays green. Publication
never relies on that: it requires the `verified` output that only the dry
run's last step sets. Once the gate is enabled, a failure fails Nightly.

Before publishing, the job refuses a payload whose ring, version, tag or
source SHA is not this run's, and refuses to reuse `v<version>`, including a
draft a failed run left behind (the error names the release id to delete).

To enable it (owner only):

- Plan retention first. Each publish adds a permanent prerelease and tag
  `vX.Y.Z-nightly.<code>` (the versioned assets pinned and rollback manifests
  point at): one for each Nightly that builds. The default six-hour minimum permits
  about four publication opportunities a day; hourly decisions that skip add no
  release, and a shorter configured interval increases retention needs.
- Provision the `portable-nightly-signing` environment and its
  `STATION_PORTABLE_NIGHTLY_MANIFEST_SIGNING_KEY` secret, matching the public
  key pinned as `station-portable-nightly-2026-09` in
  `config/release-manifest-keys.json`. Review the environment's access,
  approval and deployment-branch policy before enabling publication. The
  workflow names the environment; its current policy and secret provisioning
  are live GitHub configuration and remain `NOT_VERIFIED` by this source review.
- Create the `portable-nightly` prerelease pointer, then set the variable, for
  example
  `gh variable set STATION_PORTABLE_NIGHTLY_PUBLISH --repo kontourai/station --body enabled`.
- Read the first enabled Nightly's step summary for "Assemble, dry-run sign and
  verify". It says whether the gate evaluated as enabled for that run. The gate
  relies on `github.workflow_ref` in a called workflow naming the top-level
  caller (`nightly.yml`), as GitHub documents. Historical qualification-driven
  identity remains admitted, but no current workflow calls Nightly that way.
  Actual enabled publication remains unverified until that provider run. If
  the summary says dry run, the publish job was skipped, which fails safe.

Deleting the variable returns every run to a dry run.

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
| `station dev` | Server bases `39141-39640`, with terminal/voice/consent at base +1/+2/+3; UI `40141-40640` | Per-worktree allocator |

Nightly's `Info.nightly.plist` is merged into its macOS app bundle through
Tauri's supported `bundle.macOS.infoPlist` configuration. Its app-specific
`LSEnvironment.STATION_DESKTOP_PORT=38141` owns the server base at launch;
the bundled runtime derives terminal and voice ports `38142` and `38143`.
This prevents an ambient `STATION_DESKTOP_PORT=3141` from selecting Dogfood's
reservation for Nightly. Stable Station continues to own its existing optional
`STATION_DESKTOP_PORT` behavior.

The local installer below and the hosted desktop publisher are separate paths.
The hosted cohort stages notarized macOS artifacts and publishes a rolling
GitHub prerelease with a signed updater feed. A locally certificate-signed build
does not acquire that publication or notarization receipt.

## Update checks in Settings: source check vs release check

Two distinct mechanisms answer "is there an update?", and Settings keeps them
separate:

- **Desktop release check.** Tauri's configured signed update feed owns
  desktop release availability and installation. The packaged server code
  updates with the desktop app.
- **Server source check** (`GET /api/system/core-update`). This reports
  source-comparison facts for the connected server: a git checkout's
  behind/ahead counts, or a stamped install's build hash versus its configured
  source ref. A stamped build hash that differs from the source ref is a
  build-stamp comparison only — it does **not** establish that an installable
  release is available, and the UI never renders it as "update available".
  A prebuilt release archive is the exception: the same route fetches the
  signed public manifest its install records, verifies it against the pinned
  keys for its ring, and reports the running and newest versions. A manifest
  older than the newest release that install already accepted is not offered
  (it would be a stale or replayed one). Settings can
  apply that update only when the service's fixed launcher runs the server.
  Such a server downloads and verifies the release without restarting (when
  asked, or by itself under the `serverUpdateDownloadPolicy` setting). Only
  Restart or Update when idle switches it to the new version; see the
  [CLI `service` reference](../reference/cli.md#service). Any other archive
  names `station upgrade` on the host, or a reinstall.

An established built-in (embedded sidecar) server never runs the ordinary
source check at all; its update path is the desktop app itself, and its card
says so.

### When the server is older than the app

A desktop or mobile app whose version a release pipeline stamped
(`STATION_BUILD_VERSION`) compares that version with the one a prebuilt
archive server reports on the same route, in Station's release order
([`release-version-order.ts`](../../packages/shared/src/release-version-order.ts)).
A native Nightly's `X.Y.Z-nightly.<day>[.<build>]` is first written as the
portable `X.Y.Z-nightly.<day × 100 + build>` that names the same nightly
allocation; #2962 is meant to replace that bridge with one identity. An iOS
build's Apple marketing version is the bare `X.Y.Z`, so its web bundle is
stamped with the cohort's full Nightly version, or a Beta's full release
version, instead. A bare `X.Y.Z` client never counts as newer than a
prerelease of the same `X.Y.Z`; that also keeps a stable `0.1.12` client quiet
against a `0.1.12-preview.N` server, which tracks another ring and cannot
update itself to the stable release. When the server is older, a dismissible
banner says the server is older and names both versions in one readable form,
a Nightly by its build date
([`ServerOlderLaunchCheck`](../../src-ui/src/components/ServerOlderLaunchCheck.tsx)).
If the service's launcher runs the server and its verified manifest names a
newer release, the banner offers **Update server to …**. That queues the same
service update Settings applies and follows its progress through the restart.
Any other server gets the way to update it on its host instead. The banner
never appears for a dev or locally built app, equal versions, a server that
reports no version (source checkouts and desktop bundles), the server's own
web UI, or a built-in server.

### Advanced source installer boundary

The checkout-backed bundle installer survives behind the **Source installation
details** disclosure on the server updates card, under the action
**Rebuild and reinstall desktop app from source…**. It is a distinct advanced
workflow, not the normal desktop update path: the source query behind it mounts
only while the disclosure is open, it names the affected host from the
correlated server identity, and the server-side eligibility revalidation on
apply remains authoritative. Coordination between a simultaneous source
rebuild and a signed-updater installation is an explicit, unsolved risk — do
not run both against the same install.

## Install or refresh

Use Node 24 from a clean checkout with the intended `origin` remote:

```sh
export PATH="$HOME/.local/share/mise/installs/node/24.19.0/bin:$PATH"
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
Nightly. If publishing the candidate fails after the prior app was renamed
aside, it attempts to restore that backup. This is a staged filesystem swap,
not a health-checked runtime rollback; retain and inspect any surviving backup
after failure. It never writes to `/Applications/Station.app`.

The `--relaunch` path asks the old app to quit, waits up to ten seconds, and
then calls `open`. It does not prove that the old process stopped or that the
new process reached readiness. Verify the running version separately.

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
or receipt replacement. Archive entry names are checked for user-home and
private-key paths before retention; this is not a scan of every file's content.
Its receipt records the exact source SHA, channel,
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

Compare the receipt with the exact source SHA selected for that build;
`origin/main` can advance afterward. The bundle identifier must be
`io.kontourai.station.nightly`.

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

Local build/install success is not permission or evidence for hosted
publication. A build-only archive can request notarization explicitly and its
receipt distinguishes not-requested, notarized and failed outcomes. The hosted
Nightly cohort already publishes notarized macOS downloads and a separate
signed updater channel. Preserve the Stable/Beta trust contracts; do not mix
local archives into that feed or infer store/device delivery from signing.

## Windows desktop and the shared update feed

Windows Nightly uses Tauri's built-in NSIS installer and v2 updater artifacts.
The same `setup.exe` serves as the initial installer and update payload; its
`.sig` is generated and checked with the Tauri updater key. The app installs
per user and uses the separate `io.kontourai.station.nightly` identity and
`station-nightly.exe` process name, so NSIS does not close Stable during an update.
Station's desktop server currently requires Node 24 on the user's PATH.

`nightly-native-stage.yml` builds Windows from the same source SHA and reserved
version as macOS and Android. `scripts/build-windows-nightly.ps1` uses
`npm run build:desktop`, including the Windows resource staging adapter, and
extracts the installer with 7-Zip to verify packaged build provenance.
The pre-release desktop workflow also builds an unsigned NSIS package.

For local packaging in a clean Windows worktree with Node 24 and 7-Zip:

```powershell
npm run dependencies:ci
./scripts/build-windows-nightly.ps1 -SourceSha (git rev-parse HEAD) -BundleVersion 244399
```

That example number is a local test identity. Hosted releases consume the
reserved `plan-cohort.outputs.bundle_version`. Generated output from a prior
build must be retained separately before another build uses the same worktree.

Windows publisher signing is optional for Nightly. It can use Tauri's `signCommand` through the protected
`WINDOWS_SIGN_COMMAND` variable, with the signing tool and its credentials
configured in the runner environment. This supports cloud/HSM signing such as
Azure Artifact Signing. Existing exportable certificates can instead use
`WINDOWS_CERTIFICATE_BASE64` and `WINDOWS_CERTIFICATE_PASSWORD`. The builder
checks Authenticode independently of the Tauri updater signature.

Updater signing uses `TAURI_SIGNING_PRIVATE_KEY`, `TAURI_SIGNING_PUBLIC_KEY`,
and an optional `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`. `-RequireSigning`
requires both publisher and updater signing. Hosted Nightly always uses
`-SignUpdater`; it additionally requires publisher signing when publisher
credentials are configured. Without those credentials, the installer records
`platformSigningState: NOT_SIGNED` and can publish with a verified Tauri updater
signature. Missing or invalid updater signatures always block publication;
configured publisher-signing failures also block instead of falling back.
This uses our own updater keys and GitHub Releases without a paid Windows
certificate subscription. Hosted Nightly configures no publisher credentials
today, so the published Windows installer has no Authenticode signature
(`station-0.1.11-nightly.2475.3-windows-x86_64-setup.exe` had an empty PE
certificate table on 2026-10-12). Running the downloaded installer,
Microsoft Defender SmartScreen shows "Windows protected your PC" with an
unknown publisher, and the user must choose **More info**, then **Run
anyway**; with Windows 11 Smart App Control on, Windows can block it with no
override. Updates through the
Tauri updater are verified with the updater key. Publisher signing is
[#3591](https://github.com/kontourai/station/issues/3591). Existing macOS
signing remains required.

One publisher owns `nightly-desktop/latest.json`. It waits for both desktop
builds, verifies their updater signatures, and creates a manifest containing
only that cohort; each signature must name the cohort version (#3851). It uploads the five version-specific desktop downloads and
checks their GitHub sizes and digests. Then it replaces three more assets:
the two installers again under fixed names,
`station-nightly-macos-aarch64.dmg` and
`station-nightly-windows-x86_64-setup.exe` (so
`releases/download/nightly-desktop/<name>` is always the newest build), and
`SHA256SUMS`, which lists this build's seven downloads under both names. It
replaces `latest.json` last and reads every asset back. It refuses version
regression. Previous versioned downloads are not overwritten, so an upload
failure before the manifest write leaves the previous feed usable, although
the fixed names may already serve the new build. GitHub's asset replacement
is a delete then an upload, not a transaction: a download in between can
miss a fixed name, or pair it with the other build's `SHA256SUMS`, which then
fails the check. Interrupted provider writes remain unresolved until readback
verifies them. The older `station-nightly-desktop-*` assets on the release
come from builds before versioned names, and are not updated.

The final receipt records separate macOS and Windows claims for this shared
publication. Android retains its separate provider outcome. A build or release
receipt does not prove installation. Use
`scripts/verify-windows-installer-upgrade.ps1` on a host without an existing
Nightly install to compare an upgraded installation with both the packaged
payload and a clean installation, exercise Tauri's NSIS `/UPDATE` path, and
verify uninstall and preservation of the separate Station home. Native window
and in-app download/relaunch checks remain separate evidence. Use `-InstallRoot`
to select an unused installation directory independently of the proof directory.
Deep installation paths can exceed NSIS/Windows path limits and omit runtime
files; an inventory mismatch must not be waived simply because installation exited zero.
