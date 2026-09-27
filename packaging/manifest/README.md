# Public ecosystem manifest

[install.sh](../../install.sh) uses the ecosystem-manifest path when
`STATION_INSTALL_PUBLIC_MANIFEST_URL` is set. Otherwise it uses the GitHub
release/attestation path. The manifest is a JSON envelope containing a payload,
key ID and detached Ed25519 signature over the canonical payload; the installer
checks the selected portable archive against the signed hash before promotion.

Normal verification uses the channel-scoped public keys embedded in the
installer, kept in sync with
[release-manifest-keys.json](../../config/release-manifest-keys.json). It does
not fetch its trust key from a third origin or require manifest/artifact hosts
to be distinct. A key URL is accepted only behind the explicit insecure-test
override; do not use fixture overrides as a production trust configuration.

Signature and hash checks establish an authorized signer and named bytes, not
freshness or safe behavior. Existing-install version checks refuse ordinary
downgrades and same-version byte replacement, but a new installation can still
receive an older signed manifest; no maximum manifest age is enforced. The
public-manifest path is opt-in, not evidence of a live public distribution.

[ecosystem-manifest.mjs](../../scripts/ecosystem-manifest.mjs) owns manifest
creation/verification and cask rendering. Its `create` command reads an explicit
private-key file; production key custody is an operator responsibility, not a
property proved by this directory. Schema v1 includes macOS cask artifacts;
schema v2 supports portable-only payloads. See
[ecosystem packaging](../../docs/guides/ecosystem-packaging.md) and the
[publish boundary](../../scripts/ecosystem-publish-boundary.sh) before any
separately authorized publication. No workflow execution, published artifact or
installer run is established by this README.
