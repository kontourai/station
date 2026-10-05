# Release channel ports

Station channels are separate local runtimes. Their homes, launchers, install
roots, and loopback ports are deliberately distinct so a stable session can
remain live while beta, nightly, or a development worktree runs beside it.
The table describes configured identities, not a receipt that every platform
has been installed together or published. Mobile clients use their package
identity and connect to a selected server; they do not host these local listeners.

| Runtime channel | UI | Server | Home | Launcher | Provenance |
| --- | ---: | ---: | --- | --- | --- |
| development worktree | 40141-40640 | 39141-39640 | `~/.station/instances/dev/<worktree-id>` | worktree command | the checked-out worktree |
| stable | 18000 | 18141 | `~/.station/instances/stable` | `station` | stable release tag and verified release metadata |
| beta | 28000 | 28141 | `~/.station/instances/beta` | `station-beta` | preview release tag and verified release metadata |
| nightly | 38000 | 38141 | `~/.station/instances/nightly` | `station-nightly` | signed nightly manifest (`vX.Y.Z-nightly.N` from `origin/main`) |

Development worktrees use the `40141-40640` UI and `39141-39640` server bands
and must not borrow a release-channel port. `station dev` deterministically
resolves an offset within those bands from the worktree contract. The release installer uses the public release protocol
names `stable` and `preview`, then maps verified provenance to runtime names:
stable becomes `stable`; preview becomes `beta`. A branch name is never a
release provenance source: worktrees are development only, nightlies follow
`origin/main`, beta uses the preview release protocol, and stable uses the
stable release protocol. Release tag/commit binding and signature verification
of release metadata/artifacts are distinct checks; a channel name does not
prove a cryptographically signed Git tag.

`STATION_ROOT` defaults to `~/.station` and owns shared client profiles at
`config/profiles.json`, `cache/`, and `installs/<channel>`. An explicit
`STATION_ROOT` remains independent of home selection. With no explicit root,
the shared runtime resolver can derive it from `STATION_HOME`: a channel home
under `instances/` identifies its containing root, while an external raw home
is self-rooted. Do not export an inferred self-root as an explicit root equal
to the home; runtime admission rejects that ambiguous ownership. See
[`runtime-path-resolver.ts`](../../packages/shared/src/runtime-path-resolver.ts).
The release installer separately defaults its root before deriving channel
home/install paths. Its
`STATION_INSTALL_SERVER_PORT` and `STATION_INSTALL_UI_PORT`
are explicit local overrides. They are useful for a disposable test instance,
but callers must set both values and keep a matching `STATION_HOME` and
`STATION_INSTALL_ROOT`; an override does not change the channel's provenance.
The install state records the ports Station was installed with, and a later
installer run or upgrade that names no port reuses them. `station upgrade`
passes the installer these two variables but not the runtime
`STATION_SERVER_PORT`/`STATION_UI_PORT`, which every Station CLI process
carries with its channel's defaults; change an installed port with the
installer's variables.
The owned launcher exports the exact channel, home, and install root on every
later command and upgrade. Do not use the retired `STATION_CHANNEL=preview`:
run `STATION_CHANNEL=beta` instead.

`config/channel-ports.json` is the single source for these values: its
`channels` hold each runtime's ports and home, and its `releaseRings` map
each installable ring to the runtime it installs as (`preview` installs as
`beta`), whether it is a prerelease, and its launcher. `install.sh` must stay
one standalone file, so `scripts/install-script-generated.mjs` projects that
table, the pinned signing keys from `config/release-manifest-keys.json`,
portable targets from `packages/shared/src/portable-server-targets.mjs`, and
Node.js pins from `config/portable-server-node-runtime.json` into generated
blocks. It does the same for the Windows `install.ps1`: the channel list,
the pinned win32-x64 Node.js zip, and the installer core bundled from
`packages/shared/src/installer/` (which carries the signing keys and the
shared manifest verifier). `npm run install-script:check` fails when either
installer is stale, and `node scripts/install-script-generated.mjs --sync`
rewrites them.

