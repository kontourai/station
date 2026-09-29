# ADR 0020 — Distribution: two trains, channels as pointers, installer-first

**Status:** Accepted, 2026-09-29. It records the direction the owner set on
2026-09-29 for epic [#2956](https://github.com/kontourai/station/issues/2956)
(D1–D5) and the owner's answers the same day to the open design points of
[#2713](https://github.com/kontourai/station/issues/2713): the slower-channel
rule, the verifier, desktop identities, and client channels. It **extends**
[ADR 0015](0015-restore-desktop-owned-command-station-sidecar.md) and
supersedes none of it: the sidecar lifetime split, the single-claim registry
rule, and the removal of attach-to-existing all stand. No behavior changes
with this ADR. Later phases (#2959–#2962) implement it, and each one changes
docs, enforcing tests, and behavior together. Where a rule is an engineering
addition rather than an owner decision, the text says so.

## Context

Station reaches users through three install paths with different trust
stories. The default `install.sh` path needs an authenticated `gh` and
builds from source. A signed public manifest path exists but only for
Nightly, behind `STATION_INSTALL_PUBLIC_MANIFEST_URL`. The third path is a
source checkout. No tagged release has completed
([#1243](https://github.com/kontourai/station/issues/1243)), so the
documented one-liner has never installed a stable artifact.

Channels are separate products by convention. Stable, beta, and nightly each
have their own desktop identity (`io.kontourai.station[.beta|.nightly]`), port
block (18141/28141/38141), home (`instances/<channel>`), launcher, and
updater endpoint baked in at build time. The desktop bundle pins a host
runtime byte-for-byte, so every host change ships as a desktop update.

Two compatibility contracts already exist:

- **Launcher protocol:** how a launcher starts and supervises a host runtime.
  Signed v2 release manifests carry `launcherProtocol {min, max}`.
  `install.sh` and the in-app archive update refuse an out-of-range release.
  The desktop spawn path does not check it. The value is declared separately
  in `install.sh`, `packages/shared/src/service-launcher-protocol.ts`, the
  portable `station-launcher.mjs`, and the Nightly publisher.
- **Client API protocol:** how clients talk to a host.
  `packages/contracts/src/environment-security.ts` defines
  `STATION_COMPAT_PROTOCOL_VERSION` and `STATION_COMPAT_MIN_CLIENT_PROTOCOL`.
  The web and desktop client refuses a host that says it is too old or too new
  (`src-ui/src/lib/compatibility.ts`). The host publishes its range but does
  not itself refuse an old client.

A home's `.station-home-schema.json` only moves forward. A build refuses a
home whose schema is newer than its own (`STATION_HOME_SCHEMA_DOWNGRADE_REFUSED`),
and the #2675 update backup snapshots that file with the stores.

## Decision

### D1. Channels are pointers over one host stream

The host (server plus the web UI it serves) is built once per version. A
channel is a **rolling signed manifest** that points at one of those
versions. Channels are not separate builds, apps, or install products. The
existing rings keep their names: `stable`, `preview` (runtime channel
`beta`), and `nightly`.

Manifests are signed per **trust boundary**, not per channel. The Nightly key
signs only the `nightly` pointer from an unattended, main-only environment.
The release key signs `stable` and `preview` from an owner-reviewed
environment. Both public halves are already pinned in
`config/release-manifest-keys.json`. A publish replaces its rolling pointer
last, after the `not-regressing` check, and stays a dry run until its signing
secret exists.

### D2. Two version axes, joined by two protocol ranges

- **Client train:** the desktop shell, the CLI (`@kontourai/station-cli`), and
  the mobile apps share one version identity and one release cadence.
  Artifacts stay per surface: npm tarball, notarized desktop bundles, and
  store packages.
- **Host stream:** the server and web UI, versioned separately and delivered
  through D1's pointers.

The client train offers `stable`, `beta`, and `nightly` channels, mirroring
the host's `stable`, `preview` (runtime `beta`), and `nightly` rings (owner
decision). The client's channels are its own pointers, and a client's channel
does not select the host's.

Compatibility between the axes is the pair of protocol ranges above. Each
has exactly one authority: a single generated constant set in
`@kontourai/station-contracts`, which every launcher, installer, publisher,
shell, and host reads (engineering addition; today's copies become
generated). Every boundary refuses an out-of-range peer with a readable
remediation:

| Boundary | Contract | Refuses today? | Rejection owner |
| --- | --- | --- | --- |
| Installer and archive update | launcher | Yes | `install.sh`, `archive-update.ts` |
| Desktop spawn of a host | launcher | **No** | Shell, before spawn (#2961) |
| Client to host | API | Client side only | Host, at pairing and handshake (#2962) |

**Rollout window:** during a rollout, a host accepts clients from train N−1
across both contracts. An engineering addition makes that concrete: a host
raises a minimum only after the previous train has been generally available
for one full release, which covers store-review lag.

### D3. The installer is manifest-only

`install.sh` installs only prebuilt archives named by a signed manifest,
fetched anonymously over HTTPS. Anonymous is not unsigned: the pinned-key
signature and per-artifact SHA-256 checks are unchanged, and an unsigned or
mismatched archive is refused. The authenticated `gh` path and its
source-release branch are removed (#2960). Manifest URLs derive from one
`BASE_URL` constant shared by the installer and docs. It points at GitHub
release assets now; a `kontourai.io` redirect later is a repoint, not a
rework. Installers already published stay frozen at their tags.

### D4. The desktop shell carries installer capability, not host bytes

The shell stops bundling a pinned host. On a first run with no host present,
it fetches the host from D1's manifest stream, verifies it, and spawns it
through ADR 0015's claim path unchanged. It verifies with the **same
verifier implementation** `install.sh` uses. The shell runs that JavaScript
verifier under a SHA-pinned bootstrapped Node, as `install.sh` does, and
never a second implementation. The fetched archive carries its own Node, so
the sidecar stops depending on a system Node.

- The exact-byte sidecar identity ticket becomes a launcher-protocol range
  check (D2). An out-of-range host refuses at spawn.
- An offline first run refuses with a readable message and never falls back
  silently.
- The sidecar concept stays: the shell trusts only a host it claimed and
  spawned. Attach-to-existing stays removed for ADR 0015's reasons.
- The ownership logic collapses: one atomic claim path. `sidecar` and
  `service` differ only in supervisor (the app versus launchd, systemd, or
  Task Scheduler) and lifetime policy.

Mobile keeps its host bytes and store-gated builds, because store rules
forbid downloading executable code. The download model applies only to
direct-distributed desktop builds.

### D5. One opt-in service-install capability

The host archive's `station service install` is the single capability that
installs a durable service. The installer offers it as an explicit opt-in
prompt, never on by default, and the tray and desktop invoke the same
command. This resolves ADR 0015's UNRESOLVED packaged-desktop installer: the
desktop runs the fetched host's own command rather than a second installer.

## Settled points from #2713

### Switching to a slower channel

**Never go backwards in place.** Moving to a faster pointer is an ordinary
upgrade. Moving to a slower pointer holds the current version until the
slower pointer reaches or passes it, which is Chrome's rule. The schema
downgrade refusal remains the rejection path and is never bypassed.

For users who need the slower channel now, there are two explicit escape
hatches:

- **restore** the #2675 pre-update backup of that home, including
  `.station-home-schema.json`, when its version is at or below the target; or
- **start fresh** in a new home, keeping the old home intact.

Neither deletes data without confirmation.

### Existing per-channel installs

Migration is forward-only and consent-based. Existing channel installs keep
working at their versions and are never merged, because homes with different
schemas cannot be merged safely. Consolidating means the user picks the one
home to keep, and the rest are archived, not deleted. The stable desktop
identity (`io.kontourai.station`) becomes the one desktop app. The beta and
nightly desktop identities get a final update that says so and then stop
receiving updates. Named side-by-side instances, with their own home and
ports, remain an opt-in for developers.

### Ports and mobile pairing

The default install uses one port block (today's stable block). Per-channel
blocks survive only as defaults for opt-in named instances. Pairing is
already keyed by endpoint URL, and pairing links already treat
`clientChannel` as the client build a link opens, not the backend, so
pairing needs no new identity. Mapping mobile store tracks (TestFlight and
Play testing versus production) onto client-train channels is a store
decision for #2962 and stays with the owner.

### Which channel am I on

There is one record per axis, and each has one writer:

- **Host channel:** the install state `.station-release-state.json`
  (`releaseChannel` and `manifestUrl`). `station upgrade`, the supervised
  launcher, and the archive-update route already resolve the channel from
  this record; the only other input is an explicit
  `STATION_INSTALL_PUBLIC_MANIFEST_URL` override. A
  channel switch rewrites it through one command, subject to the rule above.
- **Client channel:** a shell setting (`stable`, `beta`, or `nightly`) that
  selects the client updater endpoint at runtime instead of at build time
  (#2962).

No surface keeps a copy. The desktop learns the host channel from the host's
build-provenance route, and the host never reads the client's channel.

## Consequences

- Host fixes stop requiring desktop releases, and desktop updates shrink to
  the shell.
- The desktop gains trust code (D4). It stays behind the owner gate: nothing
  in #2961 lands before this ADR, and its verification reuses #2957's
  packaged-build method.
- The first stable manifest needs the release signing secret. That upload,
  every rolling pointer's first publish, and store-track choices stay owner
  actions.
- #2957 found divergences the implementing phases must carry: the Windows
  first launch exceeded the 30 s readiness budget, and shared roots without
  saved metadata refuse the first launch. See the
  [ADR 0015 evidence addendum](0015-restore-desktop-owned-command-station-sidecar.md#evidence-addendum-2026-09-29-2957)
  once it lands.

## References

#2956 (epic), #2957–#2962 (phases), #2713, #2675, #1243, #606, and
[ADR 0015](0015-restore-desktop-owned-command-station-sidecar.md).
