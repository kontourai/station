# Applied registry trust policy

The local profile verifies registry source claims through the existing plugin
installer, records the decision on the selected immutable generation, and fences
new execution through the existing activation and MCP custody owners. It supports
an initial verified install, exact-claim replay, and retained recovery under the
same applied policy. Changed claims, signing principals, or policy epochs require
a separately reviewed continuity operation; this slice refuses them and retains
data. It does not implement that migration operation or a publisher trust badge.

## Configuration and application

`registryTrust` in AppConfig is candidate configuration. Hosts use the existing
configuration writer (`PUT /config/app`), schema, settings registry, and runtime
application owner. Each profile selects the exact opaque `registryKey` exposed
by its registry provider, a `signatures` value of `optional` or `required`, and a
map of `trustedEd25519Keys`. Values are public Ed25519 SPKI PEMs; private-key PEMs
are rejected before configuration is saved. There are at most 16 profiles and 16
keys per profile. A registry cannot supply or install its own trust anchors.

Profiles apply to their selected registry. An unrelated unsigned local source
continues to work without a registry account. A supplied registry claim without
a corresponding host policy is refused. Removing a profile never turns a
previously bound installation into an anonymous local package.

Reading candidate configuration does not make it accepted. The non-mutating
observer neither initializes a missing home nor migrates, chmods, or repairs
existing files. It preserves a stable supported config-file symlink, captures
its physical regular-file target, opens without blocking or following a replaced
symlink, and checks handle and path identity after reading.

After required startup work or a full configuration rebuild succeeds, the
existing owner checks that the candidate actually built is still current under
its configuration mutation authority. It then publishes through compare-and-swap
on the same EventStore database. A stale expected epoch refuses, including when
candidate A is restored after an applied B. Applied A → B → A has distinct epochs.
A failed required initialization step does not publish an accepted policy. An
uncertain publication response requires inspection, not overwriting a newer
record.

The policy decision stores bounded identities, epochs, and SHA-256 fingerprints
of actual Ed25519 SPKI material. It does not store PEM keys. Sorting is ordinal;
both publication and deserialization validate the identity within a 64 KiB
limit. A `keyId` is a configured label. It is not independent authentication of a
legal publisher identity. Replacing key material under the same label changes
the policy identity and its applied epoch.

## Acquisition and consent

`JsonManifestRegistryProvider.resolvePackage()` obtains source and untrusted
claim from one fresh catalog response, bypassing its browsing cache. The central
installer resolves the host provider again before building. Request bodies
cannot supply a trusted claim, provider, signing key, or applied policy.

The signature payload binds the schema target, registry identity, plugin name,
version, source, and source-tree digest. The manifest is validated separately.
The canonical digest includes path, entry kind, file bytes, and symlink target
strings in ordinal path order; only root `.git` metadata is excluded. Symlinks
are not followed by the digest. Existing materialization containment checks
remain necessary. A signature does not prove sandboxing, harmless code,
reproducible builds, or the contents of code downloaded during execution.

Preview returns an opaque `registryTrustRevision` alongside the existing source
content digest and grant revision. The client returns it in install consent,
including each verified dependency's consent. The installer recomputes the
revision from current host verification; an absent or stale review refuses
before build. Required-signature dependencies use the same claim path. A legacy
dependency mutation that cannot satisfy a selected registry policy, or would
replace a bound generation, refuses before its build or raw provider mutation.

The signed source digest and post-build artifact digest remain distinct. The
existing activation plan records a bounded registry receipt: claim digest,
registry-key digest, registry id, source digest, signing-key fingerprint, and
applied scope/epoch/identity. It contains no source URLs, PEMs, or signatures. The
generation binds the receipt digest, so missing or corrupt receipt storage cannot
demote a bound package to unsigned. Registry aliases remain projections; the
selected generation and its activation plan are the authority.

## Execution and retained recovery

New acquisition builds and provider import/factory entries check current policy
through the asynchronous admission owner. The local journal checks the
authoritative applied epoch for ordinary ready admission, private pending permits, reservation, and
entry into an MCP effect. Provider handles retain current-generation fences.
A refusal between provider constructions stays under the existing preparation
cleanup owner; cleanup attempts do not prove external work terminated.

A candidate-only file edit is not a completed policy withdrawal. New acquisition
verification and recovery observations refuse candidate/applied mismatch. An
accepted epoch change fences captured local handles immediately. Retained code, including a provider restored
at startup, is authorized against the still-applied decision while a new
candidate is being constructed. It is not labeled as admitted under the new
policy: publication of that policy closes the old generation's handles, and
configuration reconciliation drops the stale composition. No equivalent
guarantee is claimed for an eventually updated remote cache. The public policy/storage boundary is
asynchronous; an unsupported hosted synchronization profile must refuse rather
than emulate local revocation semantics.

Retained recovery uses the captured immutable built artifact, the original
journal-bound verification, the same current policy and signing principal, and
fresh consent. It does not contact the registry or original source, and does not
claim a fresh source observation. The original source digest remains attached
to that verification. Ready retained children are inspected through their
captured journal identities; their current byte, permission, and trust consent
must match. Missing children keep their explicit recovery remedy. A pending child is
recovered first, preserving its recorded parent reference through the existing
journal owner so the parent sees its new generation; the parent can then recover.
Recovery does not invent a pending capability or a new parent relationship.

Updating or withdrawing routing retains old code, stable plugin data, and any
uncertain external effects. Policy changes do not terminate already-started
work, revoke operating-system capabilities retroactively, or authorize garbage
collection. Code rollback is not data rollback.

## Public integration and failures

Existing configuration and plugin-route authentication/authorization still
apply. Signature verification does not give a caller permission to install,
create tenant membership, or change host policy. See
[Integrating Station](../guides/integrating-station.md) for host and tenant
ownership. A shared writable home is not tenant isolation; hosted adapters are
not qualified by this local implementation.

A direct trust refusal returns HTTP 409 with `code: "registry-trust-refused"` and
a closed `reason`, such as `stale-review`, `missing-claim`,
`untrusted-signing-key`, `signature-mismatch`, `continuity-change`, or
`receipt-unavailable`. Messages contain no raw claim URLs or key material.
Preview/review can resolve a stale observation. A continuity or unavailable
receipt refusal retains data and requires the indicated inspection or reviewed
migration; automatic retries cannot provide that authority. Aggregate
compensation failures retain their existing failure result rather than being
flattened into a simple trust refusal.

Author tooling uses the explicit Node leaves
`@kontourai/station-shared/plugin-tree-digest` and
`@kontourai/station-shared/plugin-registry-signature`. They do not enter the shared
root/browser barrel. The server retains its installed-root resolution wrapper.
The [signing example](../../examples/registry/signed-package/README.md) keeps key
input and catalog output outside the signed tree and describes candidate-package
versus published-package availability.
