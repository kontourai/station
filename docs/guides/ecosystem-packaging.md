# Ecosystem packaging

Station has tools for signed ecosystem manifests, portable-archive installation
and Homebrew cask generation. Those tools do not establish a live public
distribution, an approved tap or production signing-key custody.

The installer selects the public-manifest path only when
`STATION_INSTALL_PUBLIC_MANIFEST_URL` is set; its default path uses GitHub release
attestation and a GitHub credential. Normal manifest verification uses pinned,
channel-scoped keys. It does not require different manifest/artifact origins or
fetch a trust key from a third authority. Signature and hash checks identify the
signer and artifact bytes, not every aspect of freshness or safe execution.
See the [manifest contract](../../packaging/manifest/README.md) for version checks
and the explicit fixture-key override boundary.

The [cask renderer](../../packaging/homebrew/README.md) requires a schema-v1
manifest with a macOS artifact. Schema-v2 portable-only manifests do not imply a
Homebrew artifact. Rendering a cask does not create a tap or install an app.

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
