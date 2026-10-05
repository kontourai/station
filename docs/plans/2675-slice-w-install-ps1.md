# #2675 slice W: `install.ps1` for the prebuilt Windows archive (design)

Status: W1 and W2 implemented (see section 6); W3 is designed here, not
built. W2 kept the profile-only rule for install roots and added ACLs on top
of it (section 8). Base: `origin/main` 8608541b9. Slices A, B1, B2, C, D and E have
merged. #2954 (installers must not treat bootstrap ports as explicit) is still
open.

Owner decisions (2026-09-29) are recorded in section 7. Please keep pushing
back: several premises here contradict the epic's own framing of W as "a
thin installer" (see section 1).

## 1. Where the code disagrees with the epic's scope for W

The epic says W is "`install.ps1` over the same manifest, plus the Windows
service in the supervisor's update path. No second trust system." The code on
main makes W larger than that. In the list below, EXECUTED means I ran it and
REASONED means I read it from the code or the platform documentation.

1. **Node.js is still required at install time on Windows (REASONED).** Windows
   PowerShell 5.1 runs on .NET Framework, which has no Ed25519. PowerShell 7
   runs on .NET, and .NET exposes no Ed25519 public API either. So
   `install.ps1` cannot verify the pinned-key manifest by itself. Like
   install.sh, it must bootstrap a Node.js in this order:
   1. host `node` 20 or newer;
   2. `<installRoot>\current\runtime\node.exe`, copied to temp first;
   3. the pinned `node-v24.21.0-win-x64.zip`, checked by sha256.

   The pin in step 3 is already in `config/portable-server-node-runtime.json`.
   `nodeRuntimePinsBlock()` skips it today, and its comment says "Windows
   installs through install.ps1".
