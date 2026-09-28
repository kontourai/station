# Signed release rings

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
the protected manual `Publish Station release` workflow revalidates that draft
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

Wait for `Stage Station release`. Inspect its draft and inventory, then approve
`Publish Station release` for that tag. Confirm that the manual workflow
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
