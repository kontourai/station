# Deploy ledger

Every ship this repository makes, recorded by the workflow that shipped it — the answer to "on this date, this version was deployed; how out of date am I?" (archive#4572).

## Machine-readable source of truth

- JSON (stable location, newest first): [`docs/reference/deploy-ledger.json`](deploy-ledger.json) on `main`. This public repository makes the current ledger readable at [the raw JSON URL](https://raw.githubusercontent.com/kontourai/station/main/docs/reference/deploy-ledger.json).
- This markdown view is generated from that JSON by `scripts/deploy-ledger.mjs`; it is a projection, never edited by hand.

### JSON schema (one array element per ship)

- `timestampUtc` — ISO 8601 UTC. When the recording workflow step ran (immediately after the publish it records); never in the future.
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
