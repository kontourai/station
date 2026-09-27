# Ecosystem packaging

Station has tools for signed ecosystem manifests, portable-archive installation
and Homebrew cask generation. Those tools do not establish a live public
distribution, an approved tap or production signing-key custody.

The installer selects the public-manifest path only when
`STATION_INSTALL_PUBLIC_MANIFEST_URL` is set; its default stable/beta path uses
GitHub release attestation and a GitHub credential. Nightly requires the explicit
public-manifest path. Normal manifest verification uses pinned,
channel-scoped keys. It does not require different manifest/artifact origins or
fetch a trust key from a third authority. Signature and hash checks identify the
signer and artifact bytes, not every aspect of freshness or safe execution.
See the [manifest contract](../../packaging/manifest/README.md) for version checks
and the explicit fixture-key override boundary.

The [cask renderer](../../packaging/homebrew/README.md) requires a schema-v1
manifest with a macOS artifact. Rendering a cask does not create a tap or install
an app.

There are two different payloads labelled schema v2 in the current code.
`install.sh` accepts the older source-archive shape, with `artifacts.portable`
naming `station-portable.tar.gz`. The manifest CLI now accepts the newer
platform-array shape defined by
[release-manifest.mjs](../../packages/shared/src/release-manifest.mjs), including
Node version and launcher-protocol bounds. Its `assemble` command builds that
payload from archive descriptors; `create` signs it. This newer payload is not
accepted by `install.sh`, and neither v2 shape produces a Homebrew cask.
The [manifest README](../../packaging/manifest/README.md) maps these consumers.
[#2675](https://github.com/kontourai/station/issues/2675) owns the prebuilt-server
delivery integration; the existence of the assembler is not publication proof.

The [portable Nightly publication workflow](nightly.md#portable-server-nightly-dry-run-until-the-owner-enables-it)
uses this platform-array payload. It defaults to a dry run; its separately
enabled publication path does not change the current installer limitation.

The [packaging workflow](../../.github/workflows/ecosystem-packaging.yml) is
configured to run a macOS fixture dry-run: it generates ephemeral signing
material, verifies/renders a manifest and cask, exercises a packaged installer,
and reaches the inert publish boundary. Its DMG is a placeholder, and the
portable install skips starting Station. It does not test a Homebrew install or
a native application launch. A workflow definition or fixture result
is not a receipt for a current production release.

External publication is off by default in the
[boundary script](../../scripts/ecosystem-publish-boundary.sh). When explicitly
enabled, it requires both manifest and Homebrew publish commands and runs them.
The workflow supplies those commands from secrets for manual dispatch. The
script does not verify human approval, protected-environment settings, separate
origin ownership or key isolation. Those are operator responsibilities to review
before publication; this documentation audit performed no external publish.