`STATION_CHANNEL=nightly` installs only from a signed public manifest
(`STATION_INSTALL_PUBLIC_MANIFEST_URL`) whose envelope names the pinned
nightly key; the authenticated GitHub-release path serves stable and beta
only. This is the installer contract; publication is tracked separately in #2675. Stable and
beta also accept a signed public manifest through the same variable. The
release workflows can publish one per ring (`portable-stable`,
`portable-preview`) once the owner enables them; see
[signed host-stream manifests](release-rings.md#signed-host-stream-manifests).
The default path for stable and beta is still the authenticated one. Nightly has no
public/runtime name split: the ring, the runtime, and the provenance channel
are all `nightly`, and its version is `X.Y.Z-nightly.<code>` with `<code>`
reserved by `nightly-version-code`. `STATION_VERSION` accepts an exact
`vX.Y.Z-nightly.N` so a rollback can name its target; builds order
numerically on `N`.

A portable nightly install and the Station Nightly desktop app are the same
channel runtime: both default to `~/.station/instances/nightly` and ports
`38141`/`38000`, so only one can run on a host at a time. The installer
therefore refuses to adopt a default nightly home that holds data it does not
own (set `STATION_HOME` to share that home deliberately, or to another
instance directory to keep separate data), and refuses to start a fresh
nightly install over a port that is already in use. Stable and beta desktop
apps share their channels' defaults in the same way; the installer does not
yet guard those channels.

## Prebuilt archives and source releases

A signed public manifest (schema 2) names prebuilt server archives by
platform (`station-server-<os>-<arch>`). The shell installer supports macOS
and Linux on x64 or arm64 and requires a matching tar.gz artifact and a
compatible launcher-protocol range; the manifest's Windows zip is not a
shell-installer target. The Windows zip is `install.ps1`'s; see
[Windows archive installs](#windows-archive-installs). `install.sh` verifies the manifest
against the pinned keys, picks this host's archive, checks its size and
sha256, its `.station-prebuilt-archive` marker and its `.station-release.json`
provenance, and extracts it to
`$STATION_ROOT/installs/<channel>/versions/<version>/`. It then runs the
version's own `bin/station --version`, which must report the signed version
on the manifest's Node.js, writes the `.station-install-complete` sentinel,
and makes the directory read-only. `current` points at the active version,
and the launcher (`station-owned-launcher-v2`) runs `current/bin/station`.
Nothing is built, and the archive's bundled Node.js runs Station. Pruning
happens only after the installer itself starts Station: it keeps the active
version and the one it replaced, and removes the rest. With
`STATION_INSTALL_NO_START=1` nothing is pruned.

Verifying the manifest still needs a Node.js at install time. `install.sh`
uses a Node.js 20 or newer from `PATH`. If there is none, it uses the Node.js
inside the channel's installed archive, so `station upgrade` and uninstall
need no host Node.js. Otherwise, for uninstall and on the public-manifest
path, it downloads the official Node.js distribution pinned by sha256 in
`config/portable-server-node-runtime.json` (a generated block in
`install.sh`), and uses it only to verify and extract.

The install state (`.station-release-state.json`) is schema 4 and records
the manifest URL when the install came from a public manifest. The
authenticated GitHub-release path records no URL and keeps writing schema 3,
which released installers and CLIs read. A packaged `station upgrade` re-runs the installed version's
`install.sh` with that URL, so it needs no environment variable. An explicit
`STATION_INSTALL_PUBLIC_MANIFEST_URL` still wins.

A service installed from an archive's active version (`station service
install` run through the launcher) runs `<install root>/current`, and its
service manifest records `kind: "archive"` and that install root. On Linux and
macOS the unit runs through the fixed service launcher that `service install`
copies to `<install root>/runtime/station-launcher.mjs`. Such a service does
not block `station upgrade`. For a running launcher service, the installer
only stages the new version, asks the service to switch, and reports the
outcome; the launcher trials the new version and keeps the previous one if the
trial fails. Otherwise the installer stops the service, switches `current`,
and starts it again, restoring the previous version if the service does not
come back as the new release. A registered unit that is not running is left
stopped, and no separate Station is started beside it. The unit keeps its
installed ports; an explicitly named different port refuses the upgrade. An
unfinished or operator-blocked launcher update refuses the upgrade until the
service has finished or restored it.
Installing a service from an inactive `versions/<version>` directory is
refused. Any other installed service, including one on a source release, still
blocks `station upgrade`. See the [CLI reference](../reference/cli.md) for
the service details.

Source releases are still supported and are built on the host. They come from
the authenticated GitHub-release path, which is how stable and beta install
today, and from a schema 1 public manifest (`station-portable.tar.gz`), which
stable and preview can publish until those rings ship archives. A source
release lives in `installs/<channel>/releases/<sha256>/`, needs Node.js 24
and npm on the host, and uses the v1 launcher. An install can move from a
source release to an archive: the installer recognises either launcher as its
own and keeps the source release as the rollback target. Uninstall removes
both layouts.

The installer checks a schema 1 manifest with the signer's rules, so its
source SHA and sha256 must be lowercase hex, as the signer writes them. (It
accepted uppercase before.) Downloads are capped with curl's
`--max-filesize`: the manifest at 1 MiB, an archive at its signed size. curl
8.4.0 and newer stop any transfer at the cap; older curl (Ubuntu 22.04,
Debian 12) enforces it only on a declared Content-Length, so a chunked
response can exceed it there. The size and sha256 checks refuse it after the
download either way.

Moving between layouts at the same version needs no rollback flag. A replayed
old signed manifest can therefore swap a source vX for a previously published
archive vX (or back); both are legitimately signed vX, so this is accepted.

Known limits until later #2675 slices:

- An `install.sh` from before prebuilt archives (for example the copy inside
  an old source release) cannot remove a read-only version directory left in
  the install root. Uninstall with a current `install.sh`.
- Uninstall refuses while a service runs the archive install; remove the
  service first. A source release cannot replace an archive a service runs.


### Windows archive installs

`install.ps1` installs the `station-server-win32-x64.zip` archive from a
signed public manifest only (`STATION_INSTALL_PUBLIC_MANIFEST_URL`; there is
no authenticated GitHub-release path on Windows). It runs on Windows
PowerShell 5.1 and PowerShell 7, either as
`powershell -NoProfile -ExecutionPolicy Bypass -File install.ps1` or through
`irm <url> | iex` (configuration comes only from the environment, so the
`iex` form cannot uninstall). It verifies with a host Node.js 20 or newer,
the installed version's `runtime\node.exe`, or the pinned official Node.js
zip, checked by sha256. It then does what `install.sh` does for an archive,
with the same variables, files and messages:

- the version is verified and sealed under
  `%USERPROFILE%\.station\installs\<channel>\versions\<version>`;
- `current` is a directory junction to it, switched by removing `current`
  and renaming `current.next` into its place; a later run finishes a switch a
  crash interrupted;
- the owned launcher is `station.cmd`, `station-beta.cmd` or
  `station-nightly.cmd` in `%USERPROFILE%\.local\bin` (or
  `STATION_BIN_DIR`), recognized by its exact text
  (`rem station-owned-launcher-v2`); the installer prints a PATH hint and
  never edits PATH. cmd.exe reads a batch file in the console code page, so
  paths beneath the profile are written through `%USERPROFILE%` (a profile
  such as `C:\Users\José` works) and any other non-ASCII path is refused.
  The launcher hands over to the version without CALL, so arguments with
  `^` or `%` arrive unchanged;
- schema 4 state records the manifest URL and the ports;
- ports come from `STATION_INSTALL_SERVER_PORT`/`STATION_INSTALL_UI_PORT`,
  then the recorded ports, then the channel's. Unlike `install.sh`, it never
  reads `STATION_SERVER_PORT`/`STATION_UI_PORT`;
- the downgrade and same-version-new-bytes refusals, with the
  `STATION_VERSION` plus `STATION_INSTALL_ALLOW_ROLLBACK=1` opt-in, and the
  nightly coexistence refusals above;
- stop, switch, start, restoring the previous version (or removing a first
  install) when a step fails; the restored version starts on the ports its
  restored state records (install.sh restarts it on the new ones); `STATION_INSTALL_NO_START=1` skips the start.
  It keeps the active and the previous version and removes the others; a
  version a process still holds is left for the next install, with a warning.

Uninstall with the installed copy, which stops Station and keeps its data
unless `-PurgeData` is given:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File "$env:USERPROFILE\.station\installs\stable\current\install.ps1" uninstall
```

Permissions: every root must be an absolute path, and the install root must
lie beneath the user profile. Install and uninstall check an existing
install root before reading or running anything in it, and run a
`node.exe` only from a `current` that names a directory of its
`versions`. The installer gives a new install root a
protected ACL that grants only the current user, and refuses an existing
one whose ACL grants anyone else, since a version in it could have been
planted. `install.ps1` runs the installed `node.exe` only from such a root.
Such a root (for example one a stage-only run created before the installer
restricted roots) is removed by uninstalling it with a freshly downloaded
`install.ps1`: uninstall runs nothing from an unrestricted root, not even its
`station stop`, so it refuses while a Station still answers on the ports the
install recorded (stop it first), and otherwise removes the program files
and keeps the data.
The launcher directory must not be writable by accounts other than the
user, SYSTEM and Administrators.

A Station the installer starts keeps Windows PowerShell's own output handle
(.NET passes every inheritable handle to the processes it starts). A caller
that reads `install.ps1`'s output through a pipe therefore sees its end only
when that Station stops; PowerShell itself returns as soon as the install
does. A console, `irm | iex` and `station upgrade` are unaffected, and
`STATION_INSTALL_NO_START=1` avoids it.

A Station service of the install (#2675 slice W3) is a Task Scheduler task
that runs the fixed service launcher, which owns the switch. When it is
running, `install.ps1` stages the new version and queues it as an update
request (`runtime\update-request.json`); the launcher trials it and keeps or
rolls it back, and `install.ps1` reports that verdict (exit 0 when it
committed, 1 otherwise). When it is registered but stopped, `install.ps1`
stops it through its manager, switches `current`, records the version for its
launcher, starts nothing, and leaves it stopped. An update the launcher left
unfinished, or one it could not roll back, is refused until the service
finishes it. A service installed before the launcher ran Windows services is
refused with a migration in order: `service uninstall` with the installed
version, `install.ps1` again with `STATION_INSTALL_NO_START=1`, then `service
install` with the new version (the old version's CLI cannot install a launcher
service, so reinstalling it first would refuse again); and
`install.ps1 uninstall` still refuses while any service runs the install.
`station upgrade` from a Windows archive install re-runs the active
version's `install.ps1` through the system Windows PowerShell; the same rules
apply.

## Platform identity matrix

`config/channel-platform-matrix.json` is the explicit cross-platform contract
for app names, bundle/package identifiers, homes, ports, and icon sources.
macOS, Windows, Linux, and Android have distinct Stable, Beta, and Nightly
identities. Desktop development adds a worktree-derived identifier and home;
Android development uses the separate `io.kontourai.station.debug` package.
The Android release workflows reapply the selected channel icon to both the
`main` and `debug` source sets after `tauri android init`, preventing Gradle
source-set precedence from showing a Dev icon in Beta or Nightly.

iOS Stable, Beta and Nightly now have source-configured bundle identifiers,
pairing schemes and separate icon catalogs. The actual delivery owner is
[`ios-testflight-channel.mjs`](../../scripts/ios-testflight-channel.mjs) and
the reusable [TestFlight workflow](../../.github/workflows/testflight-delivery.yml).
The release workflow selects Stable or Beta; Nightly staging selects Nightly.
These are implemented routes, not merely reserved identifiers. Their protected
profiles, App Store Connect records, tester groups and successful provider
receipts remain separate operational prerequisites; the matrix's
`provider-NOT_VERIFIED` label does not prove they are absent or delivered today.

Development has a narrower, explicit simulator path:
[`tauri.ios.dev.conf.json`](../../src-desktop/tauri.ios.dev.conf.json) uses
`io.kontourai.station.dev.instance` and `station-dev-instance`.
`npm run build:ios:simulator` owns its simulator build and entitlement checks;
see [native shell verification](native-shell-verification.md#build-a-development-ios-simulator-app).
The matrix's older `development.iosStatus` still says no isolated contract;
that description does not account for this simulator overlay. It is not a
general per-worktree iOS device-signing or TestFlight contract, and multiple
Dev simulator builds share that fixed identifier.

Port defaults and generated copies are owned by
[`channel-ports.json`](../../config/channel-ports.json) and checked by
`npm run channel-ports:check`. Worktree allocation lives in
[`dev-ports.ts`](../../packages/cli/src/commands/dev-ports.ts): the deterministic
offset is a starting point, and occupied ports can cause a forward scan.
Configuration parity does not prove listener availability or coexistence.