2. **The fixed launcher (D) is POSIX-only in practice.** In
   `service-command.ts`, `runsLauncher()` returns false on win32 ("Windows keeps
   running the version itself until slice W"). Enabling it needs real porting,
   not wiring:
   - **`current` swap.** `pointCurrentAt()` does `symlinkSync(target, pending)`
     and then `renameSync(pending, current)`. On Windows a directory symlink
     needs a privilege that standard users lack. `rename` over an existing
     directory or junction fails, because MoveFileEx cannot replace a
     directory (REASONED).
   - **Stop grace.** The launcher stops the child with `child.kill('SIGTERM')`.
     On Windows that is TerminateProcess: `service run`'s 60 s shutdown never
     runs, so the "≥ 65 s grace" is zero. Only the fallback `station stop` by
     record stops the detached server and UI (REASONED).
   - **Restart after a failed restore.** After a failed restore, the launcher
     relies on "its service manager starts it again". The Windows task is
     `schtasks /SC ONLOGON` with no `RestartCount`/`RestartInterval`. Nothing
     under `packages/cli/src` sets them (EXECUTED: grep), so Task Scheduler
     never restarts it.
   - **Stopping the service.** `schtasks /End` ends only the cmd wrapper
     (`service-command.ts` comment). Once the wrapper runs the launcher
     (`node.exe station-launcher.mjs`), `service stop` must also stop the
     launcher process, not only Station's children.
3. **The Windows trust check forbids reparse points in execution paths
   (REASONED, from `packages/shared/src/windows-path-trust.ts`).**
   `Assert-NoReparse` walks every segment and throws on any reparse point.
   `service install` and the Task Scheduler boundary both verify
   `<installRoot>\current\runtime\node.exe`
   (`resolveServiceCodeLocation` → `manifestCommandTargets`). So a `current`
   **junction** would fail the service trust check as the code stands. This is
   a genuine design conflict, not an edge case.
4. **Upgrade and staging hard-code `sh`.**
   - `delegatePackagedUpgradeIfPresent` runs `sh ./install.sh install`
     (`lifecycle.ts` ~5121).
   - `stageServiceUpdate` spawns `sh <version>/install.sh`
     (`service-launcher-link.ts:126`).
   - The archive ships only `install.sh` (`portable-server-archive.mjs:465`).

   A Windows install would find no installer to re-run.
5. **The only published Windows artifact is nightly.** It is signed and live
   (EXECUTED: fetched the `portable-nightly` manifest; it lists
   `station-server-win32-x64.zip`, 215 MB, for `0.1.11-nightly.246302`).
   Stable and preview publish no archives, and the unauthenticated default
   flip hasn't happened. So `install.ps1` is public-manifest only. The
   `gh attestation` source-release path builds on the host and doesn't apply
   to Windows.
6. **CI gating.** `install-smoke.yml` (`pull_request_target`, path-filtered)
   is not a required check. The required Windows check, `Windows PR portable
   floor`, runs a small fixed vitest set (`test:windows:portable`). A Windows
   install regression would merge unless someone watches the smoke.

## 2. Parity matrix: install.sh → install.ps1

| install.sh feature | install.ps1 behavior |
| --- | --- |
| Pinned keys, channel constants, targets, Node pins as generated blocks | **Built in W1.** The same generator (`install-script-generated.mjs`) renders three `# BEGIN GENERATED …` blocks into install.ps1: the installable channels, the win32-x64 Node.js zip pin, and the installer core (an esbuild bundle, base64). The keys, rings and targets reach install.ps1 through the bundle, which imports their sources, so no fourth copy exists. `--check` covers both installers. |
| Signed v2 manifest verification (exit codes 2–8, messages) | **Built in W1.** `manifest.ts` composes the shared verifier's own functions in `verifyReleaseManifest`'s order, adding install.sh's test-only URL and key policy and its exit codes and summaries. Schema v1 (source releases) is refused: not a Windows target. The golden vectors run through the bundle install.ps1 embeds. |
| HTTPS-only URLs; test-only key override behind `…ALLOW_INSECURE_TEST_URLS=1` | Same variables and the same refusal. `Invoke-WebRequest -UseBasicParsing`, TLS 1.2 forced on 5.1. |
| Manifest capped at 1 MiB; archive capped at the signed size, then an exact size check and sha256 | **Built in W1.** `download.ts` refuses a declared Content-Length over the cap before reading, and aborts a streamed body at the first byte past it. Then an exact size check and the sha256. Each has a rejection path. |
| tar entry-type and path safety checks | **Built in W1.** The core reads the zip's central directory itself (`packages/shared/src/installer/zip.ts`) and refuses the whole archive before writing anything when any entry is outside `station/`, has an empty, `.` or `..` segment, a backslash, colon or other character Windows forbids, a control character, a trailing dot or space, or a device name; when two entries collide case-insensitively, or a file is used as a directory; or when an entry is a symlink, FIFO or reparse point, encrypted, or compressed other than stored or deflated. Then the same code extracts it, checking each entry's inflated size and CRC-32. It uses no archive tool: `tar.exe` and `Expand-Archive` would each be a second parser of untrusted bytes, and `Expand-Archive` also propagates Mark-of-the-Web, which would block `-File` of the installed `install.ps1` under RemoteSigned. |
| Marker and provenance read from the verified archive before extraction; re-compared after | Same: read `station/.station-prebuilt-archive` and `.station-release.json` from the ZipArchive, then byte-compare them after extraction. |
| `versions/<v>` + `.station-install-complete` sentinel + read-only seal | Same layout. Self-check runs `versions\<v>\runtime\node.exe versions\<v>\bin\station.mjs --version --json` directly, not the `.cmd`. Seal = the file ReadOnly attribute, the same as Node's `chmod a-w` on Windows. Removal clears it first. |
| `current` symlink, atomic rename | A **junction** (no privilege needed). The swap is not atomic: rename `current.next` into place after removing the old junction. Crash recovery: at startup, if `current` is missing and `current.next` exists, finish the swap. The state file records `activeVersion` so recovery never guesses. Service-path conflict: see decision D4. |
| Owned launcher `~/.local/bin/station` (exact-text ownership check) | `station.cmd` / `station-beta.cmd` / `station-nightly.cmd` in the bin dir, with the same exact-text ownership rule (`rem station-owned-launcher-v2`). It sets `STATION_CHANNEL/ROOT/HOME/INSTALL_ROOT`, then `call "<current>\bin\station.cmd" %*`. Bin dir: decision D3. PATH: print a hint, as install.sh does (decision D3). |
| Root, home and channel-leaf safety checks; ownership markers; overlap refusal | Same rules and marker files, with case-insensitive path comparison. |
| 0600/0700 modes, uid ownership | ACLs. Install root, state file and launcher get a protected DACL: current user, SYSTEM and Administrators (execution-safe). This must pass `windows-path-trust.ts`'s `execution-safe` verify, since `service install` checks those paths. |
| State schema 4 (`manifestUrl`, recorded ports) | Same JSON, same file (`.station-release-state.json`). It adds nothing Windows-specific except `activeVersion` if D4 needs it. Readers already ignore unknown fields. |
| Port resolution (explicit > recorded > channel default) | Explicit means `STATION_INSTALL_SERVER_PORT`/`…_UI_PORT` **only**. `STATION_SERVER_PORT`/`STATION_UI_PORT` are never read (per #2954: the bootstrap sets them to channel defaults). This intentionally diverges from install.sh, which should follow. |
| Downgrade / same-version-new-bytes refusal; `STATION_VERSION` + `STATION_INSTALL_ALLOW_ROLLBACK=1` | Same ordering rules and messages. |
| Nightly coexistence (default home not ours; port in use with no install) | Same, and it matters more here: Station Nightly desktop on Windows shares `%USERPROFILE%\.station\instances\nightly` and 38141/38000. |
| `STATION_INSTALL_NO_START`, prune (keep active and previous) | Same. Prune is best effort on Windows: a version with a running `node.exe` cannot be deleted, so the installer warns and the next install retries. It is never fatal. |
| Service stop → flip → start with identity rollback; registered-but-stopped left stopped | Same logic through the active version's CLI (`service status --json`, `stop`, `start`). Deferred to slice W3 (below), until the launcher works on win32. Until then install.ps1 **refuses** when an archive service runs the install root, with the remedy. |
| Launcher handoff (`update-request.json`) and `STATION_INSTALL_STAGE_ONLY=1` | Same file protocol (W3). Stage-only is needed as soon as `stageServiceUpdate` can spawn install.ps1. |
| `uninstall [--purge-data]` | `install.ps1 uninstall [-PurgeData]`: same refusals (marker, overlap, services), and clears ReadOnly before removal. |
| `curl \| sh` whole-script brace group | `irm … \| iex` parses the whole script before running it. Every entry is a function called at the end, and all params come from the environment (iex cannot take `-Param`). |

## 3. Keeping verification and logic DRY (decision D1)

- **Option A: port install.sh line for line.** install.ps1 would carry its
  own copy of each `node -e` snippet, which gives two parallel installers of
  about 2,000 lines each. The verifier would be a fourth copy, tied to the
  others only by golden vectors. This is cheap to start and expensive forever.
- **Option B (recommended): a thin PowerShell bootstrap over one bundled Node
  installer core.**
  - `install.ps1` does only what must happen before Node exists: resolve
    Node (host, installed, or pinned zip by sha256), set TLS, and hand over
    the environment.
  - Everything else is a TypeScript module under `packages/shared/src/installer/`:
    verification (it **imports** `release-manifest.mjs`, so the installer,
    signer and supervisor share one verifier), download caps, zip checks,
    layout, state, launcher text, and the service dance.
  - esbuild bundles that module into one CJS string. The generator embeds it
    as a generated block (a base64 here-string) in install.ps1.
  - At runtime, install.ps1 writes the block into its private temp dir and
    runs it with the resolved Node. The PowerShell side stays about 200 lines.
  - Outcome: one verifier in three places (signer, supervisor, Windows
    installer). The core is unit-testable with vitest on every OS, including
    the required Windows lane. Golden vectors run the embedded block on
    Linux CI.
  - install.sh could later become the same thin bootstrap over the same core.
    That is **not** part of W; it's a follow-up the owner can take or leave.
- The cost of B: the bundle makes install.ps1 larger (84 KB at W1, the core
  being about 56 KB of JavaScript) and less reviewable as a single file. Review happens on the TS sources, and
  `install-script:check` proves the embedded bundle matches them.

## 4. Service interaction on Windows (W3)

- **Execution path free of reparse points (decision D4).**
  - Option (a), recommended: the Task Scheduler wrapper runs
    `<installRoot>\runtime\node.exe <installRoot>\runtime\station-launcher.mjs
    service run …`. `service install` copies the launcher's own `node.exe`
    there, just as it already copies `station-launcher.mjs`, and freezes it
    with the launcher, which uses only Node built-ins. The launcher spawns
    `versions\<v>\runtime\node.exe` by real path. No junction is on any
    trusted execution path, and `Assert-NoReparse` stays strict.
  - Option (b): teach the trust check to resolve one junction under an
    install root it owns. This weakens a security guard, so (b) is not
    recommended.
- **Launcher `pointCurrentAt` on win32:** a junction, plus remove-then-rename
  with the `current.next` recovery rule from section 2. It is exported and
  shared with install.ps1's core, so there is one recovery rule.
- **Task Scheduler settings:** `RestartCount=3` and `RestartInterval=PT1M`
  (Set-ScheduledTask, next to the existing priority update), so a failed
  restore gets its restart. `ExecutionTimeLimit=PT0S`, so the 72 h default
  doesn't kill a long-running service.
- **Stopping:**
  - `service stop` on win32 stops the launcher by its recorded pid and birth
    time, not only the wrapper. The launcher then stops its child with
    `station stop` first, not TerminateProcess, so the Station children
    actually drain.
  - `LAUNCHER_STOP_BUDGET_MS` must be re-derived for Windows. With no SIGTERM
    grace, the budget is the own-stop time.
- `STATION_SERVICE_MANAGED=1` is already set (slice C).
- `stageServiceUpdate` and `delegatePackagedUpgradeIfPresent` pick the
  installer by platform:
  `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File <version>\install.ps1 install`,
  resolved with `windowsSystemUtilityPath`. Both use `installerInheritedEnv`
  from #2954.
- The process-birth probe still cold-starts PowerShell (#2805; branch
  `fix/windows-birth-native-2805` exists). The trial's 240 s budget absorbs
  it, but W3's smoke will hit it on cold runners. Land #2805 first or accept
  the flake risk, and diagnose rather than rerun.

## 5. Testing

- **Linux fast-checks (required):**
  - `install-script-generated` covers both files.
  - `release-manifest-vectors.test.ts` gains an install.ps1 entry point: it
    extracts the embedded core and runs every golden vector through it with
    node.
  - Core unit tests cover the size cap, the zip entry rules (fixture zips
    with `..`, absolute paths, drive letters, symlink attributes), and the
    state and launcher text.
- **Windows required lane (`test:windows:portable`):** add the core's
  Windows-only tests: junction swap and recovery, ReadOnly seal and removal,
  ACL application passing `assertWindowsPathsTrusted`, and case-insensitive
  root checks. Bounded, with no archive build.
- **Windows smoke (`install-smoke.yml` job `install-ps1-windows`, built in
  W1):** a Node.js driver, `scripts/smoke-install-ps1.mjs`, runs install.ps1
  with a PATH that holds no `node.exe`.
  - Setup: two archive generations of the candidate, signed with a throwaway
    key through the test-key override under the ring's pinned key id, and
    served from loopback HTTP.
  - Path length: a Station root long enough that the deepest installed path
    crosses MAX_PATH (#2484).
  - W1 scenario: Windows PowerShell 5.1 stages archive 1 with the downloaded
    pinned Node.js; PowerShell 7 stages archive 2 with the installed Node.js
    through a `current` junction; `Invoke-Expression` of the script text finds
    the active version "nothing to do" and leaves the caller's session alive;
    tampered bytes and a foreign signature are refused with nothing staged.
  - Later slices extend it: install → start → identity → upgrade → downgrade
    refusal → uninstall (W2), and the Task Scheduler service path (W3).
  - install-smoke runs on `pull_request_target`, so a pull request runs the
    base branch's jobs: the new job first runs on this branch by
    `workflow_dispatch`, and on pull requests only once merged.
  - Decision D5: required once it has run green for a while.
- **Fault injection, per slice.** For each, commit, inject, and confirm the
  named test fails for the named reason:
  - flip one signature byte;
  - a key that is not pinned;
  - a nightly key signing stable;
  - size +1 and −1;
  - a changed sha256;
  - a zip with `station/../x`, and a zip with a symlink entry;
  - an unowned launcher;
  - replaying an older manifest;
  - a state file with a foreign ACL;
  - deleting `current` between remove and rename (recovery);
  - reverting the port rule to read `STATION_SERVER_PORT`, which must fail a
    test that sets the bootstrap ports.

## 6. Slice breakdown (reviewable PRs)

- **W1 (this PR): the installer core and the verifier bundle, no layout changes.**
  - Contents: `packages/shared/src/installer/` (verify, download caps, zip
    rules), the generator block for install.ps1 (keys, channels, targets,
    win32 Node pin, core bundle), and install.ps1's Node bootstrap. Only
    `STATION_INSTALL_STAGE_ONLY=1` mode works: download, verify, extract into
    `versions\<v>`, self-check, sentinel, seal. The downgrade check against
    an existing `current` is in W1 too, since stage-only reports "nothing to
    do" for the active version.
  - Not in W1: ACLs on the install root, the `current` junction swap, the
    launcher, state, uninstall. Instead, on Windows the core refuses any
    install root outside the user profile (a root like `C:\station` usually
    inherits write access for every local user, who could plant a version
    the installer reuses), and install.ps1 runs the installed
    `current\runtime\node.exe` only for a root beneath the profile with no
    reparse point on the way. W2's ACL checks lift the restriction.
  - Every root variable (`STATION_ROOT`, `STATION_INSTALL_ROOT`,
    `STATION_HOME`) must be absolute (drive-qualified or UNC on Windows):
    install.ps1 refuses a relative one before it looks for any Node.js,
    because .NET and PowerShell resolve relative paths against different
    directories, and the core refuses it too.
  - Accepted gap in W1: the user profile is read from `USERPROFILE` on both
    sides (as Node.js's `os.homedir()` does), so a caller who points
    `USERPROFILE` elsewhere moves the trusted area with it. That is the
    caller's own choice, not another user's, and the Windows smoke relies on
    it to use a private profile.
  - Accepted gaps in W1: the download guard that refuses a redirect away
    from HTTPS has no test (a loopback HTTPS server needs a certificate for
    127.0.0.1); the zip reader does not fold Unicode case pairs beyond
    `toLowerCase` and caps neither total size nor entry count. Both fail
    closed: files are created exclusively (`wx`) and the archive's bytes are
    pinned by the signed sha256 first.
  - A test-only `STATION_INSTALL_TEST_HOST_TARGET` (refused without the
    test-only flag) lets the Linux tests stage the win32-x64 artifact.
  - Tests: vectors on Linux, a Windows smoke that stages both generations,
    and the injections above.
  - Also: the archive ships `install.ps1`.
- **W2: a full install without services.**
  - `current` junction plus recovery, the owned `.cmd` launcher, ACLs,
    schema-4 state, ports (#2954 rule), downgrade guard, nightly
    coexistence, NO_START, prune, uninstall.
  - `station upgrade` on win32 delegates to install.ps1.
  - install.ps1 refuses when an archive service runs the root.
  - Tests: the smoke runs the full install → upgrade → uninstall.
  - Docs: the cli.md "Native installation" Windows block and the
    release-channel-ports archive section.
- **W3: the Windows service in the update path.**
  - `runsLauncher` on win32, via the execution path free of reparse points
    (D4).
  - The launcher's `pointCurrentAt` on win32, the Task Scheduler restart and
    time-limit settings, `service stop` of the launcher, and
    `stageServiceUpdate` using install.ps1.
  - install.ps1's stop/flip/start with rollback, and the launcher handoff.
  - The smoke adds a Task Scheduler service, `station upgrade` under it, and
    a forced trial failure that rolls back.
- **W4 (optional):** move install.sh onto the shared core (only if D1 = B and
  the owner wants it).

## 7. Decisions

Decided 2026-09-29: **D1** option B (thin bootstrap plus a shared bundled
core). **D2** Windows PowerShell 5.1 and PowerShell 7. **D4** option (a),
`node.exe` frozen beside the launcher; the no-reparse trust check stays
strict. **D5** the Windows install-smoke leg stays advisory: install-smoke is a
path-filtered `pull_request_target` workflow, so a required check there would
never report on unrelated pull requests; it can become required only behind an
always-reporting wrapper. **D3** print a PATH hint, no PATH writes. **D6**
install.ps1 is fetched the way install.sh is, raw from `main`, not as a
release asset; W1 publishes nothing. No Authenticode now. **D7** keep refusing
to share the Nightly desktop app's home and ports. **D8** out of scope for
install.sh; install.ps1 honors only `STATION_INSTALL_*_PORT` (accepted
divergence). The Task Scheduler
72 h limit and missing restart-on-failure are #2970, which W3 depends on.

The options as originally posed:

- **D1.** Option B (thin bootstrap plus a shared bundled Node core) or option
  A (a line-for-line PowerShell port)? This blocks W1's shape.
- **D2.** The PowerShell floor. I recommend Windows PowerShell 5.1, the
  version that ships with Windows, so `irm | iex` works on a stock machine.
- **D3.** The Windows bin dir and PATH. The options are
  `%USERPROFILE%\.station\bin` or `%LOCALAPPDATA%\Programs\Station\bin`. The
  installer could print a PATH hint, as install.sh does, or write HKCU PATH
  when asked with `STATION_INSTALL_ADD_TO_PATH=1`.
- **D4.** The service execution path. Option (a) freezes `node.exe` beside
  the launcher, free of reparse points; option (b) relaxes `Assert-NoReparse`
  for the install root's junction. I recommend (a).
- **D5.** Make the Windows install-smoke leg a required check?
- **D6.** How install.ps1 is distributed:
  - Option 1: a release asset on the rolling `portable-*` pointers, beside
    the manifest.
  - Option 2: raw from `main`.
  - Is Authenticode signing of install.ps1 wanted? It is out of scope unless
    asked. The payload is already pinned-key verified, but the script that
    verifies it is trusted on first use, as install.sh is.
- **D7.** Station Nightly desktop on Windows shares the portable nightly home
  and ports. Keep install.sh's refusal (recommended), or add a separate
  default home for the portable nightly?
- **D8.** Should install.sh also stop reading
  `STATION_SERVER_PORT`/`STATION_UI_PORT` as explicit? #2954 strips them in
  the CLI, but a user shell that exports them still hits the same
  service-port refusal.

## 8. W2 as built, and what W3 needs

- **Kept the profile rule.** The design said W2's ACL checks would lift the
  "install root beneath the user profile" restriction. They do not: between
  the installer creating a root elsewhere (`C:\station`) and restricting it,
  another local user could plant a version, so W2 keeps the rule and adds the
  ACL on top. A new root gets a protected current-user-only DACL
  (`windows-path-trust.ts`'s `ensure`); an existing root must still have it
  (`verify`), or it is refused. install.ps1 runs `current\runtime\node.exe`
  only for a root beneath the profile with that DACL.
- **The code root.** `bin\station.cmd`'s `cd` leaves the working directory on
  the `current` junction's path, which made the CLI see `current`, not
  `versions\<v>`, as its code root. `bin/station.mjs` now moves to the real
  version directory when the working directory is the same directory through
  a link. Archives built before W2 lack this and cannot `station upgrade` on
  Windows (none was installed: W1 was stage-only).
- **Bin directory.** `%USERPROFILE%\.local\bin`, as install.sh's
  `~/.local/bin`; it must pass the trust module's `execution-safe` rule.
- **Rollback starts the previous release only without
  `STATION_INSTALL_NO_START=1`**, first stops a half-started new release,
  and starts the previous one on the ports its restored state records
  (install.sh's `restart_previous_station` uses the new ones).
- **Launcher text** (review): ASCII through `%USERPROFILE%` (cmd.exe reads
  batch files in the OEM code page), and no CALL on the hand-over line.
- **The data home's ACL is not set by the installer** (the server owns its
  home's trust).

W3 needs, beyond section 4:
- `stageServiceUpdate` (`service-launcher-link.ts`) still spawns `sh
  install.sh`; `packagedInstallerCommand` in `prebuilt-archive.ts` is the
  shared choice to reuse.
- install.ps1 refuses when a service's manifest names the install root, and
  when `runtime\service-state.json` exists; W3 replaces both refusals with
  the stop/flip/start and the launcher handoff.
- `pointCurrentAt` and `recoverCurrent` (`installer/full-install.ts`) are the
  Windows switch and recovery rule the launcher should share.
- During `station upgrade` the launcher's `cmd.exe` keeps its working
  directory on `current` while the installer replaces the junction. The W2
  Windows smoke exercises exactly this path without a service; a service
  wrapper adds its own `cmd.exe`, which W3 must exercise too.
