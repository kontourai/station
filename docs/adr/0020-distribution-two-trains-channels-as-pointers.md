# ADR 0020 — Distribution: two trains, channels as pointers, installer-first

**Status:** Accepted, 2026-09-29. It records owner decisions made that day for
epic [#2956](https://github.com/kontourai/station/issues/2956):

- the direction recorded on [#2713](https://github.com/kontourai/station/issues/2713)
  (D1–D5 below);
- answers to #2713's open points: never go backwards on a channel switch,
  one shared verifier, converge on the stable desktop identity, and
  `stable`/`beta`/`nightly` client channels;
- ring-tagged pointers now, with promotion as the target (D1);
- split updater signing keys (D6).

Rules that are engineering additions rather than owner decisions say so
inline.

It **supersedes in part**
[ADR 0015](0015-restore-desktop-owned-command-station-sidecar.md). D4
replaces ADR 0015's fixed sidecar command, which ran
`node <resource-dir>/dist-server/command-station.js` with `node` taken from
the login-shell PATH. D5 resolves ADR 0015's UNRESOLVED packaged-desktop
installer. ADR 0015's lifetime split stands: a sidecar dies with the app and
a service outlives it. So do its single-claim registry rule and its removal
of attach-to-existing.

No behavior changes with this ADR. Phases #2959–#2962 implement it, and each
changes docs, enforcing tests, and behavior together.

## Context

Station reaches users through three install paths with different trust
stories:

- **Default `install.sh` path:** needs an authenticated `gh` and installs
  GitHub-attested release rings, building from source.
- **Signed public manifest path:** selected by
  `STATION_INSTALL_PUBLIC_MANIFEST_URL`. It accepts any ring, but only Nightly
  requires it and only Nightly publishes one
  ([`install.sh`](../../install.sh)).
- **Source checkout.**

No tagged release has completed
([#1243](https://github.com/kontourai/station/issues/1243)), so the
documented one-liner has never installed a stable artifact.

Channels are separate products by convention:

- **Desktop:** stable, beta, and nightly each have their own identity
  (`io.kontourai.station[.beta|.nightly]` in
  [`src-desktop/tauri*.conf.json`](../../src-desktop/tauri.conf.json)) and
  their own deep-link scheme.
- **Ports, homes, launchers:** each channel has its own port block and home
  ([`config/channel-ports.json`](../../config/channel-ports.json)) and its own
  launcher.
- **Updater endpoint:** chosen at build time.
- **Version strings:** bound to their ring. The shared verifier requires a
  stable version `X.Y.Z` and a nightly version `X.Y.Z-nightly.N`
  ([`release-manifest.mjs`](../../packages/shared/src/release-manifest.mjs)),
  and each archive bakes in its ring.
- **Host runtime:** the desktop bundle ships one, so every host change is a
  desktop release.

Two compatibility contracts exist.

**Launcher protocol.** How a launcher starts and supervises a host runtime.

- Signed v2 manifests carry `launcherProtocol {min, max}`.
- `install.sh` and the in-app archive update
  ([`archive-update.ts`](../../src-server/routes/system/archive-update.ts))
  refuse an out-of-range release. The desktop spawn path does not check it.
- The value is declared separately in four places: `install.sh`,
  [`service-launcher-protocol.ts`](../../packages/shared/src/service-launcher-protocol.ts),
  the portable `station-launcher.mjs`, and the Nightly publisher.
- The fixed service launcher persists across updates and declares its own
  protocol.

**Client API protocol.** How clients talk to a host.

- The host advertises `protocolVersion` and `minClientProtocol` from
  [`environment-security.ts`](../../packages/contracts/src/environment-security.ts).
- The web and desktop client refuses when the host's minimum is above its
  own protocol, or when the host's protocol is below the client's minimum
  ([`compatibility.ts`](../../src-ui/src/lib/compatibility.ts)).
- At this decision's baseline, clients sent no protocol version, so a host
  could not refuse an old client. The #2962 addendum below records the current
  host rejection path.

**Desktop sidecar trust.** The desktop trusts its sidecar through a startup
ticket that binds generation, instance ID, boot ID, and API base. It proves
the shell talks to the process it spawned. The host's bytes are pinned only
because they ship inside the signed bundle.

**Home schema.** A home's `.station-home-schema.json` only moves forward. A
build refuses a newer home (`STATION_HOME_SCHEMA_DOWNGRADE_REFUSED` in
[`station-home-schema.ts`](../../packages/shared/src/station-home-schema.ts)).
The #2675 update backup includes that file.

**Channel records.** "Which channel am I on" lives in two records kept in
agreement:

- the ring baked into the installed archive's `.station-release.json`;
- `.station-release-state.json`, the install state holding `releaseChannel`
  and `manifestUrl`.

[`station upgrade`](../../packages/cli/src/commands/lifecycle.ts) requires
the two to agree. The archive-update route takes the ring from the baked
marker and the manifest URL from the install state.

## Decision

### D1. Channels are pointers; ring-tagged builds now, promotion later

Each ring is a **rolling signed manifest** (a pointer) that names one host
version. For now each pointer names a version built for that ring, from one
build pipeline, with the ring-tagged version strings above. This is the
staged model the owner chose. It is what #2959 publishes.

The target is **promotion**: the same bytes serve every ring, and a pointer
may name any build. It needs:

- ring-neutral version strings with one ordering across rings;
- no ring baked into archives or build provenance;
- install roots that are not keyed by channel.

Promotion is sequenced after #2962 and is not part of the six phases.

Manifests are signed per **trust boundary**, not per channel:

- The Nightly key signs only the `nightly` pointer, from an unattended,
  main-only environment.
- The release key signs `stable` and `preview` from an owner-reviewed
  environment.

Both public halves are already pinned in
[`config/release-manifest-keys.json`](../../config/release-manifest-keys.json).
A publish replaces its pointer last, after a not-regressing check, and stays
a dry run until its signing secret exists.

### D2. Two version axes, joined by two protocol ranges

- **Client train:** the desktop shell, the npm CLI package
  (`@kontourai/station-cli`), and the mobile apps share one version identity
  and one release cadence. Artifacts stay per surface: the npm tarball,
  notarized desktop bundles, and store packages. The train offers `stable`,
  `beta`, and `nightly` channels (owner decision). These are the client's own
  pointers, and a client's channel does not select the host's.
- **Host stream:** the server, the web UI it serves, and the `station`
  command inside the host archive. That command runs `station upgrade` and
  `station service install` for its own install, so it is versioned with the
  host.

Compatibility between the axes is the pair of protocol ranges. The fixed
service launcher belongs to neither train, and only the launcher-protocol
range governs it. Each contract gets one generated authority in
`@kontourai/station-contracts` that every launcher, installer, publisher,
shell, and host reads. Today's hand-kept copies become generated
(engineering addition).

Every boundary refuses an out-of-range peer with readable remediation:

| Boundary | Contract | Refuses today? | Rejection owner |
| --- | --- | --- | --- |
| Installer and archive update | launcher | Yes | `install.sh`, `archive-update.ts` |
| Desktop spawn of a host | launcher | **No** | Shell, before spawn (#2961) |
| Client meets host | API | Client and host HTTP admission (#2962) | Host checks paired-scope HTTP and pairing request/access-request/exchange; the public handshake stays reachable (see addendum) |

**Rollout window.** During a rollout, a host accepts clients from the
previous client train across both contracts (owner decision). Engineering
addition, which tightens the "decide separately" guidance in
`environment-security.ts`:

- A host raises `minClientProtocol` only after a client release speaking the
  new protocol has been generally available for one full client-train
  release. That covers store-review lag.
- A client raises its minimum server protocol only after every host pointer
  it may meet, including `stable`, serves the new protocol.

### D3. The installer is manifest-only

`install.sh` installs only prebuilt archives named by a signed manifest,
fetched anonymously over HTTPS. Anonymous is not unsigned: the pinned-key
signature and per-artifact SHA-256 checks are unchanged, and an unsigned or
mismatched archive is refused. The authenticated `gh` path and its
source-release branch are removed (#2960).

Manifest URLs derive from one `BASE_URL` constant shared by the installer and
the docs. It points at GitHub release assets now; a later `kontourai.io`
redirect is a repoint, not a rework. Installers already published stay frozen
at their tags.

### D4. The desktop shell carries installer capability, not host bytes

The shell stops bundling a host. On a first run with no host present, it
fetches the host from D1's `stable` pointer (the user may choose another
ring; engineering addition), verifies it, and spawns it through ADR 0015's
claim path.

**Verification (owner decision).** The shell runs the shared JavaScript
verifier, [`release-manifest.mjs`](../../packages/shared/src/release-manifest.mjs),
under a SHA-pinned Node that it bootstraps as `install.sh` does, or under the
Node inside an archive it has already verified. It never verifies with a Node
found on the user's PATH: `install.sh`'s preference for an existing Node checks
only its major version, which is not an integrity check. `install.sh`'s inline
copy, bound to the same golden
vectors, stays the only other implementation, and no third one is added. The
fetched archive carries its own Node, so the sidecar stops depending on a
system Node.

- The bundled-host pin becomes a launcher-protocol range check (D2). An
  out-of-range host refuses at spawn. The startup ticket proof stays.
- An offline first run refuses with a readable message and never falls back
  silently.
- The shell trusts only a host it claimed and spawned. Attach-to-existing
  stays removed for ADR 0015's reasons.
- The ownership logic collapses to one atomic claim path. `sidecar` and
  `service` differ only in supervisor (the app, or launchd, systemd, or Task
  Scheduler) and lifetime policy. #2961 implements this as `claimHostOwner`
  ([Instance Registry](../design/instance-registry.md)): the desktop launch,
  `station service install`, and the service supervisor all claim through it,
  and the desktop maps its result to an owner without a separate launch read.
  Installation reserves the home with the installer's live PID and writes
  policy before starting the OS backend; backend failure restores the prior
  registry entry. A supervisor without installed policy takes the same atomic
  claim itself, publishing a service owner with its PID and birth before start.
  A conflicting live owner keeps it alive and waiting, without running Station;
  polling backs off to at most 30 seconds and logs only reason changes. Lost
  ownership at readiness or on an existing five-second health tick stops and
  reaps Station before the same wait. The tick checks the service id, type,
  PID and birth without refreshing the claim; recovery also waits for a live
  replacement service at the same registry id. Only a successful registry read
  proving a missing or different owner triggers recovery. An unreadable tick
  read keeps Station running until the next tick; an unreadable startup claim
  still fails closed. Desktop records the spawned child's PID and birth before
  waiting for Listening, so
  an orphan still shutting down holds the reservation after desktop death.
  Runtime preparation's safety read does not choose the launch owner.
  This is cooperative fencing for service supervisors and Desktop sidecars,
  not an OS lock around every server. Direct `command-station.js` launches
  do not claim the registry, including a container that invokes that entry
  point directly; when bound to `0.0.0.0`, they are reachable through the
  container's exposed/published ports. The Dockerfile's existing
  `service run --instance=container` command self-claims a fresh home without
  requiring `service install` or a separate policy-registration lifecycle.

Mobile apps keep their bundled web UI and store-gated builds. Store rules
forbid downloading executable code, so the download model applies only to
direct-distributed desktop builds.

### D5. One opt-in service-install capability

The host archive's `station service install` is the single capability that
installs a durable service. The installer offers it as an explicit opt-in
prompt, never on by default. The tray and the desktop invoke the same
command, so the desktop runs the fetched host's own command rather than a
second installer.

### D6. Client updates are signed per trust boundary

Nightly and release desktop builds share one Tauri updater key today. Once
the desktop identities converge, a stable-channel user would otherwise trust
anything the nightly pipeline signs.

The client updater therefore follows D1's rule: a nightly updater key and a
release updater key, both pinned in the shell, each checked against the
channel it serves (owner decision). Generating the new key and uploading its
secret are owner actions. They must happen before #2962 converges the
desktop identities.

Rotation needs one bootstrap step (engineering addition). Installed apps
trust only today's shared key, so the update that installs the split keys is
signed with that key. The shared key is then retired from the nightly signing
environment. Until then, the nightly pipeline could still sign updates that
stable apps already in the field accept.

## Settled points from #2713

### Switching to a slower channel

**Never go backwards automatically** (owner decision). Moving to a faster
pointer is an ordinary upgrade. Moving to a slower pointer holds the current
version until the slower pointer reaches or passes it, which is Chrome's
rule. Under D1's ring-tagged versions, a slower pointer reaches the current
version only when its `X.Y.Z` core is strictly greater. A nightly's core is the
package version, which may still be the last release's, so equal cores can
hide newer code, and the switch holds while cores are equal. Promotion
replaces this rule with a
single ordering (engineering addition).

The schema downgrade refusal remains the rejection path and is never
bypassed. Users who need the slower channel now choose one of two explicit
actions:

- **Restore** the #2675 pre-update backup of that home, including
  `.station-home-schema.json`, when its version is at or below the target.
  This discards anything the home recorded after the backup, and the user is
  told so.
- **Start fresh** in a new home, keeping the old one intact.

### Existing per-channel installs

Existing channel installs keep working at their versions and are never
merged, because homes with different schemas cannot be merged safely.
Consolidating means the user picks the one home to keep (owner decision). The
rest are archived rather than deleted, and nothing moves without the user's
consent (engineering additions).

- The stable desktop identity (`io.kontourai.station`) becomes the one desktop
  app. The beta and nightly desktop identities get a final update that says
  so, then stop receiving updates.
- Named side-by-side instances, each with its own home and ports, remain an
  opt-in for developers.

### Ports and pairing

These are engineering additions:

- The default install uses one port block, today's stable block. Per-channel
  blocks survive only as defaults for named instances.
- Pairing endpoints are already keyed by URL. Deep-link schemes are app
  identities, though, and today `clientChannel` is the build's channel. After
  convergence, the one desktop app registers one scheme, and `clientChannel`
  becomes data describing the running client's update channel.
- Mapping mobile store tracks (TestFlight and Play testing versus production)
  onto client-train channels is a store decision for #2962 and stays with the
  owner.

### Which channel am I on

Today the host's answer is two agreeing records (see Context). The target is
one record per axis, each with one writer (engineering addition):

- **Host ring:** the install state `.station-release-state.json`. `install.sh`
  and the desktop's first-run fetch (D4) write it through one shared module,
  and #2961 owns that module. The archive's baked ring stays a consistency
  check until promotion removes it. The desktop learns the host ring from a
  build-provenance field reporting the install state's `releaseChannel`,
  which #2962 adds; today that route reports only the build's channel.
- **Client channel:** a shell setting (`stable`, `beta`, or `nightly`) that
  selects the client updater endpoint at runtime rather than at build time
  (#2962).

No other surface keeps a copy, apart from the baked ring until promotion. A
channel switch still moves between install
roots keyed by channel until promotion.

## Alternatives considered

- **Keep separate apps per channel** (#2713 option 1). Rejected by the owner:
  it keeps three products and the collisions #2688 had to guard against.
- **Hybrid by surface** (#2713 option 5). Rejected: it keeps a second
  identity model on one surface.
- **Promotion now** instead of ring-tagged pointers. Deferred by the owner: it
  would put ring-neutral versioning, provenance, and install-root changes in
  front of the first anonymous stable install.
- **A thin shell that requires a prior install.** Rejected because it loses
  ADR 0015's clean-home first run. A fat bundle forever was rejected because
  it keeps host changes on the desktop release cadence.
- **A native Rust verifier** bound to the golden vectors. Rejected by the
  owner in favor of the shared JavaScript verifier, which avoids a third
  implementation.

## NOT_VERIFIED

Decisions remain implementation targets until their phases land with
enforcing tests. The #2961 claim-path notes describe that bounded source
slice, not delivery of D4's first-run fetch or package changes. These packaged-build divergences from
[ADR 0015's evidence addendum](0015-restore-desktop-owned-command-station-sidecar.md#evidence-addendum-2026-09-29-2957)
bear on D4's claim path and startup, and the implementing phases carry them:

- the Windows first launch exceeded the 30 s readiness budget;
- a Windows sidecar outlived its dead desktop by about 100 s;
- stale `type: sidecar` entries remain after an abrupt death (since #2961
  the next host claim reaps an entry whose pid and birth prove it gone; a
  test covers this with a real `SIGKILL`, a packaged run does not);
- shared roots without saved metadata refuse the first launch.

## Addendum, 2026-10-03: host-side client API rejection (#2962)

The "Client meets host" row now has a host rejection path. Clients declare
`X-Station-Client-Protocol`, and the host refuses a protocol below
`minClientProtocol` with `426 client_protocol_unsupported`. It applies this
on paired-scope routes and at the pairing request, access-request, and
exchange routes; the handshake stays open. An absent header reads as
protocol 1. The contract and the
exempt routes are specified in the
[remote-access threat model](../security/remote-access-threat-model.md#client-api-protocol-admission-2962).
Cross-origin carriage is capability-gated; the remaining caller gaps must
close before any host raises its minimum above 1:

- cross-origin browser requests send the header only after the host advertises
  `compatibility.capabilities.clientProtocolHeader >= 1`; older or unobserved
  hosts receive an unlabelled request, interpreted as protocol 1;
- the native pairing exchange request, built in Rust, does not send it;
- terminal and voice WebSockets are not checked (separate listeners, and a
  browser socket cannot send a header; the threat model records the planned
  query-parameter carriage);
- direct `fetch` calls that bypass the SDK seam do not send it.

The minimum remains 1. The admission ratchet test names the native pairing
exchange, notification action, local UI identity request and CLI operate event
stream, and fails if the minimum rises while those callers remain listed.
Malformed declarations return `400 client_protocol_invalid`; unsupported and
malformed refusals emit denial audits without retaining raw header text.
Those refusals use a separate direct-socket-peer audit budget (default: 10 per
60 seconds), reusing the existing limiter and its 1,024-peer cap. Exhaustion
suppresses protocol audits while 400/426 responses continue; refusals neither
consult nor consume the authentication budget. The UI clears prior header
acceptance when a handshake starts. Only the latest-started handshake per
origin may restore it; its non-OK response, invalid JSON or transport error
leaves acceptance cleared, even if an older overlapping handshake succeeds.

## Consequences

- Host fixes stop requiring desktop releases, and desktop updates shrink to
  the shell.
- The desktop gains trust code (D4), which stays behind the owner gate:
  nothing in #2961 lands before this ADR.
- These remain owner actions:
  - uploading the release manifest signing secret;
  - creating each rolling pointer release and its first publish;
  - cutting the first tagged release (#1243);
  - generating and uploading the split updater keys (D6);
  - choosing store tracks.

## References

#2956 (epic), #2957–#2962 (phases), #2713, #2675, #1243, #606, and
[ADR 0015](0015-restore-desktop-owned-command-station-sidecar.md).
