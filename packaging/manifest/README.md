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
downgrades and same-version byte replacement within one layout unless an exact
replacement is explicitly authorized. A same-version switch between source
and prebuilt layouts is accepted without that flag. A new installation can
still receive an older signed manifest; no maximum manifest age is enforced. The
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
The current v2 payload uses a platform artifact array. The former v2 source-archive
shape is no longer accepted by the installer or manifest CLI.

| Signed payload | Producer or fixture | Current consumer |
| --- | --- | --- |
| v1: `artifacts.macos` and `artifacts.portable`, stable/preview | Manifest CLI `create`; ecosystem dry-run fixture | CLI `verify`/`cask`; `install.sh` selects `station-portable.tar.gz` |
| Former v2: `artifacts.portable`, including Nightly | Historical installer fixtures | Refused by current `install.sh` and manifest CLI |
| Platform v2: `artifacts[]` with OS, architecture, format, size and digest; `nodeVersion`; `launcherProtocol` | CLI `assemble` then `create`; owner-gated portable Nightly workflow | CLI `verify`, shared verifier, macOS/Linux `install.sh` host selection, and the Windows `install.ps1` core; no cask rendering |

[release-manifest.mjs](../../packages/shared/src/release-manifest.mjs) and
[portable-server-targets.mjs](../../packages/shared/src/portable-server-targets.mjs)
own the platform format and target vocabulary. `assemble` checks descriptor
identity, common Node version and required target coverage; when an archive sits
beside its descriptor, it also checks those bytes. A descriptor without that
archive is not a download/readback receipt.

The [archive workflow](../../.github/workflows/portable-server-archives.yml)
builds, smokes and uploads CI artifacts. The separate
[portable Nightly publication workflow](../../docs/guides/nightly.md#portable-server-nightly-dry-run-until-the-owner-enables-it)
assembles v2 and can publish its signed rolling manifest only behind the owner
gate. The installer requires an explicit public manifest URL.

The [ecosystem dry-run](../../scripts/exercise-ecosystem-packaging-dry-run.sh)
uses v1 through a disposable local endpoint. The separate
[prebuilt installer smoke](../../scripts/smoke-install-prebuilt-archive.sh)
uses two locally built preview archives and fixture signing keys to exercise
install, start, upgrade and uninstall without Node.js on the installer's PATH.
Its workflow covers Linux x64 and macOS arm64; only the Linux leg also installs
a systemd user service that runs the fixed service launcher, and checks that
`station upgrade` hands the upgraded archive to that launcher, which trials
and commits it before the service serves it.
These source definitions are
not executed receipts or public-release proof. See the
[archive install contract](../../docs/guides/release-channel-ports.md#prebuilt-archives-and-source-releases)
for layout, runtime, upgrade and service boundaries.
