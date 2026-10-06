# Signed release rings

Start with [integration, qualification and releases](releasing.md) for the
cadence, exact-source evidence, repair ownership and full release procedure.

Station's default portable installer uses GitHub-attested release rings.
Stable is the default;
Beta is opt-in with `STATION_CHANNEL=beta`. Its public release protocol remains
named `preview`, and a preview tag has the form
`vMAJOR.MINOR.PATCH-preview.N`; a stable tag has the form `vMAJOR.MINOR.PATCH`.
Promotion creates a new stable tag from the exact reviewed preview commit. The
repository's `package.json` carries the stable base version (`X.Y.Z`) once;
preview numbering lives only in immutable `vX.Y.Z-preview.N` tags and their
release overlays. Promotion never edits source, moves a tag, or relabels a
preview artifact.

Nightly is a separate, opt-in signed-public-manifest path:
`STATION_CHANNEL=nightly` requires `STATION_INSTALL_PUBLIC_MANIFEST_URL`.
The authenticated GitHub-release path serves Stable and Beta only. See
[channel identity and coexistence](release-channel-ports.md) for Nightly's
home/port admission and the distinction between the public manifest signature
and a signed Git tag. Publication remains separate from installer support.

## Release artifacts and trust boundary

The Stable/preview source-archive path uses these three installer inputs:

- `station-release-ring-stable.json` or `station-release-ring-preview.json`
- `station-portable.tar.gz.sha256`
- `station-portable.tar.gz`

The tag-triggered release workflow produces those inputs and uploads
them only after the full native release inventory validates. It creates a draft;
the protected manual `Release: Publish` workflow revalidates that draft
and is the only workflow allowed to publish it. The tag workflow identity and
the release tag must name the same Git ref.

The default installer path requires an authenticated `gh` with attestation support. Before it
parses a manifest, checksum, or archive, it verifies that file against:

- repository `kontourai/station`
- workflow `kontourai/station/.github/workflows/release.yml`
- the selected release tag and its resolved source commit
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
not freshness. Existing-install downgrade guards do not prevent an old signed
manifest from being offered to a fresh installation. Read the exact owner in
[`install.sh`](../../install.sh) before changing that policy.

