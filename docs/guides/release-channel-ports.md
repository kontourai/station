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
| nightly | 38000 | 38141 | `~/.station/instances/nightly` | nightly launcher | `origin/main` |

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
