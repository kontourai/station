# Applied registry trust policy

Status: implementation checkpoint for #1521. The durable policy-decision owner is
wired into configuration application. Registry acquisition and protected-effect
admission are not yet wired; this checkpoint does not complete signed registry
installation or establish a new trust badge.

`registryTrust` in AppConfig is candidate configuration. It uses the existing
configuration writer, schema, settings registry and runtime application owner.
Reading a candidate does not make it accepted. The bounded non-mutating observer
neither initializes a missing home nor migrates, chmods or repairs existing files.

After startup or a full configuration rebuild succeeds, the existing owner checks
that the candidate actually built is still current under its configuration
mutation authority. It then publishes a decision through compare-and-swap on the
same EventStore database. A stale expected epoch refuses, including when candidate
A is restored after an applied B. Applied A → B → A therefore has three distinct
epochs even though the first and last policy fingerprints match. A failed rebuild
never reaches policy publication. An uncertain publication response requires
inspection of the durable decision; it is not permission to overwrite a newer
one.

The journal stores bounded identities, epochs and SHA-256 fingerprints of actual
Ed25519 SPKI public-key material. It does not store PEM keys. Sorting is ordinal,
and both published and deserialized identities are shape-checked within a 64 KiB
limit. Public keys used by later verification must match the applied identity.
Deleting a configuration profile must not downgrade a generation that already
carries a pinned receipt.

`current()` is an observation, not an effect permit. Candidate/applied mismatch
refuses that observation. The next implementation stage must connect policy
identity to each new protected effect through existing activation/admission
owners; a final-ready check alone cannot undo an import, build or MCP invocation
that already began. Policy withdrawal must not claim to terminate started work.

The selected generation's activation receipt will remain the sole pin and
continuity authority. Registry aliases are projections. Production preview and
admission must obtain a fresh, coherent claim from the host-resolved provider,
keep signed source-tree and post-build artifact digests distinct, and refuse
unsupported continuity changes while retaining data. Unprofiled local unsigned
authoring remains supported. Hosted adapters and tenant isolation are not proved
by the local policy owner.
