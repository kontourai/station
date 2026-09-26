# Release channel ports

Station channels are separate local runtimes. Their homes, launchers, install
roots, and loopback ports are deliberately distinct so a stable session can
remain live while beta, nightly, or a development worktree runs beside it.

| Runtime channel | UI | Server | Home | Launcher | Provenance |
| --- | ---: | ---: | --- | --- | --- |
| development worktree | 40141-40640 | 39141-39640 | `~/.station/instances/dev/<worktree-id>` | worktree command | the checked-out worktree |
| stable | 18000 | 18141 | `~/.station/instances/stable` | `station` | signed stable tag |
| beta | 28000 | 28141 | `~/.station/instances/beta` | `station-beta` | signed preview tag |
| nightly | 38000 | 38141 | `~/.station/instances/nightly` | `station-nightly` | signed nightly manifest (`vX.Y.Z-nightly.N` from `origin/main`) |

Development worktrees use the `40141-40640` UI and `39141-39640` server bands
and must not borrow a release-channel port. `station dev` deterministically
resolves an offset within those bands from the worktree contract. The release installer uses the public release protocol
names `stable` and `preview`, then maps verified provenance to runtime names:
stable becomes `stable`; preview becomes `beta`. A branch name is never a
release provenance source: worktrees are development only, nightlies follow
`origin/main`, beta requires a signed preview tag, and stable requires a signed
stable tag.

`STATION_ROOT` defaults to `~/.station` and owns shared client profiles at
`config/profiles.json`, `cache/`, and `installs/<channel>`; it is not changed
by `STATION_HOME`, `--home`, or `--base`. The installer's
`STATION_INSTALL_SERVER_PORT` and `STATION_INSTALL_UI_PORT`
are explicit local overrides. They are useful for a disposable test instance,
but callers must set both values and keep a matching `STATION_HOME` and
`STATION_INSTALL_ROOT`; an override does not change the channel's provenance.
The owned launcher exports the exact channel, home, and install root on every
later command and upgrade. Do not use the retired `STATION_CHANNEL=preview`:
run `STATION_CHANNEL=beta` instead.

`config/channel-ports.json` is the single source for these values: its
`channels` hold each runtime's ports and home, and its `releaseRings` map
each installable ring to the runtime it installs as (`preview` installs as
`beta`), whether it is a prerelease, and its launcher. `install.sh` must stay
one standalone file, so `scripts/install-script-generated.mjs` projects that
table (and the pinned signing keys from `config/release-manifest-keys.json`)
into generated blocks; `npm run install-script:check` fails when they are
stale, and `node scripts/install-script-generated.mjs --sync` rewrites them.

`STATION_CHANNEL=nightly` installs only from a signed public manifest
(`STATION_INSTALL_PUBLIC_MANIFEST_URL`) whose envelope names the pinned
nightly key; the authenticated GitHub-release path serves stable and beta
only. Nightly has no public/runtime name split: the ring, the runtime, and the
provenance channel are all `nightly`, and its version is the caller-supplied
`X.Y.Z-nightly.<code>` reserved by `nightly-version-code`. `STATION_VERSION`
accepts an exact `vX.Y.Z-nightly.N` so a rollback can name its target; builds
order numerically on `N`.

A portable nightly install and the Station Nightly desktop app are the same
channel runtime: both default to `~/.station/instances/nightly` and ports
`38141`/`38000`, so only one can run on a host at a time. The installer
therefore refuses to adopt a default nightly home that holds data it does not
own (set `STATION_HOME` to share that home deliberately, or to another
instance directory to keep separate data), and refuses to start a fresh
nightly install over a port that is already in use. Stable and beta desktop
apps share their channels' defaults in the same way; the installer does not
yet guard those channels.

## Platform identity matrix

`config/channel-platform-matrix.json` is the explicit cross-platform contract
for app names, bundle/package identifiers, homes, ports, and icon sources.
macOS, Windows, Linux, and Android have distinct Stable, Beta, and Nightly
identities. Desktop development adds a worktree-derived identifier and home;
Android development uses the separate `io.kontourai.station.debug` package.
The Android release workflows reapply the selected channel icon to both the
`main` and `debug` source sets after `tauri android init`, preventing Gradle
source-set precedence from showing a Dev icon in Beta or Nightly.

iOS is intentionally not described as aligned yet. Stable remains
`io.kontourai.station` and retains the existing signing path. Beta and Nightly
reserve `io.kontourai.station.beta` and `io.kontourai.station.nightly` in the
matrix, but release jobs remain gated until those App IDs have their own
provisioning profiles, signing secrets, icons, and App Store Connect/TestFlight
listings. Development similarly needs an isolated iOS bundle/signing contract
before it can coexist with installed Stable.
