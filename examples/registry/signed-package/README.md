# Prepare a signed registry package

This authoring example prepares one Agent Plugins 1.0 source claim and a JSON
catalog using public Station package imports. It makes no network request,
changes no Station configuration, and performs no installation. The signing-key
label identifies a key configured by an operator; it does not establish a legal
publisher identity.

## Requirements

- Node 24, tsx, and matching candidate builds of the Station contracts and shared
  packages containing the registry-trust, plugin-tree-digest, and
  plugin-registry-signature public leaves. New exports in a candidate checkout
  are not a claim that they are already available on npm.
- A frozen source snapshot exactly matching the Git ref that consumers fetch.
  Use a clean clone or export. The tree digest excludes only the root .git
  directory: build output, dependencies, and private files must stay outside
  this snapshot. The digest observes bytes and link targets; it does not grant
  execution authority or establish materialization containment.
- An unencrypted Ed25519 private-key PEM outside the source snapshot. Keep it in
  your existing protected signing workflow, outside the repository and catalog.
- A public HTTPS Git locator ending in .git#REF and the exact public HTTPS catalog
  URL that operators configure. This example rejects URL credentials and query
  parameters. Its output parent directory must exist; the output directory must
  be new and outside the source snapshot.

The packages currently contain TypeScript sources, so run this example with
tsx rather than relying on Node to strip TypeScript inside node_modules. Install
matching candidate package tarballs and tsx in an independent tool directory
using your package manager's script-disabled install mode. Copy this example
directory there, then replace the two Station package dependencies with those
tarballs before installation. The example has its own package.json and
tsconfig.json; it imports no Station server internals or repository configuration.
Run pnpm check to check its types and pnpm test to exercise the real CLI against
ephemeral package/key fixtures. Verification checks signatures, tampering,
output/private-key placement, invalid namespace refusal and credential redaction,
then removes its temporary keys and files. It starts no Station server.

For unreleased tarballs, pin the candidate contracts package throughout the
dependency graph. A direct dependency alone can leave the shared package using
an older published contracts version. With pnpm 11, use pnpm-workspace.yaml
(package.json's pnpm.overrides is ignored):

~~~yaml
packages:
  - .
overrides:
  "@kontourai/station-contracts": "file:/work/packages/kontourai-station-contracts-0.7.0.tgz"
~~~

Use the actual candidate archive path/version, and set the two direct Station
dependencies in package.json to the matching file tarballs before running
pnpm install --ignore-scripts. Published releases must instead declare a shared
package dependency floor that includes the required contracts exports; an
override is candidate qualification, not evidence that an older npm package
contains new APIs.

## Prepare the catalog

~~~sh
pnpm exec tsx prepare.ts \
  --package /work/release-snapshot \
  --source https://github.com/example/example-plugin.git#v1.0.0 \
  --registry https://plugins.example.org/catalog.json \
  --key-id release-key \
  --private-key /secure/example-plugin-ed25519.pem \
  --out /work/prepared-catalog
~~~

The optional --id sets the registry entry ID; otherwise it uses the manifest
name. The manifest must declare an explicit version. Portable core and the
known Station namespace are validated before signing, and the source digest is
checked again before writing output.

The new output directory contains:

- catalog.json: the registry entry and its Ed25519 claim, bound to the exact
  source digest, source locator, registry URL, entry ID, name, and version.
- signer-public-key.pem: the public key for independent operator review.

The command reports the source digest and public-key fingerprint. It never
outputs the private key. Existing output directories are refused. An I/O error
may leave partial public output for inspection; use a new destination for a retry.

## Operator handoff

Publish the unchanged catalog at its declared URL through your existing release
process. Give the operator the public key and fingerprint through their normal
review channel. Merely serving a catalog or including a key in package metadata
does not make that key trusted.

The operator configures the exact registry URL and signing-key label in
Station's registry trust profile and applies that configuration. Preview and
install use fresh host-resolved claims and fresh consent. Changed source, key,
or policy continuity may be refused by the supported initial pinning profile;
this tool does not authorize an upgrade or data migration.

Recovery of already-admitted retained code uses its original journal receipt,
retained artifact, current local policy, and fresh consent. It does not require
this signing tool or a reachable source registry.

See the [registry trust design](../../../docs/design/registry-trust-policy.md)
for the policy owner and [plugin guide](../../../docs/guides/plugins.md) for
installation and authoring.
