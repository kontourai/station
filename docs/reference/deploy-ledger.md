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
| 2026-08-29T06:25:39Z | nightly-android | 0.1.2-nightly.2432 | `68cd081` | nightly test-gate success on 68cd081f90ef766268d856bbcb056624276310ae (station#4539) | [run](https://github.com/kontourai/station/actions/runs/33237355902) |
| 2026-08-29T02:01:11Z | nightly-android | 0.1.2-nightly.2432 | `b0ac1b7` | nightly test-gate success on b0ac1b7b186a9d8f941616938321d09930c2ad38 (station#4539) | [run](https://github.com/kontourai/station/actions/runs/33225213529) |
| 2026-08-28T16:30:48Z | stable-npm | 0.7.0 | `b4fe42e` | npm trusted-publisher OIDC preflight success; changeset publish from refs/heads/main (b4fe42e5cc089fc95f8f513d549d78b82f198d96) | [run](https://github.com/kontourai/station/actions/runs/33188020921) |
| 2026-08-28T16:30:48Z | stable-npm | 0.7.0 | `b4fe42e` | npm trusted-publisher OIDC preflight success; changeset publish from refs/heads/main (b4fe42e5cc089fc95f8f513d549d78b82f198d96) | [run](https://github.com/kontourai/station/actions/runs/33188020921) |
| 2026-08-28T16:25:30Z | stable-npm | 0.7.0 | `b4fe42e` | npm trusted-publisher OIDC preflight success; changeset publish from refs/heads/main (b4fe42e5cc089fc95f8f513d549d78b82f198d96) | [run](https://github.com/kontourai/station/actions/runs/33188020921) |
| 2026-08-27T10:54:02Z | nightly-android | 0.1.2-nightly.2430 | `c4229f4` | no test gate existed for this ship: the nightly test gate landed after it (station#4565 merged 2026-08-27T16:04:07Z, this nightly job completed 2026-08-27T10:54:02Z) | [run](https://github.com/kontourai/station-archive/actions/runs/33064078473) |

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
- [#736](https://github.com/kontourai/station/pull/736) fix(ci): copy lifecycle helper into the image and keep Windows on desktop-win
- [#735](https://github.com/kontourai/station/pull/735) fix(desktop): harden native startup cover
- [#735](https://github.com/kontourai/station/pull/735) fix(desktop): use native startup cover on macOS
- [#734](https://github.com/kontourai/station/pull/734) fix(desktop): recover readiness after activation timeout
- [#732](https://github.com/kontourai/station/pull/732) fix(desktop): retain cold pairing window activation

**CI / workflow**

- [#733](https://github.com/kontourai/station/pull/733) ci: move public CI off desktop-win onto GitHub-hosted runners

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
