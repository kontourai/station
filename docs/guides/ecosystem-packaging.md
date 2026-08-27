# Ecosystem packaging (owner-gated)

Station has release plumbing for a Homebrew cask and a public `curl | sh`
fallback, but public distribution is disabled by default. No Homebrew tap,
package name, release manifest, or signing key is created by this repository.

The public fallback will obtain its signed manifest from the trust origin and
the selected artifact from the release origin. The installer rejects an
artifact served by the manifest authority and verifies the artifact's SHA-256
against the signed manifest before extracting it. The cask is rendered from
that same verified manifest, so both installer surfaces pin the exact bytes.

`ecosystem-packaging.yml` runs a macOS clean-machine dry-run: it signs an
ephemeral manifest, renders the cask, installs a freshly packaged artifact with
no GitHub credential, and then runs the publish boundary in its inert default
mode. Only a manual dispatch with `publish: true` plus owner-managed publish
commands may cross the external boundary.

Before enabling it, the owner must provision separate release, trust-manifest,
and trust-key authorities, an offline-held Ed25519 signing key, and an
explicitly reviewed Homebrew tap destination. These prerequisites are not
created or claimed by the dry run.