This public path also accepts the platform-array v2 manifest for prebuilt
server archives. It checks the selected host, launcher protocol, signed size
and hash, and the archive's release identity before activation. Those archives
use `versions/<version>` and their bundled Node runtime; schema-v1 source
manifests use `releases/` and run dependencies/build steps. This does not change
the default GitHub-attested source path described above. See the
[manifest consumer table](../../packaging/manifest/README.md#formats-and-consumers).

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
and it may sign `stable` and `preview` only. With the variable enabled and the
secret missing, the job fails before the release is published. With the gate
on, the publish job:

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
versioned release, requires the payload to name this run's version, tag and
source SHA, and verifies them with the pinned key table before any pointer
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

A tag built before this workflow change carries no host archives or payload,
so its draft fails revalidation and cannot be published with it. No such tag
exists: no tagged release has completed (#1243).

The locations come from one base,
[`scripts/lib/public-release-locations.mjs`](../../scripts/lib/public-release-locations.mjs):
`https://github.com/kontourai/station/releases/download/`. The versioned
manifest is `v<version>/station-portable-<ring>-manifest.json`. The rolling
pointers are `portable-stable/station-portable-stable-manifest.json` and
`portable-preview/station-portable-preview-manifest.json`. Nightly's
`portable-nightly` pointer derives from the same base. Stable and preview
versions order numerically on `X.Y.Z` and `X.Y.Z-preview.N`.

Nothing has been published this way yet. These remain owner actions: add the
secret, create the `portable-stable` and `portable-preview` pointer releases
(public), set the variable, cut a tagged release that completes (#1243), and
set `allow_empty_host_manifest_bootstrap` on each ring's first publish.
The installer's defaults are unchanged. `install.sh` already accepts a stable
or preview manifest through `STATION_INSTALL_PUBLIC_MANIFEST_URL`, and making
these URLs its default is #2960.

## Publish a preview

Release actions below require an authorized release handoff. Use a clean
exclusive checkout of the exact reviewed `main` commit, and choose the version
from current repository/provider state rather than these illustrative tags:

```sh
git status --short
reviewed_sha=<exact-reviewed-commit>
git tag -s v0.2.0-preview.1 "$reviewed_sha" -m 'Station v0.2.0-preview.1'
git push origin v0.2.0-preview.1
```

Wait for `Release: Stage`. Inspect its draft and inventory, then approve
`Release: Publish` for that tag. Confirm that the manual workflow
published a prerelease and verify each downloaded input independently:

```sh
work=$(mktemp -d)
gh release download v0.2.0-preview.1 --repo kontourai/station --dir "$work"
for file in \
  station-release-ring-preview.json \
  station-portable.tar.gz.sha256 \
  station-portable.tar.gz
do
  gh attestation verify "$work/$file" \
    --repo kontourai/station \
    --signer-workflow kontourai/station/.github/workflows/release.yml \
    --source-ref refs/tags/v0.2.0-preview.1 \
    --source-digest "$(git rev-parse v0.2.0-preview.1^{commit})" \
    --cert-identity-regex '^https://github.com/kontourai/station/.github/workflows/release\.yml@refs/tags/v0\.2\.0-preview\.1$' \
    --cert-oidc-issuer https://token.actions.githubusercontent.com \
    --deny-self-hosted-runners
done
rm -rf "$work"
```

Install or switch an existing portable install to Beta using the authenticated
bootstrap command in the README with `STATION_CHANNEL=beta`. `station upgrade`
then remains on the signed preview release ring until the installer explicitly
switches channels.

## Promote to stable

After preview dogfooding, tag the same reviewed commit with its stable version.
If a fix was needed, publish and dogfood a new preview tag from that newer
commit first; Stable always names bytes that Beta already exercised:

```sh
reviewed_sha=$(git rev-parse 'v0.2.0-preview.1^{commit}')
git tag -s v0.2.0 "$reviewed_sha" -m 'Station v0.2.0'
git push origin v0.2.0
```

Repeat the three-file verification above using
`station-release-ring-stable.json`, `refs/tags/v0.2.0`, and the stable identity
regex. Stable should follow preview only after its smoke and dogfood evidence is
reviewed; do not promote on a fixed calendar when evidence is incomplete.

## Upgrade and rollback behavior

The installer records the selected channel and canonical install/data roots in a
mode-0600 state file only as part of promotion. `station upgrade` delegates to the
same installer contract and does not silently switch rings or accept unsigned
inputs. Failed startup attempts restoration of the prior link/state and runtime.
A failed rollback is reported separately; it is not a guarantee that recovery
will always succeed.

An installer-owned prebuilt version carries its installer. Its schema-4 state
also records the public manifest URL, which `station upgrade` reuses unless an
explicit `STATION_INSTALL_PUBLIC_MANIFEST_URL` overrides it. When a running
Station service's fixed launcher runs that install, the installer only stages
the new version: the launcher trials it and, if the trial fails, restores its
home backup and the previous version (see the
[`service` reference](../reference/cli.md#service)). A manually
extracted archive has no installer-owned upgrade target and still requires
manual replacement. [Channel coexistence](release-channel-ports.md) describes
the shared home/state and owned-file removal boundaries.

For a failed draft, fix the source and use a new immutable tag. Do not move
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

## Rotating the attestation action pin

Treat a pin update as a release-policy change: review the upstream action release
and commit, update the workflow and installer assumptions together, run the local
release-ring tests, publish a preview, verify all three real attestations, dogfood
the preview, and only then promote a new stable version.

Real GitHub OIDC publication and hosted macOS/Linux smoke evidence remain
`NOT_VERIFIED` until an authorized Actions run executes. Local fake-verifier tests
prove command shape and failure behavior, not provider provenance.
