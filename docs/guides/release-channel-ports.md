# Release channel ports

Station channels are separate local runtimes. Their homes, launchers, install
roots, and loopback ports are deliberately distinct so a stable session can
remain live while beta, nightly, or a development worktree runs beside it.

| Runtime channel | UI | Server | Home | Launcher | Provenance |
| --- | ---: | ---: | --- | --- | --- |
| development worktree | 40141-40640 | 39141-39640 | `~/.station/instances/dev/<worktree-id>` | worktree command | the checked-out worktree |
| stable | 18000 | 18141 | `~/.station/instances/stable` | `station` | signed stable tag |
| beta | 28000 | 28141 | `~/.station/instances/beta` | `station-beta` | signed preview tag |
| nightly | 38000 | 38141 | `~/.station/instances/nightly` | nightly launcher | `origin/main` |

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
