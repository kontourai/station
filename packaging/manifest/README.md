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
property proved by this directory. See
[ecosystem packaging](../../docs/guides/ecosystem-packaging.md) and the
[publish boundary](../../scripts/ecosystem-publish-boundary.sh) before any
separately authorized publication. No workflow execution, published artifact or
installer run is established by this README.

## Formats and consumers

The envelope's `schemaVersion: 1` is distinct from the signed payload's version.
Do not select a consumer from the payload version number alone: two current
formats use `schemaVersion: 2`.

| Signed payload | Producer or fixture | Current consumer |
| --- | --- | --- |
| v1: `artifacts.macos` and `artifacts.portable`, stable/preview | Manifest CLI `create`; ecosystem dry-run fixture | CLI `verify`/`cask`; `install.sh` selects `station-portable.tar.gz` |
| Older v2: `artifacts.portable`, including Nightly | Installer test fixtures sign this shape directly | `install.sh`; current manifest CLI does not accept this shape |
| Platform v2: `artifacts[]` with OS, architecture, format, size and digest; `nodeVersion`; `launcherProtocol` | CLI `assemble` writes the payload, then `create` signs it | CLI `verify` and the shared verifier; current `install.sh` refuses it |

[release-manifest.mjs](../../packages/shared/src/release-manifest.mjs) and
[portable-server-targets.mjs](../../packages/shared/src/portable-server-targets.mjs)
own the platform format and target vocabulary. `assemble` checks descriptor
identity, common Node version and required target coverage; when an archive sits
beside its descriptor, it also checks those bytes. A descriptor without that
archive is not a download/readback receipt.

The [archive workflow](../../.github/workflows/portable-server-archives.yml)
builds, smokes and uploads CI artifacts. It does not wire `assemble` output to
a public manifest URL consumed by the shell installer. The current
[ecosystem dry-run](../../scripts/exercise-ecosystem-packaging-dry-run.sh)
uses v1 through a disposable local endpoint. An operator supplies the public
URL or publication commands; no broken deployed release is established by the
format mismatch alone. See
[#2675](https://github.com/kontourai/station/issues/2675) for the integration work.
