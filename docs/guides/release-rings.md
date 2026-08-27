# Signed release rings

Station portable installs use signed GitHub release rings. Stable is the default;
Beta is opt-in with `STATION_CHANNEL=beta`. Its public release protocol remains
named `preview`, and a preview tag has the form
`vMAJOR.MINOR.PATCH-preview.N`; a stable tag has the form `vMAJOR.MINOR.PATCH`.
Promotion creates a new stable tag from the exact reviewed preview commit. The
repository's `package.json` carries the stable base version (`X.Y.Z`) once;
preview numbering lives only in immutable `vX.Y.Z-preview.N` tags and their
release overlays. Promotion never edits source, moves a tag, or relabels a
preview artifact.

## Release artifacts and trust boundary

Every release contains exactly these installer inputs:

- `station-release-ring-stable.json` or `station-release-ring-preview.json`
- `station-portable.tar.gz.sha256`
- `station-portable.tar.gz`

The tag-triggered release workflow builds those inputs in that order and uploads
them only after the full native release inventory validates. It creates a draft;
the protected manual `Publish Station release` workflow revalidates that draft
and is the only workflow allowed to publish it. The tag workflow identity and
the release tag must name the same Git ref.

The installer requires an authenticated `gh` with attestation support. Before it
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

## Publish a preview

Start from the exact reviewed commit on `main`:

```sh
git switch main
git pull --ff-only origin main
git status --short
git tag -s v0.2.0-preview.1 -m 'Station v0.2.0-preview.1'
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
git switch main
git pull --ff-only origin main
git tag -s v0.2.0 -m 'Station v0.2.0'
git push origin v0.2.0
```

Repeat the three-file verification above using
`station-release-ring-stable.json`, `refs/tags/v0.2.0`, and the stable identity
regex. Stable should follow preview only after its smoke and dogfood evidence is
reviewed; do not promote on a fixed calendar when evidence is incomplete.

## Upgrade and rollback behavior

The installer records the selected channel and canonical install/data roots in a
mode-0600 state file only as part of promotion. `station upgrade` delegates to the
same signed installer contract and never falls back to another ring or unsigned
assets. The previous release link and prior ring state are restored if the new
release cannot start.

For a failed draft, fix the source and publish a new version; do not reuse a tag.
Delete an unpublished, incomplete release and its remote tag before creating the
replacement:

```sh
gh release delete v0.2.0-preview.1 --repo kontourai/station --yes
git push origin :refs/tags/v0.2.0-preview.1
git tag -d v0.2.0-preview.1
```

If a published release is compromised, immediately remove it from installer
resolution and then announce the affected version:

```sh
gh release edit v0.2.0 --repo kontourai/station --draft
```

Publish a higher replacement version and rerun the signed installer. Never
silently move the compromised tag.

## Rotating the attestation action pin

Treat a pin update as a release-policy change: review the upstream action release
and commit, update the workflow and installer assumptions together, run the local
release-ring tests, publish a preview, verify all three real attestations, dogfood
the preview, and only then promote a new stable version.

Real GitHub OIDC publication and hosted macOS/Linux smoke evidence remain
`NOT_VERIFIED` until an authorized Actions run executes. Local fake-verifier tests
prove command shape and failure behavior, not provider provenance.
