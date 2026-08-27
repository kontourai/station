# Public ecosystem manifest

The public installer reads a detached Ed25519-signed manifest from the trust
origin, for example `https://trust.station.kontour.ai/manifests/v1.2.3.json`.
The manifest names an artifact on the release origin, for example
`https://releases.station.kontour.ai/v1.2.3/station-1.2.3-macos-universal.dmg`.

Those are intentionally different authorities. Release-artifact credentials
can write only the release origin; they cannot replace a signed manifest on the
trust origin. A compromise of the artifact origin therefore changes the
artifact hash and is rejected before installation. The manifest is additionally
verified against a public key fetched from a third protected trust authority in
the public bootstrap configuration.

The private key is never committed. It is supplied only to the owner-gated
manifest-publish environment after an owner has enabled public distribution.
