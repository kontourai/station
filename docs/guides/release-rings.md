# Signed release rings

Start with [integration, qualification and releases](releasing.md) for the
cadence, exact-source evidence, repair ownership and full release procedure.

Station has two release channels: Stable and Nightly. A release candidate is
an acceptance step toward Stable, not another runtime channel. Beta, the
`preview` ring, `vX.Y.Z-preview.N` tags and `STATION_CHANNEL=beta` are retired
([#4929](https://github.com/kontourai/station/issues/4929)). They are rejected,
not redirected to Stable.

An immutable `vX.Y.Z-rc.N` tag (N from 1 to 98) builds Stable application
identity and the bare product version `X.Y.Z`. Its asset names, inventory tag,
SBOM subjects and attestation source ref retain the producing RC tag. Native
store builds use slot N; a separately built direct-final `vX.Y.Z` uses slot 99.
Promotion retains the RC's slot N and all original bytes. The repository's
private root `package.json` owns the product base; published CLI/library
packages keep their own Changesets versions.

`Release: Publish` has three explicit modes:

| Mode | Input tag | Result |
| --- | --- | --- |
| `rc` | `vX.Y.Z-rc.N` | Public GitHub prerelease for acceptance; no Stable rolling pointer, mobile feed, container alias, deploy ledger or issue availability projection |
| `promote` | Published `vX.Y.Z-rc.N` | Creates `vX.Y.Z` at the same source without a producer rebuild, transfers unchanged assets and promotes the exact store builds |
| `stable` | Direct-final `vX.Y.Z` | Publishes that qualified draft; also owns the separately admitted published desktop-pointer repair path |

RC container staging is immutable and candidate-specific, so another RC at the
same source can consume its own native build slot. RC publication never moves
`latest`, bare-version or source-SHA aliases. Original RC releases and assets
must remain public while a promoted release references them: the unchanged
host payload keeps its RC archive URLs.

New Stable portable server archives carry schema-3 provenance bound to source SHA and
product version, not the tag where they were staged. An RC and its final release
can therefore select the same Stable archive bytes. Both installers check the
authenticated manifest's SHA, version and channel; older schema-2 archives keep
exact-ref validation. The archived launcher reports a canonical `v<version>`
identity for schema 3. See the [provenance decision](../decisions/rc-promotion-provenance.md).

An exact source-release pin such as `STATION_VERSION=v0.2.0-rc.1` selects the
Stable runtime and requires a GitHub prerelease at that exact tag. Its asset
attestations still verify the producing `refs/tags/v0.2.0-rc.1` and source SHA.
Unpinned Stable installation continues to select only final releases. This
selection support does not publish candidates or move Stable pointers.

Nightly is a separate, opt-in signed-public-manifest path:
`STATION_CHANNEL=nightly` installs from the rolling `portable-nightly`
manifest unless `STATION_INSTALL_PUBLIC_MANIFEST_URL` names another signed
manifest. The authenticated GitHub-release path serves Stable only. See
[channel identity and coexistence](release-channel-ports.md) for Nightly's
home/port admission and the distinction between the public manifest signature
and a signed Git tag. Publication remains separate from installer support.

## Release artifacts and trust boundary

The Stable source-archive path, including an exact RC pin, uses these three installer inputs:

- `station-release-ring-stable.json`
- `station-portable.tar.gz.sha256`
- `station-portable.tar.gz`

The tag-triggered release workflow produces those inputs and uploads
them only after the full native release inventory validates. It creates a draft;
the protected manual `Release: Publish` workflow revalidates that draft
and is the only workflow allowed to publish it. The tag workflow identity and
the producer tag must name the same Git ref. A promoted final release also
requires the default-branch publication receipt that authenticates the
producer-to-final transfer; its original assets retain RC attestations.

The default installer path requires an authenticated `gh` with attestation support. Before it
parses a manifest, checksum, or archive, it verifies that file against:

- repository `kontourai/station`
- workflow `kontourai/station/.github/workflows/release.yml`
- the producing release tag and its resolved source commit
- GitHub's OIDC issuer and GitHub-hosted runner environment

The workflow pins `actions/attest-build-provenance` by commit. The portable OIDC
attestations use no long-lived signing key; desktop/Tauri signing has a separate
key-custody contract. Release code builds with a temporary home and temporary,
disabled GitHub CLI config after the verifier token is removed.

This is credential-lifetime minimization, not an OS sandbox. The attested Station
source is the code being authorized to run and, after verification, executes with
the same user-level file access as the installed Station application. The
temporary environment prevents accidental inheritance of the verifier token and
normal GitHub CLI credential lookup; it does not claim to confine malicious code
already authorized through the pinned repository/workflow/tag policy.

The optional `STATION_INSTALL_PUBLIC_MANIFEST_URL` path instead verifies an
Ed25519 envelope against pinned channel-authorized keys, then verifies the
archive digest. It needs no `gh` token. This is a separate opt-in trust path,
not the default ring resolver: signature validity proves origin/integrity,
not freshness. Existing-install downgrade guards compare with the active
release and with the newest release the install root ever accepted (so a
replayed manifest is refused after a rollback too), but they do not prevent an
old signed manifest from being offered to a fresh installation. Read the exact owner in
[`install.sh`](../../install.sh) before changing that policy.

This public path also accepts the platform-array v2 manifest for prebuilt
server archives. It checks the selected host, launcher protocol, signed size
and hash, and the archive's release identity before activation. Those archives
use `versions/<version>` and their bundled Node runtime; schema-v1 source
manifests use `releases/` and run dependencies/build steps. This does not change
the default GitHub-attested source path described above. See the
[manifest consumer table](../../packaging/manifest/README.md#formats-and-consumers).

New prebuilt versions installed by `install.sh` retain the exact verified public envelope as
`.station-signed-release-manifest.json` before the completion sentinel and
read-only seal. Existing sealed caches are not backfilled. A consumer must
verify the retained signature and relevant artifact identity again; the file's
presence does not authenticate arbitrary extracted files or qualify a companion
installation.

## Signed host-stream manifests

This implements the ring pointers and the one manifest base of
[ADR 0020](../adr/0020-distribution-two-trains-channels-as-pointers.md)
(D1 and D3). Every tag also builds the host stream (#2959): the five
`station-server-<os>-<arch>` prebuilt archives for the tag's ring, and the
schema v2 payload that names them. The `host-manifest` job in
[`release.yml`](../../.github/workflows/release.yml) assembles the payload
from the archive descriptors with
[`ecosystem-manifest.mjs assemble`](../../scripts/ecosystem-manifest.mjs),
signs it with a throwaway key, verifies that signature, and fails if the
throwaway envelope verifies against the pinned key table. It reads no secret.
The archives and `station-server-manifest-payload.json` are attested and
join the draft through the ordinary inventory, which checks that the payload
names this release's ring, version, source SHA and exact archive bytes.

[`publish-release.yml`](../../.github/workflows/publish-release.yml) repeats
that dry run on every publish. It signs with the release key only when the
repository variable `STATION_PORTABLE_RELEASE_PUBLISH` is exactly `enabled`.
The key is the `STATION_PORTABLE_RELEASE_MANIFEST_SIGNING_KEY` secret in the
`native-release-publish` environment. Its public half is
`station-portable-release-2026-09` in
[`config/release-manifest-keys.json`](../../config/release-manifest-keys.json),
and it may sign `stable` only. With the variable enabled and the
secret missing, the job fails before the release is published. With the gate
on, RC publication signs and attaches the versioned manifest but skips all
rolling-pointer operations. Final publication performs these steps:

1. signs the payload and verifies it with the pinned table;
2. requires the owner's rolling pointer release to exist and be public;
3. plans the pointer against the manifest it serves now, and refuses before
   anything is public if that manifest does not verify, if it names the same
   version with other bytes, or if the pointer serves no manifest (the
   owner's first publish sets `allow_empty_host_manifest_bootstrap`);
4. attaches `station-portable-<ring>-manifest.json` to the versioned release,
   which the existing publish step then makes public.

A separate `host-pointer` job then moves the pointer. It runs once publish
reports the release public, even if a later publish step such as the deploy
ledger failed (but not after the owner cancels the run), and its own failure
never skips the ledger or release availability. Re-running the failed job retries only the pointer. It holds no
secret: it downloads the signed manifest and its payload from the public
versioned release, requires the payload to name this run's version, producing tag and
source SHA (and its authenticated producer tag for promotion), and verifies them with the pinned key table before any pointer
write. The pointer plan also refuses a signed manifest for any other
version. It then re-downloads the versioned archives and manifest
anonymously, compares them with the payload, and plans the pointer again:

- **Newer version:** it saves the manifest the pointer release holds and
  plans again against those bytes, because the plan read a cacheable URL that
  can serve an older copy. It replaces the manifest only if that second plan
  still says the candidate is newer; an older candidate leaves the pointer
  alone with the same warning, and the same version with other bytes fails.
  It then re-verifies the replaced manifest with the pinned key. The re-verification waits up to five
  minutes while the asset host still serves the older manifest, and fails at
  once on anything else. If the upload or the re-verification
  fails, it restores the saved manifest (or removes a bootstrap one) and
  fails. The restore writes the bytes saved before the replace, so it would
  overwrite a manifest someone edited onto the pointer release by hand while
  the run was verifying.
- **Same version, same bytes:** the pointer already moved (a rerun), so it
  only re-verifies.
- **Older tag:** for example a desktop break-glass rollback, it leaves the
  host pointer where it is with a warning in the run summary. The host
  pointer never moves backwards. If a mis-tagged, too-high version was
  published to a pointer, no workflow moves it back: recovering is an owner
  action on the pointer release.

An owner cancel can land between the delete and the upload that
`gh release upload --clobber` performs. That leaves the rolling host pointer
with no manifest, because the restore trap does not run on cancel. The
desktop pointer has the same exposure. A job timeout behaves like a cancel.
Each manifest or archive GET is bounded to 30 seconds per attempt, and a
read retries up to ten times, so one hanging read fails its step (and runs
the restore) within about six minutes. An asset host that keeps hanging
across several steps can still reach the 20-minute job timeout, and a timeout
that lands mid-clobber leaves the same empty pointer. This fails safe: the next publish
stops at the empty-pointer refusal. To recover, check the versioned release,
then re-run `Publish Station release` for that tag with
`allow_empty_host_manifest_bootstrap`.

A tag without the required host archives or payload fails revalidation.
Inspect current GitHub release state for delivery history; source support does
not establish that a tagged release completed.

The locations come from one base,
[`scripts/lib/public-release-locations.mjs`](../../scripts/lib/public-release-locations.mjs):
`https://github.com/kontourai/station/releases/download/`. The versioned
manifest is `<publication-tag>/station-portable-stable-manifest.json`. Its
payload can retain the producing RC tag in archive URLs. Stable's rolling
pointer is `portable-stable/station-portable-stable-manifest.json`.
Nightly's separate `portable-nightly` pointer derives from the same base, and
`scripts/install-script-generated.mjs` projects it into both installers as the
Nightly default.

Before the first Stable host publication, the owner provisions the signing
secret, creates the public `portable-stable` pointer release, sets the
publication variable, and explicitly sets `allow_empty_host_manifest_bootstrap`.
These are operational prerequisites, not facts established by this guide.
Stable's default installer path remains GitHub-attested; selecting its signed
public manifest uses `STATION_INSTALL_PUBLIC_MANIFEST_URL`. Making that URL
the default remains #2960.

## Author telemetry in official builds

The repository **Actions variable** `STATION_AUTHOR_TELEMETRY_ENDPOINT` is public
build metadata. It is embedded in distributed JavaScript, so it must never
contain a secret. An unset or empty variable produces an empty constant and no
author sink. Runtime environment variables cannot enable that sink in an
already built binary or a source checkout.

Setting this variable is an **owner-gated activation**, separate from merging
these workflows. After the owner has authorized the receiver and real data
flow, an owner with repository administration access can open **Settings →
Secrets and variables → Actions → Variables**, create the repository variable
`STATION_AUTHOR_TELEMETRY_ENDPOINT`, and enter the receiver's HTTPS URL. For
the [Kontour Worker receiver](../../deploy/telemetry-worker/README.md) that is
`https://telemetry.kontourai.io/v1/lite/station`. Official builds post anonymous
daily counts to this URL unchanged. Station disables Detailed for this
receiver. Operators can choose Detailed for a compatible additional
destination under **Privacy & sharing → Advanced**. The `station` source lists every ring's channel and the
ping carries its own, so one URL serves every ring. Never revoke `station`
while builds post to it: senders record a refused ping as dropped without
retrying, so revoking it would silently lose every ring's pings. Its channel
list is provisioned final up front, and editing a source in place (an
operator update route) is future work. The
build requires a canonical HTTPS URL: input must equal its normalized URL,
including a trailing slash for a bare host. It rejects shorthand such as
`https:example.com`, credentials, queries, fragments and whitespace.
Do not set it as a secret. Do not set it, deploy a receiver, tag, publish or
dispatch a release as part of an implementation or verification task.
Removing the variable disables the author endpoint in subsequent builds;
previously distributed bytes retain their baked value. User telemetry policy
and opt-out still govern whether an available sink may send.

The injection boundary is the official producer, not a workflow-wide `env`:

| Build path | Endpoint and channel |
| --- | --- |
| Tagged Stable RC/final desktop, macOS/Windows/Linux (`release.yml`) | Repo variable and `STATION_CHANNEL` only in desktop build steps; RC and final builds both use runtime channel `stable`. Tauri resource builds inherit both. |
| Nightly desktop, macOS/Windows (`nightly-native-stage.yml`, called by `nightly.yml`) | Repo variable only in build steps for official main Nightly runs; server build stamp records `nightly`. The Windows wrapper and nested resource builds inherit it. There is no Nightly Linux release producer. |
| Five portable server archive targets, Stable/Nightly (`portable-server-archives.yml`) | Repo variable in both the initial server/UI build and the archive-packaging step, which rebuilds the server. Official tag or main Nightly callers must supply release inputs. Both builds use the selected runtime channel; staging reads it from packaged-release metadata. Direct dispatch and PR packaging proof get no endpoint. |
| npm CLI stable/Nightly and portable CLI | No endpoint injection: the CLI has no author sink. It installs or connects to a separately distributed host, whose server stamp owns telemetry. CLI package versions remain independent from the product base. |
| iOS device/simulator and Android Stable/Nightly | These clients build the UI, not a Node server. No server author constant or author sink is embedded in those apps. A connected host uses its own build's endpoint and channel. Mobile channel metadata remains owned by the native release pipeline. |
| Portable source archives (`station-portable.tar.gz`) | Source archives contain no built server. Building them on the user's machine remains a source build without an author endpoint. Use the prebuilt server archives above for an official server stamp. |
| Source, development, PR/fork CI, Docker images | No endpoint. Docker release producers are deliberately outside desktop job environments. |

The channel source is the server's existing `__STATION_SERVER_BUILD__.channel`
metadata, also exposed as `BuildProvenance.channel` by the system API. Official
server builds use runtime channels `stable` and `nightly`; RCs report `stable`.
The shared
[`mapRuntimeChannelToTelemetryChannel`](../../packages/shared/src/product-telemetry.ts)
preserves permitted current channels and omits unknown channels. The historical
telemetry `preview` dimension remains a data-reader compatibility contract; it
is not a runtime channel or an authorization to produce Beta builds. The usage
telemetry service applies the mapping when capturing build metadata. There is
no separate telemetry-channel export or setting.

[`author-telemetry-build.mjs`](../../scripts/lib/author-telemetry-build.mjs)
refuses a nonempty endpoint outside the official repository's release workflow
contexts or when it disagrees with the existing build channel.
[`check-author-telemetry-workflows.mjs`](../../scripts/check-author-telemetry-workflows.mjs)
checks the producer allowlist and excludes workflow-wide, PR and container
injection; the ordinary actionlint gate runs it too. The focused build test
runs the real server bundler into a temporary directory, checks exit statuses
and baked metadata, compares desktop/portable Stable and Nightly channels, and exercises
URL/context rejection and workflow leaks:

```sh
npm run test:focused -- scripts/__tests__/author-telemetry-build.test.ts
```

For release acceptance, use an installed candidate with an isolated Station
home on a supported desktop or portable host. Record its version, channel and
source SHA. Confirm that Kontour offers anonymous counts and Off, and that a
fresh desktop home sends only after the usage notice is handled. Run the host
across a UTC day boundary with anonymous counts enabled, then inspect
`station telemetry outbox --publisher kontour` for an acknowledged
`station_daily` row with that version and channel. Read the exact version and
channel breakdown in [private Insights](https://telemetry.kontourai.io/insights)
for the corresponding receiver arrival day. Record the receiver evidence
alongside the sender evidence. Public weekly estimates include privacy noise
and may be published without reports.

These are build and policy checks. They do not deploy a receiver, enable data
flow, or prove signed native artifacts or store delivery.

## Publish a release candidate

Release actions require an authorized release handoff. Use a clean sibling
worktree and an exact reviewed main source with successful full qualification.
Choose an unused base from current repository/provider state; these tags are
illustrative. Root product version `0.2.0` is the first planned full-release
base, not evidence of an existing public release.

```sh
git status --short
reviewed_sha=<exact-reviewed-qualified-main-commit>
git tag -s v0.2.0-rc.1 "$reviewed_sha" -m 'Station v0.2.0-rc.1'
git push origin v0.2.0-rc.1
```

Wait for `Release: Stage`, then inspect its complete draft, signing status,
checksums, inventory, SBOMs and store upload receipts. Approve RC publication:

```sh
gh workflow run publish-release.yml --repo kontourai/station --ref main \
  -f mode=rc -f tag=v0.2.0-rc.1
```

The protected workflow re-admits exact-source qualification and current advisory
policy. Verify the resulting prerelease and every downloaded input against the
producing ref and digest, for example:

```sh
work=$(mktemp -d)
gh release download v0.2.0-rc.1 --repo kontourai/station --dir "$work"
for file in station-release-ring-stable.json station-portable.tar.gz.sha256 station-portable.tar.gz; do
  gh attestation verify "$work/$file" \
    --repo kontourai/station \
    --signer-workflow kontourai/station/.github/workflows/release.yml \
    --source-ref refs/tags/v0.2.0-rc.1 \
    --source-digest "$(git rev-parse v0.2.0-rc.1^{commit})" \
    --cert-identity-regex '^https://github.com/kontourai/station/.github/workflows/release\.yml@refs/tags/v0\.2\.0-rc\.1$' \
    --cert-oidc-issuer https://token.actions.githubusercontent.com \
    --deny-self-hosted-runners
done
```

Use the authenticated bootstrap command in the README with
`STATION_CHANNEL=stable STATION_VERSION=v0.2.0-rc.1` to install that exact source
candidate. Exercise startup, critical journeys, upgrade, rollback and supported
native/device paths. RC desktop testers reinstall to move from rc.1 to rc.2:
both report `X.Y.Z`, so the updater does not offer the second as newer. Portable
testers moving between different candidate bytes at the same version explicitly
set `STATION_INSTALL_ALLOW_ROLLBACK=1`. Unpinned Stable installs continue to choose
final releases. A fix takes a new immutable RC tag and fresh matching evidence.

Immediately after a cut, prepare main's next development base through the
[release-cut command](native-releases.md#product-version-and-release-cut).
Do not edit the frozen candidate or its tag.

## Promote to stable

After acceptance, dispatch promotion with the published RC tag. Do not push a
new final tag by hand: the protected workflow creates it using its workflow
credential, which does not retrigger the tag producer. For a first Play
production launch explicitly select fraction 1; later updates may use an
owner-reviewed staged fraction.

```sh
gh workflow run publish-release.yml --repo kontourai/station --ref main \
  -f mode=promote -f tag=v0.2.0-rc.1 -f android_rollout_fraction=1
```

The final `v0.2.0` release retains the RC asset names, inventory, SBOMs,
attestations and store slot. The digest-bound `station-release-promotion.json`
receipt relates producer and publication tags, source SHA, policy SHA,
publication-workflow SHA and transferred asset hashes. The receipt is attested
by `publish-release.yml` on the default branch at its recorded workflow SHA;
asset attestations still name `release.yml` at the producing RC ref/source SHA.
A later policy checkout is not the receipt's workflow certificate source.

Store promotion requires definite authenticated RC upload authority. Play moves
the exact uploaded version code to production; Apple submits the exact existing
build for App Review with manual release. Neither operation rebuilds or uploads a
replacement. Provider review, production availability and physical installation
remain separate outcomes. See [store prerequisites](store-entry.md) and
[native publication and recovery](native-releases.md#stage-inspect-publish-and-roll-back).

On the first final publication, bootstrap only the authorities proven empty:
`allow_empty_updater_channel_bootstrap`, `allow_empty_host_manifest_bootstrap`
when host signing is enabled, and `allow_empty_availability_baseline`. The last
permits a successful first-release history result and writes no issue labels;
failed or ambiguous history never counts as empty. Existing authorities must
pass their ordinary validation.

Keep the original RC release public and retain all assets referenced by the
unchanged host payload. Inspect provider state and retained journals after any
attempted or unknown effect; do not blindly retry. An existing final ref is not
permission to overwrite it. Published-destination repair requires its completed,
attested promotion receipt and explicit repair admission.

An App Store-action custom feed remains at its previous version while the
selected build awaits review or manual release, even when the other Stable
artifacts publish. It advances only after exact released-build readback. See
[App Store feed recovery](https://github.com/kontourai/station/blob/main/docs/guides/store-entry.md#app-store-review-and-a-held-update-feed)
for the explicit operation and RC-authority limits; native store-managed updates
remain separate.

## Upgrade and rollback behavior

The installer records the selected channel and canonical install/data roots in a
mode-0600 state file only as part of promotion. `station upgrade` delegates to the
same installer contract and does not silently switch rings or accept unsigned
inputs. Failed startup attempts restoration of the prior link/state and runtime.
A failed rollback is reported separately; it is not a guarantee that recovery
will always succeed.

An installer-owned prebuilt version carries its installer. Its schema-4 state
also records the public manifest URL, which `station upgrade` reuses unless an
explicit `STATION_INSTALL_PUBLIC_MANIFEST_URL` overrides it. A
[managed policy's](managed-policy.md#update-control) mirror replaces both. When a running
Station service's fixed launcher runs that install, the installer only stages
the new version: the launcher trials it and, if the trial fails, restores its
home backup and the previous version (see the
[`service` reference](../reference/cli.md#service)). A manually
extracted archive has no installer-owned upgrade target and still requires
manual replacement. [Channel coexistence](release-channel-ports.md) describes
the shared home/state and owned-file removal boundaries.

For a failed draft, fix the source and use a new immutable tag admitted by
the existing main-ancestry, product-base and qualification guards. The
[release-cut limit](native-releases.md#product-version-and-release-cut) still
applies after main advances. Do not move
or reuse the failed tag. Retaining its draft, artifacts and receipts preserves
diagnosis; deletion is a separate owner-managed retention decision, not a
routine prerequisite to the replacement release.

For an authorized withdrawal, making the tag release a draft removes it from
the default installer resolver:

```sh
gh release edit v0.2.0 --repo kontourai/station --draft
```

That does not repair independent desktop rolling feeds or external stores.
Follow [native release recovery](native-releases.md#stage-inspect-publish-and-roll-back)
for those authorities, communicate the affected version through the incident
owner, and publish a higher fixed version. Never silently move the tag.

Withdrawal is roll-forward only for public-manifest installs. Each install
root records the newest release it accepted from a verified manifest
(`.station-release-accepted.json`). The record is raised as soon as the
manifest verifies, before extraction, so it holds even when that install or
the launcher's trial of it then failed and was rolled back. After that, a
re-signed manifest for an older release is refused on that install as stale
or replayed, the same as a hostile replay. So:

- publish a higher fixed version, or
- on each affected host, install the older release deliberately with
  `STATION_VERSION=v<x.y.z>` and `STATION_INSTALL_ALLOW_ROLLBACK=1`. That
  does not lower the record, so later updates still need a release at least
  as new as the withdrawn one.

The installers trust the record only if it is a regular file, owned by the
installing user and readable by nobody else (`0600`), and names a release of
the install's own ring. Anything else is treated as unreadable: installs and
updates are refused, and the server's update check offers nothing and says
why. To recover on the host, do one of these:

- fix the record's owner or permissions,
- remove `.station-release-accepted.json` from the install root (the next
  verified install writes a fresh one), or
- install a release explicitly with `STATION_VERSION=v<x.y.z>` and
  `STATION_INSTALL_ALLOW_ROLLBACK=1`, which rewrites the record.

Leftover `.station-release-accepted.json.*.tmp` files in the install root are
staging files from an interrupted install and are safe to delete.

One accepted edge: the record compares versions, not bytes. After a launcher
rollback from vN, a manifest for different bytes signed as the same vN is not
older than the record, and it is newer than the active release, so it
installs without a flag. It still needs a valid signature from a key pinned
for the ring.

## Rotating the attestation action pin

Treat a pin update as a release-policy change: review the upstream action release
and commit, update the workflow and installer assumptions together, run the local
release-ring tests, publish an RC, verify all three real attestations, dogfood
the candidate, and only then promote a new stable version.

Real GitHub OIDC publication and hosted macOS/Linux smoke evidence remain
`NOT_VERIFIED` until an authorized Actions run executes. Local fake-verifier tests
prove command shape and failure behavior, not provider provenance.
