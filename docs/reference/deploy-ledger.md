# Deploy ledger

Every ship this repository makes, recorded by the workflow that shipped it — the answer to "on this date, this version was deployed; how out of date am I?" (archive#4572).

## Machine-readable source of truth

- JSON (stable location, newest first): [`docs/reference/deploy-ledger.json`](deploy-ledger.json) on `main`. This public repository makes the current ledger readable at [the raw JSON URL](https://raw.githubusercontent.com/kontourai/station/main/docs/reference/deploy-ledger.json).
- This markdown view is generated from that JSON by `scripts/deploy-ledger.mjs`; it is a projection, never edited by hand.

### JSON schema (one array element per ship)

- `timestampUtc` — ISO 8601 UTC. When the recording workflow step ran (immediately after the publish it records); never in the future.
- `artifactBuiltAt` — canonical ISO 8601 UTC from the immutable packaged artifact manifest, or `null` when a provider/package artifact cannot prove one. It is never a provider upload, device install, or ledger-recording timestamp.
- `channel` — one of `nightly-android`, `nightly-npm`, `nightly-desktop`, `stable-desktop`, `stable-npm`.
- `version` — the channel-specific version identity users see (`station --version`, Play console, npm); alphanumeric plus `. + ~ -` only.
- `sha` — the exact commit shipped, 40 lowercase hex, taken from the workflow’s own decided ship SHA (never re-derived). A ship is identified by `channel` + `sha` + `version`; a re-record of the same identity is refused regardless of artifact list.
- `workflowRunUrl` — the GitHub Actions run that recorded the ship, or null when unverifiable (historical seed entries).
- `artifacts` — what shipped, one descriptor each (store track, npm package, retained bundle, release asset).
- `gateResult` — the gate verdict that preceded the ship, as a sentence.
- `notes` — null or honest caveats (fields that could not be verified for a seeded historical entry, for example).
- `changelog` — `{ previousSha, groups, note, commitCount }`; `groups` maps `feat`/`fix`/`ci`/`docs`/`other` to markdown lines linking the delivering pull request. `docs(ledger):` bookkeeping commits are excluded from every slice. `note` carries the first-entry case and the same-sha-companion case (only the first entry of a same-sha batch carries the slice).

### Site consumption

This file decides nothing about how `station.kontourai.io` will read the ledger (archive#4572 site follow-up). What is true today: the in-repo path and schema above are the source of truth, every publish appends exactly one entry per shipped surface and commits it back to `main`, and the public raw JSON URL above is available to consumers without authentication. The site PR decides whether it reads that URL directly or copies the JSON, along with caching, refresh, and presentation. Because `main` moves, consumers should retain each entry’s `sha` and `workflowRunUrl` as evidence rather than treating a later fetch as an immutable release receipt.

## Ledger

| Date (UTC) | Channel | Version | Ship SHA | Gate | Run |
| --- | --- | --- | --- | --- | --- |
| 2026-08-30T19:57:10Z | nightly-desktop | 0.1.2-nightly.2433 | `f1073fa` | nightly test-gate success on f1073fa4cefe4f46a58409e7cfd493f2d6d29228 (station#4539) | [run](https://github.com/kontourai/station/actions/runs/33330909248) |
| 2026-08-30T19:53:22Z | nightly-android | 0.1.2-nightly.2433 | `f1073fa` | nightly test-gate success on f1073fa4cefe4f46a58409e7cfd493f2d6d29228 (station#4539) | [run](https://github.com/kontourai/station/actions/runs/33330909248) |
| 2026-08-30T18:20:57Z | nightly-desktop | 0.1.2-nightly.2433 | `1c23510` | nightly test-gate success on 1c235104ce09cfbc88cf42b9a529407c7949944e (station#4539) | [run](https://github.com/kontourai/station/actions/runs/33326401200) |
| 2026-08-30T18:19:33Z | nightly-android | 0.1.2-nightly.2433 | `1c23510` | nightly test-gate success on 1c235104ce09cfbc88cf42b9a529407c7949944e (station#4539) | [run](https://github.com/kontourai/station/actions/runs/33326401200) |
| 2026-08-30T16:24:11Z | nightly-desktop | 0.1.2-nightly.2433 | `f243049` | nightly test-gate success on f2430495239251df2e15c36a190a5c0ad3c3812a (station#4539) | [run](https://github.com/kontourai/station/actions/runs/33320949045) |
| 2026-08-30T16:17:41Z | nightly-android | 0.1.2-nightly.2433 | `f243049` | nightly test-gate success on f2430495239251df2e15c36a190a5c0ad3c3812a (station#4539) | [run](https://github.com/kontourai/station/actions/runs/33320949045) |
| 2026-08-30T14:52:43Z | nightly-desktop | 0.1.2-nightly.2433 | `e9f9078` | nightly test-gate success on e9f90789523c44bcd163ce4918baa38bb71bfe91 (station#4539) | [run](https://github.com/kontourai/station/actions/runs/33316671076) |
| 2026-08-30T14:49:02Z | nightly-android | 0.1.2-nightly.2433 | `e9f9078` | nightly test-gate success on e9f90789523c44bcd163ce4918baa38bb71bfe91 (station#4539) | [run](https://github.com/kontourai/station/actions/runs/33316671076) |
| 2026-08-30T02:34:34Z | nightly-desktop | 0.1.2-nightly.2433 | `c03dfbc` | nightly test-gate success on c03dfbced16f0d9f9c46c7b51d2956d7e56ab8c7 (station#4539) | [run](https://github.com/kontourai/station/actions/runs/33286914122) |
| 2026-08-30T02:26:57Z | nightly-android | 0.1.2-nightly.2433 | `c03dfbc` | nightly test-gate success on c03dfbced16f0d9f9c46c7b51d2956d7e56ab8c7 (station#4539) | [run](https://github.com/kontourai/station/actions/runs/33286914122) |
| 2026-08-30T00:20:56Z | nightly-desktop | 0.1.2-nightly.2432 | `f2d8fa3` | nightly test-gate success on f2d8fa36f76c0e9bce1ac9c05956215802e4c865 (station#4539) | [run](https://github.com/kontourai/station/actions/runs/33281917893) |
| 2026-08-30T00:13:48Z | nightly-android | 0.1.2-nightly.2432 | `f2d8fa3` | nightly test-gate success on f2d8fa36f76c0e9bce1ac9c05956215802e4c865 (station#4539) | [run](https://github.com/kontourai/station/actions/runs/33281917893) |
| 2026-08-29T14:30:53Z | nightly-desktop | 0.1.2-nightly.2432 | `15401e2` | nightly test-gate success on 15401e2708722905149cbe54003bafc448d19848 (station#4539) | [run](https://github.com/kontourai/station/actions/runs/33256579723) |
| 2026-08-29T14:27:15Z | nightly-android | 0.1.2-nightly.2432 | `15401e2` | nightly test-gate success on 15401e2708722905149cbe54003bafc448d19848 (station#4539) | [run](https://github.com/kontourai/station/actions/runs/33256579723) |
| 2026-08-29T10:21:21Z | nightly-desktop | 0.1.2-nightly.2432 | `c9968e5` | nightly test-gate success on c9968e5b096c6489e4ce17215db0e26c40924635 (station#4539) | [run](https://github.com/kontourai/station/actions/runs/33246144107) |
| 2026-08-29T10:08:01Z | nightly-android | 0.1.2-nightly.2432 | `c9968e5` | nightly test-gate success on c9968e5b096c6489e4ce17215db0e26c40924635 (station#4539) | [run](https://github.com/kontourai/station/actions/runs/33246144107) |
| 2026-08-29T09:16:25Z | nightly-android | 0.1.2-nightly.2432 | `23478d5` | nightly test-gate success on 23478d54bdb96b7802b36ce490a7ab92b46fffac (station#4539) | [run](https://github.com/kontourai/station/actions/runs/33244055407) |
| 2026-08-29T07:43:10Z | nightly-android | 0.1.2-nightly.2432 | `52f9ee8` | nightly test-gate success on 52f9ee8fd785310a5d23281fa820694333c0b1ad (station#4539) | [run](https://github.com/kontourai/station/actions/runs/33240426822) |
| 2026-08-29T06:25:39Z | nightly-android | 0.1.2-nightly.2432 | `68cd081` | nightly test-gate success on 68cd081f90ef766268d856bbcb056624276310ae (station#4539) | [run](https://github.com/kontourai/station/actions/runs/33237355902) |
| 2026-08-29T02:01:11Z | nightly-android | 0.1.2-nightly.2432 | `b0ac1b7` | nightly test-gate success on b0ac1b7b186a9d8f941616938321d09930c2ad38 (station#4539) | [run](https://github.com/kontourai/station/actions/runs/33225213529) |
| 2026-08-28T16:30:48Z | stable-npm | 0.7.0 | `b4fe42e` | npm trusted-publisher OIDC preflight success; changeset publish from refs/heads/main (b4fe42e5cc089fc95f8f513d549d78b82f198d96) | [run](https://github.com/kontourai/station/actions/runs/33188020921) |
| 2026-08-28T16:30:48Z | stable-npm | 0.7.0 | `b4fe42e` | npm trusted-publisher OIDC preflight success; changeset publish from refs/heads/main (b4fe42e5cc089fc95f8f513d549d78b82f198d96) | [run](https://github.com/kontourai/station/actions/runs/33188020921) |
| 2026-08-28T16:25:30Z | stable-npm | 0.7.0 | `b4fe42e` | npm trusted-publisher OIDC preflight success; changeset publish from refs/heads/main (b4fe42e5cc089fc95f8f513d549d78b82f198d96) | [run](https://github.com/kontourai/station/actions/runs/33188020921) |
| 2026-08-27T10:54:02Z | nightly-android | 0.1.2-nightly.2430 | `c4229f4` | no test gate existed for this ship: the nightly test gate landed after it (station#4565 merged 2026-08-27T16:04:07Z, this nightly job completed 2026-08-27T10:54:02Z) | [run](https://github.com/kontourai/station-archive/actions/runs/33064078473) |

## 2026-08-30T19:57:10Z · nightly-desktop · 0.1.2-nightly.2433

- Ship SHA: `f1073fa4cefe4f46a58409e7cfd493f2d6d29228`
- Artifact: github-release:nightly-desktop (station-nightly-desktop-macos-aarch64.dmg, .app.tar.gz, latest.json)

### Changelog

Commits since `1c23510` ([full sha](https://github.com/kontourai/station/commit/1c235104ce09cfbc88cf42b9a529407c7949944e)):

**Features**

- [#974](https://github.com/kontourai/station/pull/974) feat(ci): nightly src-ui sweep to catch untouched-consumer breakage

**Fixes**

- [#976](https://github.com/kontourai/station/pull/976) fix(basis): keep compact inventory readable
- [#974](https://github.com/kontourai/station/pull/974) fix(scheduler): use plain DOM assertions in AgentPicker test
- [#974](https://github.com/kontourai/station/pull/974) fix(chat): stop-initiated fetch abort no longer renders as Failed
- [#974](https://github.com/kontourai/station/pull/974) fix(chat): drop Claude Stop rethrow and preserve interrupt races (#898, #921)
- [#974](https://github.com/kontourai/station/pull/974) fix(ui): surface critical chrome over a maximized dock
- [#974](https://github.com/kontourai/station/pull/974) fix(ui): keep New Project starter content clear of actions
- [#967](https://github.com/kontourai/station/pull/967) fix(usage): the drop reporter is a required dep, so omitting it cannot compile
- [#974](https://github.com/kontourai/station/pull/974) fix(scheduler): retain bound agent identity
- [#974](https://github.com/kontourai/station/pull/974) fix(composer): avoid reconciling active uploads

**CI / workflow**

- [#966](https://github.com/kontourai/station/pull/966) ci: prepare required checks for merge queue

**Docs**

- [#966](https://github.com/kontourai/station/pull/966) docs: align merge queue check timeout

**Other**

- [#969](https://github.com/kontourai/station/pull/969) chore(ci): retire local stale-base refusal
- [#974](https://github.com/kontourai/station/pull/974) chore(ui): set entry-bundle ceilings to the merged train's measured actuals
- [#965](https://github.com/kontourai/station/pull/965) test(shared): budget plugin build containment checks
- [#965](https://github.com/kontourai/station/pull/965) test(verification): budget product laws for Vitest 4.1.11
- [#965](https://github.com/kontourai/station/pull/965) test(verification): budget expanded process-heavy corpus
- [#965](https://github.com/kontourai/station/pull/965) test(connect): cover host-unavailable profile copy
- [#965](https://github.com/kontourai/station/pull/965) test(plugins): include remote profile isolation input
- [#965](https://github.com/kontourai/station/pull/965) test(installer): bound hostile-path lifecycle harness
- [#965](https://github.com/kontourai/station/pull/965) test(verification): register deadline abort before fixture delay
- [#965](https://github.com/kontourai/station/pull/965) test: repair process-heavy fixture contracts
- [#965](https://github.com/kontourai/station/pull/965) test(ci): track gallery capacity jobs in workflow corpus
- [#965](https://github.com/kontourai/station/pull/965) test(verification): budget full phases for allowed contention
- [#965](https://github.com/kontourai/station/pull/965) test(ui): keep one peer credential mock after merge
- [#965](https://github.com/kontourai/station/pull/965) test(orchestration): bound synthetic population harness time
- [#965](https://github.com/kontourai/station/pull/965) test(ui): bound terminal marker lazy queries
- [#965](https://github.com/kontourai/station/pull/965) test(ui): bound lazy transcript assertions under corpus load
- [#965](https://github.com/kontourai/station/pull/965) test(orchestration): bound smoke classification without a one-second race
- [#965](https://github.com/kontourai/station/pull/965) test: align process-heavy fixtures with runtime contracts
- [#965](https://github.com/kontourai/station/pull/965) test(ui): make orchestration fixtures contract-valid
- [#965](https://github.com/kontourai/station/pull/965) test: repair current-main full regression drift

## 2026-08-30T19:53:22Z · nightly-android · 0.1.2-nightly.2433

- Ship SHA: `f1073fa4cefe4f46a58409e7cfd493f2d6d29228`
- Artifact: play-internal-aab:io.kontourai.station.nightly@versionCode 243304
- Artifact: workflow-artifact:station-nightly-243304 (7-day retention)

### Changelog

Commits since `1c23510` ([full sha](https://github.com/kontourai/station/commit/1c235104ce09cfbc88cf42b9a529407c7949944e)):

**Features**

- [#974](https://github.com/kontourai/station/pull/974) feat(ci): nightly src-ui sweep to catch untouched-consumer breakage

**Fixes**

- [#976](https://github.com/kontourai/station/pull/976) fix(basis): keep compact inventory readable
- [#974](https://github.com/kontourai/station/pull/974) fix(scheduler): use plain DOM assertions in AgentPicker test
- [#974](https://github.com/kontourai/station/pull/974) fix(chat): stop-initiated fetch abort no longer renders as Failed
- [#974](https://github.com/kontourai/station/pull/974) fix(chat): drop Claude Stop rethrow and preserve interrupt races (#898, #921)
- [#974](https://github.com/kontourai/station/pull/974) fix(ui): surface critical chrome over a maximized dock
- [#974](https://github.com/kontourai/station/pull/974) fix(ui): keep New Project starter content clear of actions
- [#967](https://github.com/kontourai/station/pull/967) fix(usage): the drop reporter is a required dep, so omitting it cannot compile
- [#974](https://github.com/kontourai/station/pull/974) fix(scheduler): retain bound agent identity
- [#974](https://github.com/kontourai/station/pull/974) fix(composer): avoid reconciling active uploads

**CI / workflow**

- [#966](https://github.com/kontourai/station/pull/966) ci: prepare required checks for merge queue

**Docs**

- [#966](https://github.com/kontourai/station/pull/966) docs: align merge queue check timeout

**Other**

- [#969](https://github.com/kontourai/station/pull/969) chore(ci): retire local stale-base refusal
- [#974](https://github.com/kontourai/station/pull/974) chore(ui): set entry-bundle ceilings to the merged train's measured actuals
- [#965](https://github.com/kontourai/station/pull/965) test(shared): budget plugin build containment checks
- [#965](https://github.com/kontourai/station/pull/965) test(verification): budget product laws for Vitest 4.1.11
- [#965](https://github.com/kontourai/station/pull/965) test(verification): budget expanded process-heavy corpus
- [#965](https://github.com/kontourai/station/pull/965) test(connect): cover host-unavailable profile copy
- [#965](https://github.com/kontourai/station/pull/965) test(plugins): include remote profile isolation input
- [#965](https://github.com/kontourai/station/pull/965) test(installer): bound hostile-path lifecycle harness
- [#965](https://github.com/kontourai/station/pull/965) test(verification): register deadline abort before fixture delay
- [#965](https://github.com/kontourai/station/pull/965) test: repair process-heavy fixture contracts
- [#965](https://github.com/kontourai/station/pull/965) test(ci): track gallery capacity jobs in workflow corpus
- [#965](https://github.com/kontourai/station/pull/965) test(verification): budget full phases for allowed contention
- [#965](https://github.com/kontourai/station/pull/965) test(ui): keep one peer credential mock after merge
- [#965](https://github.com/kontourai/station/pull/965) test(orchestration): bound synthetic population harness time
- [#965](https://github.com/kontourai/station/pull/965) test(ui): bound terminal marker lazy queries
- [#965](https://github.com/kontourai/station/pull/965) test(ui): bound lazy transcript assertions under corpus load
- [#965](https://github.com/kontourai/station/pull/965) test(orchestration): bound smoke classification without a one-second race
- [#965](https://github.com/kontourai/station/pull/965) test: align process-heavy fixtures with runtime contracts
- [#965](https://github.com/kontourai/station/pull/965) test(ui): make orchestration fixtures contract-valid
- [#965](https://github.com/kontourai/station/pull/965) test: repair current-main full regression drift

## 2026-08-30T18:20:57Z · nightly-desktop · 0.1.2-nightly.2433

- Ship SHA: `1c235104ce09cfbc88cf42b9a529407c7949944e`
- Artifact: github-release:nightly-desktop (station-nightly-desktop-macos-aarch64.dmg, .app.tar.gz, latest.json)

### Changelog

Commits since `f243049` ([full sha](https://github.com/kontourai/station/commit/f2430495239251df2e15c36a190a5c0ad3c3812a)):

**Features**

- [#960](https://github.com/kontourai/station/pull/960) feat(basis): redesign Session inventory experience

**Fixes**

- [#957](https://github.com/kontourai/station/pull/957) fix(usage): absent stays absent — durable-history fold guard, honest costs, and the drop nobody was reporting
- [#956](https://github.com/kontourai/station/pull/956) fix: prove bundled startup without keychain read

**Other**

- [#950](https://github.com/kontourai/station/pull/950) build(deps-dev): bump vitest and coverage-v8 to 4.1.11
- [#821](https://github.com/kontourai/station/pull/821) test: restore full-regression baseline invariants

## 2026-08-30T18:19:33Z · nightly-android · 0.1.2-nightly.2433

- Ship SHA: `1c235104ce09cfbc88cf42b9a529407c7949944e`
- Artifact: play-internal-aab:io.kontourai.station.nightly@versionCode 243303
- Artifact: workflow-artifact:station-nightly-243303 (7-day retention)

### Changelog

Commits since `f243049` ([full sha](https://github.com/kontourai/station/commit/f2430495239251df2e15c36a190a5c0ad3c3812a)):

**Features**

- [#960](https://github.com/kontourai/station/pull/960) feat(basis): redesign Session inventory experience

**Fixes**

- [#957](https://github.com/kontourai/station/pull/957) fix(usage): absent stays absent — durable-history fold guard, honest costs, and the drop nobody was reporting
- [#956](https://github.com/kontourai/station/pull/956) fix: prove bundled startup without keychain read

**Other**

- [#950](https://github.com/kontourai/station/pull/950) build(deps-dev): bump vitest and coverage-v8 to 4.1.11
- [#821](https://github.com/kontourai/station/pull/821) test: restore full-regression baseline invariants

## 2026-08-30T16:24:11Z · nightly-desktop · 0.1.2-nightly.2433

- Ship SHA: `f2430495239251df2e15c36a190a5c0ad3c3812a`
- Artifact: github-release:nightly-desktop (station-nightly-desktop-macos-aarch64.dmg, .app.tar.gz, latest.json)

### Changelog

Commits since `e9f9078` ([full sha](https://github.com/kontourai/station/commit/e9f90789523c44bcd163ce4918baa38bb71bfe91)):

**Features**

- [#810](https://github.com/kontourai/station/pull/810) feat(native): add version-aware Tauri context tooling
- [#913](https://github.com/kontourai/station/pull/913) feat(ui): reasoning is a collapsed-by-default disclosure (#55)

**Fixes**

- [#825](https://github.com/kontourai/station/pull/825) fix(build): invoke Biome portably on Windows
- [#813](https://github.com/kontourai/station/pull/813) fix(native): bind Browser Preview IPC fixtures to Rust (#261)
- [#916](https://github.com/kontourai/station/pull/916) fix(basis): make full fallback a real modal
- [#914](https://github.com/kontourai/station/pull/914) fix(ci): green the container provenance gate, scan PRs for secrets, and make a red main announce itself
- [#919](https://github.com/kontourai/station/pull/919) fix(ui): classify intentional Coding pane host routing
- [#919](https://github.com/kontourai/station/pull/919) fix(ui): keep deferred first run resumable
- [#912](https://github.com/kontourai/station/pull/912) fix(desktop): retain credential recovery selection intent
- [#919](https://github.com/kontourai/station/pull/919) fix(ui): repair mobile Home dock button and New Project modal footer
- [#919](https://github.com/kontourai/station/pull/919) fix(ui): show a loading state instead of asserting no agent is ready, gate dev-only starter cards
- [#919](https://github.com/kontourai/station/pull/919) fix(ui): fill Home starter cards with shimmer instead of empty outlines
- [#919](https://github.com/kontourai/station/pull/919) fix(ui): present requested turn stops honestly
- [#919](https://github.com/kontourai/station/pull/919) fix(ui): stop bouncing installed Session Board layouts to the project page
- [#919](https://github.com/kontourai/station/pull/919) fix(ui): make Workspace Pane cards honest about layout requirements
- [#919](https://github.com/kontourai/station/pull/919) fix(ui): un-bury and un-shrink the maximized dock
- [#919](https://github.com/kontourai/station/pull/919) fix(ui): persist first-run wizard progress across reload
- [#919](https://github.com/kontourai/station/pull/919) fix(ui): stop misdiagnosing the UI proxy's own outage response
- [#919](https://github.com/kontourai/station/pull/919) fix(ui): preserve paired identity during a UI-proxy host outage
- [#912](https://github.com/kontourai/station/pull/912) fix(desktop): isolate packaged channel profile selection

**Other**

- [#878](https://github.com/kontourai/station/pull/878) test(ios): dismiss clean-install system prompt
- [#829](https://github.com/kontourai/station/pull/829) test(native): add real Tauri shell security harness
- [#919](https://github.com/kontourai/station/pull/919) chore(ui): set bundle ceilings to the wave-3 train's measured actuals
- [#919](https://github.com/kontourai/station/pull/919) test(ui): rehydrate first-run settings between cases
- [#919](https://github.com/kontourai/station/pull/919) chore(ui): raise the mobile-css ratchet to measured for HomeView's new at-rule
- [#912](https://github.com/kontourai/station/pull/912) refactor(desktop): fold profile selection intent into authorization
- [#919](https://github.com/kontourai/station/pull/919) chore(ui): re-measure the entry ceiling after the stop/Home polish fixes (#898, #890)

## 2026-08-30T16:17:41Z · nightly-android · 0.1.2-nightly.2433

- Ship SHA: `f2430495239251df2e15c36a190a5c0ad3c3812a`
- Artifact: play-internal-aab:io.kontourai.station.nightly@versionCode 243302
- Artifact: workflow-artifact:station-nightly-243302 (7-day retention)

### Changelog

Commits since `e9f9078` ([full sha](https://github.com/kontourai/station/commit/e9f90789523c44bcd163ce4918baa38bb71bfe91)):

**Features**

- [#810](https://github.com/kontourai/station/pull/810) feat(native): add version-aware Tauri context tooling
- [#913](https://github.com/kontourai/station/pull/913) feat(ui): reasoning is a collapsed-by-default disclosure (#55)

**Fixes**

- [#825](https://github.com/kontourai/station/pull/825) fix(build): invoke Biome portably on Windows
- [#813](https://github.com/kontourai/station/pull/813) fix(native): bind Browser Preview IPC fixtures to Rust (#261)
- [#916](https://github.com/kontourai/station/pull/916) fix(basis): make full fallback a real modal
- [#914](https://github.com/kontourai/station/pull/914) fix(ci): green the container provenance gate, scan PRs for secrets, and make a red main announce itself
- [#919](https://github.com/kontourai/station/pull/919) fix(ui): classify intentional Coding pane host routing
- [#919](https://github.com/kontourai/station/pull/919) fix(ui): keep deferred first run resumable
- [#912](https://github.com/kontourai/station/pull/912) fix(desktop): retain credential recovery selection intent
- [#919](https://github.com/kontourai/station/pull/919) fix(ui): repair mobile Home dock button and New Project modal footer
- [#919](https://github.com/kontourai/station/pull/919) fix(ui): show a loading state instead of asserting no agent is ready, gate dev-only starter cards
- [#919](https://github.com/kontourai/station/pull/919) fix(ui): fill Home starter cards with shimmer instead of empty outlines
- [#919](https://github.com/kontourai/station/pull/919) fix(ui): present requested turn stops honestly
- [#919](https://github.com/kontourai/station/pull/919) fix(ui): stop bouncing installed Session Board layouts to the project page
- [#919](https://github.com/kontourai/station/pull/919) fix(ui): make Workspace Pane cards honest about layout requirements
- [#919](https://github.com/kontourai/station/pull/919) fix(ui): un-bury and un-shrink the maximized dock
- [#919](https://github.com/kontourai/station/pull/919) fix(ui): persist first-run wizard progress across reload
- [#919](https://github.com/kontourai/station/pull/919) fix(ui): stop misdiagnosing the UI proxy's own outage response
- [#919](https://github.com/kontourai/station/pull/919) fix(ui): preserve paired identity during a UI-proxy host outage
- [#912](https://github.com/kontourai/station/pull/912) fix(desktop): isolate packaged channel profile selection

**Other**

- [#878](https://github.com/kontourai/station/pull/878) test(ios): dismiss clean-install system prompt
- [#829](https://github.com/kontourai/station/pull/829) test(native): add real Tauri shell security harness
- [#919](https://github.com/kontourai/station/pull/919) chore(ui): set bundle ceilings to the wave-3 train's measured actuals
- [#919](https://github.com/kontourai/station/pull/919) test(ui): rehydrate first-run settings between cases
- [#919](https://github.com/kontourai/station/pull/919) chore(ui): raise the mobile-css ratchet to measured for HomeView's new at-rule
- [#912](https://github.com/kontourai/station/pull/912) refactor(desktop): fold profile selection intent into authorization
- [#919](https://github.com/kontourai/station/pull/919) chore(ui): re-measure the entry ceiling after the stop/Home polish fixes (#898, #890)

## 2026-08-30T14:52:43Z · nightly-desktop · 0.1.2-nightly.2433

- Ship SHA: `e9f90789523c44bcd163ce4918baa38bb71bfe91`
- Artifact: github-release:nightly-desktop (station-nightly-desktop-macos-aarch64.dmg, .app.tar.gz, latest.json)

### Changelog

Commits since `c03dfbc` ([full sha](https://github.com/kontourai/station/commit/c03dfbced16f0d9f9c46c7b51d2956d7e56ab8c7)):

**Features**

- [#904](https://github.com/kontourai/station/pull/904) feat(ui): bound what a single message can cost to render (#330)
- [#880](https://github.com/kontourai/station/pull/880) feat(ui): incremental block-split markdown for the streaming transcript (#329)
- [#905](https://github.com/kontourai/station/pull/905) feat(e2e,ci): host-hermetic gallery roster + owner-approved capture cadence (#875, #518)

**Fixes**

- [#886](https://github.com/kontourai/station/pull/886) fix(agents): retain observed detail fetch authority
- [#886](https://github.com/kontourai/station/pull/886) fix(agents): keep persisted route actions available
- [#901](https://github.com/kontourai/station/pull/901) fix(ui): restore the SessionsView suite that 890e's apiBase threading broke
- [#901](https://github.com/kontourai/station/pull/901) fix(sdk): distinguish benign attention-ack 404s from real failures (#890, review prescription)
- [#901](https://github.com/kontourai/station/pull/901) fix(scheduler): typed 409 conflict for duplicate job names, rendered in the dialog
- [#901](https://github.com/kontourai/station/pull/901) fix(scheduler): honor the busy-banner promise and reflect real run outcomes
- [#901](https://github.com/kontourai/station/pull/901) fix(scheduler): offer only runner-resolvable agents in the Add Job picker
- [#901](https://github.com/kontourai/station/pull/901) fix(ui): disclose retained tasks after project deletion
- [#901](https://github.com/kontourai/station/pull/901) fix(composer): reflect receipted approval mode
- [#901](https://github.com/kontourai/station/pull/901) fix(composer): make microphone capability honest
- [#897](https://github.com/kontourai/station/pull/897) fix(ui): Tools page leads with tools — secret bindings demoted to an advanced disclosure in form grammar
- [#901](https://github.com/kontourai/station/pull/901) fix(ui): make pending pairing dismissal actionable
- [#901](https://github.com/kontourai/station/pull/901) fix(ui): make guidance markdown import live
- [#901](https://github.com/kontourai/station/pull/901) fix(composer): admit and bound attachment staging
- [#901](https://github.com/kontourai/station/pull/901) fix(ui): surface project mutation failures
- [#894](https://github.com/kontourai/station/pull/894) fix(chat): Stop button resolves the continuation child via the hook (#887, review prescription)
- [#895](https://github.com/kontourai/station/pull/895) fix(plugins): register starter layout components at the runtime seam
- [#894](https://github.com/kontourai/station/pull/894) fix(tests): restore walkthrough expected-fails — live cause persists past source registration
- [#894](https://github.com/kontourai/station/pull/894) fix(chat): persist direct-chat sessions; repair share/stop/steer record dependencies
- [#894](https://github.com/kontourai/station/pull/894) fix(plugins): register declared layout components in knowledge-docs and minimal starters
- [#894](https://github.com/kontourai/station/pull/894) fix(sdk): knowledge routes double-prefixed apiBase; surface knowledge failures
- [#894](https://github.com/kontourai/station/pull/894) fix(registry): card install routes through the consented pipeline
- [#894](https://github.com/kontourai/station/pull/894) fix(ui): diff pane renders patch content and comment gutter
- [#885](https://github.com/kontourai/station/pull/885) fix(release): bound large macOS artifact packaging
- [#883](https://github.com/kontourai/station/pull/883) fix(macos): preserve automatic WebView accessibility children
- [#862](https://github.com/kontourai/station/pull/862) fix(test): satisfy sessionReadAuthorityFromRequest arity in runs.routes tests
- [#862](https://github.com/kontourai/station/pull/862) fix(test): raise store-quarantine per-test budgets to survive 2-core CI runners
- [#862](https://github.com/kontourai/station/pull/862) fix(test): runs.routes tests inject session-read authority instead of asserting the host username
- [#879](https://github.com/kontourai/station/pull/879) fix(ui): render release channel as a sidebar badge
- [#862](https://github.com/kontourai/station/pull/862) fix(test): make readiness-probe tests binary-presence-independent
- [#862](https://github.com/kontourai/station/pull/862) fix(system): distinguish aborted from completed-error readiness probes; hold genuine observations

**Other**

- [#909](https://github.com/kontourai/station/pull/909) test(ui): pin Basis mobile sheet geometry
- [#905](https://github.com/kontourai/station/pull/905) test(e2e): re-baseline connections-tools for upstream #897's Tools redesign
- [#905](https://github.com/kontourai/station/pull/905) test(ci): pin the nightly entrypoint chain and the gallery's fail semantics (#875, #518)
- [#901](https://github.com/kontourai/station/pull/901) chore(ui): re-measure the entry ceiling after the attention-ack fix
- [#901](https://github.com/kontourai/station/pull/901) test(server): pin the ack 404 message and repair the #765 D5 list assertion
- [#901](https://github.com/kontourai/station/pull/901) chore(attribution): record Codex authorship for the 890e commits
- [#901](https://github.com/kontourai/station/pull/901) chore(ui): re-measure the entry bundle ceiling on the wave-2 combined tree
- [#893](https://github.com/kontourai/station/pull/893) test(e2e): pin the mobile page-action 44px touch floor per section
- [#895](https://github.com/kontourai/station/pull/895) test(walkthrough): remove stale expected-fails proven passing live
- [#894](https://github.com/kontourai/station/pull/894) chore(ui): set bundle ceilings to measured actuals for merged train
- [#894](https://github.com/kontourai/station/pull/894) style: apply required formatting
- [#905](https://github.com/kontourai/station/pull/905) test(e2e): re-baseline the four agents-family screens on the hermetic roster
- [#883](https://github.com/kontourai/station/pull/883) test(macos): distinguish covered presentation from reveal
- [#883](https://github.com/kontourai/station/pull/883) test(macos): pin covered and reveal accessibility order

## 2026-08-30T14:49:02Z · nightly-android · 0.1.2-nightly.2433

- Ship SHA: `e9f90789523c44bcd163ce4918baa38bb71bfe91`
- Artifact: play-internal-aab:io.kontourai.station.nightly@versionCode 243301
- Artifact: workflow-artifact:station-nightly-243301 (7-day retention)

### Changelog

Commits since `c03dfbc` ([full sha](https://github.com/kontourai/station/commit/c03dfbced16f0d9f9c46c7b51d2956d7e56ab8c7)):

**Features**

- [#904](https://github.com/kontourai/station/pull/904) feat(ui): bound what a single message can cost to render (#330)
- [#880](https://github.com/kontourai/station/pull/880) feat(ui): incremental block-split markdown for the streaming transcript (#329)
- [#905](https://github.com/kontourai/station/pull/905) feat(e2e,ci): host-hermetic gallery roster + owner-approved capture cadence (#875, #518)

**Fixes**

- [#886](https://github.com/kontourai/station/pull/886) fix(agents): retain observed detail fetch authority
- [#886](https://github.com/kontourai/station/pull/886) fix(agents): keep persisted route actions available
- [#901](https://github.com/kontourai/station/pull/901) fix(ui): restore the SessionsView suite that 890e's apiBase threading broke
- [#901](https://github.com/kontourai/station/pull/901) fix(sdk): distinguish benign attention-ack 404s from real failures (#890, review prescription)
- [#901](https://github.com/kontourai/station/pull/901) fix(scheduler): typed 409 conflict for duplicate job names, rendered in the dialog
- [#901](https://github.com/kontourai/station/pull/901) fix(scheduler): honor the busy-banner promise and reflect real run outcomes
- [#901](https://github.com/kontourai/station/pull/901) fix(scheduler): offer only runner-resolvable agents in the Add Job picker
- [#901](https://github.com/kontourai/station/pull/901) fix(ui): disclose retained tasks after project deletion
- [#901](https://github.com/kontourai/station/pull/901) fix(composer): reflect receipted approval mode
- [#901](https://github.com/kontourai/station/pull/901) fix(composer): make microphone capability honest
- [#897](https://github.com/kontourai/station/pull/897) fix(ui): Tools page leads with tools — secret bindings demoted to an advanced disclosure in form grammar
- [#901](https://github.com/kontourai/station/pull/901) fix(ui): make pending pairing dismissal actionable
- [#901](https://github.com/kontourai/station/pull/901) fix(ui): make guidance markdown import live
- [#901](https://github.com/kontourai/station/pull/901) fix(composer): admit and bound attachment staging
- [#901](https://github.com/kontourai/station/pull/901) fix(ui): surface project mutation failures
- [#894](https://github.com/kontourai/station/pull/894) fix(chat): Stop button resolves the continuation child via the hook (#887, review prescription)
- [#895](https://github.com/kontourai/station/pull/895) fix(plugins): register starter layout components at the runtime seam
- [#894](https://github.com/kontourai/station/pull/894) fix(tests): restore walkthrough expected-fails — live cause persists past source registration
- [#894](https://github.com/kontourai/station/pull/894) fix(chat): persist direct-chat sessions; repair share/stop/steer record dependencies
- [#894](https://github.com/kontourai/station/pull/894) fix(plugins): register declared layout components in knowledge-docs and minimal starters
- [#894](https://github.com/kontourai/station/pull/894) fix(sdk): knowledge routes double-prefixed apiBase; surface knowledge failures
- [#894](https://github.com/kontourai/station/pull/894) fix(registry): card install routes through the consented pipeline
- [#894](https://github.com/kontourai/station/pull/894) fix(ui): diff pane renders patch content and comment gutter
- [#885](https://github.com/kontourai/station/pull/885) fix(release): bound large macOS artifact packaging
- [#883](https://github.com/kontourai/station/pull/883) fix(macos): preserve automatic WebView accessibility children
- [#862](https://github.com/kontourai/station/pull/862) fix(test): satisfy sessionReadAuthorityFromRequest arity in runs.routes tests
- [#862](https://github.com/kontourai/station/pull/862) fix(test): raise store-quarantine per-test budgets to survive 2-core CI runners
- [#862](https://github.com/kontourai/station/pull/862) fix(test): runs.routes tests inject session-read authority instead of asserting the host username
- [#879](https://github.com/kontourai/station/pull/879) fix(ui): render release channel as a sidebar badge
- [#862](https://github.com/kontourai/station/pull/862) fix(test): make readiness-probe tests binary-presence-independent
- [#862](https://github.com/kontourai/station/pull/862) fix(system): distinguish aborted from completed-error readiness probes; hold genuine observations

**Other**

- [#909](https://github.com/kontourai/station/pull/909) test(ui): pin Basis mobile sheet geometry
- [#905](https://github.com/kontourai/station/pull/905) test(e2e): re-baseline connections-tools for upstream #897's Tools redesign
- [#905](https://github.com/kontourai/station/pull/905) test(ci): pin the nightly entrypoint chain and the gallery's fail semantics (#875, #518)
- [#901](https://github.com/kontourai/station/pull/901) chore(ui): re-measure the entry ceiling after the attention-ack fix
- [#901](https://github.com/kontourai/station/pull/901) test(server): pin the ack 404 message and repair the #765 D5 list assertion
- [#901](https://github.com/kontourai/station/pull/901) chore(attribution): record Codex authorship for the 890e commits
- [#901](https://github.com/kontourai/station/pull/901) chore(ui): re-measure the entry bundle ceiling on the wave-2 combined tree
- [#893](https://github.com/kontourai/station/pull/893) test(e2e): pin the mobile page-action 44px touch floor per section
- [#895](https://github.com/kontourai/station/pull/895) test(walkthrough): remove stale expected-fails proven passing live
- [#894](https://github.com/kontourai/station/pull/894) chore(ui): set bundle ceilings to measured actuals for merged train
- [#894](https://github.com/kontourai/station/pull/894) style: apply required formatting
- [#905](https://github.com/kontourai/station/pull/905) test(e2e): re-baseline the four agents-family screens on the hermetic roster
- [#883](https://github.com/kontourai/station/pull/883) test(macos): distinguish covered presentation from reveal
- [#883](https://github.com/kontourai/station/pull/883) test(macos): pin covered and reveal accessibility order

## 2026-08-30T02:34:34Z · nightly-desktop · 0.1.2-nightly.2433

- Ship SHA: `c03dfbced16f0d9f9c46c7b51d2956d7e56ab8c7`
- Artifact: github-release:nightly-desktop (station-nightly-desktop-macos-aarch64.dmg, .app.tar.gz, latest.json)

### Changelog

Commits since `f2d8fa3` ([full sha](https://github.com/kontourai/station/commit/f2d8fa36f76c0e9bce1ac9c05956215802e4c865)):

**Features**

- [#864](https://github.com/kontourai/station/pull/864) feat(release): bind native promotion to one revision
- [#849](https://github.com/kontourai/station/pull/849) feat(delegation): pin the operator-channel-only refusal detail in the promotion route test (#790, #765 D4)
- [#849](https://github.com/kontourai/station/pull/849) feat(delegation): raise entry-JS ceiling 306350 -> 306352 for the peer Station option (#790, #765 D4)
- [#849](https://github.com/kontourai/station/pull/849) feat(delegation): surface paired peer Stations in Computers and the Delegate dialog (#790, #765 D4)

**Fixes**

- [#876](https://github.com/kontourai/station/pull/876) fix(e2e): connections add-flow asserts the real contract; reconnect alerts scoped; 320px labelled-chip overlap fixed
- [#873](https://github.com/kontourai/station/pull/873) fix(ios): prevent form focus zoom
- [#870](https://github.com/kontourai/station/pull/870) fix(macos): refresh accessibility after startup reveal
- [#867](https://github.com/kontourai/station/pull/867) fix(delegation): harden peer Activity reconciliation
- [#864](https://github.com/kontourai/station/pull/864) fix(release): require channel receipts to converge
- [#866](https://github.com/kontourai/station/pull/866) fix(release): verify DMG signer before notarization
- [#866](https://github.com/kontourai/station/pull/866) fix(release): bound resumable DMG packaging
- [#864](https://github.com/kontourai/station/pull/864) fix(release): keep store preflight policy-clean
- [#867](https://github.com/kontourai/station/pull/867) fix(delegation): surface peer delegation outcomes in the delegator Activity
- [#860](https://github.com/kontourai/station/pull/860) fix(ui): occupant picker joins the drag surface and defers below 481px
- [#849](https://github.com/kontourai/station/pull/849) fix(lint): biome-ignore literal template-string assertions (fix-forward, upstream main red)
- [#860](https://github.com/kontourai/station/pull/860) fix(ui): checkpoint fix round 2 — shared chooseAmbientOccupant dispatcher (incomplete)
- [#853](https://github.com/kontourai/station/pull/853) fix(ios): unblock clean startup with 274 gzip bytes
- [#860](https://github.com/kontourai/station/pull/860) fix(ui): review round 2 — CSS ratchet, dock-and-empty picker gap, chip safety
- [#860](https://github.com/kontourai/station/pull/860) fix(ui): mobile dock-and-empty contract — refuse placeholder-only viewport
- [#860](https://github.com/kontourai/station/pull/860) fix(ui): dock-shell mobile parity — occupant picker + collapsed-height fix
- [#860](https://github.com/kontourai/station/pull/860) fix(ui): mobile chrome — safe-area under maximized dock, composer chip ellipsis

**Other**

- [#871](https://github.com/kontourai/station/pull/871) test(e2e): regenerate gallery baselines — seeded surfaces + accumulated upstream drift
- [#870](https://github.com/kontourai/station/pull/870) test(macos): pin complete accessibility reveal order
- [#871](https://github.com/kontourai/station/pull/871) test(e2e): seed connection + knowledge state instead of hiding the surfaces
- [#868](https://github.com/kontourai/station/pull/868) test(e2e): screenshot fixtures release their routes (#573)
- [#865](https://github.com/kontourai/station/pull/865) test(e2e): 320px header case pins the labelled connection-chip budget (#547)
- [#866](https://github.com/kontourai/station/pull/866) test(release): close DMG-only parser gaps
- [#860](https://github.com/kontourai/station/pull/860) test(ui): review hygiene — attributable picker-absence test, corrected spec citation
- [#860](https://github.com/kontourai/station/pull/860) test(ui): direct chooseAmbientOccupant dispatcher coverage (fix round 2 completion)
- [#853](https://github.com/kontourai/station/pull/853) test(ios): add hosted packaged-runtime smoke

## 2026-08-30T02:26:57Z · nightly-android · 0.1.2-nightly.2433

- Ship SHA: `c03dfbced16f0d9f9c46c7b51d2956d7e56ab8c7`
- Artifact: play-internal-aab:io.kontourai.station.nightly@versionCode 243300
- Artifact: workflow-artifact:station-nightly-243300 (7-day retention)

### Changelog

Commits since `f2d8fa3` ([full sha](https://github.com/kontourai/station/commit/f2d8fa36f76c0e9bce1ac9c05956215802e4c865)):

**Features**

- [#864](https://github.com/kontourai/station/pull/864) feat(release): bind native promotion to one revision
- [#849](https://github.com/kontourai/station/pull/849) feat(delegation): pin the operator-channel-only refusal detail in the promotion route test (#790, #765 D4)
- [#849](https://github.com/kontourai/station/pull/849) feat(delegation): raise entry-JS ceiling 306350 -> 306352 for the peer Station option (#790, #765 D4)
- [#849](https://github.com/kontourai/station/pull/849) feat(delegation): surface paired peer Stations in Computers and the Delegate dialog (#790, #765 D4)

**Fixes**

- [#876](https://github.com/kontourai/station/pull/876) fix(e2e): connections add-flow asserts the real contract; reconnect alerts scoped; 320px labelled-chip overlap fixed
- [#873](https://github.com/kontourai/station/pull/873) fix(ios): prevent form focus zoom
- [#870](https://github.com/kontourai/station/pull/870) fix(macos): refresh accessibility after startup reveal
- [#867](https://github.com/kontourai/station/pull/867) fix(delegation): harden peer Activity reconciliation
- [#864](https://github.com/kontourai/station/pull/864) fix(release): require channel receipts to converge
- [#866](https://github.com/kontourai/station/pull/866) fix(release): verify DMG signer before notarization
- [#866](https://github.com/kontourai/station/pull/866) fix(release): bound resumable DMG packaging
- [#864](https://github.com/kontourai/station/pull/864) fix(release): keep store preflight policy-clean
- [#867](https://github.com/kontourai/station/pull/867) fix(delegation): surface peer delegation outcomes in the delegator Activity
- [#860](https://github.com/kontourai/station/pull/860) fix(ui): occupant picker joins the drag surface and defers below 481px
- [#849](https://github.com/kontourai/station/pull/849) fix(lint): biome-ignore literal template-string assertions (fix-forward, upstream main red)
- [#860](https://github.com/kontourai/station/pull/860) fix(ui): checkpoint fix round 2 — shared chooseAmbientOccupant dispatcher (incomplete)
- [#853](https://github.com/kontourai/station/pull/853) fix(ios): unblock clean startup with 274 gzip bytes
- [#860](https://github.com/kontourai/station/pull/860) fix(ui): review round 2 — CSS ratchet, dock-and-empty picker gap, chip safety
- [#860](https://github.com/kontourai/station/pull/860) fix(ui): mobile dock-and-empty contract — refuse placeholder-only viewport
- [#860](https://github.com/kontourai/station/pull/860) fix(ui): dock-shell mobile parity — occupant picker + collapsed-height fix
- [#860](https://github.com/kontourai/station/pull/860) fix(ui): mobile chrome — safe-area under maximized dock, composer chip ellipsis

**Other**

- [#871](https://github.com/kontourai/station/pull/871) test(e2e): regenerate gallery baselines — seeded surfaces + accumulated upstream drift
- [#870](https://github.com/kontourai/station/pull/870) test(macos): pin complete accessibility reveal order
- [#871](https://github.com/kontourai/station/pull/871) test(e2e): seed connection + knowledge state instead of hiding the surfaces
- [#868](https://github.com/kontourai/station/pull/868) test(e2e): screenshot fixtures release their routes (#573)
- [#865](https://github.com/kontourai/station/pull/865) test(e2e): 320px header case pins the labelled connection-chip budget (#547)
- [#866](https://github.com/kontourai/station/pull/866) test(release): close DMG-only parser gaps
- [#860](https://github.com/kontourai/station/pull/860) test(ui): review hygiene — attributable picker-absence test, corrected spec citation
- [#860](https://github.com/kontourai/station/pull/860) test(ui): direct chooseAmbientOccupant dispatcher coverage (fix round 2 completion)
- [#853](https://github.com/kontourai/station/pull/853) test(ios): add hosted packaged-runtime smoke

## 2026-08-30T00:20:56Z · nightly-desktop · 0.1.2-nightly.2432

- Ship SHA: `f2d8fa36f76c0e9bce1ac9c05956215802e4c865`
- Artifact: github-release:nightly-desktop (station-nightly-desktop-macos-aarch64.dmg, .app.tar.gz, latest.json)

### Changelog

Commits since `15401e2` ([full sha](https://github.com/kontourai/station/commit/15401e2708722905149cbe54003bafc448d19848)):

**Features**

- [#852](https://github.com/kontourai/station/pull/852) feat(e2e): muse echo provider reachable under contained E2E runtimes — real-turn journey coverage for the muse engine family
- [#845](https://github.com/kontourai/station/pull/845) feat(ui): motion polish pass — route/list/dialog/press choreography + legacy token migration (#753)
- [#838](https://github.com/kontourai/station/pull/838) feat(ci): core-loop journey tests (#766 item 2)
- [#796](https://github.com/kontourai/station/pull/796) feat(ci): fresh-home walkthrough — mark suite-issued API calls for the console budget (#766 item 1)
- [#796](https://github.com/kontourai/station/pull/796) feat(ci): fresh-home walkthrough suite (#766 item 1)
- [#792](https://github.com/kontourai/station/pull/792) feat(feedback): add state-honesty review lens (#766 item 5)
- [#792](https://github.com/kontourai/station/pull/792) feat(feedback): add in-app Report a problem flow (#766 item 4)
- [#792](https://github.com/kontourai/station/pull/792) feat(feedback): add first-run dogfood ritual before stable cuts (#766 item 3)
- [#757](https://github.com/kontourai/station/pull/757) feat(desktop): improve tray endpoint actions

**Fixes**

- [#858](https://github.com/kontourai/station/pull/858) fix(motion): preserve responsive touch targets
- [#857](https://github.com/kontourai/station/pull/857) fix(release): set nightly macOS bundle version
- [#828](https://github.com/kontourai/station/pull/828) fix(profiles): refuse post-genesis disappearance
- [#828](https://github.com/kontourai/station/pull/828) fix(desktop): await Windows profile lock authority
- [#843](https://github.com/kontourai/station/pull/843) fix(verification): retry exact Windows owner birth probe
- [#828](https://github.com/kontourai/station/pull/828) fix(desktop): close Windows profile replacement handle
- [#850](https://github.com/kontourai/station/pull/850) fix(ui): raise entry-JS ceiling 306350 -> 306398 for the #765 residue batch
- [#850](https://github.com/kontourai/station/pull/850) fix(ui): biome import-order for the conversation-fold imports
- [#850](https://github.com/kontourai/station/pull/850) fix(ui): keep New Project Create clickable when the directory check has no verdict (#765 create-click-eating)
- [#828](https://github.com/kontourai/station/pull/828) fix(desktop): await Windows profile readers
- [#828](https://github.com/kontourai/station/pull/828) fix(desktop): retry Windows profile replacement
- [#850](https://github.com/kontourai/station/pull/850) fix(ui): stop cannot_verify flaps contradicting verified engine readiness (#765 B2)
- [#850](https://github.com/kontourai/station/pull/850) fix(ui): fold per-turn sessions into one Activity conversation row (#765 activity-turn-rows)
- [#846](https://github.com/kontourai/station/pull/846) fix(chat): make a stopped conversation continuable through the successor reserve
- [#850](https://github.com/kontourai/station/pull/850) fix(ui): redirect /review to /review-queue (#765 review-404)
- [#842](https://github.com/kontourai/station/pull/842) fix(windows): compile desktop Rust tests on PRs
- [#828](https://github.com/kontourai/station/pull/828) fix(desktop): preserve profile CAS across channels
- [#839](https://github.com/kontourai/station/pull/839) fix(desktop): retain early renderer mount before state
- [#839](https://github.com/kontourai/station/pull/839) fix(desktop): require React mount before startup reveal
- [#828](https://github.com/kontourai/station/pull/828) fix(profiles): fence markerless runtimes
- [#837](https://github.com/kontourai/station/pull/837) fix(ui): own 504-byte resource admission affordance
- [#835](https://github.com/kontourai/station/pull/835) fix(e2e): quarantine tracking pointer names the live defect issue
- [#837](https://github.com/kontourai/station/pull/837) fix(runtime): carry resource intent across every start surface
- [#837](https://github.com/kontourai/station/pull/837) fix(runtime): bind critical starts to one-shot authority
- [#833](https://github.com/kontourai/station/pull/833) fix(ui): normalize Vite hash entropy in bundle budget
- [#832](https://github.com/kontourai/station/pull/832) fix(notifications): pairing approve/deny auth wiring (#765 D5)
- [#837](https://github.com/kontourai/station/pull/837) fix(runtime): tighten posture type contracts
- [#837](https://github.com/kontourai/station/pull/837) fix(runtime): make resource admission sustained and intent-aware
- [#771](https://github.com/kontourai/station/pull/771) fix(ui): a URL change made through an open dialog survives the dialog's close
- [#828](https://github.com/kontourai/station/pull/828) fix(setup): establish profiles before local runtime
- [#828](https://github.com/kontourai/station/pull/828) fix(profiles): refuse redirected genesis children
- [#828](https://github.com/kontourai/station/pull/828) fix(profiles): harden shared-store genesis root
- [#828](https://github.com/kontourai/station/pull/828) fix(profiles): recover guarded shared-store genesis
- [#822](https://github.com/kontourai/station/pull/822) fix(taxonomy): slice-3 review round — twin constants, state-accurate referents, glossary amendment
- [#828](https://github.com/kontourai/station/pull/828) fix(profiles): fence shared-store bootstrap
- [#803](https://github.com/kontourai/station/pull/803) fix(desktop): claim the published startup ticket
- [#803](https://github.com/kontourai/station/pull/803) fix(desktop): claim directly on sidecar ticket
- [#815](https://github.com/kontourai/station/pull/815) fix(verification): bound direct Windows birth probe startup
- [#803](https://github.com/kontourai/station/pull/803) fix(desktop): advance every native owner after page start
- [#803](https://github.com/kontourai/station/pull/803) fix(desktop): remove automatic renderer readiness polling
- [#815](https://github.com/kontourai/station/pull/815) fix(verification): use direct Windows process birth authority
- [#815](https://github.com/kontourai/station/pull/815) fix(verification): space Windows birth probe retries
- [#803](https://github.com/kontourai/station/pull/803) fix(desktop): prioritize native readiness claim
- [#803](https://github.com/kontourai/station/pull/803) fix(desktop): observe readiness from native page start
- [#803](https://github.com/kontourai/station/pull/803) fix(desktop): bound native metadata readiness retry
- [#814](https://github.com/kontourai/station/pull/814) fix: defer outbound replay without consuming attempts
- [#814](https://github.com/kontourai/station/pull/814) fix: defer outbound flush until conversation revalidates
- [#803](https://github.com/kontourai/station/pull/803) fix(desktop): signal readiness before app modules load
- [#811](https://github.com/kontourai/station/pull/811) fix(verification): share Windows creation-date authority
- [#814](https://github.com/kontourai/station/pull/814) fix: recheck conversation mutability before drain dispatch
- [#814](https://github.com/kontourai/station/pull/814) fix: gate continuation drains on open state
- [#803](https://github.com/kontourai/station/pull/803) fix(desktop): coalesce native readiness wakes
- [#811](https://github.com/kontourai/station/pull/811) fix(verification): retry Windows own-process birth probe
- [#803](https://github.com/kontourai/station/pull/803) fix(desktop): bootstrap readiness through native invoke init
- [#803](https://github.com/kontourai/station/pull/803) fix(desktop): defer native host selection until document ready
- [#814](https://github.com/kontourai/station/pull/814) fix: lazy-load conversation open recovery
- [#808](https://github.com/kontourai/station/pull/808) fix(verification): reconcile fail-fast changed diagnostics
- [#803](https://github.com/kontourai/station/pull/803) fix(desktop): eager-load startup readiness proof
- [#814](https://github.com/kontourai/station/pull/814) fix: fail closed while reloading conversations
- [#814](https://github.com/kontourai/station/pull/814) fix: revalidate persisted conversation opens
- [#822](https://github.com/kontourai/station/pull/822) fix(taxonomy): conform noun vocabulary outside Connections (#592 slice 3)
- [#796](https://github.com/kontourai/station/pull/796) fix(ui): re-measure bundle ceilings after merging origin/main
- [#796](https://github.com/kontourai/station/pull/796) fix(ui): set bundle ceilings to the combined train's measured actuals
- [#814](https://github.com/kontourai/station/pull/814) fix: bind conversation opens to resolved session
- [#802](https://github.com/kontourai/station/pull/802) fix(desktop): log startup identity refusal
- [#801](https://github.com/kontourai/station/pull/801) fix(connections): registry descriptions speak the user vocabulary
- [#801](https://github.com/kontourai/station/pull/801) fix(connections): resolve M2's return-focus target at close time, not by carrying a node
- [#796](https://github.com/kontourai/station/pull/796) fix(chat): re-measure entry JS ceiling to 307748 after merging main's 306939 raise
- [#814](https://github.com/kontourai/station/pull/814) fix: resolve conversation opens authoritatively
- [#797](https://github.com/kontourai/station/pull/797) fix(desktop): keep readiness proof live under cover
- [#796](https://github.com/kontourai/station/pull/796) fix(ui): set bundle ceilings to the batch tree's measured actuals
- [#796](https://github.com/kontourai/station/pull/796) fix(tests): fail the walkthrough when a listed expected-failure passes
- [#796](https://github.com/kontourai/station/pull/796) fix(chat): raise entry JS ceiling 306937 -> 307742 for #765 chat-continuity surfaces
- [#796](https://github.com/kontourai/station/pull/796) fix(tests): match expected plugin failures on id AND message substring
- [#796](https://github.com/kontourai/station/pull/796) fix(chat): surface the turn-stall observation in the chat with a stop affordance (#765 A2)
- [#796](https://github.com/kontourai/station/pull/796) fix(chat): clear the composer draft when a send is queued behind a running turn (#765 A2)
- [#796](https://github.com/kontourai/station/pull/796) fix(chat): propagate the server's failed fold to conversation rows (#765 A2)
- [#796](https://github.com/kontourai/station/pull/796) fix(chat): translate rehydrated engine failures and keep the retry affordance (#765 A1)
- [#796](https://github.com/kontourai/station/pull/796) fix(chat): persist foreground engine sessions and refuse disproved resume cursors (#765 A1)
- [#796](https://github.com/kontourai/station/pull/796) fix(ui): never present a cancelled turn's partial text as the session's final answer
- [#796](https://github.com/kontourai/station/pull/796) fix(plugins): install registry plugins through the consent-gated build pipeline (#765 D1)
- [#801](https://github.com/kontourai/station/pull/801) fix(connections): address independent review of the Engines catalogue merge
- [#796](https://github.com/kontourai/station/pull/796) fix(notifications): classify devicePairingRequests as a public SDK query domain (#765 D5)
- [#796](https://github.com/kontourai/station/pull/796) fix(ui): raise entry JS gzip ceiling to measured 306949 (#765 B1)
- [#796](https://github.com/kontourai/station/pull/796) fix(ui): advertise the peers CLI verb the Computers page instructs (#765 D3)
- [#796](https://github.com/kontourai/station/pull/796) fix(ui): redirect bare /tasks to Home instead of 404ing (#765 D2)
- [#796](https://github.com/kontourai/station/pull/796) fix(ui): classify workspacePaneGlyphs in the coding-composition inventory (#765 F4)
- [#796](https://github.com/kontourai/station/pull/796) fix(ui): set entry JS ceiling to the pre-push hook's measured actual
- [#796](https://github.com/kontourai/station/pull/796) fix(ui): persist telemetry-disclosure dismissal and make Not now defer (#765 B1)
- [#796](https://github.com/kontourai/station/pull/796) fix(notifications): surface pairing requests as approvable attention items (#765 D5)
- [#796](https://github.com/kontourai/station/pull/796) fix(ui): raise entry bundle ceilings for the #765 design batch
- [#796](https://github.com/kontourai/station/pull/796) fix(ui): surface delegated/session results, humanize last-user-action (#765 D6)
- [#796](https://github.com/kontourai/station/pull/796) fix(ui): styled environment select, unclipped New Project footer (#765 F5)
- [#796](https://github.com/kontourai/station/pull/796) fix(ui): compact, qualified token figure on chat answers (#765 A8)
- [#796](https://github.com/kontourai/station/pull/796) fix(ui): real pane icons on workspace cards, plain section copy (#765 F4)
- [#791](https://github.com/kontourai/station/pull/791) fix(desktop): make startup cover accessible
- [#796](https://github.com/kontourai/station/pull/796) fix(ui): humanize the no-project context label to plain 'Home folder' (#765 F8)

**CI / workflow**

- [#795](https://github.com/kontourai/station/pull/795) ci(windows): require portable PR verification

**Docs**

- [#843](https://github.com/kontourai/station/pull/843) docs(test): keep resource override fixture provenance current
- [#822](https://github.com/kontourai/station/pull/822) docs(glossary): retire the last two Provider-umbrella passages; doctor label on the specific noun
- [#807](https://github.com/kontourai/station/pull/807) docs(ci): remove private runner hostname
- [#799](https://github.com/kontourai/station/pull/799) docs(testing): document required Windows PR floor

**Other**

- [#828](https://github.com/kontourai/station/pull/828) test(desktop): retain Windows profile ACL on replace
- [#828](https://github.com/kontourai/station/pull/828) test(desktop): harden Windows profile race seed
- [#828](https://github.com/kontourai/station/pull/828) test(desktop): trust Windows profile race fixture
- [#843](https://github.com/kontourai/station/pull/843) test(journeys): wait through one-shot capacity challenge
- [#843](https://github.com/kontourai/station/pull/843) test(journeys): exercise one-shot capacity admission
- [#843](https://github.com/kontourai/station/pull/843) test(e2e): await restored assistant baseline
- [#840](https://github.com/kontourai/station/pull/840) test(e2e): keep dynamic lineage authoritative
- [#840](https://github.com/kontourai/station/pull/840) test(e2e): bind fixture conversations to current sessions
- [#840](https://github.com/kontourai/station/pull/840) test(e2e): preserve exact conversation lineage
- [#840](https://github.com/kontourai/station/pull/840) test(e2e): authorize persisted chat fixtures
- [#828](https://github.com/kontourai/station/pull/828) test(desktop): race bundled profile bootstrap
- [#832](https://github.com/kontourai/station/pull/832) chore(ui): own the merged entry ceiling at measured 309069 gzip bytes (#765 D5)
- [#828](https://github.com/kontourai/station/pull/828) test(profiles): pin shared genesis lock
- [#803](https://github.com/kontourai/station/pull/803) chore(ui): record native readiness bundle savings
- [#815](https://github.com/kontourai/station/pull/815) test(verification): type direct Windows birth probe fixture
- [#803](https://github.com/kontourai/station/pull/803) chore(desktop): log native readiness handoff
- [#814](https://github.com/kontourai/station/pull/814) test: complete authoritative open integration proof
- [#814](https://github.com/kontourai/station/pull/814) test: prove completed conversations remain continuable
- [#814](https://github.com/kontourai/station/pull/814) test: cover authoritative conversation reopen
- [#806](https://github.com/kontourai/station/pull/806) test(approvals): stabilize inbox law observation on Windows
- [#757](https://github.com/kontourai/station/pull/757) perf(ui): own 58-byte rebased tray manifest delta
- [#803](https://github.com/kontourai/station/pull/803) test(desktop): pin readiness trigger in entry graph
- [#814](https://github.com/kontourai/station/pull/814) test: cover read-only conversation opens
- [#814](https://github.com/kontourai/station/pull/814) test: cover conversation open reload state
- [#796](https://github.com/kontourai/station/pull/796) style(ui): sort imports in sessionFinalOutput.test (lint:check)
- [#792](https://github.com/kontourai/station/pull/792) chore(ui): raise the entry JS gzip ceiling to the measured 306939
- [#801](https://github.com/kontourai/station/pull/801) refactor(connections): retire the dead connections-acp route type
- [#801](https://github.com/kontourai/station/pull/801) refactor(connections): merge the Engines tab's two add flows into one catalogue
- [#757](https://github.com/kontourai/station/pull/757) perf(ui): own 37-byte lazy tray manifest delta

## 2026-08-30T00:13:48Z · nightly-android · 0.1.2-nightly.2432

- Ship SHA: `f2d8fa36f76c0e9bce1ac9c05956215802e4c865`
- Artifact: play-internal-aab:io.kontourai.station.nightly@versionCode 243206
- Artifact: workflow-artifact:station-nightly-243206 (7-day retention)

### Changelog

Commits since `15401e2` ([full sha](https://github.com/kontourai/station/commit/15401e2708722905149cbe54003bafc448d19848)):

**Features**

- [#852](https://github.com/kontourai/station/pull/852) feat(e2e): muse echo provider reachable under contained E2E runtimes — real-turn journey coverage for the muse engine family
- [#845](https://github.com/kontourai/station/pull/845) feat(ui): motion polish pass — route/list/dialog/press choreography + legacy token migration (#753)
- [#838](https://github.com/kontourai/station/pull/838) feat(ci): core-loop journey tests (#766 item 2)
- [#796](https://github.com/kontourai/station/pull/796) feat(ci): fresh-home walkthrough — mark suite-issued API calls for the console budget (#766 item 1)
- [#796](https://github.com/kontourai/station/pull/796) feat(ci): fresh-home walkthrough suite (#766 item 1)
- [#792](https://github.com/kontourai/station/pull/792) feat(feedback): add state-honesty review lens (#766 item 5)
- [#792](https://github.com/kontourai/station/pull/792) feat(feedback): add in-app Report a problem flow (#766 item 4)
- [#792](https://github.com/kontourai/station/pull/792) feat(feedback): add first-run dogfood ritual before stable cuts (#766 item 3)
- [#757](https://github.com/kontourai/station/pull/757) feat(desktop): improve tray endpoint actions

**Fixes**

- [#858](https://github.com/kontourai/station/pull/858) fix(motion): preserve responsive touch targets
- [#857](https://github.com/kontourai/station/pull/857) fix(release): set nightly macOS bundle version
- [#828](https://github.com/kontourai/station/pull/828) fix(profiles): refuse post-genesis disappearance
- [#828](https://github.com/kontourai/station/pull/828) fix(desktop): await Windows profile lock authority
- [#843](https://github.com/kontourai/station/pull/843) fix(verification): retry exact Windows owner birth probe
- [#828](https://github.com/kontourai/station/pull/828) fix(desktop): close Windows profile replacement handle
- [#850](https://github.com/kontourai/station/pull/850) fix(ui): raise entry-JS ceiling 306350 -> 306398 for the #765 residue batch
- [#850](https://github.com/kontourai/station/pull/850) fix(ui): biome import-order for the conversation-fold imports
- [#850](https://github.com/kontourai/station/pull/850) fix(ui): keep New Project Create clickable when the directory check has no verdict (#765 create-click-eating)
- [#828](https://github.com/kontourai/station/pull/828) fix(desktop): await Windows profile readers
- [#828](https://github.com/kontourai/station/pull/828) fix(desktop): retry Windows profile replacement
- [#850](https://github.com/kontourai/station/pull/850) fix(ui): stop cannot_verify flaps contradicting verified engine readiness (#765 B2)
- [#850](https://github.com/kontourai/station/pull/850) fix(ui): fold per-turn sessions into one Activity conversation row (#765 activity-turn-rows)
- [#846](https://github.com/kontourai/station/pull/846) fix(chat): make a stopped conversation continuable through the successor reserve
- [#850](https://github.com/kontourai/station/pull/850) fix(ui): redirect /review to /review-queue (#765 review-404)
- [#842](https://github.com/kontourai/station/pull/842) fix(windows): compile desktop Rust tests on PRs
- [#828](https://github.com/kontourai/station/pull/828) fix(desktop): preserve profile CAS across channels
- [#839](https://github.com/kontourai/station/pull/839) fix(desktop): retain early renderer mount before state
- [#839](https://github.com/kontourai/station/pull/839) fix(desktop): require React mount before startup reveal
- [#828](https://github.com/kontourai/station/pull/828) fix(profiles): fence markerless runtimes
- [#837](https://github.com/kontourai/station/pull/837) fix(ui): own 504-byte resource admission affordance
- [#835](https://github.com/kontourai/station/pull/835) fix(e2e): quarantine tracking pointer names the live defect issue
- [#837](https://github.com/kontourai/station/pull/837) fix(runtime): carry resource intent across every start surface
- [#837](https://github.com/kontourai/station/pull/837) fix(runtime): bind critical starts to one-shot authority
- [#833](https://github.com/kontourai/station/pull/833) fix(ui): normalize Vite hash entropy in bundle budget
- [#832](https://github.com/kontourai/station/pull/832) fix(notifications): pairing approve/deny auth wiring (#765 D5)
- [#837](https://github.com/kontourai/station/pull/837) fix(runtime): tighten posture type contracts
- [#837](https://github.com/kontourai/station/pull/837) fix(runtime): make resource admission sustained and intent-aware
- [#771](https://github.com/kontourai/station/pull/771) fix(ui): a URL change made through an open dialog survives the dialog's close
- [#828](https://github.com/kontourai/station/pull/828) fix(setup): establish profiles before local runtime
- [#828](https://github.com/kontourai/station/pull/828) fix(profiles): refuse redirected genesis children
- [#828](https://github.com/kontourai/station/pull/828) fix(profiles): harden shared-store genesis root
- [#828](https://github.com/kontourai/station/pull/828) fix(profiles): recover guarded shared-store genesis
- [#822](https://github.com/kontourai/station/pull/822) fix(taxonomy): slice-3 review round — twin constants, state-accurate referents, glossary amendment
- [#828](https://github.com/kontourai/station/pull/828) fix(profiles): fence shared-store bootstrap
- [#803](https://github.com/kontourai/station/pull/803) fix(desktop): claim the published startup ticket
- [#803](https://github.com/kontourai/station/pull/803) fix(desktop): claim directly on sidecar ticket
- [#815](https://github.com/kontourai/station/pull/815) fix(verification): bound direct Windows birth probe startup
- [#803](https://github.com/kontourai/station/pull/803) fix(desktop): advance every native owner after page start
- [#803](https://github.com/kontourai/station/pull/803) fix(desktop): remove automatic renderer readiness polling
- [#815](https://github.com/kontourai/station/pull/815) fix(verification): use direct Windows process birth authority
- [#815](https://github.com/kontourai/station/pull/815) fix(verification): space Windows birth probe retries
- [#803](https://github.com/kontourai/station/pull/803) fix(desktop): prioritize native readiness claim
- [#803](https://github.com/kontourai/station/pull/803) fix(desktop): observe readiness from native page start
- [#803](https://github.com/kontourai/station/pull/803) fix(desktop): bound native metadata readiness retry
- [#814](https://github.com/kontourai/station/pull/814) fix: defer outbound replay without consuming attempts
- [#814](https://github.com/kontourai/station/pull/814) fix: defer outbound flush until conversation revalidates
- [#803](https://github.com/kontourai/station/pull/803) fix(desktop): signal readiness before app modules load
- [#811](https://github.com/kontourai/station/pull/811) fix(verification): share Windows creation-date authority
- [#814](https://github.com/kontourai/station/pull/814) fix: recheck conversation mutability before drain dispatch
- [#814](https://github.com/kontourai/station/pull/814) fix: gate continuation drains on open state
- [#803](https://github.com/kontourai/station/pull/803) fix(desktop): coalesce native readiness wakes
- [#811](https://github.com/kontourai/station/pull/811) fix(verification): retry Windows own-process birth probe
- [#803](https://github.com/kontourai/station/pull/803) fix(desktop): bootstrap readiness through native invoke init
- [#803](https://github.com/kontourai/station/pull/803) fix(desktop): defer native host selection until document ready
- [#814](https://github.com/kontourai/station/pull/814) fix: lazy-load conversation open recovery
- [#808](https://github.com/kontourai/station/pull/808) fix(verification): reconcile fail-fast changed diagnostics
- [#803](https://github.com/kontourai/station/pull/803) fix(desktop): eager-load startup readiness proof
- [#814](https://github.com/kontourai/station/pull/814) fix: fail closed while reloading conversations
- [#814](https://github.com/kontourai/station/pull/814) fix: revalidate persisted conversation opens
- [#822](https://github.com/kontourai/station/pull/822) fix(taxonomy): conform noun vocabulary outside Connections (#592 slice 3)
- [#796](https://github.com/kontourai/station/pull/796) fix(ui): re-measure bundle ceilings after merging origin/main
- [#796](https://github.com/kontourai/station/pull/796) fix(ui): set bundle ceilings to the combined train's measured actuals
- [#814](https://github.com/kontourai/station/pull/814) fix: bind conversation opens to resolved session
- [#802](https://github.com/kontourai/station/pull/802) fix(desktop): log startup identity refusal
- [#801](https://github.com/kontourai/station/pull/801) fix(connections): registry descriptions speak the user vocabulary
- [#801](https://github.com/kontourai/station/pull/801) fix(connections): resolve M2's return-focus target at close time, not by carrying a node
- [#796](https://github.com/kontourai/station/pull/796) fix(chat): re-measure entry JS ceiling to 307748 after merging main's 306939 raise
- [#814](https://github.com/kontourai/station/pull/814) fix: resolve conversation opens authoritatively
- [#797](https://github.com/kontourai/station/pull/797) fix(desktop): keep readiness proof live under cover
- [#796](https://github.com/kontourai/station/pull/796) fix(ui): set bundle ceilings to the batch tree's measured actuals
- [#796](https://github.com/kontourai/station/pull/796) fix(tests): fail the walkthrough when a listed expected-failure passes
- [#796](https://github.com/kontourai/station/pull/796) fix(chat): raise entry JS ceiling 306937 -> 307742 for #765 chat-continuity surfaces
- [#796](https://github.com/kontourai/station/pull/796) fix(tests): match expected plugin failures on id AND message substring
- [#796](https://github.com/kontourai/station/pull/796) fix(chat): surface the turn-stall observation in the chat with a stop affordance (#765 A2)
- [#796](https://github.com/kontourai/station/pull/796) fix(chat): clear the composer draft when a send is queued behind a running turn (#765 A2)
- [#796](https://github.com/kontourai/station/pull/796) fix(chat): propagate the server's failed fold to conversation rows (#765 A2)
- [#796](https://github.com/kontourai/station/pull/796) fix(chat): translate rehydrated engine failures and keep the retry affordance (#765 A1)
- [#796](https://github.com/kontourai/station/pull/796) fix(chat): persist foreground engine sessions and refuse disproved resume cursors (#765 A1)
- [#796](https://github.com/kontourai/station/pull/796) fix(ui): never present a cancelled turn's partial text as the session's final answer
- [#796](https://github.com/kontourai/station/pull/796) fix(plugins): install registry plugins through the consent-gated build pipeline (#765 D1)
- [#801](https://github.com/kontourai/station/pull/801) fix(connections): address independent review of the Engines catalogue merge
- [#796](https://github.com/kontourai/station/pull/796) fix(notifications): classify devicePairingRequests as a public SDK query domain (#765 D5)
- [#796](https://github.com/kontourai/station/pull/796) fix(ui): raise entry JS gzip ceiling to measured 306949 (#765 B1)
- [#796](https://github.com/kontourai/station/pull/796) fix(ui): advertise the peers CLI verb the Computers page instructs (#765 D3)
- [#796](https://github.com/kontourai/station/pull/796) fix(ui): redirect bare /tasks to Home instead of 404ing (#765 D2)
- [#796](https://github.com/kontourai/station/pull/796) fix(ui): classify workspacePaneGlyphs in the coding-composition inventory (#765 F4)
- [#796](https://github.com/kontourai/station/pull/796) fix(ui): set entry JS ceiling to the pre-push hook's measured actual
- [#796](https://github.com/kontourai/station/pull/796) fix(ui): persist telemetry-disclosure dismissal and make Not now defer (#765 B1)
- [#796](https://github.com/kontourai/station/pull/796) fix(notifications): surface pairing requests as approvable attention items (#765 D5)
- [#796](https://github.com/kontourai/station/pull/796) fix(ui): raise entry bundle ceilings for the #765 design batch
- [#796](https://github.com/kontourai/station/pull/796) fix(ui): surface delegated/session results, humanize last-user-action (#765 D6)
- [#796](https://github.com/kontourai/station/pull/796) fix(ui): styled environment select, unclipped New Project footer (#765 F5)
- [#796](https://github.com/kontourai/station/pull/796) fix(ui): compact, qualified token figure on chat answers (#765 A8)
- [#796](https://github.com/kontourai/station/pull/796) fix(ui): real pane icons on workspace cards, plain section copy (#765 F4)
- [#791](https://github.com/kontourai/station/pull/791) fix(desktop): make startup cover accessible
- [#796](https://github.com/kontourai/station/pull/796) fix(ui): humanize the no-project context label to plain 'Home folder' (#765 F8)

**CI / workflow**

- [#795](https://github.com/kontourai/station/pull/795) ci(windows): require portable PR verification

**Docs**

- [#843](https://github.com/kontourai/station/pull/843) docs(test): keep resource override fixture provenance current
- [#822](https://github.com/kontourai/station/pull/822) docs(glossary): retire the last two Provider-umbrella passages; doctor label on the specific noun
- [#807](https://github.com/kontourai/station/pull/807) docs(ci): remove private runner hostname
- [#799](https://github.com/kontourai/station/pull/799) docs(testing): document required Windows PR floor

**Other**

- [#828](https://github.com/kontourai/station/pull/828) test(desktop): retain Windows profile ACL on replace
- [#828](https://github.com/kontourai/station/pull/828) test(desktop): harden Windows profile race seed
- [#828](https://github.com/kontourai/station/pull/828) test(desktop): trust Windows profile race fixture
- [#843](https://github.com/kontourai/station/pull/843) test(journeys): wait through one-shot capacity challenge
- [#843](https://github.com/kontourai/station/pull/843) test(journeys): exercise one-shot capacity admission
- [#843](https://github.com/kontourai/station/pull/843) test(e2e): await restored assistant baseline
- [#840](https://github.com/kontourai/station/pull/840) test(e2e): keep dynamic lineage authoritative
- [#840](https://github.com/kontourai/station/pull/840) test(e2e): bind fixture conversations to current sessions
- [#840](https://github.com/kontourai/station/pull/840) test(e2e): preserve exact conversation lineage
- [#840](https://github.com/kontourai/station/pull/840) test(e2e): authorize persisted chat fixtures
- [#828](https://github.com/kontourai/station/pull/828) test(desktop): race bundled profile bootstrap
- [#832](https://github.com/kontourai/station/pull/832) chore(ui): own the merged entry ceiling at measured 309069 gzip bytes (#765 D5)
- [#828](https://github.com/kontourai/station/pull/828) test(profiles): pin shared genesis lock
- [#803](https://github.com/kontourai/station/pull/803) chore(ui): record native readiness bundle savings
- [#815](https://github.com/kontourai/station/pull/815) test(verification): type direct Windows birth probe fixture
- [#803](https://github.com/kontourai/station/pull/803) chore(desktop): log native readiness handoff
- [#814](https://github.com/kontourai/station/pull/814) test: complete authoritative open integration proof
- [#814](https://github.com/kontourai/station/pull/814) test: prove completed conversations remain continuable
- [#814](https://github.com/kontourai/station/pull/814) test: cover authoritative conversation reopen
- [#806](https://github.com/kontourai/station/pull/806) test(approvals): stabilize inbox law observation on Windows
- [#757](https://github.com/kontourai/station/pull/757) perf(ui): own 58-byte rebased tray manifest delta
- [#803](https://github.com/kontourai/station/pull/803) test(desktop): pin readiness trigger in entry graph
- [#814](https://github.com/kontourai/station/pull/814) test: cover read-only conversation opens
- [#814](https://github.com/kontourai/station/pull/814) test: cover conversation open reload state
- [#796](https://github.com/kontourai/station/pull/796) style(ui): sort imports in sessionFinalOutput.test (lint:check)
- [#792](https://github.com/kontourai/station/pull/792) chore(ui): raise the entry JS gzip ceiling to the measured 306939
- [#801](https://github.com/kontourai/station/pull/801) refactor(connections): retire the dead connections-acp route type
- [#801](https://github.com/kontourai/station/pull/801) refactor(connections): merge the Engines tab's two add flows into one catalogue
- [#757](https://github.com/kontourai/station/pull/757) perf(ui): own 37-byte lazy tray manifest delta

## 2026-08-29T14:30:53Z · nightly-desktop · 0.1.2-nightly.2432

- Ship SHA: `15401e2708722905149cbe54003bafc448d19848`
- Artifact: github-release:nightly-desktop (station-nightly-desktop-macos-aarch64.dmg, .app.tar.gz, latest.json)

### Changelog

Commits since `c9968e5` ([full sha](https://github.com/kontourai/station/commit/c9968e5b096c6489e4ce17215db0e26c40924635)):

**Fixes**

- [#789](https://github.com/kontourai/station/pull/789) fix(ui): pin the Registry layouts-tab eyebrow derivation (#765 F1)
- [#789](https://github.com/kontourai/station/pull/789) fix(ui): restyle the engine row Needs state as a muted warning chip (#765 B3)
- [#789](https://github.com/kontourai/station/pull/789) fix(ui): use a real glyph for the Review Queue empty state (#765 F3c)
- [#789](https://github.com/kontourai/station/pull/789) fix(ui): dedupe the Telemetry fleet empty-state sentence (#765 F3b)
- [#788](https://github.com/kontourai/station/pull/788) fix(deps): flow 5.1.1 — directory-fsync tolerance unblocks Windows
- [#787](https://github.com/kontourai/station/pull/787) fix(ci): derive the emulator smoke's launch identity from the APK

**Other**

- [#788](https://github.com/kontourai/station/pull/788) chore(ui): raise the entry JS gzip ceiling to the measured 306937

## 2026-08-29T14:27:15Z · nightly-android · 0.1.2-nightly.2432

- Ship SHA: `15401e2708722905149cbe54003bafc448d19848`
- Artifact: play-internal-aab:io.kontourai.station.nightly@versionCode 243205
- Artifact: workflow-artifact:station-nightly-243205 (7-day retention)

### Changelog

Commits since `c9968e5` ([full sha](https://github.com/kontourai/station/commit/c9968e5b096c6489e4ce17215db0e26c40924635)):

**Fixes**

- [#789](https://github.com/kontourai/station/pull/789) fix(ui): pin the Registry layouts-tab eyebrow derivation (#765 F1)
- [#789](https://github.com/kontourai/station/pull/789) fix(ui): restyle the engine row Needs state as a muted warning chip (#765 B3)
- [#789](https://github.com/kontourai/station/pull/789) fix(ui): use a real glyph for the Review Queue empty state (#765 F3c)
- [#789](https://github.com/kontourai/station/pull/789) fix(ui): dedupe the Telemetry fleet empty-state sentence (#765 F3b)
- [#788](https://github.com/kontourai/station/pull/788) fix(deps): flow 5.1.1 — directory-fsync tolerance unblocks Windows
- [#787](https://github.com/kontourai/station/pull/787) fix(ci): derive the emulator smoke's launch identity from the APK

**Other**

- [#788](https://github.com/kontourai/station/pull/788) chore(ui): raise the entry JS gzip ceiling to the measured 306937

## 2026-08-29T10:21:21Z · nightly-desktop · 0.1.2-nightly.2432

- Ship SHA: `c9968e5b096c6489e4ce17215db0e26c40924635`
- Artifact: github-release:nightly-desktop (station-nightly-desktop-macos-aarch64.dmg, .app.tar.gz, latest.json)

### Changelog

> First recorded entry for this channel; no previous ship SHA exists in the ledger, so no changelog slice was derived.

## 2026-08-29T10:08:01Z · nightly-android · 0.1.2-nightly.2432

- Ship SHA: `c9968e5b096c6489e4ce17215db0e26c40924635`
- Artifact: play-internal-aab:io.kontourai.station.nightly@versionCode 243204
- Artifact: workflow-artifact:station-nightly-243204 (7-day retention)

### Changelog

Commits since `23478d5` ([full sha](https://github.com/kontourai/station/commit/23478d54bdb96b7802b36ce490a7ab92b46fffac)):

**Fixes**

- [#786](https://github.com/kontourai/station/pull/786) fix(release): bound updater archive validation

## 2026-08-29T09:16:25Z · nightly-android · 0.1.2-nightly.2432

- Ship SHA: `23478d54bdb96b7802b36ce490a7ab92b46fffac`
- Artifact: play-internal-aab:io.kontourai.station.nightly@versionCode 243203
- Artifact: workflow-artifact:station-nightly-243203 (7-day retention)

### Changelog

Commits since `52f9ee8` ([full sha](https://github.com/kontourai/station/commit/52f9ee8fd785310a5d23281fa820694333c0b1ad)):

**Features**

- [#782](https://github.com/kontourai/station/pull/782) feat(engine): deliver the authored prompt on the session's first turn when the engine has no system-prompt channel
- [#782](https://github.com/kontourai/station/pull/782) feat(delegate): disclose agent capability-delivery receipts at the delegate seam

**Fixes**

- [#784](https://github.com/kontourai/station/pull/784) fix(release): atomically persist signing journal
- [#784](https://github.com/kontourai/station/pull/784) fix(release): validate signing readiness state
- [#784](https://github.com/kontourai/station/pull/784) fix(release): preserve keychain restore state
- [#782](https://github.com/kontourai/station/pull/782) fix(engine): close delta-review gaps in first-turn instructions disclosure
- [#784](https://github.com/kontourai/station/pull/784) fix(release): persist signing keychain lifecycle
- [#784](https://github.com/kontourai/station/pull/784) fix(release): harden signing keychain cleanup
- [#784](https://github.com/kontourai/station/pull/784) fix(release): verify macOS signing key readiness
- [#782](https://github.com/kontourai/station/pull/782) fix(engine): close review-found gaps in first-turn instructions delivery/disclosure
- [#780](https://github.com/kontourai/station/pull/780) fix(scripts): derive merged-issue facts over deduplicated pulls; name the failure
- [#782](https://github.com/kontourai/station/pull/782) fix(agent): disclose the model-field footgun for engine-bound agents

**Other**

- [#784](https://github.com/kontourai/station/pull/784) test(release): harden signing readiness faults
- [#782](https://github.com/kontourai/station/pull/782) chore(ui): raise the entry JS gzip ceiling to the measured 306934
- [#784](https://github.com/kontourai/station/pull/784) test(release): exercise signing deadline faults
- [#784](https://github.com/kontourai/station/pull/784) test(release): cover signing keychain lifecycle
- [#780](https://github.com/kontourai/station/pull/780) style: format the merge-push projection test

## 2026-08-29T07:43:10Z · nightly-android · 0.1.2-nightly.2432

- Ship SHA: `52f9ee8fd785310a5d23281fa820694333c0b1ad`
- Artifact: play-internal-aab:io.kontourai.station.nightly@versionCode 243202
- Artifact: workflow-artifact:station-nightly-243202 (7-day retention)

### Changelog

Commits since `68cd081` ([full sha](https://github.com/kontourai/station/commit/68cd081f90ef766268d856bbcb056624276310ae)):

**Fixes**

- [#779](https://github.com/kontourai/station/pull/779) fix(release): reserve nightly macOS deadline
- [#779](https://github.com/kontourai/station/pull/779) fix(release): classify bounded embedded probes
- [#779](https://github.com/kontourai/station/pull/779) fix(release): bound embedded macOS sealing
- [#778](https://github.com/kontourai/station/pull/778) fix(release): give the embedded sealing pass a batch-scaled ceiling and a heartbeat
- [#777](https://github.com/kontourai/station/pull/777) fix(server): review round — honest D3 comment, warn on unconfirmed reap
- [#777](https://github.com/kontourai/station/pull/777) fix(server): handle stdin EPIPE from dead codex app-server children
- [#775](https://github.com/kontourai/station/pull/775) fix(delegation): close round-2 review findings on #764 continuation lineage
- [#772](https://github.com/kontourai/station/pull/772) fix(install): review round — head-sha assertion, hardened marker read, reuse-path rollback
- [#775](https://github.com/kontourai/station/pull/775) fix(delegation): continue ACP/external-engine delegated tasks
- [#772](https://github.com/kontourai/station/pull/772) fix(install): stop the running instance before re-starting a reused release
- [#772](https://github.com/kontourai/station/pull/772) fix(ci): route the smoke's packaged upgrades through env for the public vars
- [#772](https://github.com/kontourai/station/pull/772) fix(ci): point the install smoke's root mirrors at install.sh's derived roots
- [#772](https://github.com/kontourai/station/pull/772) fix(shared): let the home schema gate bootstrap install.sh's data-root claim
- [#772](https://github.com/kontourai/station/pull/772) fix(ci): run the install smoke through the public manifest path
- [#772](https://github.com/kontourai/station/pull/772) fix(cli): validate the schemaVersion 2 packaged-release manifest
- [#772](https://github.com/kontourai/station/pull/772) fix(scripts): restore ecosystem dry-run executability and the cask verifier's test-url flag

**CI / workflow**

- [#772](https://github.com/kontourai/station/pull/772) ci(install-smoke): dump instance logs on failure

**Other**

- [#775](https://github.com/kontourai/station/pull/775) refactor(server): type the resume-support bridge against its producer
- [#772](https://github.com/kontourai/station/pull/772) test(install): discriminating unreadable-marker case; byte-length bound for the marker read
- [#775](https://github.com/kontourai/station/pull/775) chore: suppress noTemplateCurlyInString for nightly-build-identity literal placeholder assertion
- [#772](https://github.com/kontourai/station/pull/772) style(shared): format the installer-marker schema test

## 2026-08-29T06:25:39Z · nightly-android · 0.1.2-nightly.2432

- Ship SHA: `68cd081f90ef766268d856bbcb056624276310ae`
- Artifact: play-internal-aab:io.kontourai.station.nightly@versionCode 243201
- Artifact: workflow-artifact:station-nightly-243201 (7-day retention)

### Changelog

Commits since `b0ac1b7` ([full sha](https://github.com/kontourai/station/commit/b0ac1b7b186a9d8f941616938321d09930c2ad38)):

**Fixes**

- [#773](https://github.com/kontourai/station/pull/773) fix(chat): stabilize nightly project and agent activation reads
- [#769](https://github.com/kontourai/station/pull/769) fix(ui): label the dock copy chip and separate path from session count (#765 A7)
- [#769](https://github.com/kontourai/station/pull/769) fix(ui): pin the scrollable dock body for docked non-chat panes (#765 C1)
- [#768](https://github.com/kontourai/station/pull/768) fix(scripts): carry assertion failure text through product-law FAIL verdicts
- [#767](https://github.com/kontourai/station/pull/767) fix(desktop): admit migrated paired startup owner
- [#762](https://github.com/kontourai/station/pull/762) fix(ui): update the regex pin the literal sweep missed; smooth the found-detail copy
- [#763](https://github.com/kontourai/station/pull/763) fix(basis): select an existing pane before fallback
- [#761](https://github.com/kontourai/station/pull/761) fix(desktop): bind startup readiness to sidecar profile
- [#762](https://github.com/kontourai/station/pull/762) fix(ui): review round — scope ambiguous locators, neutralize shared readiness copy
- [#763](https://github.com/kontourai/station/pull/763) fix(basis): reject ambient panes without renderers
- [#760](https://github.com/kontourai/station/pull/760) fix(release): retain timeout wrapper through descendants
- [#762](https://github.com/kontourai/station/pull/762) fix(ui): conform Connections vocabulary to model connection / engine
- [#763](https://github.com/kontourai/station/pull/763) fix(basis): focus existing full inventory pane
- [#760](https://github.com/kontourai/station/pull/760) fix(release): retain macOS timeout group ownership
- [#763](https://github.com/kontourai/station/pull/763) fix(basis): hand off compact session inventory
- [#756](https://github.com/kontourai/station/pull/756) fix(ci): normalize ledger-only nightly commits
- [#752](https://github.com/kontourai/station/pull/752) fix(desktop): use supported AppKit cover identity
- [#747](https://github.com/kontourai/station/pull/747) fix(ci): harden the ledger token path per review
- [#751](https://github.com/kontourai/station/pull/751) fix(pairing): select exact Tailscale Serve origin
- [#747](https://github.com/kontourai/station/pull/747) fix(ci): push ledger commits with the release app's token
- [#744](https://github.com/kontourai/station/pull/744) fix(ci): enable KVM for the hosted-runner Android emulator job
- [#760](https://github.com/kontourai/station/pull/760) fix(release): bound macOS notarization commands
- [#746](https://github.com/kontourai/station/pull/746) fix(desktop): serialize native cover dispatch
- [#740](https://github.com/kontourai/station/pull/740) fix(ci): harden the tag advance and decouple ledger records from it
- [#740](https://github.com/kontourai/station/pull/740) fix(scripts): disclose an unreachable previous ship SHA instead of failing the channel
- [#740](https://github.com/kontourai/station/pull/740) fix(ci): advance rolling nightly tags via the refs API and widen the desktop timeout
- [#739](https://github.com/kontourai/station/pull/739) fix(e2e): build the plugin-preview fixture through the sanctioned ./station entry (#537)
- [#738](https://github.com/kontourai/station/pull/738) fix(ci): run container-smoke Playwright on the docker fleet
- [#736](https://github.com/kontourai/station/pull/736) fix(ci): copy lifecycle helper into the image and keep Windows on the native runner
- [#735](https://github.com/kontourai/station/pull/735) fix(desktop): harden native startup cover
- [#735](https://github.com/kontourai/station/pull/735) fix(desktop): use native startup cover on macOS
- [#734](https://github.com/kontourai/station/pull/734) fix(desktop): recover readiness after activation timeout
- [#732](https://github.com/kontourai/station/pull/732) fix(desktop): retain cold pairing window activation

**CI / workflow**

- [#733](https://github.com/kontourai/station/pull/733) ci: move public CI off the private runner onto GitHub-hosted runners

**Other**

- [#773](https://github.com/kontourai/station/pull/773) refactor(chat): own merged UI bundle delta (-18B gzip)
- [#763](https://github.com/kontourai/station/pull/763) test(chat): follow canonical new-chat binding path
- [#762](https://github.com/kontourai/station/pull/762) chore(ui): raise the entry JS gzip ceiling to the measured 306850
- [#763](https://github.com/kontourai/station/pull/763) chore(ui): account for Basis handoff bundle cost (+27 gzip)
- [#740](https://github.com/kontourai/station/pull/740) refactor(ci): trim tag-advance commentary to constraints and strengthen per-step pins
- [#740](https://github.com/kontourai/station/pull/740) style: format the unreachable-probe test fixture

## 2026-08-29T02:01:11Z · nightly-android · 0.1.2-nightly.2432

- Ship SHA: `b0ac1b7b186a9d8f941616938321d09930c2ad38`
- Artifact: play-internal-aab:io.kontourai.station.nightly@versionCode 243200
- Artifact: workflow-artifact:station-nightly-243200 (7-day retention)
- Note: Recorded after the fact: run 33225213529 published to the Play internal testing track, then failed at the tag-advance step before its ledger steps could run. timestampUtc is the Play upload step's completion time (2026-08-29T02:01:11Z), used verbatim.

### Changelog

> Changelog slice omitted: previous ship SHA c4229f4 is not reachable in this repository's history, so no commit range exists to derive.

## 2026-08-28T16:30:48Z · stable-npm · 0.7.0

- Ship SHA: `b4fe42e5cc089fc95f8f513d549d78b82f198d96`
- Artifact: npm:@kontourai/station-shared@0.7.0 (dist-tag latest)
- Note: Recorded late: published in run 33188020921 alongside station-contracts@0.7.0, but the ledger loop refused this row as a duplicate — the identity lacked the package name and three packages shared version 0.7.0 at one sha (fixed in the change carrying this row). Same run also recorded five tag-only private packages as npm ships; those fabricated rows are removed in the same change.

### Changelog

> slice carried by the same run's station-contracts row (same sha, same publish)

## 2026-08-28T16:30:48Z · stable-npm · 0.7.0

- Ship SHA: `b4fe42e5cc089fc95f8f513d549d78b82f198d96`
- Artifact: npm:@kontourai/station-sdk@0.7.0 (dist-tag latest)
- Note: Recorded late: published in run 33188020921 alongside station-contracts@0.7.0, but the ledger loop refused this row as a duplicate — the identity lacked the package name and three packages shared version 0.7.0 at one sha (fixed in the change carrying this row). Same run also recorded five tag-only private packages as npm ships; those fabricated rows are removed in the same change.

### Changelog

> slice carried by the same run's station-contracts row (same sha, same publish)

## 2026-08-28T16:25:30Z · stable-npm · 0.7.0

- Ship SHA: `b4fe42e5cc089fc95f8f513d549d78b82f198d96`
- Artifact: npm:@kontourai/station-contracts@0.7.0 (dist-tag latest)

### Changelog

> Changelog slice omitted: this ship is a same-sha companion of stable-npm 0.5.1 (recorded at b4fe42e) — no commits exist between same-sha ships, so the slice would repeat that entry's.

## 2026-08-27T10:54:02Z · nightly-android · 0.1.2-nightly.2430

- Ship SHA: `c4229f43f7569e96874c25356d1199fa01cbfec1`
- Artifact: play-internal-aab:io.kontourai.station.nightly@versionCode 243000
- Artifact: workflow-artifact:station-nightly-243000 (7-day retention, archive outcome recorded in the run)
- Note: PRE-RESET SHIP (2026-08-28 history reset): the sha and tags reference the archived pre-reset history (kontourai/station-archive) and do not exist in this repository's single-root history; the run URL has been repointed to the archive, where the run records live. The ship itself (Play internal, versionCode 243000) is real and unaffected.
- Note: Seeded from observable history (station#4572): version 0.1.2-nightly.2430 = day 2430 build 0 = versionCode 243000; the immutable reservation tag refs/tags/nightly-version-code/243000 and the rolling refs/tags/nightly both point at the recorded sha; nightly run 33064078473 (created 2026-08-27T10:40:51Z) concluded success with its nightly job completing 2026-08-27T10:54:02Z — used verbatim as timestampUtc; the publish moment inside the job is not separately observable.
- Note: Owner's brief dated this ship 2026-08-26 (local time); UTC day 2430 is 2026-08-27, which is what the version and run timestamps record.

### Changelog

> First recorded entry for this channel; no previous ship SHA exists in the ledger, so no changelog slice was derived.
