# Deploy ledger

Release records appended by the publishing workflows, plus explicitly qualified historical entries (archive#4572). Check each record's source revision, workflow and caveats; this ledger is not proof that every attempted publication succeeded or was recorded.

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

The public raw JSON URL can be read without authentication. Publishing workflows invoke the appender for their shipped surfaces and use a separate commit-back step. A publication and its ledger update can fail independently; this Markdown cannot establish completeness or current artifact availability. Consumers may read the JSON directly or copy it under their own caching and refresh policy. Because `main` moves, retain each entry’s `sha` and `workflowRunUrl` rather than treating a later fetch as an immutable release receipt.

## Ledger

| Date (UTC) | Channel | Version | Ship SHA | Gate | Run |
| --- | --- | --- | --- | --- | --- |
| 2026-10-08T06:55:08Z | nightly-android | 0.1.11-nightly.2472 | `8a8f382` | native cohort final receipt complete | [run](https://github.com/kontourai/station/actions/runs/37735427039) |
| 2026-10-08T06:31:44Z | nightly-npm | 0.7.0-nightly.2472.37735427039 | `8a8f382` | Nightly exact gates success; npm registry gitHead equals source SHA | [run](https://github.com/kontourai/station/actions/runs/37735427039) |
| 2026-10-06T01:13:15Z | nightly-desktop | 0.1.11-nightly.2470 | `353dfd9` | native cohort final receipt complete | [run](https://github.com/kontourai/station/actions/runs/37392869133) |
| 2026-10-06T01:13:11Z | nightly-android | 0.1.11-nightly.2470 | `353dfd9` | native cohort final receipt complete | [run](https://github.com/kontourai/station/actions/runs/37392869133) |
| 2026-10-06T00:40:03Z | nightly-npm | 0.7.0-nightly.2470.37392869133 | `353dfd9` | Nightly exact gates success; npm registry gitHead equals source SHA | [run](https://github.com/kontourai/station/actions/runs/37392869133) |
| 2026-10-02T15:39:03Z | nightly-desktop | 0.1.11-nightly.2466.3 | `e7fb9b3` | native cohort final receipt complete | [run](https://github.com/kontourai/station/actions/runs/37021990417) |
| 2026-10-02T15:38:59Z | nightly-android | 0.1.11-nightly.2466.3 | `e7fb9b3` | native cohort final receipt complete | [run](https://github.com/kontourai/station/actions/runs/37021990417) |
| 2026-10-02T15:36:40Z | nightly-npm | 0.7.0-nightly.2466.37021990417 | `e7fb9b3` | Nightly exact gates success; npm registry gitHead equals source SHA | [run](https://github.com/kontourai/station/actions/runs/37021990417) |
| 2026-10-02T13:20:33Z | nightly-desktop | 0.1.11-nightly.2466.2 | `1c46287` | native cohort final receipt complete | [run](https://github.com/kontourai/station/actions/runs/37006002202) |
| 2026-10-02T13:20:31Z | nightly-android | 0.1.11-nightly.2466.2 | `1c46287` | native cohort final receipt complete | [run](https://github.com/kontourai/station/actions/runs/37006002202) |
| 2026-10-02T13:16:04Z | nightly-npm | 0.7.0-nightly.2466.37006002202 | `1c46287` | Nightly exact gates success; npm registry gitHead equals source SHA | [run](https://github.com/kontourai/station/actions/runs/37006002202) |
| 2026-10-02T06:39:22Z | nightly-desktop | 0.1.11-nightly.2466.1 | `2ed63fc` | native cohort final receipt complete | [run](https://github.com/kontourai/station/actions/runs/36968209089) |
| 2026-10-02T06:39:20Z | nightly-android | 0.1.11-nightly.2466.1 | `2ed63fc` | native cohort final receipt complete | [run](https://github.com/kontourai/station/actions/runs/36968209089) |
| 2026-10-02T06:29:08Z | nightly-npm | 0.7.0-nightly.2466.36968209089 | `2ed63fc` | Nightly exact gates success; npm registry gitHead equals source SHA | [run](https://github.com/kontourai/station/actions/runs/36968209089) |
| 2026-10-01T14:30:43Z | nightly-desktop | 0.1.11-nightly.2465.1 | `a91c50d` | native cohort final receipt complete | [run](https://github.com/kontourai/station/actions/runs/36865249714) |
| 2026-10-01T14:30:40Z | nightly-android | 0.1.11-nightly.2465.1 | `a91c50d` | native cohort final receipt complete | [run](https://github.com/kontourai/station/actions/runs/36865249714) |
| 2026-10-01T14:08:22Z | nightly-npm | 0.7.0-nightly.2465.36865249714 | `a91c50d` | Nightly exact gates success; npm registry gitHead equals source SHA | [run](https://github.com/kontourai/station/actions/runs/36865249714) |
| 2026-10-01T07:13:08Z | nightly-desktop | 0.1.11-nightly.2465 | `3b001e5` | native cohort final receipt complete | [run](https://github.com/kontourai/station/actions/runs/36819975981) |
| 2026-10-01T07:13:05Z | nightly-android | 0.1.11-nightly.2465 | `3b001e5` | native cohort final receipt complete | [run](https://github.com/kontourai/station/actions/runs/36819975981) |
| 2026-10-01T06:47:09Z | nightly-npm | 0.7.0-nightly.2465.36819975981 | `3b001e5` | Nightly exact gates success; npm registry gitHead equals source SHA | [run](https://github.com/kontourai/station/actions/runs/36819975981) |
| 2026-09-30T23:10:29Z | nightly-desktop | 0.1.11-nightly.2464.3 | `4dbf9ac` | native cohort final receipt complete | [run](https://github.com/kontourai/station/actions/runs/36783703696) |
| 2026-09-30T23:10:26Z | nightly-android | 0.1.11-nightly.2464.3 | `4dbf9ac` | native cohort final receipt complete | [run](https://github.com/kontourai/station/actions/runs/36783703696) |
| 2026-09-30T23:03:25Z | nightly-npm | 0.6.0-nightly.2464.36783703696 | `4dbf9ac` | Nightly exact gates success; npm registry gitHead equals source SHA | [run](https://github.com/kontourai/station/actions/runs/36783703696) |
| 2026-09-30T20:34:00Z | nightly-desktop | 0.1.11-nightly.2464.2 | `5ecd682` | native cohort final receipt complete | [run](https://github.com/kontourai/station/actions/runs/36767826654) |
| 2026-09-30T20:33:57Z | nightly-android | 0.1.11-nightly.2464.2 | `5ecd682` | native cohort final receipt complete | [run](https://github.com/kontourai/station/actions/runs/36767826654) |
| 2026-09-30T20:29:52Z | nightly-npm | 0.6.0-nightly.2464.36767826654 | `5ecd682` | Nightly exact gates success; npm registry gitHead equals source SHA | [run](https://github.com/kontourai/station/actions/runs/36767826654) |
| 2026-09-30T06:25:54Z | nightly-desktop | 0.1.11-nightly.2464 | `e27600d` | native cohort final receipt complete | [run](https://github.com/kontourai/station/actions/runs/36672468094) |
| 2026-09-30T06:25:51Z | nightly-android | 0.1.11-nightly.2464 | `e27600d` | native cohort final receipt complete | [run](https://github.com/kontourai/station/actions/runs/36672468094) |
| 2026-09-30T06:22:05Z | nightly-npm | 0.6.0-nightly.2464.36672468094 | `e27600d` | Nightly exact gates success; npm registry gitHead equals source SHA | [run](https://github.com/kontourai/station/actions/runs/36672468094) |
| 2026-09-29T23:54:41Z | nightly-desktop | 0.1.11-nightly.2463.3 | `fa78d02` | native cohort final receipt complete | [run](https://github.com/kontourai/station/actions/runs/36637714147) |
| 2026-09-29T23:54:39Z | nightly-android | 0.1.11-nightly.2463.3 | `fa78d02` | native cohort final receipt complete | [run](https://github.com/kontourai/station/actions/runs/36637714147) |
| 2026-09-29T23:19:11Z | nightly-npm | 0.6.0-nightly.2463.36637714147 | `fa78d02` | Nightly exact gates success; npm registry gitHead equals source SHA | [run](https://github.com/kontourai/station/actions/runs/36637714147) |
| 2026-09-29T13:27:53Z | nightly-desktop | 0.1.11-nightly.2463.2 | `0690c93` | native cohort final receipt complete | [run](https://github.com/kontourai/station/actions/runs/36569268737) |
| 2026-09-29T13:27:50Z | nightly-android | 0.1.11-nightly.2463.2 | `0690c93` | native cohort final receipt complete | [run](https://github.com/kontourai/station/actions/runs/36569268737) |
| 2026-09-29T13:20:39Z | nightly-npm | 0.6.0-nightly.2463.36569268737 | `0690c93` | Nightly exact gates success; npm registry gitHead equals source SHA | [run](https://github.com/kontourai/station/actions/runs/36569268737) |
| 2026-09-29T06:59:09Z | nightly-desktop | 0.1.11-nightly.2463.1 | `e8cbb94` | native cohort final receipt partial | [run](https://github.com/kontourai/station/actions/runs/36526165983) |
| 2026-09-29T06:54:46Z | nightly-npm | 0.6.0-nightly.2463.36526165983 | `e8cbb94` | Nightly exact gates success; npm registry gitHead equals source SHA | [run](https://github.com/kontourai/station/actions/runs/36526165983) |
| 2026-09-29T05:51:27Z | nightly-desktop | 0.1.11-nightly.2463 | `99f9520` | native cohort final receipt complete | [run](https://github.com/kontourai/station/actions/runs/36520805311) |
| 2026-09-29T05:51:25Z | nightly-android | 0.1.11-nightly.2463 | `99f9520` | native cohort final receipt complete | [run](https://github.com/kontourai/station/actions/runs/36520805311) |
| 2026-09-29T05:21:53Z | nightly-npm | 0.6.0-nightly.2463.36520805311 | `99f9520` | Nightly exact gates success; npm registry gitHead equals source SHA | [run](https://github.com/kontourai/station/actions/runs/36520805311) |
| 2026-09-29T00:28:17Z | nightly-desktop | 0.1.11-nightly.2462.3 | `ec29a87` | native cohort final receipt complete | [run](https://github.com/kontourai/station/actions/runs/36497491629) |
| 2026-09-29T00:28:15Z | nightly-android | 0.1.11-nightly.2462.3 | `ec29a87` | native cohort final receipt complete | [run](https://github.com/kontourai/station/actions/runs/36497491629) |
| 2026-09-29T00:19:44Z | nightly-npm | 0.6.0-nightly.2462.36497491629 | `ec29a87` | Nightly exact gates success; npm registry gitHead equals source SHA | [run](https://github.com/kontourai/station/actions/runs/36497491629) |
| 2026-09-28T20:32:01Z | nightly-desktop | 0.1.11-nightly.2462.2 | `d0ca944` | native cohort final receipt complete | [run](https://github.com/kontourai/station/actions/runs/36471134637) |
| 2026-09-28T20:31:58Z | nightly-android | 0.1.11-nightly.2462.2 | `d0ca944` | native cohort final receipt complete | [run](https://github.com/kontourai/station/actions/runs/36471134637) |
| 2026-09-28T20:28:33Z | nightly-npm | 0.6.0-nightly.2462.36471134637 | `d0ca944` | Nightly exact gates success; npm registry gitHead equals source SHA | [run](https://github.com/kontourai/station/actions/runs/36471134637) |
| 2026-09-28T15:27:48Z | nightly-desktop | 0.1.11-nightly.2462.1 | `a30f084` | native cohort final receipt complete | [run](https://github.com/kontourai/station/actions/runs/36429714384) |
| 2026-09-28T15:27:44Z | nightly-android | 0.1.11-nightly.2462.1 | `a30f084` | native cohort final receipt complete | [run](https://github.com/kontourai/station/actions/runs/36429714384) |
| 2026-09-28T14:45:05Z | nightly-npm | 0.6.0-nightly.2462.36429714384 | `a30f084` | Nightly exact gates success; npm registry gitHead equals source SHA | [run](https://github.com/kontourai/station/actions/runs/36429714384) |
| 2026-09-28T06:21:17Z | nightly-desktop | 0.1.11-nightly.2462 | `ef6e2f0` | native cohort final receipt complete | [run](https://github.com/kontourai/station/actions/runs/36380121606) |
| 2026-09-28T06:21:14Z | nightly-android | 0.1.11-nightly.2462 | `ef6e2f0` | native cohort final receipt complete | [run](https://github.com/kontourai/station/actions/runs/36380121606) |
| 2026-09-28T06:04:26Z | nightly-npm | 0.6.0-nightly.2462.36380121606 | `ef6e2f0` | Nightly exact gates success; npm registry gitHead equals source SHA | [run](https://github.com/kontourai/station/actions/runs/36380121606) |
| 2026-09-27T22:24:20Z | nightly-desktop | 0.1.11-nightly.2461.3 | `9d39d40` | native cohort final receipt complete | [run](https://github.com/kontourai/station/actions/runs/36350925838) |
| 2026-09-27T22:24:17Z | nightly-android | 0.1.11-nightly.2461.3 | `9d39d40` | native cohort final receipt complete | [run](https://github.com/kontourai/station/actions/runs/36350925838) |
| 2026-09-27T22:14:54Z | nightly-npm | 0.6.0-nightly.2461.36350925838 | `9d39d40` | Nightly exact gates success; npm registry gitHead equals source SHA | [run](https://github.com/kontourai/station/actions/runs/36350925838) |
| 2026-09-27T18:18:23Z | nightly-desktop | 0.1.11-nightly.2461.2 | `73e3cda` | native cohort final receipt complete | [run](https://github.com/kontourai/station/actions/runs/36334655311) |
| 2026-09-27T18:18:20Z | nightly-android | 0.1.11-nightly.2461.2 | `73e3cda` | native cohort final receipt complete | [run](https://github.com/kontourai/station/actions/runs/36334655311) |
| 2026-09-27T17:55:24Z | nightly-npm | 0.6.0-nightly.2461.36334655311 | `73e3cda` | Nightly exact gates success; npm registry gitHead equals source SHA | [run](https://github.com/kontourai/station/actions/runs/36334655311) |
| 2026-09-27T12:43:28Z | nightly-desktop | 0.1.11-nightly.2461.1 | `b61a6d5` | native cohort final receipt complete | [run](https://github.com/kontourai/station/actions/runs/36317054434) |
| 2026-09-27T12:43:25Z | nightly-android | 0.1.11-nightly.2461.1 | `b61a6d5` | native cohort final receipt complete | [run](https://github.com/kontourai/station/actions/runs/36317054434) |
| 2026-09-27T12:39:12Z | nightly-npm | 0.6.0-nightly.2461.36317054434 | `b61a6d5` | Nightly exact gates success; npm registry gitHead equals source SHA | [run](https://github.com/kontourai/station/actions/runs/36317054434) |
| 2026-09-27T06:24:37Z | nightly-desktop | 0.1.11-nightly.2461 | `bda38d3` | native cohort final receipt complete | [run](https://github.com/kontourai/station/actions/runs/36295895609) |
| 2026-09-27T06:24:34Z | nightly-android | 0.1.11-nightly.2461 | `bda38d3` | native cohort final receipt complete | [run](https://github.com/kontourai/station/actions/runs/36295895609) |
| 2026-09-27T06:04:02Z | nightly-npm | 0.6.0-nightly.2461.36295895609 | `bda38d3` | Nightly exact gates success; npm registry gitHead equals source SHA | [run](https://github.com/kontourai/station/actions/runs/36295895609) |
| 2026-09-26T17:34:01Z | nightly-desktop | 0.1.11-nightly.2460.4 | `719e004` | native cohort final receipt complete | [run](https://github.com/kontourai/station/actions/runs/36254706366) |
| 2026-09-26T17:33:59Z | nightly-android | 0.1.11-nightly.2460.4 | `719e004` | native cohort final receipt complete | [run](https://github.com/kontourai/station/actions/runs/36254706366) |
| 2026-09-26T17:18:51Z | nightly-npm | 0.6.0-nightly.2460.36254706366 | `719e004` | Nightly exact gates success; npm registry gitHead equals source SHA | [run](https://github.com/kontourai/station/actions/runs/36254706366) |
| 2026-09-26T16:24:11Z | nightly-desktop | 0.1.11-nightly.2460.3 | `3c43c43` | native cohort final receipt complete | [run](https://github.com/kontourai/station/actions/runs/36252766737) |
| 2026-09-26T16:24:09Z | nightly-android | 0.1.11-nightly.2460.3 | `3c43c43` | native cohort final receipt complete | [run](https://github.com/kontourai/station/actions/runs/36252766737) |
| 2026-09-26T16:21:23Z | nightly-npm | 0.6.0-nightly.2460.36252766737 | `3c43c43` | Nightly exact gates success; npm registry gitHead equals source SHA | [run](https://github.com/kontourai/station/actions/runs/36252766737) |
| 2026-09-26T12:10:51Z | nightly-npm | 0.6.0-nightly.2460.36238106182 | `fe8660d` | Nightly exact gates success; npm registry gitHead equals source SHA | [run](https://github.com/kontourai/station/actions/runs/36238106182) |
| 2026-09-26T06:19:12Z | nightly-npm | 0.6.0-nightly.2460.36218473798 | `73b5db6` | Nightly exact gates success; npm registry gitHead equals source SHA | [run](https://github.com/kontourai/station/actions/runs/36218473798) |
| 2026-09-25T23:08:06Z | nightly-desktop | 0.1.11-nightly.2459.3 | `a279a57` | native cohort final receipt complete | [run](https://github.com/kontourai/station/actions/runs/36191456945) |
| 2026-09-25T23:08:02Z | nightly-android | 0.1.11-nightly.2459.3 | `a279a57` | native cohort final receipt complete | [run](https://github.com/kontourai/station/actions/runs/36191456945) |
| 2026-09-25T22:16:16Z | nightly-npm | 0.6.0-nightly.2459.36191456945 | `a279a57` | Nightly exact gates success; npm registry gitHead equals source SHA | [run](https://github.com/kontourai/station/actions/runs/36191456945) |
| 2026-09-25T18:47:12Z | nightly-desktop | 0.1.11-nightly.2459.2 | `20c6e65` | native cohort final receipt complete | [run](https://github.com/kontourai/station/actions/runs/36164412979) |
| 2026-09-25T18:47:08Z | nightly-android | 0.1.11-nightly.2459.2 | `20c6e65` | native cohort final receipt complete | [run](https://github.com/kontourai/station/actions/runs/36164412979) |
| 2026-09-25T18:06:31Z | nightly-npm | 0.6.0-nightly.2459.36164412979 | `20c6e65` | Nightly exact gates success; npm registry gitHead equals source SHA | [run](https://github.com/kontourai/station/actions/runs/36164412979) |
| 2026-09-25T13:13:53Z | nightly-desktop | 0.1.11-nightly.2459.1 | `73fd03c` | native cohort final receipt complete | [run](https://github.com/kontourai/station/actions/runs/36130497746) |
| 2026-09-25T13:13:50Z | nightly-android | 0.1.11-nightly.2459.1 | `73fd03c` | native cohort final receipt complete | [run](https://github.com/kontourai/station/actions/runs/36130497746) |
| 2026-09-25T12:32:31Z | nightly-npm | 0.6.0-nightly.2459.36130497746 | `73fd03c` | Nightly exact gates success; npm registry gitHead equals source SHA | [run](https://github.com/kontourai/station/actions/runs/36130497746) |
| 2026-09-25T05:50:30Z | nightly-desktop | 0.1.11-nightly.2459 | `bdc00df` | native cohort final receipt complete | [run](https://github.com/kontourai/station/actions/runs/36095097383) |
| 2026-09-25T05:50:26Z | nightly-android | 0.1.11-nightly.2459 | `bdc00df` | native cohort final receipt complete | [run](https://github.com/kontourai/station/actions/runs/36095097383) |
| 2026-09-25T05:37:05Z | nightly-npm | 0.6.0-nightly.2459.36095097383 | `bdc00df` | Nightly exact gates success; npm registry gitHead equals source SHA | [run](https://github.com/kontourai/station/actions/runs/36095097383) |
| 2026-09-24T22:28:31Z | nightly-desktop | 0.1.11-nightly.2458.6 | `f18562c` | native cohort final receipt complete | [run](https://github.com/kontourai/station/actions/runs/36061294532) |
| 2026-09-24T22:28:28Z | nightly-android | 0.1.11-nightly.2458.6 | `f18562c` | native cohort final receipt complete | [run](https://github.com/kontourai/station/actions/runs/36061294532) |
| 2026-09-24T22:24:13Z | nightly-npm | 0.6.0-nightly.2458.36061294532 | `f18562c` | Nightly exact gates success; npm registry gitHead equals source SHA | [run](https://github.com/kontourai/station/actions/runs/36061294532) |
| 2026-09-24T17:56:23Z | nightly-desktop | 0.1.11-nightly.2458.5 | `e390f5a` | native cohort final receipt partial | [run](https://github.com/kontourai/station/actions/runs/36031064921) |
| 2026-09-24T17:49:08Z | nightly-npm | 0.6.0-nightly.2458.36031064921 | `e390f5a` | Nightly exact gates success; npm registry gitHead equals source SHA | [run](https://github.com/kontourai/station/actions/runs/36031064921) |
| 2026-09-24T12:31:36Z | nightly-desktop | 0.1.11-nightly.2458.4 | `847ec8d` | native cohort final receipt complete | [run](https://github.com/kontourai/station/actions/runs/35993578648) |
| 2026-09-24T12:31:32Z | nightly-android | 0.1.11-nightly.2458.4 | `847ec8d` | native cohort final receipt complete | [run](https://github.com/kontourai/station/actions/runs/35993578648) |
| 2026-09-24T12:27:21Z | nightly-npm | 0.6.0-nightly.2458.35993578648 | `847ec8d` | Nightly exact gates success; npm registry gitHead equals source SHA | [run](https://github.com/kontourai/station/actions/runs/35993578648) |
| 2026-09-24T05:19:34Z | nightly-desktop | 0.1.11-nightly.2458.3 | `3ab9ce1` | native cohort final receipt complete | [run](https://github.com/kontourai/station/actions/runs/35955520672) |
| 2026-09-24T05:19:31Z | nightly-android | 0.1.11-nightly.2458.3 | `3ab9ce1` | native cohort final receipt complete | [run](https://github.com/kontourai/station/actions/runs/35955520672) |
| 2026-09-24T05:16:07Z | nightly-npm | 0.6.0-nightly.2458.35955520672 | `3ab9ce1` | Nightly exact gates success; npm registry gitHead equals source SHA | [run](https://github.com/kontourai/station/actions/runs/35955520672) |
| 2026-09-24T03:22:42Z | nightly-desktop | 0.1.11-nightly.2458.2 | `7bc3cc6` | native cohort final receipt complete | [run](https://github.com/kontourai/station/actions/runs/35945178538) |
| 2026-09-24T03:22:39Z | nightly-android | 0.1.11-nightly.2458.2 | `7bc3cc6` | native cohort final receipt complete | [run](https://github.com/kontourai/station/actions/runs/35945178538) |
| 2026-09-24T03:16:24Z | nightly-npm | 0.6.0-nightly.2458.35945178538 | `7bc3cc6` | Nightly exact gates success; npm registry gitHead equals source SHA | [run](https://github.com/kontourai/station/actions/runs/35945178538) |
| 2026-09-24T02:27:24Z | nightly-desktop | 0.1.11-nightly.2458.1 | `1bfdde4` | native cohort final receipt complete | [run](https://github.com/kontourai/station/actions/runs/35941621675) |
| 2026-09-24T02:27:21Z | nightly-android | 0.1.11-nightly.2458.1 | `1bfdde4` | native cohort final receipt complete | [run](https://github.com/kontourai/station/actions/runs/35941621675) |
| 2026-09-24T02:23:57Z | nightly-npm | 0.6.0-nightly.2458.35941621675 | `1bfdde4` | Nightly exact gates success; npm registry gitHead equals source SHA | [run](https://github.com/kontourai/station/actions/runs/35941621675) |
| 2026-09-23T17:38:49Z | nightly-desktop | 0.1.11-nightly.2457.2 | `ac819b5` | native cohort final receipt complete | [run](https://github.com/kontourai/station/actions/runs/35890429058) |
| 2026-09-23T17:38:45Z | nightly-android | 0.1.11-nightly.2457.2 | `ac819b5` | native cohort final receipt complete | [run](https://github.com/kontourai/station/actions/runs/35890429058) |
| 2026-09-22T22:04:19Z | nightly-desktop | 0.1.11-nightly.2456.1 | `0015690` | native cohort final receipt complete | [run](https://github.com/kontourai/station/actions/runs/35784910501) |
| 2026-09-22T22:04:15Z | nightly-android | 0.1.11-nightly.2456.1 | `0015690` | native cohort final receipt complete | [run](https://github.com/kontourai/station/actions/runs/35784910501) |
| 2026-09-22T21:59:05Z | nightly-npm | 0.6.0-nightly.2456.35784910501 | `0015690` | Nightly exact gates success; npm registry gitHead equals source SHA | [run](https://github.com/kontourai/station/actions/runs/35784910501) |
| 2026-09-22T17:34:38Z | nightly-npm | 0.6.0-nightly.2456.35756143372 | `a294ead` | Nightly exact gates success; npm registry gitHead equals source SHA | [run](https://github.com/kontourai/station/actions/runs/35756143372) |
| 2026-09-22T12:10:11Z | nightly-npm | 0.6.0-nightly.2456.35721103767 | `3d3b656` | Nightly exact gates success; npm registry gitHead equals source SHA | [run](https://github.com/kontourai/station/actions/runs/35721103767) |
| 2026-09-22T05:16:09Z | nightly-desktop | 0.1.11-nightly.2456 | `8b599ec` | native cohort final receipt complete | [run](https://github.com/kontourai/station/actions/runs/35687186254) |
| 2026-09-22T05:16:06Z | nightly-android | 0.1.11-nightly.2456 | `8b599ec` | native cohort final receipt complete | [run](https://github.com/kontourai/station/actions/runs/35687186254) |
| 2026-09-22T05:12:56Z | nightly-npm | 0.6.0-nightly.2456.35687186254 | `8b599ec` | Nightly exact gates success; npm registry gitHead equals source SHA | [run](https://github.com/kontourai/station/actions/runs/35687186254) |
| 2026-09-20T11:53:33Z | nightly-npm | 0.6.0-nightly.2454.35506930127 | `6a52072` | Nightly exact gates success; npm registry gitHead equals source SHA | [run](https://github.com/kontourai/station/actions/runs/35506930127) |
| 2026-09-20T05:15:52Z | nightly-npm | 0.6.0-nightly.2454.35489589152 | `49543b7` | Nightly exact gates success; npm registry gitHead equals source SHA | [run](https://github.com/kontourai/station/actions/runs/35489589152) |
| 2026-09-19T21:13:57Z | nightly-npm | 0.6.0-nightly.2453.35467424270 | `d0ab3de` | Nightly exact gates success; npm registry gitHead equals source SHA | [run](https://github.com/kontourai/station/actions/runs/35467424270) |
| 2026-09-19T18:36:05Z | nightly-desktop | 0.1.11-nightly.2453.5 | `79b6112` | native cohort final receipt complete | [run](https://github.com/kontourai/station/actions/runs/35459320578) |
| 2026-09-19T18:36:02Z | nightly-android | 0.1.11-nightly.2453.5 | `79b6112` | native cohort final receipt complete | [run](https://github.com/kontourai/station/actions/runs/35459320578) |
| 2026-09-19T18:29:37Z | nightly-npm | 0.6.0-nightly.2453.35459320578 | `79b6112` | Nightly exact gates success; npm registry gitHead equals source SHA | [run](https://github.com/kontourai/station/actions/runs/35459320578) |
| 2026-09-19T11:35:25Z | nightly-desktop | 0.1.11-nightly.2453.1 | `1ad69f6` | native cohort final receipt complete | [run](https://github.com/kontourai/station/actions/runs/35438202313) |
| 2026-09-19T11:35:22Z | nightly-android | 0.1.11-nightly.2453.1 | `1ad69f6` | native cohort final receipt complete | [run](https://github.com/kontourai/station/actions/runs/35438202313) |
| 2026-09-19T11:30:29Z | nightly-npm | 0.6.0-nightly.2453.35438202313 | `1ad69f6` | Nightly exact gates success; npm registry gitHead equals source SHA | [run](https://github.com/kontourai/station/actions/runs/35438202313) |
| 2026-09-19T05:00:18Z | nightly-desktop | 0.1.11-nightly.2453 | `5b6383e` | native cohort final receipt complete | [run](https://github.com/kontourai/station/actions/runs/35420920112) |
| 2026-09-19T05:00:15Z | nightly-android | 0.1.11-nightly.2453 | `5b6383e` | native cohort final receipt complete | [run](https://github.com/kontourai/station/actions/runs/35420920112) |
| 2026-09-19T04:56:00Z | nightly-npm | 0.6.0-nightly.2453.35420920112 | `5b6383e` | Nightly exact gates success; npm registry gitHead equals source SHA | [run](https://github.com/kontourai/station/actions/runs/35420920112) |
| 2026-09-18T05:12:07Z | nightly-desktop | 0.1.11-nightly.2452 | `26b4dec` | native cohort final receipt complete | [run](https://github.com/kontourai/station/actions/runs/35306644320) |
| 2026-09-18T05:12:04Z | nightly-android | 0.1.11-nightly.2452 | `26b4dec` | native cohort final receipt complete | [run](https://github.com/kontourai/station/actions/runs/35306644320) |
| 2026-09-18T05:06:29Z | nightly-npm | 0.6.0-nightly.2452.35306644320 | `26b4dec` | Nightly exact gates success; npm registry gitHead equals source SHA | [run](https://github.com/kontourai/station/actions/runs/35306644320) |
| 2026-09-17T22:12:01Z | nightly-desktop | 0.1.11-nightly.2451.3 | `c479c21` | native cohort final receipt complete | [run](https://github.com/kontourai/station/actions/runs/35275391814) |
| 2026-09-17T22:11:58Z | nightly-android | 0.1.11-nightly.2451.3 | `c479c21` | native cohort final receipt complete | [run](https://github.com/kontourai/station/actions/runs/35275391814) |
| 2026-09-17T21:59:18Z | nightly-npm | 0.6.0-nightly.2451.35275391814 | `c479c21` | Nightly exact gates success; npm registry gitHead equals source SHA | [run](https://github.com/kontourai/station/actions/runs/35275391814) |
| 2026-09-17T20:25:45Z | nightly-android | 0.1.11-nightly.2451.2 | `adfba3a` | native cohort final receipt partial | [run](https://github.com/kontourai/station/actions/runs/35265013644) |
| 2026-09-17T20:13:41Z | nightly-npm | 0.6.0-nightly.2451.35265013644 | `adfba3a` | Nightly exact gates success; npm registry gitHead equals source SHA | [run](https://github.com/kontourai/station/actions/runs/35265013644) |
| 2026-09-17T17:54:52Z | nightly-android | 0.1.11-nightly.2451.1 | `fa83684` | native cohort final receipt partial | [run](https://github.com/kontourai/station/actions/runs/35248613245) |
| 2026-09-17T17:30:49Z | nightly-npm | 0.6.0-nightly.2451.35248613245 | `fa83684` | Nightly exact gates success; npm registry gitHead equals source SHA | [run](https://github.com/kontourai/station/actions/runs/35248613245) |
| 2026-09-17T12:05:26Z | nightly-npm | 0.6.0-nightly.2451.35215764545 | `d858401` | Nightly exact gates success; npm registry gitHead equals source SHA | [run](https://github.com/kontourai/station/actions/runs/35215764545) |
| 2026-09-17T05:13:39Z | nightly-npm | 0.6.0-nightly.2451.35182540277 | `9a437a4` | Nightly exact gates success; npm registry gitHead equals source SHA | [run](https://github.com/kontourai/station/actions/runs/35182540277) |
| 2026-09-17T02:50:36Z | nightly-desktop | 0.1.11-nightly.2451 | `ea101d6` | native cohort final receipt complete | [run](https://github.com/kontourai/station/actions/runs/35172665354) |
| 2026-09-17T02:50:33Z | nightly-android | 0.1.11-nightly.2451 | `ea101d6` | native cohort final receipt complete | [run](https://github.com/kontourai/station/actions/runs/35172665354) |
| 2026-09-17T02:45:30Z | nightly-npm | 0.6.0-nightly.2451.35172665354 | `ea101d6` | Nightly exact gates success; npm registry gitHead equals source SHA | [run](https://github.com/kontourai/station/actions/runs/35172665354) |
| 2026-09-15T21:22:59Z | nightly-desktop | 0.1.11-nightly.2449.5 | `b9f05fe` | native cohort final receipt complete | [run](https://github.com/kontourai/station/actions/runs/35020162279) |
| 2026-09-15T21:22:56Z | nightly-android | 0.1.11-nightly.2449.5 | `b9f05fe` | native cohort final receipt complete | [run](https://github.com/kontourai/station/actions/runs/35020162279) |
| 2026-09-15T21:16:27Z | nightly-npm | 0.6.0-nightly.2449.35020162279 | `b9f05fe` | Nightly exact gates success; npm registry gitHead equals source SHA | [run](https://github.com/kontourai/station/actions/runs/35020162279) |
| 2026-09-15T17:35:14Z | nightly-desktop | 0.1.11-nightly.2449.4 | `e8c0b1b` | native cohort final receipt complete | [run](https://github.com/kontourai/station/actions/runs/34997120268) |
| 2026-09-15T17:35:12Z | nightly-android | 0.1.11-nightly.2449.4 | `e8c0b1b` | native cohort final receipt complete | [run](https://github.com/kontourai/station/actions/runs/34997120268) |
| 2026-09-15T17:28:29Z | nightly-npm | 0.6.0-nightly.2449.34997120268 | `e8c0b1b` | Nightly exact gates success; npm registry gitHead equals source SHA | [run](https://github.com/kontourai/station/actions/runs/34997120268) |
| 2026-09-15T16:06:17Z | nightly-desktop | 0.1.11-nightly.2449.3 | `1701011` | native cohort final receipt complete | [run](https://github.com/kontourai/station/actions/runs/34987268974) |
| 2026-09-15T16:06:14Z | nightly-android | 0.1.11-nightly.2449.3 | `1701011` | native cohort final receipt complete | [run](https://github.com/kontourai/station/actions/runs/34987268974) |
| 2026-09-15T15:59:32Z | nightly-npm | 0.6.0-nightly.2449.34987268974 | `1701011` | Nightly exact gates success; npm registry gitHead equals source SHA | [run](https://github.com/kontourai/station/actions/runs/34987268974) |
| 2026-09-15T12:24:07Z | nightly-desktop | 0.1.11-nightly.2449.2 | `9f05d7a` | native cohort final receipt complete | [run](https://github.com/kontourai/station/actions/runs/34963886217) |
| 2026-09-15T12:24:03Z | nightly-android | 0.1.11-nightly.2449.2 | `9f05d7a` | native cohort final receipt complete | [run](https://github.com/kontourai/station/actions/runs/34963886217) |
| 2026-09-15T12:15:41Z | nightly-npm | 0.6.0-nightly.2449.34963886217 | `9f05d7a` | Nightly exact gates success; npm registry gitHead equals source SHA | [run](https://github.com/kontourai/station/actions/runs/34963886217) |
| 2026-09-12T16:03:48Z | nightly-npm | 0.6.0-nightly.2446.34702144379 | `eb93cd4` | Nightly exact gates success; npm registry gitHead equals source SHA | [run](https://github.com/kontourai/station/actions/runs/34702144379) |
| 2026-09-12T15:12:53Z | nightly-desktop | 0.1.11-nightly.2446 | `f4ee278` | native cohort final receipt complete | [run](https://github.com/kontourai/station/actions/runs/34699081987) |
| 2026-09-12T15:12:50Z | nightly-android | 0.1.11-nightly.2446 | `f4ee278` | native cohort final receipt complete | [run](https://github.com/kontourai/station/actions/runs/34699081987) |
| 2026-09-12T15:05:54Z | nightly-npm | 0.6.0-nightly.2446.34699081987 | `f4ee278` | Nightly exact gates success; npm registry gitHead equals source SHA | [run](https://github.com/kontourai/station/actions/runs/34699081987) |
| 2026-09-12T11:13:24Z | nightly-npm | 0.6.0-nightly.2446.34688699784 | `e330d3e` | Nightly exact gates success; npm registry gitHead equals source SHA | [run](https://github.com/kontourai/station/actions/runs/34688699784) |
| 2026-09-12T04:47:15Z | nightly-npm | 0.6.0-nightly.2446.34672535343 | `6ed7890` | Nightly exact gates success; npm registry gitHead equals source SHA | [run](https://github.com/kontourai/station/actions/runs/34672535343) |
| 2026-09-12T00:02:24Z | nightly-desktop | 0.1.11-nightly.2445.8 | `71e0381` | native cohort final receipt complete | [run](https://github.com/kontourai/station/actions/runs/34657340502) |
| 2026-09-12T00:02:22Z | nightly-android | 0.1.11-nightly.2445.8 | `71e0381` | native cohort final receipt complete | [run](https://github.com/kontourai/station/actions/runs/34657340502) |
| 2026-09-11T23:55:13Z | nightly-npm | 0.6.0-nightly.2445.34657340502 | `71e0381` | Nightly exact gates success; npm registry gitHead equals source SHA | [run](https://github.com/kontourai/station/actions/runs/34657340502) |
| 2026-09-11T11:49:49Z | nightly-desktop | 0.1.11-nightly.2445.5 | `4e7ccc7` | native cohort final receipt complete | [run](https://github.com/kontourai/station/actions/runs/34592166222) |
| 2026-09-11T11:49:47Z | nightly-android | 0.1.11-nightly.2445.5 | `4e7ccc7` | native cohort final receipt complete | [run](https://github.com/kontourai/station/actions/runs/34592166222) |
| 2026-09-11T11:43:48Z | nightly-npm | 0.6.0-nightly.2445.34592166222 | `4e7ccc7` | Nightly exact gates success; npm registry gitHead equals source SHA | [run](https://github.com/kontourai/station/actions/runs/34592166222) |
| 2026-09-09T14:00:58Z | nightly-desktop | 0.1.11-nightly.2443.2 | `49cfa59` | native cohort final receipt complete | [run](https://github.com/kontourai/station/actions/runs/34355735437) |
| 2026-09-09T14:00:51Z | nightly-android | 0.1.11-nightly.2443.2 | `49cfa59` | native cohort final receipt complete | [run](https://github.com/kontourai/station/actions/runs/34355735437) |
| 2026-09-09T13:52:04Z | nightly-npm | 0.6.0-nightly.2443.34355735437 | `49cfa59` | Nightly exact gates success; npm registry gitHead equals source SHA | [run](https://github.com/kontourai/station/actions/runs/34355735437) |
| 2026-09-09T02:49:16Z | nightly-desktop | 0.1.11-nightly.2443.1 | `a7935a4` | native cohort final receipt complete | [run](https://github.com/kontourai/station/actions/runs/34301435508) |
| 2026-09-09T02:49:10Z | nightly-android | 0.1.11-nightly.2443.1 | `a7935a4` | native cohort final receipt complete | [run](https://github.com/kontourai/station/actions/runs/34301435508) |
| 2026-09-09T02:43:48Z | nightly-npm | 0.6.0-nightly.2443.34301435508 | `a7935a4` | Nightly exact gates success; npm registry gitHead equals source SHA | [run](https://github.com/kontourai/station/actions/runs/34301435508) |
| 2026-09-08T17:23:06Z | nightly-desktop | 0.1.11-nightly.2442.5 | `fd2c04e` | native cohort final receipt complete | [run](https://github.com/kontourai/station/actions/runs/34252063142) |
| 2026-09-08T17:23:00Z | nightly-android | 0.1.11-nightly.2442.5 | `fd2c04e` | native cohort final receipt complete | [run](https://github.com/kontourai/station/actions/runs/34252063142) |
| 2026-09-08T17:13:07Z | nightly-npm | 0.6.0-nightly.2442.34252063142 | `fd2c04e` | Nightly exact gates success; npm registry gitHead equals source SHA | [run](https://github.com/kontourai/station/actions/runs/34252063142) |
| 2026-09-08T16:34:52Z | nightly-android | 0.1.11-nightly.2442.4 | `9ef6da4` | native cohort final receipt partial | [run](https://github.com/kontourai/station/actions/runs/34247229018) |
| 2026-09-08T16:28:03Z | nightly-npm | 0.6.0-nightly.2442.34247229018 | `9ef6da4` | Nightly exact gates success; npm registry gitHead equals source SHA | [run](https://github.com/kontourai/station/actions/runs/34247229018) |
| 2026-09-08T14:27:53Z | nightly-npm | 0.6.0-nightly.2442.34234368088 | `92b5e7b` | Nightly exact gates success; npm registry gitHead equals source SHA | [run](https://github.com/kontourai/station/actions/runs/34234368088) |
| 2026-09-08T13:45:30Z | nightly-npm | 0.6.0-nightly.2442.34230188430 | `5dda86f` | Nightly exact gates success; npm registry gitHead equals source SHA | [run](https://github.com/kontourai/station/actions/runs/34230188430) |
| 2026-09-08T10:24:53Z | nightly-npm | 0.6.0-nightly.2442.34211909749 | `370c33e` | Nightly exact gates success; npm registry gitHead equals source SHA | [run](https://github.com/kontourai/station/actions/runs/34211909749) |
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

## 2026-10-08T06:55:08Z · nightly-android · 0.1.11-nightly.2472

- Ship SHA: `8a8f38298ef2e0a64c8fb1e1c48b312099f088cb`
- Artifact built at: `2026-10-08T06:27:32.476Z` (not provider upload/record time)
- Artifact: play-internal-aab:cohort-finalized
- Note: ios: TestFlight delivery success (run 37735427039)

### Changelog

Commits since `353dfd9` ([full sha](https://github.com/kontourai/station/commit/353dfd913bc2837d47a6fc5cede97858a32e32fe)):

**Features**

- [#3490](https://github.com/kontourai/station/pull/3490) feat(chat): redesign shared start and choose a Station for tasks
- [#3388](https://github.com/kontourai/station/pull/3388) feat(chat): one mobile bottom sheet for elicitation forms and approvals (#3331)
- [#3249](https://github.com/kontourai/station/pull/3249) feat: add IAM relay invitations and compact mobile device controls
- [#3449](https://github.com/kontourai/station/pull/3449) feat(automation): contracts, unattended principal, store and ledger (#3439 S1)
- [#3385](https://github.com/kontourai/station/pull/3385) feat(profile): show reconciled Station usage with a compact operator view
- [#3306](https://github.com/kontourai/station/pull/3306) feat(mcp): prompts as slash commands and form elicitation (#3284 slice 1)
- [#3259](https://github.com/kontourai/station/pull/3259) feat(projects): add tool defaults and Knowledge stores
- [#3428](https://github.com/kontourai/station/pull/3428) feat(station-control): list_project_activity, get_session_digest and a read_conversation anchor (#3413 A)
- [#3468](https://github.com/kontourai/station/pull/3468) feat(chat): one work row per settled turn on phones
- [#3452](https://github.com/kontourai/station/pull/3452) feat(transcript): show context-compacted and rewound markers
- [#3434](https://github.com/kontourai/station/pull/3434) feat(activity): show OpenCode conversations started outside Station
- [#3212](https://github.com/kontourai/station/pull/3212) feat(server): refuse client API protocols below the advertised minimum (#2962)
- [#3433](https://github.com/kontourai/station/pull/3433) feat(activity): show Grok CLI conversations started outside Station
- [#3435](https://github.com/kontourai/station/pull/3435) feat(activity): Continue in Station for worktree and No project conversations
- [#3409](https://github.com/kontourai/station/pull/3409) feat(cli): station environment access revoke and remove; panel names the host commands (#3256)

**Fixes**

- [#3501](https://github.com/kontourai/station/pull/3501) fix(tooling): restore Windows qualification checks
- [#3498](https://github.com/kontourai/station/pull/3498) fix(tooling): collect bounded context probes concurrently
- [#3492](https://github.com/kontourai/station/pull/3492) fix(connect): preserve explicitly promoted relay access
- [#3497](https://github.com/kontourai/station/pull/3497) fix(ci): bootstrap Ubuntu prerequisites from trusted workflow source
- [#3494](https://github.com/kontourai/station/pull/3494) fix(guardrails): require public usage attribution export
- [#3491](https://github.com/kontourai/station/pull/3491) fix(chat): preserve folded approval through the mobile request sheet (#3149)
- [#3479](https://github.com/kontourai/station/pull/3479) fix(ci): retain nested readiness failure diagnostics
- [#3476](https://github.com/kontourai/station/pull/3476) fix(ci): accept private-only plans and migrated public review prose
- [#3473](https://github.com/kontourai/station/pull/3473) fix(chat): retain form input across transcript remounts
- [#3474](https://github.com/kontourai/station/pull/3474) fix(ci): create version PRs with scoped GitHub App authentication
- [#3213](https://github.com/kontourai/station/pull/3213) fix(packaging): include bundled Station marketplace in distributions
- [#3471](https://github.com/kontourai/station/pull/3471) fix(ci): load landing helpers from the trusted workflow revision
- [#3297](https://github.com/kontourai/station/pull/3297) fix(claude): recognize selected macOS secure-store readiness
- [#3445](https://github.com/kontourai/station/pull/3445) fix(security): repair advisory graph and bind formatter acceptance
- [#3443](https://github.com/kontourai/station/pull/3443) fix(security): a paired device needs coding:exec to choose a folder, a command or code (#3441)
- [#3455](https://github.com/kontourai/station/pull/3455) fix(activity): read outside-session folders in a helper process so a hung mount can't freeze Station
- [#3454](https://github.com/kontourai/station/pull/3454) fix(continuation): open continued conversations in the dock and keep follow-ups in their folder
- [#3450](https://github.com/kontourai/station/pull/3450) fix(projects): resolve a session's preview workspace from its start record
- [#3383](https://github.com/kontourai/station/pull/3383) fix(engines): dock header uses the catalog engine; refuse ACP ids native engines own (#3355)
- [#3446](https://github.com/kontourai/station/pull/3446) fix(tooling): probe Windows Tauri CLIs through Node
- [#3444](https://github.com/kontourai/station/pull/3444) fix(ci): stage bundled examples before Windows Rust compilation
- [#3424](https://github.com/kontourai/station/pull/3424) fix(gallery): keep the Settings frame visible and validate complete captures
- [#3442](https://github.com/kontourai/station/pull/3442) fix(child-work): Muse children settle with their full usage; reported usage fields stay sticky
- [#3437](https://github.com/kontourai/station/pull/3437) fix(acp): startAll clears the previous probe timer before arming a new one (#3421)

**CI / workflow**

- [#3393](https://github.com/kontourai/station/pull/3393) ci(queue): explain merge-queue removals on the PR and re-arm queue-ahead conflicts (#3101 C, E)
- [#3438](https://github.com/kontourai/station/pull/3438) ci(qualification-repair): no automated repair agent unless explicitly configured

**Docs**

- [#3478](https://github.com/kontourai/station/pull/3478) docs: visualize release process and faster Nightly design
- [#3448](https://github.com/kontourai/station/pull/3448) docs(design): propose Station Automations (#3439 S0)

**Other**

- [#3466](https://github.com/kontourai/station/pull/3466) test(e2e): assert the Coding rail's active-mode state and settle the sheet entrance
- [#3472](https://github.com/kontourai/station/pull/3472) test(windows): repair native path and workflow shell fixtures
- [#3469](https://github.com/kontourai/station/pull/3469) test(projects): bind checkout fixture remotes by exact path
- [#3453](https://github.com/kontourai/station/pull/3453) test(protocol): align caller keepers with canonical headers
- [#3451](https://github.com/kontourai/station/pull/3451) chore: finish the identity scrub follow-ups
- [#3436](https://github.com/kontourai/station/pull/3436) test(coding): let the FIFO worktree case run on git that omits the registration
- [#3432](https://github.com/kontourai/station/pull/3432) chore(test): rename media-server host fixtures to a neutral name
- [#3431](https://github.com/kontourai/station/pull/3431) test(knowledge): a VoltAgent turn strips the tool purpose and reads the knowledge result

## 2026-10-08T06:31:44Z · nightly-npm · 0.7.0-nightly.2472.37735427039

- Ship SHA: `8a8f38298ef2e0a64c8fb1e1c48b312099f088cb`
- Artifact built at: `unknown` (no immutable artifact manifest binding)
- Artifact: npm:@kontourai/station-cli@0.7.0-nightly.2472.37735427039 (dist-tag nightly; artifactBuiltAt unknown)
- Note: artifactBuiltAt is null: npm package has no native artifact manifest

### Changelog

Commits since `353dfd9` ([full sha](https://github.com/kontourai/station/commit/353dfd913bc2837d47a6fc5cede97858a32e32fe)):

**Features**

- [#3490](https://github.com/kontourai/station/pull/3490) feat(chat): redesign shared start and choose a Station for tasks
- [#3388](https://github.com/kontourai/station/pull/3388) feat(chat): one mobile bottom sheet for elicitation forms and approvals (#3331)
- [#3249](https://github.com/kontourai/station/pull/3249) feat: add IAM relay invitations and compact mobile device controls
- [#3449](https://github.com/kontourai/station/pull/3449) feat(automation): contracts, unattended principal, store and ledger (#3439 S1)
- [#3385](https://github.com/kontourai/station/pull/3385) feat(profile): show reconciled Station usage with a compact operator view
- [#3306](https://github.com/kontourai/station/pull/3306) feat(mcp): prompts as slash commands and form elicitation (#3284 slice 1)
- [#3259](https://github.com/kontourai/station/pull/3259) feat(projects): add tool defaults and Knowledge stores
- [#3428](https://github.com/kontourai/station/pull/3428) feat(station-control): list_project_activity, get_session_digest and a read_conversation anchor (#3413 A)
- [#3468](https://github.com/kontourai/station/pull/3468) feat(chat): one work row per settled turn on phones
- [#3452](https://github.com/kontourai/station/pull/3452) feat(transcript): show context-compacted and rewound markers
- [#3434](https://github.com/kontourai/station/pull/3434) feat(activity): show OpenCode conversations started outside Station
- [#3212](https://github.com/kontourai/station/pull/3212) feat(server): refuse client API protocols below the advertised minimum (#2962)
- [#3433](https://github.com/kontourai/station/pull/3433) feat(activity): show Grok CLI conversations started outside Station
- [#3435](https://github.com/kontourai/station/pull/3435) feat(activity): Continue in Station for worktree and No project conversations
- [#3409](https://github.com/kontourai/station/pull/3409) feat(cli): station environment access revoke and remove; panel names the host commands (#3256)

**Fixes**

- [#3501](https://github.com/kontourai/station/pull/3501) fix(tooling): restore Windows qualification checks
- [#3498](https://github.com/kontourai/station/pull/3498) fix(tooling): collect bounded context probes concurrently
- [#3492](https://github.com/kontourai/station/pull/3492) fix(connect): preserve explicitly promoted relay access
- [#3497](https://github.com/kontourai/station/pull/3497) fix(ci): bootstrap Ubuntu prerequisites from trusted workflow source
- [#3494](https://github.com/kontourai/station/pull/3494) fix(guardrails): require public usage attribution export
- [#3491](https://github.com/kontourai/station/pull/3491) fix(chat): preserve folded approval through the mobile request sheet (#3149)
- [#3479](https://github.com/kontourai/station/pull/3479) fix(ci): retain nested readiness failure diagnostics
- [#3476](https://github.com/kontourai/station/pull/3476) fix(ci): accept private-only plans and migrated public review prose
- [#3473](https://github.com/kontourai/station/pull/3473) fix(chat): retain form input across transcript remounts
- [#3474](https://github.com/kontourai/station/pull/3474) fix(ci): create version PRs with scoped GitHub App authentication
- [#3213](https://github.com/kontourai/station/pull/3213) fix(packaging): include bundled Station marketplace in distributions
- [#3471](https://github.com/kontourai/station/pull/3471) fix(ci): load landing helpers from the trusted workflow revision
- [#3297](https://github.com/kontourai/station/pull/3297) fix(claude): recognize selected macOS secure-store readiness
- [#3445](https://github.com/kontourai/station/pull/3445) fix(security): repair advisory graph and bind formatter acceptance
- [#3443](https://github.com/kontourai/station/pull/3443) fix(security): a paired device needs coding:exec to choose a folder, a command or code (#3441)
- [#3455](https://github.com/kontourai/station/pull/3455) fix(activity): read outside-session folders in a helper process so a hung mount can't freeze Station
- [#3454](https://github.com/kontourai/station/pull/3454) fix(continuation): open continued conversations in the dock and keep follow-ups in their folder
- [#3450](https://github.com/kontourai/station/pull/3450) fix(projects): resolve a session's preview workspace from its start record
- [#3383](https://github.com/kontourai/station/pull/3383) fix(engines): dock header uses the catalog engine; refuse ACP ids native engines own (#3355)
- [#3446](https://github.com/kontourai/station/pull/3446) fix(tooling): probe Windows Tauri CLIs through Node
- [#3444](https://github.com/kontourai/station/pull/3444) fix(ci): stage bundled examples before Windows Rust compilation
- [#3424](https://github.com/kontourai/station/pull/3424) fix(gallery): keep the Settings frame visible and validate complete captures
- [#3442](https://github.com/kontourai/station/pull/3442) fix(child-work): Muse children settle with their full usage; reported usage fields stay sticky
- [#3437](https://github.com/kontourai/station/pull/3437) fix(acp): startAll clears the previous probe timer before arming a new one (#3421)

**CI / workflow**

- [#3393](https://github.com/kontourai/station/pull/3393) ci(queue): explain merge-queue removals on the PR and re-arm queue-ahead conflicts (#3101 C, E)
- [#3438](https://github.com/kontourai/station/pull/3438) ci(qualification-repair): no automated repair agent unless explicitly configured

**Docs**

- [#3478](https://github.com/kontourai/station/pull/3478) docs: visualize release process and faster Nightly design
- [#3448](https://github.com/kontourai/station/pull/3448) docs(design): propose Station Automations (#3439 S0)

**Other**

- [#3466](https://github.com/kontourai/station/pull/3466) test(e2e): assert the Coding rail's active-mode state and settle the sheet entrance
- [#3472](https://github.com/kontourai/station/pull/3472) test(windows): repair native path and workflow shell fixtures
- [#3469](https://github.com/kontourai/station/pull/3469) test(projects): bind checkout fixture remotes by exact path
- [#3453](https://github.com/kontourai/station/pull/3453) test(protocol): align caller keepers with canonical headers
- [#3451](https://github.com/kontourai/station/pull/3451) chore: finish the identity scrub follow-ups
- [#3436](https://github.com/kontourai/station/pull/3436) test(coding): let the FIFO worktree case run on git that omits the registration
- [#3432](https://github.com/kontourai/station/pull/3432) chore(test): rename media-server host fixtures to a neutral name
- [#3431](https://github.com/kontourai/station/pull/3431) test(knowledge): a VoltAgent turn strips the tool purpose and reads the knowledge result

## 2026-10-06T01:13:15Z · nightly-desktop · 0.1.11-nightly.2470

- Ship SHA: `353dfd913bc2837d47a6fc5cede97858a32e32fe`
- Artifact built at: `2026-10-06T00:38:10.511Z` (not provider upload/record time)
- Artifact: github-release:nightly-desktop (cohort-finalized)
- Note: ios: TestFlight delivery success (run 37392869133)

### Changelog

Commits since `e7fb9b3` ([full sha](https://github.com/kontourai/station/commit/e7fb9b3161de5d6a3e006ad9760ced9c862130c8)):

**Features**

- [#3420](https://github.com/kontourai/station/pull/3420) feat(docs): compact landed review notes into immutable archives at baseline advance (#3394)
- [#3407](https://github.com/kontourai/station/pull/3407) feat(activity): show outside conversations in worktrees and outside any project
- [#3346](https://github.com/kontourai/station/pull/3346) feat(attention): answer a paired Station's question, and open its tasks in Activity everywhere
- [#3203](https://github.com/kontourai/station/pull/3203) feat(connections): make proxy setup and routing visible
- [#3298](https://github.com/kontourai/station/pull/3298) feat(integrations): per-principal connected accounts (slice 1)
- [#3299](https://github.com/kontourai/station/pull/3299) feat(agents): versioned Agent audience and member-caller gate (#3276 slice 1)
- [#3243](https://github.com/kontourai/station/pull/3243) feat(pairing): observe off-host operator-credential use; operator device-access design (#2894)
- [#3371](https://github.com/kontourai/station/pull/3371) feat(start): one start composer on Home and in the dock — one way to start a chat
- [#3230](https://github.com/kontourai/station/pull/3230) feat(control): agents can wait on, message and interrupt Sessions in their Project (#3160)
- [#3379](https://github.com/kontourai/station/pull/3379) feat(usage): count delegated tasks Station linked to a conversation but you can't read as missing
- [#3366](https://github.com/kontourai/station/pull/3366) feat(projects): project icons — one validated rule, shown everywhere a project appears, settable after creation
- [#3368](https://github.com/kontourai/station/pull/3368) feat(new-chat): the remembered Agent per context is live on every mounted surface
- [#3369](https://github.com/kontourai/station/pull/3369) feat(dock): the collapsed bar and the empty dock offer the one New chat action
- [#3319](https://github.com/kontourai/station/pull/3319) feat(identity): operator passkey enrollment on the consent origin (#3257 S2b)
- [#3353](https://github.com/kontourai/station/pull/3353) feat(home): Home's work rows carry the inbox's branch and project colour
- [#3261](https://github.com/kontourai/station/pull/3261) feat(install): install.ps1 installs, upgrades and uninstalls the Windows archive (#2675 W2)
- [#3271](https://github.com/kontourai/station/pull/3271) feat(station-control): external engines declare pull requests; Tasks close out on merge (#3161)
- [#3324](https://github.com/kontourai/station/pull/3324) feat(usage): roll up a conversation's usage with its subagents and delegated tasks, with a breakdown
- [#3239](https://github.com/kontourai/station/pull/3239) feat(ui): one duration, one group heading and one flat Earlier on every work surface
- [#3315](https://github.com/kontourai/station/pull/3315) feat(attention): answer a paired Station's approval from the inbox and Activity
- [#3313](https://github.com/kontourai/station/pull/3313) feat(recovery): usage-limit banner with Resume now and Cancel auto-resume (#3157)
- [#3244](https://github.com/kontourai/station/pull/3244) feat(delegation): version-matched execution preparation, slice 1 (#2875)
- [#3263](https://github.com/kontourai/station/pull/3263) feat(station-control): search_sessions and rename_session tools (#176)
- [#3189](https://github.com/kontourai/station/pull/3189) feat(agents): show each subagent's own model and a read-only transcript (#3163)
- [#3301](https://github.com/kontourai/station/pull/3301) feat(ci): publish the Nightly from the qualification run that passed (dormant until enabled)
- [#3208](https://github.com/kontourai/station/pull/3208) feat(station-control): read a conversation a person referenced
- [#3289](https://github.com/kontourai/station/pull/3289) feat(consent): optional HTTPS consent origin (#3257 S2a)
- [#3231](https://github.com/kontourai/station/pull/3231) feat(coding): quiet chrome for the Diff pane, pull requests view and review
- [#3268](https://github.com/kontourai/station/pull/3268) feat(cli): supported dev mode with live reload; stop never kills a sibling Station (#3253, #3254)
- [#3188](https://github.com/kontourai/station/pull/3188) feat(recovery): resume usage-limit stops at the provider reset
- [#3229](https://github.com/kontourai/station/pull/3229) feat(coding): side panels beside Chat past the wide fold — rail, splitters, folded inbox edge, Terminal strip
- [#3196](https://github.com/kontourai/station/pull/3196) feat(knowledge): separate data MCP from Station controls
- [#3246](https://github.com/kontourai/station/pull/3246) feat(acp): per-model image input for OpenCode models
- [#3251](https://github.com/kontourai/station/pull/3251) feat(registry): one atomic host-owner claim for desktop sidecar and service (#2961)
- [#3238](https://github.com/kontourai/station/pull/3238) feat(tasks): review immutable output versions in Task rooms
- [#3186](https://github.com/kontourai/station/pull/3186) feat(browser): agents can close their own Browser sessions
- [#3227](https://github.com/kontourai/station/pull/3227) feat(docs): derive review freshness from append-only notes (#3101 A)
- [#3201](https://github.com/kontourai/station/pull/3201) feat(chat): open drafts with scoped recent work and setup help
- [#1418](https://github.com/kontourai/station/pull/1418) feat(plugins): plugin palette commands with strict-withdrawal command effects
- [#3177](https://github.com/kontourai/station/pull/3177) feat(orchestration): seed handoffs and forks with whole messages under a budget
- [#3171](https://github.com/kontourai/station/pull/3171) feat(pull-requests): checks and inline review comments in the review pane
- [#3192](https://github.com/kontourai/station/pull/3192) feat(release): publish signed host-stream manifests for stable and preview (#2959)
- [#3170](https://github.com/kontourai/station/pull/3170) feat(skills): add guided visual preparation and canonical session views
- [#3114](https://github.com/kontourai/station/pull/3114) feat(relay): native enrollment and encrypted member access
- [#3168](https://github.com/kontourai/station/pull/3168) feat(registry): connect source-qualified marketplaces to canonical acquisition
- [#3155](https://github.com/kontourai/station/pull/3155) feat(agents): simplify and organize MCP tool setup
- [#3127](https://github.com/kontourai/station/pull/3127) feat(chat): improve active-turn composer and engine activity
- [#3152](https://github.com/kontourai/station/pull/3152) feat(skills): add local experience authoring and curated engineering collection
- [#3144](https://github.com/kontourai/station/pull/3144) feat(ui): unify mobile pickers and project context
- [#3145](https://github.com/kontourai/station/pull/3145) feat(skills): simplify discovery and canonical chat launch (#3138)
- [#3146](https://github.com/kontourai/station/pull/3146) feat(ci): separate integration, qualification, and release delivery
- [#3142](https://github.com/kontourai/station/pull/3142) feat(plugins): define visual skill experience authoring (#3129)
- [#3099](https://github.com/kontourai/station/pull/3099) feat(tasks): pin a previewable brief to agent requests

**Fixes**

- [#3425](https://github.com/kontourai/station/pull/3425) fix(ci): request workflow permission and verify head-bound queue admission
- [#3423](https://github.com/kontourai/station/pull/3423) fix(acp): reuse one probe session instead of leaking one per capability probe
- [#3398](https://github.com/kontourai/station/pull/3398) fix(start): the start Model picker closes on a choice and names its default; record titles wrap at word boundaries
- [#3378](https://github.com/kontourai/station/pull/3378) fix(usage): count a resumed Claude Code session's cost once
- [#3381](https://github.com/kontourai/station/pull/3381) fix(agents): engine attribution survives a failed or slow connection inspection (#3355)
- [#3380](https://github.com/kontourai/station/pull/3380) fix(ui): project marks on the last row surfaces, aligned sidebar names, member icons, agent glyph sizing
- [#3387](https://github.com/kontourai/station/pull/3387) fix(desktop): forward the x-station-envelope marker through the native HTTP broker (#3166)
- [#3310](https://github.com/kontourai/station/pull/3310) fix(claude): read a macOS Keychain login through `claude auth status` (#3303)
- [#3377](https://github.com/kontourai/station/pull/3377) fix(chat): label deletes as deletes and never guess a read from a path (#3364)
- [#3373](https://github.com/kontourai/station/pull/3373) fix(station-control): keep a current-Station refusal's typed code on the peer follow-up path (#3338)
- [#3340](https://github.com/kontourai/station/pull/3340) fix(child-work): a later settle replaces a running-time usage figure
- [#3307](https://github.com/kontourai/station/pull/3307) fix(docs): append-only review notes, fail-closed merge base, ledger path budget, write rollback (#3036)
- [#3375](https://github.com/kontourai/station/pull/3375) fix: repair main qualification round 3 (#3149): local respond refusal, runtime fakes
- [#3325](https://github.com/kontourai/station/pull/3325) fix(ci): use canonical npm launcher on Windows
- [#3260](https://github.com/kontourai/station/pull/3260) fix(docs): gate hand-edited review coverageBaseline in scoped freshness (#3101)
- [#3210](https://github.com/kontourai/station/pull/3210) fix(auth): restrict account observation exception to native proof
- [#3354](https://github.com/kontourai/station/pull/3354) fix(chat): no Scroll to bottom row in a dock too short for the transcript
- [#3351](https://github.com/kontourai/station/pull/3351) fix(chat): one Earlier messages press loads one page (#3288)
- [#3344](https://github.com/kontourai/station/pull/3344) fix: repair main qualification round 2 (#3149): cohort spawn collision, guardrail drift, stale pins
- [#3343](https://github.com/kontourai/station/pull/3343) fix(home): name the Agent and Model Start uses; one-vocabulary follow-ups (#3312)
- [#3321](https://github.com/kontourai/station/pull/3321) fix(chat): read a Station-agent conversation's whole lineage and store what was typed
- [#3314](https://github.com/kontourai/station/pull/3314) fix(test): transfer gate and region-host tests stop failing on a busy host (#3058)
- [#3322](https://github.com/kontourai/station/pull/3322) fix(tests): bound content integrity Git oracle capture
- [#3318](https://github.com/kontourai/station/pull/3318) fix(test): bound the whole-tree git captures in the scan tests (#3305)
- [#3316](https://github.com/kontourai/station/pull/3316) fix(cli,delegation,browser): dogfood friction — not-ready reasons, sessions list paging, viewport errors, bound host (#3304)
- [#3311](https://github.com/kontourai/station/pull/3311) fix(chat): rebuild open approvals from older turns after a reload
- [#3309](https://github.com/kontourai/station/pull/3309) fix(verification): widen local liveness bounds on a host under CPU pressure (#3302)
- [#3296](https://github.com/kontourai/station/pull/3296) fix(chat): repair the mobile composer e2e (#3228); a labelled Discard for a message waiting to retry in a short dock
- [#3300](https://github.com/kontourai/station/pull/3300) fix(usage): reconcile bounded receipt aggregates and peer transfer
- [#3287](https://github.com/kontourai/station/pull/3287) fix(chat): stop a never-used predecessor only when no turn is starting; bind reloaded approvals to their turn
- [#3206](https://github.com/kontourai/station/pull/3206) fix(station-control): agents dispatch without an approval mode (#2377 C3b)
- [#3217](https://github.com/kontourai/station/pull/3217) fix(sdk): load the skill-experience reader statically in the client entry (#3209)
- [#3175](https://github.com/kontourai/station/pull/3175) fix(scripts): bound synchronous child captures past the 1 MiB default (#2787)
- [#3258](https://github.com/kontourai/station/pull/3258) fix: repair main qualification (#3149): account-bound status read and stale fixtures
- [#3272](https://github.com/kontourai/station/pull/3272) fix(ui): the draft model picker returns focus; Home and default-agent journeys follow the New chat draft (#3228)
- [#3172](https://github.com/kontourai/station/pull/3172) fix(ui): Duplicate asks once; every list search field is 44px on touch (#3102)
- [#3178](https://github.com/kontourai/station/pull/3178) fix(activity): the attached session transcript uses chat's part mapping; drop the unused task rank
- [#3248](https://github.com/kontourai/station/pull/3248) fix(chat): Send again resends the typed turn, not the stored model input (#3112)
- [#3197](https://github.com/kontourai/station/pull/3197) fix(native): route relay link events through the Tauri adapter
- [#3205](https://github.com/kontourai/station/pull/3205) fix(chat): contain project badges and qualify phone card geometry
- [#3202](https://github.com/kontourai/station/pull/3202) fix(skills): inspect shared references and expose rich continuation
- [#3236](https://github.com/kontourai/station/pull/3236) fix(verification): retain bounded capture phase diagnostics
- [#3174](https://github.com/kontourai/station/pull/3174) fix(chat): stop a never-used session's engine after a model change; rebuild approvals after a reload
- [#3247](https://github.com/kontourai/station/pull/3247) fix(ui): working-directory paths read and copy as one line, cut at the start (#2799)
- [#3242](https://github.com/kontourai/station/pull/3242) fix(approval): re-confine a running engine at its next turn after a revoke (#2898)
- [#3241](https://github.com/kontourai/station/pull/3241) fix(sdk): identify Station refusals by the x-station-envelope marker; typed SDK refusals (#2842)
- [#3235](https://github.com/kontourai/station/pull/3235) fix(ui): the phone toolbar keeps the app name whole; the composer repeats only send failures; one waiting-on-you count
- [#3187](https://github.com/kontourai/station/pull/3187) fix(station-control): interrupts stay in the caller's scope (#2377 C3)
- [#3234](https://github.com/kontourai/station/pull/3234) fix(security): repoint the typography-note secret-scan exemption
- [#3232](https://github.com/kontourai/station/pull/3232) fix(usage): preserve attached turn ancestry and per-turn observations
- [#3106](https://github.com/kontourai/station/pull/3106) fix(tasks): fence output publication and retain private provenance
- [#3223](https://github.com/kontourai/station/pull/3223) fix(station-control): re-check the dispatch folder at spawn and scope ACP connection defaults (#2873)
- [#3222](https://github.com/kontourai/station/pull/3222) fix(test-changed): trace two-hop top-level uses in the SDK barrel refinement (#2766)
- [#3191](https://github.com/kontourai/station/pull/3191) fix(projects): members can read a shared Task publication
- [#3216](https://github.com/kontourai/station/pull/3216) fix(verification): retain bounded transfer refusal diagnostics
- [#3215](https://github.com/kontourai/station/pull/3215) fix(verification): close settled Windows wrappers during forced cleanup
- [#3200](https://github.com/kontourai/station/pull/3200) fix: consume published Flow Agents 6.5.1
- [#3199](https://github.com/kontourai/station/pull/3199) fix: repair relay recovery and compact native setup
- [#3198](https://github.com/kontourai/station/pull/3198) fix(tests): await lazy composer and repair readiness fixtures
- [#3190](https://github.com/kontourai/station/pull/3190) fix(native): keep Station trust available after Device activation
- [#3180](https://github.com/kontourai/station/pull/3180) fix(approval): a guardian allow answers only plain tool calls (#2947)
- [#3143](https://github.com/kontourai/station/pull/3143) fix(settings): simplify preferences and repair live Activity
- [#3154](https://github.com/kontourai/station/pull/3154) fix(profile): refresh usage and show paired people
- [#3151](https://github.com/kontourai/station/pull/3151) fix(verification): retain request identity in bounded explanations
- [#3148](https://github.com/kontourai/station/pull/3148) fix(registry): preserve nested skill sources and disclose compatibility (#3139)
- [#3126](https://github.com/kontourai/station/pull/3126) fix(chat): simplify status, tool activity, and attention controls
- [#2972](https://github.com/kontourai/station/pull/2972) fix(connections): refuse a create that would overwrite a model connection, and name the CLI's write target
- [#2976](https://github.com/kontourai/station/pull/2976) fix(lab): record the pinned node-datachannel version instead of a restated literal
- [#3125](https://github.com/kontourai/station/pull/3125) fix(native): diagnose queue pressure and retry unsent requests

**CI / workflow**

- [#3392](https://github.com/kontourai/station/pull/3392) ci(review): run the advisory PR review only on request, once per head (#3101 I)
- [#3397](https://github.com/kontourai/station/pull/3397) ci: let qualified main drive Nightly and monitor delivery health
- [#3389](https://github.com/kontourai/station/pull/3389) ci(workflows): group workflow names by trigger (#3101 G)

**Docs**

- [#3404](https://github.com/kontourai/station/pull/3404) docs(design): repoint operator device-access citations so strict freshness is green
- [#3221](https://github.com/kontourai/station/pull/3221) docs(strategy): date the Veritas contract passage as a 2026-07-19 snapshot
- [#3267](https://github.com/kontourai/station/pull/3267) docs(learn): re-capture the Knowledge Library screenshots after the phone toolbar fix
- [#3181](https://github.com/kontourai/station/pull/3181) docs(agents): bare issue numbers refer to this repository
- [#3169](https://github.com/kontourai/station/pull/3169) docs: preserve canonical experience review history
- [#3153](https://github.com/kontourai/station/pull/3153) docs: preserve installed experience review history

**Other**

- [#3408](https://github.com/kontourai/station/pull/3408) test(verification): read scaled heartbeat timeout budgets
- [#3396](https://github.com/kontourai/station/pull/3396) test(e2e): repair first-run, starter, phone dock and file-preview specs; fix native knowledge tool schemas
- [#3401](https://github.com/kontourai/station/pull/3401) test(e2e): declare and wait for the file-preview changes read in task-first-home (#3365)
- [#3400](https://github.com/kontourai/station/pull/3400) test: repair Nightly fixtures and preserve actionable failure reports
- [#3218](https://github.com/kontourai/station/pull/3218) test(e2e): scope the ui-blocks form controls and check filled values before submit
- [#3395](https://github.com/kontourai/station/pull/3395) chore(veritas): record the noreply address in committed attestations
- [#3376](https://github.com/kontourai/station/pull/3376) test(ui): pin other-tab model memory sync and narrow the "Still waiting" scan
- [#3233](https://github.com/kontourai/station/pull/3233) test(docs): run #3101 review-notes tests in parallel from a shared fixture
- [#3359](https://github.com/kontourai/station/pull/3359) test(prepush): name the liveness resolver as a hook setup step in gate-for
- [#3357](https://github.com/kontourai/station/pull/3357) test(projects): expect timeAgo's canonical relative time
- [#3339](https://github.com/kontourai/station/pull/3339) test(activity): feed the cross-surface block typed summaries, not casts
- [#3349](https://github.com/kontourai/station/pull/3349) test(veritas): run the readiness evidence wrapper against a minimal fixture repo
- [#3336](https://github.com/kontourai/station/pull/3336) test(station-control): classify the execution-preparation mode as a reviewed non-posture field
- [#3333](https://github.com/kontourai/station/pull/3333) test(prepush): copy the liveness-scale resolver closure into the push fixture
- [#3317](https://github.com/kontourai/station/pull/3317) test(e2e): drop the task-first journey's own skill-experience stub
- [#3214](https://github.com/kontourai/station/pull/3214) chore(chat): drop the direct-New helpers and comments #3170 left behind
- [#3292](https://github.com/kontourai/station/pull/3292) test(sdk): let the portable client lazy-load literal station-shared subpaths
- [#3264](https://github.com/kontourai/station/pull/3264) test(policy): drive each station-control policy tool through the server its serverIds names
- [#3252](https://github.com/kontourai/station/pull/3252) test(orchestration): follow #3242's revoke report in the task-dispatch full-access test
- [#3250](https://github.com/kontourai/station/pull/3250) test(docs): avoid history replay for ledger cardinality
- [#3237](https://github.com/kontourai/station/pull/3237) test(e2e): model the Project identity read in the task-first-home fixture
- [#3220](https://github.com/kontourai/station/pull/3220) test(ui): follow #3127's engine-silence wording in the dock activity test (#3173)
- [#3219](https://github.com/kontourai/station/pull/3219) test(ui): rate the agent icon a selected row really shows
- [#3207](https://github.com/kontourai/station/pull/3207) refactor(build): deslop plugin-build commentary and diagnostics
- [#3184](https://github.com/kontourai/station/pull/3184) refactor(settings): remove obsolete styles and repair mobile journey checks
- [#3183](https://github.com/kontourai/station/pull/3183) test(cli): remove credential-only test seams
- [#3182](https://github.com/kontourai/station/pull/3182) test: consolidate cleanup coverage and remove test-only seams
- [#3179](https://github.com/kontourai/station/pull/3179) test(e2e): the mobile sweep follows the scrolling chip row and the docked Activity pane
- [#3156](https://github.com/kontourai/station/pull/3156) chore(security): record approved seven-day advisory exceptions
- [#2980](https://github.com/kontourai/station/pull/2980) chore(deps): bump the github-actions-minor-patch group across 1 directory with 2 updates

## 2026-10-06T01:13:11Z · nightly-android · 0.1.11-nightly.2470

- Ship SHA: `353dfd913bc2837d47a6fc5cede97858a32e32fe`
- Artifact built at: `2026-10-06T00:37:31.827Z` (not provider upload/record time)
- Artifact: play-internal-aab:cohort-finalized
- Note: ios: TestFlight delivery success (run 37392869133)

### Changelog

Commits since `e7fb9b3` ([full sha](https://github.com/kontourai/station/commit/e7fb9b3161de5d6a3e006ad9760ced9c862130c8)):

**Features**

- [#3420](https://github.com/kontourai/station/pull/3420) feat(docs): compact landed review notes into immutable archives at baseline advance (#3394)
- [#3407](https://github.com/kontourai/station/pull/3407) feat(activity): show outside conversations in worktrees and outside any project
- [#3346](https://github.com/kontourai/station/pull/3346) feat(attention): answer a paired Station's question, and open its tasks in Activity everywhere
- [#3203](https://github.com/kontourai/station/pull/3203) feat(connections): make proxy setup and routing visible
- [#3298](https://github.com/kontourai/station/pull/3298) feat(integrations): per-principal connected accounts (slice 1)
- [#3299](https://github.com/kontourai/station/pull/3299) feat(agents): versioned Agent audience and member-caller gate (#3276 slice 1)
- [#3243](https://github.com/kontourai/station/pull/3243) feat(pairing): observe off-host operator-credential use; operator device-access design (#2894)
- [#3371](https://github.com/kontourai/station/pull/3371) feat(start): one start composer on Home and in the dock — one way to start a chat
- [#3230](https://github.com/kontourai/station/pull/3230) feat(control): agents can wait on, message and interrupt Sessions in their Project (#3160)
- [#3379](https://github.com/kontourai/station/pull/3379) feat(usage): count delegated tasks Station linked to a conversation but you can't read as missing
- [#3366](https://github.com/kontourai/station/pull/3366) feat(projects): project icons — one validated rule, shown everywhere a project appears, settable after creation
- [#3368](https://github.com/kontourai/station/pull/3368) feat(new-chat): the remembered Agent per context is live on every mounted surface
- [#3369](https://github.com/kontourai/station/pull/3369) feat(dock): the collapsed bar and the empty dock offer the one New chat action
- [#3319](https://github.com/kontourai/station/pull/3319) feat(identity): operator passkey enrollment on the consent origin (#3257 S2b)
- [#3353](https://github.com/kontourai/station/pull/3353) feat(home): Home's work rows carry the inbox's branch and project colour
- [#3261](https://github.com/kontourai/station/pull/3261) feat(install): install.ps1 installs, upgrades and uninstalls the Windows archive (#2675 W2)
- [#3271](https://github.com/kontourai/station/pull/3271) feat(station-control): external engines declare pull requests; Tasks close out on merge (#3161)
- [#3324](https://github.com/kontourai/station/pull/3324) feat(usage): roll up a conversation's usage with its subagents and delegated tasks, with a breakdown
- [#3239](https://github.com/kontourai/station/pull/3239) feat(ui): one duration, one group heading and one flat Earlier on every work surface
- [#3315](https://github.com/kontourai/station/pull/3315) feat(attention): answer a paired Station's approval from the inbox and Activity
- [#3313](https://github.com/kontourai/station/pull/3313) feat(recovery): usage-limit banner with Resume now and Cancel auto-resume (#3157)
- [#3244](https://github.com/kontourai/station/pull/3244) feat(delegation): version-matched execution preparation, slice 1 (#2875)
- [#3263](https://github.com/kontourai/station/pull/3263) feat(station-control): search_sessions and rename_session tools (#176)
- [#3189](https://github.com/kontourai/station/pull/3189) feat(agents): show each subagent's own model and a read-only transcript (#3163)
- [#3301](https://github.com/kontourai/station/pull/3301) feat(ci): publish the Nightly from the qualification run that passed (dormant until enabled)
- [#3208](https://github.com/kontourai/station/pull/3208) feat(station-control): read a conversation a person referenced
- [#3289](https://github.com/kontourai/station/pull/3289) feat(consent): optional HTTPS consent origin (#3257 S2a)
- [#3231](https://github.com/kontourai/station/pull/3231) feat(coding): quiet chrome for the Diff pane, pull requests view and review
- [#3268](https://github.com/kontourai/station/pull/3268) feat(cli): supported dev mode with live reload; stop never kills a sibling Station (#3253, #3254)
- [#3188](https://github.com/kontourai/station/pull/3188) feat(recovery): resume usage-limit stops at the provider reset
- [#3229](https://github.com/kontourai/station/pull/3229) feat(coding): side panels beside Chat past the wide fold — rail, splitters, folded inbox edge, Terminal strip
- [#3196](https://github.com/kontourai/station/pull/3196) feat(knowledge): separate data MCP from Station controls
- [#3246](https://github.com/kontourai/station/pull/3246) feat(acp): per-model image input for OpenCode models
- [#3251](https://github.com/kontourai/station/pull/3251) feat(registry): one atomic host-owner claim for desktop sidecar and service (#2961)
- [#3238](https://github.com/kontourai/station/pull/3238) feat(tasks): review immutable output versions in Task rooms
- [#3186](https://github.com/kontourai/station/pull/3186) feat(browser): agents can close their own Browser sessions
- [#3227](https://github.com/kontourai/station/pull/3227) feat(docs): derive review freshness from append-only notes (#3101 A)
- [#3201](https://github.com/kontourai/station/pull/3201) feat(chat): open drafts with scoped recent work and setup help
- [#1418](https://github.com/kontourai/station/pull/1418) feat(plugins): plugin palette commands with strict-withdrawal command effects
- [#3177](https://github.com/kontourai/station/pull/3177) feat(orchestration): seed handoffs and forks with whole messages under a budget
- [#3171](https://github.com/kontourai/station/pull/3171) feat(pull-requests): checks and inline review comments in the review pane
- [#3192](https://github.com/kontourai/station/pull/3192) feat(release): publish signed host-stream manifests for stable and preview (#2959)
- [#3170](https://github.com/kontourai/station/pull/3170) feat(skills): add guided visual preparation and canonical session views
- [#3114](https://github.com/kontourai/station/pull/3114) feat(relay): native enrollment and encrypted member access
- [#3168](https://github.com/kontourai/station/pull/3168) feat(registry): connect source-qualified marketplaces to canonical acquisition
- [#3155](https://github.com/kontourai/station/pull/3155) feat(agents): simplify and organize MCP tool setup
- [#3127](https://github.com/kontourai/station/pull/3127) feat(chat): improve active-turn composer and engine activity
- [#3152](https://github.com/kontourai/station/pull/3152) feat(skills): add local experience authoring and curated engineering collection
- [#3144](https://github.com/kontourai/station/pull/3144) feat(ui): unify mobile pickers and project context
- [#3145](https://github.com/kontourai/station/pull/3145) feat(skills): simplify discovery and canonical chat launch (#3138)
- [#3146](https://github.com/kontourai/station/pull/3146) feat(ci): separate integration, qualification, and release delivery
- [#3142](https://github.com/kontourai/station/pull/3142) feat(plugins): define visual skill experience authoring (#3129)
- [#3099](https://github.com/kontourai/station/pull/3099) feat(tasks): pin a previewable brief to agent requests

**Fixes**

- [#3425](https://github.com/kontourai/station/pull/3425) fix(ci): request workflow permission and verify head-bound queue admission
- [#3423](https://github.com/kontourai/station/pull/3423) fix(acp): reuse one probe session instead of leaking one per capability probe
- [#3398](https://github.com/kontourai/station/pull/3398) fix(start): the start Model picker closes on a choice and names its default; record titles wrap at word boundaries
- [#3378](https://github.com/kontourai/station/pull/3378) fix(usage): count a resumed Claude Code session's cost once
- [#3381](https://github.com/kontourai/station/pull/3381) fix(agents): engine attribution survives a failed or slow connection inspection (#3355)
- [#3380](https://github.com/kontourai/station/pull/3380) fix(ui): project marks on the last row surfaces, aligned sidebar names, member icons, agent glyph sizing
- [#3387](https://github.com/kontourai/station/pull/3387) fix(desktop): forward the x-station-envelope marker through the native HTTP broker (#3166)
- [#3310](https://github.com/kontourai/station/pull/3310) fix(claude): read a macOS Keychain login through `claude auth status` (#3303)
- [#3377](https://github.com/kontourai/station/pull/3377) fix(chat): label deletes as deletes and never guess a read from a path (#3364)
- [#3373](https://github.com/kontourai/station/pull/3373) fix(station-control): keep a current-Station refusal's typed code on the peer follow-up path (#3338)
- [#3340](https://github.com/kontourai/station/pull/3340) fix(child-work): a later settle replaces a running-time usage figure
- [#3307](https://github.com/kontourai/station/pull/3307) fix(docs): append-only review notes, fail-closed merge base, ledger path budget, write rollback (#3036)
- [#3375](https://github.com/kontourai/station/pull/3375) fix: repair main qualification round 3 (#3149): local respond refusal, runtime fakes
- [#3325](https://github.com/kontourai/station/pull/3325) fix(ci): use canonical npm launcher on Windows
- [#3260](https://github.com/kontourai/station/pull/3260) fix(docs): gate hand-edited review coverageBaseline in scoped freshness (#3101)
- [#3210](https://github.com/kontourai/station/pull/3210) fix(auth): restrict account observation exception to native proof
- [#3354](https://github.com/kontourai/station/pull/3354) fix(chat): no Scroll to bottom row in a dock too short for the transcript
- [#3351](https://github.com/kontourai/station/pull/3351) fix(chat): one Earlier messages press loads one page (#3288)
- [#3344](https://github.com/kontourai/station/pull/3344) fix: repair main qualification round 2 (#3149): cohort spawn collision, guardrail drift, stale pins
- [#3343](https://github.com/kontourai/station/pull/3343) fix(home): name the Agent and Model Start uses; one-vocabulary follow-ups (#3312)
- [#3321](https://github.com/kontourai/station/pull/3321) fix(chat): read a Station-agent conversation's whole lineage and store what was typed
- [#3314](https://github.com/kontourai/station/pull/3314) fix(test): transfer gate and region-host tests stop failing on a busy host (#3058)
- [#3322](https://github.com/kontourai/station/pull/3322) fix(tests): bound content integrity Git oracle capture
- [#3318](https://github.com/kontourai/station/pull/3318) fix(test): bound the whole-tree git captures in the scan tests (#3305)
- [#3316](https://github.com/kontourai/station/pull/3316) fix(cli,delegation,browser): dogfood friction — not-ready reasons, sessions list paging, viewport errors, bound host (#3304)
- [#3311](https://github.com/kontourai/station/pull/3311) fix(chat): rebuild open approvals from older turns after a reload
- [#3309](https://github.com/kontourai/station/pull/3309) fix(verification): widen local liveness bounds on a host under CPU pressure (#3302)
- [#3296](https://github.com/kontourai/station/pull/3296) fix(chat): repair the mobile composer e2e (#3228); a labelled Discard for a message waiting to retry in a short dock
- [#3300](https://github.com/kontourai/station/pull/3300) fix(usage): reconcile bounded receipt aggregates and peer transfer
- [#3287](https://github.com/kontourai/station/pull/3287) fix(chat): stop a never-used predecessor only when no turn is starting; bind reloaded approvals to their turn
- [#3206](https://github.com/kontourai/station/pull/3206) fix(station-control): agents dispatch without an approval mode (#2377 C3b)
- [#3217](https://github.com/kontourai/station/pull/3217) fix(sdk): load the skill-experience reader statically in the client entry (#3209)
- [#3175](https://github.com/kontourai/station/pull/3175) fix(scripts): bound synchronous child captures past the 1 MiB default (#2787)
- [#3258](https://github.com/kontourai/station/pull/3258) fix: repair main qualification (#3149): account-bound status read and stale fixtures
- [#3272](https://github.com/kontourai/station/pull/3272) fix(ui): the draft model picker returns focus; Home and default-agent journeys follow the New chat draft (#3228)
- [#3172](https://github.com/kontourai/station/pull/3172) fix(ui): Duplicate asks once; every list search field is 44px on touch (#3102)
- [#3178](https://github.com/kontourai/station/pull/3178) fix(activity): the attached session transcript uses chat's part mapping; drop the unused task rank
- [#3248](https://github.com/kontourai/station/pull/3248) fix(chat): Send again resends the typed turn, not the stored model input (#3112)
- [#3197](https://github.com/kontourai/station/pull/3197) fix(native): route relay link events through the Tauri adapter
- [#3205](https://github.com/kontourai/station/pull/3205) fix(chat): contain project badges and qualify phone card geometry
- [#3202](https://github.com/kontourai/station/pull/3202) fix(skills): inspect shared references and expose rich continuation
- [#3236](https://github.com/kontourai/station/pull/3236) fix(verification): retain bounded capture phase diagnostics
- [#3174](https://github.com/kontourai/station/pull/3174) fix(chat): stop a never-used session's engine after a model change; rebuild approvals after a reload
- [#3247](https://github.com/kontourai/station/pull/3247) fix(ui): working-directory paths read and copy as one line, cut at the start (#2799)
- [#3242](https://github.com/kontourai/station/pull/3242) fix(approval): re-confine a running engine at its next turn after a revoke (#2898)
- [#3241](https://github.com/kontourai/station/pull/3241) fix(sdk): identify Station refusals by the x-station-envelope marker; typed SDK refusals (#2842)
- [#3235](https://github.com/kontourai/station/pull/3235) fix(ui): the phone toolbar keeps the app name whole; the composer repeats only send failures; one waiting-on-you count
- [#3187](https://github.com/kontourai/station/pull/3187) fix(station-control): interrupts stay in the caller's scope (#2377 C3)
- [#3234](https://github.com/kontourai/station/pull/3234) fix(security): repoint the typography-note secret-scan exemption
- [#3232](https://github.com/kontourai/station/pull/3232) fix(usage): preserve attached turn ancestry and per-turn observations
- [#3106](https://github.com/kontourai/station/pull/3106) fix(tasks): fence output publication and retain private provenance
- [#3223](https://github.com/kontourai/station/pull/3223) fix(station-control): re-check the dispatch folder at spawn and scope ACP connection defaults (#2873)
- [#3222](https://github.com/kontourai/station/pull/3222) fix(test-changed): trace two-hop top-level uses in the SDK barrel refinement (#2766)
- [#3191](https://github.com/kontourai/station/pull/3191) fix(projects): members can read a shared Task publication
- [#3216](https://github.com/kontourai/station/pull/3216) fix(verification): retain bounded transfer refusal diagnostics
- [#3215](https://github.com/kontourai/station/pull/3215) fix(verification): close settled Windows wrappers during forced cleanup
- [#3200](https://github.com/kontourai/station/pull/3200) fix: consume published Flow Agents 6.5.1
- [#3199](https://github.com/kontourai/station/pull/3199) fix: repair relay recovery and compact native setup
- [#3198](https://github.com/kontourai/station/pull/3198) fix(tests): await lazy composer and repair readiness fixtures
- [#3190](https://github.com/kontourai/station/pull/3190) fix(native): keep Station trust available after Device activation
- [#3180](https://github.com/kontourai/station/pull/3180) fix(approval): a guardian allow answers only plain tool calls (#2947)
- [#3143](https://github.com/kontourai/station/pull/3143) fix(settings): simplify preferences and repair live Activity
- [#3154](https://github.com/kontourai/station/pull/3154) fix(profile): refresh usage and show paired people
- [#3151](https://github.com/kontourai/station/pull/3151) fix(verification): retain request identity in bounded explanations
- [#3148](https://github.com/kontourai/station/pull/3148) fix(registry): preserve nested skill sources and disclose compatibility (#3139)
- [#3126](https://github.com/kontourai/station/pull/3126) fix(chat): simplify status, tool activity, and attention controls
- [#2972](https://github.com/kontourai/station/pull/2972) fix(connections): refuse a create that would overwrite a model connection, and name the CLI's write target
- [#2976](https://github.com/kontourai/station/pull/2976) fix(lab): record the pinned node-datachannel version instead of a restated literal
- [#3125](https://github.com/kontourai/station/pull/3125) fix(native): diagnose queue pressure and retry unsent requests

**CI / workflow**

- [#3392](https://github.com/kontourai/station/pull/3392) ci(review): run the advisory PR review only on request, once per head (#3101 I)
- [#3397](https://github.com/kontourai/station/pull/3397) ci: let qualified main drive Nightly and monitor delivery health
- [#3389](https://github.com/kontourai/station/pull/3389) ci(workflows): group workflow names by trigger (#3101 G)

**Docs**

- [#3404](https://github.com/kontourai/station/pull/3404) docs(design): repoint operator device-access citations so strict freshness is green
- [#3221](https://github.com/kontourai/station/pull/3221) docs(strategy): date the Veritas contract passage as a 2026-07-19 snapshot
- [#3267](https://github.com/kontourai/station/pull/3267) docs(learn): re-capture the Knowledge Library screenshots after the phone toolbar fix
- [#3181](https://github.com/kontourai/station/pull/3181) docs(agents): bare issue numbers refer to this repository
- [#3169](https://github.com/kontourai/station/pull/3169) docs: preserve canonical experience review history
- [#3153](https://github.com/kontourai/station/pull/3153) docs: preserve installed experience review history

**Other**

- [#3408](https://github.com/kontourai/station/pull/3408) test(verification): read scaled heartbeat timeout budgets
- [#3396](https://github.com/kontourai/station/pull/3396) test(e2e): repair first-run, starter, phone dock and file-preview specs; fix native knowledge tool schemas
- [#3401](https://github.com/kontourai/station/pull/3401) test(e2e): declare and wait for the file-preview changes read in task-first-home (#3365)
- [#3400](https://github.com/kontourai/station/pull/3400) test: repair Nightly fixtures and preserve actionable failure reports
- [#3218](https://github.com/kontourai/station/pull/3218) test(e2e): scope the ui-blocks form controls and check filled values before submit
- [#3395](https://github.com/kontourai/station/pull/3395) chore(veritas): record the noreply address in committed attestations
- [#3376](https://github.com/kontourai/station/pull/3376) test(ui): pin other-tab model memory sync and narrow the "Still waiting" scan
- [#3233](https://github.com/kontourai/station/pull/3233) test(docs): run #3101 review-notes tests in parallel from a shared fixture
- [#3359](https://github.com/kontourai/station/pull/3359) test(prepush): name the liveness resolver as a hook setup step in gate-for
- [#3357](https://github.com/kontourai/station/pull/3357) test(projects): expect timeAgo's canonical relative time
- [#3339](https://github.com/kontourai/station/pull/3339) test(activity): feed the cross-surface block typed summaries, not casts
- [#3349](https://github.com/kontourai/station/pull/3349) test(veritas): run the readiness evidence wrapper against a minimal fixture repo
- [#3336](https://github.com/kontourai/station/pull/3336) test(station-control): classify the execution-preparation mode as a reviewed non-posture field
- [#3333](https://github.com/kontourai/station/pull/3333) test(prepush): copy the liveness-scale resolver closure into the push fixture
- [#3317](https://github.com/kontourai/station/pull/3317) test(e2e): drop the task-first journey's own skill-experience stub
- [#3214](https://github.com/kontourai/station/pull/3214) chore(chat): drop the direct-New helpers and comments #3170 left behind
- [#3292](https://github.com/kontourai/station/pull/3292) test(sdk): let the portable client lazy-load literal station-shared subpaths
- [#3264](https://github.com/kontourai/station/pull/3264) test(policy): drive each station-control policy tool through the server its serverIds names
- [#3252](https://github.com/kontourai/station/pull/3252) test(orchestration): follow #3242's revoke report in the task-dispatch full-access test
- [#3250](https://github.com/kontourai/station/pull/3250) test(docs): avoid history replay for ledger cardinality
- [#3237](https://github.com/kontourai/station/pull/3237) test(e2e): model the Project identity read in the task-first-home fixture
- [#3220](https://github.com/kontourai/station/pull/3220) test(ui): follow #3127's engine-silence wording in the dock activity test (#3173)
- [#3219](https://github.com/kontourai/station/pull/3219) test(ui): rate the agent icon a selected row really shows
- [#3207](https://github.com/kontourai/station/pull/3207) refactor(build): deslop plugin-build commentary and diagnostics
- [#3184](https://github.com/kontourai/station/pull/3184) refactor(settings): remove obsolete styles and repair mobile journey checks
- [#3183](https://github.com/kontourai/station/pull/3183) test(cli): remove credential-only test seams
- [#3182](https://github.com/kontourai/station/pull/3182) test: consolidate cleanup coverage and remove test-only seams
- [#3179](https://github.com/kontourai/station/pull/3179) test(e2e): the mobile sweep follows the scrolling chip row and the docked Activity pane
- [#3156](https://github.com/kontourai/station/pull/3156) chore(security): record approved seven-day advisory exceptions
- [#2980](https://github.com/kontourai/station/pull/2980) chore(deps): bump the github-actions-minor-patch group across 1 directory with 2 updates

## 2026-10-06T00:40:03Z · nightly-npm · 0.7.0-nightly.2470.37392869133

- Ship SHA: `353dfd913bc2837d47a6fc5cede97858a32e32fe`
- Artifact built at: `unknown` (no immutable artifact manifest binding)
- Artifact: npm:@kontourai/station-cli@0.7.0-nightly.2470.37392869133 (dist-tag nightly; artifactBuiltAt unknown)
- Note: artifactBuiltAt is null: npm package has no native artifact manifest

### Changelog

Commits since `e7fb9b3` ([full sha](https://github.com/kontourai/station/commit/e7fb9b3161de5d6a3e006ad9760ced9c862130c8)):

**Features**

- [#3420](https://github.com/kontourai/station/pull/3420) feat(docs): compact landed review notes into immutable archives at baseline advance (#3394)
- [#3407](https://github.com/kontourai/station/pull/3407) feat(activity): show outside conversations in worktrees and outside any project
- [#3346](https://github.com/kontourai/station/pull/3346) feat(attention): answer a paired Station's question, and open its tasks in Activity everywhere
- [#3203](https://github.com/kontourai/station/pull/3203) feat(connections): make proxy setup and routing visible
- [#3298](https://github.com/kontourai/station/pull/3298) feat(integrations): per-principal connected accounts (slice 1)
- [#3299](https://github.com/kontourai/station/pull/3299) feat(agents): versioned Agent audience and member-caller gate (#3276 slice 1)
- [#3243](https://github.com/kontourai/station/pull/3243) feat(pairing): observe off-host operator-credential use; operator device-access design (#2894)
- [#3371](https://github.com/kontourai/station/pull/3371) feat(start): one start composer on Home and in the dock — one way to start a chat
- [#3230](https://github.com/kontourai/station/pull/3230) feat(control): agents can wait on, message and interrupt Sessions in their Project (#3160)
- [#3379](https://github.com/kontourai/station/pull/3379) feat(usage): count delegated tasks Station linked to a conversation but you can't read as missing
- [#3366](https://github.com/kontourai/station/pull/3366) feat(projects): project icons — one validated rule, shown everywhere a project appears, settable after creation
- [#3368](https://github.com/kontourai/station/pull/3368) feat(new-chat): the remembered Agent per context is live on every mounted surface
- [#3369](https://github.com/kontourai/station/pull/3369) feat(dock): the collapsed bar and the empty dock offer the one New chat action
- [#3319](https://github.com/kontourai/station/pull/3319) feat(identity): operator passkey enrollment on the consent origin (#3257 S2b)
- [#3353](https://github.com/kontourai/station/pull/3353) feat(home): Home's work rows carry the inbox's branch and project colour
- [#3261](https://github.com/kontourai/station/pull/3261) feat(install): install.ps1 installs, upgrades and uninstalls the Windows archive (#2675 W2)
- [#3271](https://github.com/kontourai/station/pull/3271) feat(station-control): external engines declare pull requests; Tasks close out on merge (#3161)
- [#3324](https://github.com/kontourai/station/pull/3324) feat(usage): roll up a conversation's usage with its subagents and delegated tasks, with a breakdown
- [#3239](https://github.com/kontourai/station/pull/3239) feat(ui): one duration, one group heading and one flat Earlier on every work surface
- [#3315](https://github.com/kontourai/station/pull/3315) feat(attention): answer a paired Station's approval from the inbox and Activity
- [#3313](https://github.com/kontourai/station/pull/3313) feat(recovery): usage-limit banner with Resume now and Cancel auto-resume (#3157)
- [#3244](https://github.com/kontourai/station/pull/3244) feat(delegation): version-matched execution preparation, slice 1 (#2875)
- [#3263](https://github.com/kontourai/station/pull/3263) feat(station-control): search_sessions and rename_session tools (#176)
- [#3189](https://github.com/kontourai/station/pull/3189) feat(agents): show each subagent's own model and a read-only transcript (#3163)
- [#3301](https://github.com/kontourai/station/pull/3301) feat(ci): publish the Nightly from the qualification run that passed (dormant until enabled)
- [#3208](https://github.com/kontourai/station/pull/3208) feat(station-control): read a conversation a person referenced
- [#3289](https://github.com/kontourai/station/pull/3289) feat(consent): optional HTTPS consent origin (#3257 S2a)
- [#3231](https://github.com/kontourai/station/pull/3231) feat(coding): quiet chrome for the Diff pane, pull requests view and review
- [#3268](https://github.com/kontourai/station/pull/3268) feat(cli): supported dev mode with live reload; stop never kills a sibling Station (#3253, #3254)
- [#3188](https://github.com/kontourai/station/pull/3188) feat(recovery): resume usage-limit stops at the provider reset
- [#3229](https://github.com/kontourai/station/pull/3229) feat(coding): side panels beside Chat past the wide fold — rail, splitters, folded inbox edge, Terminal strip
- [#3196](https://github.com/kontourai/station/pull/3196) feat(knowledge): separate data MCP from Station controls
- [#3246](https://github.com/kontourai/station/pull/3246) feat(acp): per-model image input for OpenCode models
- [#3251](https://github.com/kontourai/station/pull/3251) feat(registry): one atomic host-owner claim for desktop sidecar and service (#2961)
- [#3238](https://github.com/kontourai/station/pull/3238) feat(tasks): review immutable output versions in Task rooms
- [#3186](https://github.com/kontourai/station/pull/3186) feat(browser): agents can close their own Browser sessions
- [#3227](https://github.com/kontourai/station/pull/3227) feat(docs): derive review freshness from append-only notes (#3101 A)
- [#3201](https://github.com/kontourai/station/pull/3201) feat(chat): open drafts with scoped recent work and setup help
- [#1418](https://github.com/kontourai/station/pull/1418) feat(plugins): plugin palette commands with strict-withdrawal command effects
- [#3177](https://github.com/kontourai/station/pull/3177) feat(orchestration): seed handoffs and forks with whole messages under a budget
- [#3171](https://github.com/kontourai/station/pull/3171) feat(pull-requests): checks and inline review comments in the review pane
- [#3192](https://github.com/kontourai/station/pull/3192) feat(release): publish signed host-stream manifests for stable and preview (#2959)
- [#3170](https://github.com/kontourai/station/pull/3170) feat(skills): add guided visual preparation and canonical session views
- [#3114](https://github.com/kontourai/station/pull/3114) feat(relay): native enrollment and encrypted member access
- [#3168](https://github.com/kontourai/station/pull/3168) feat(registry): connect source-qualified marketplaces to canonical acquisition
- [#3155](https://github.com/kontourai/station/pull/3155) feat(agents): simplify and organize MCP tool setup
- [#3127](https://github.com/kontourai/station/pull/3127) feat(chat): improve active-turn composer and engine activity
- [#3152](https://github.com/kontourai/station/pull/3152) feat(skills): add local experience authoring and curated engineering collection
- [#3144](https://github.com/kontourai/station/pull/3144) feat(ui): unify mobile pickers and project context
- [#3145](https://github.com/kontourai/station/pull/3145) feat(skills): simplify discovery and canonical chat launch (#3138)
- [#3146](https://github.com/kontourai/station/pull/3146) feat(ci): separate integration, qualification, and release delivery
- [#3142](https://github.com/kontourai/station/pull/3142) feat(plugins): define visual skill experience authoring (#3129)
- [#3099](https://github.com/kontourai/station/pull/3099) feat(tasks): pin a previewable brief to agent requests

**Fixes**

- [#3425](https://github.com/kontourai/station/pull/3425) fix(ci): request workflow permission and verify head-bound queue admission
- [#3423](https://github.com/kontourai/station/pull/3423) fix(acp): reuse one probe session instead of leaking one per capability probe
- [#3398](https://github.com/kontourai/station/pull/3398) fix(start): the start Model picker closes on a choice and names its default; record titles wrap at word boundaries
- [#3378](https://github.com/kontourai/station/pull/3378) fix(usage): count a resumed Claude Code session's cost once
- [#3381](https://github.com/kontourai/station/pull/3381) fix(agents): engine attribution survives a failed or slow connection inspection (#3355)
- [#3380](https://github.com/kontourai/station/pull/3380) fix(ui): project marks on the last row surfaces, aligned sidebar names, member icons, agent glyph sizing
- [#3387](https://github.com/kontourai/station/pull/3387) fix(desktop): forward the x-station-envelope marker through the native HTTP broker (#3166)
- [#3310](https://github.com/kontourai/station/pull/3310) fix(claude): read a macOS Keychain login through `claude auth status` (#3303)
- [#3377](https://github.com/kontourai/station/pull/3377) fix(chat): label deletes as deletes and never guess a read from a path (#3364)
- [#3373](https://github.com/kontourai/station/pull/3373) fix(station-control): keep a current-Station refusal's typed code on the peer follow-up path (#3338)
- [#3340](https://github.com/kontourai/station/pull/3340) fix(child-work): a later settle replaces a running-time usage figure
- [#3307](https://github.com/kontourai/station/pull/3307) fix(docs): append-only review notes, fail-closed merge base, ledger path budget, write rollback (#3036)
- [#3375](https://github.com/kontourai/station/pull/3375) fix: repair main qualification round 3 (#3149): local respond refusal, runtime fakes
- [#3325](https://github.com/kontourai/station/pull/3325) fix(ci): use canonical npm launcher on Windows
- [#3260](https://github.com/kontourai/station/pull/3260) fix(docs): gate hand-edited review coverageBaseline in scoped freshness (#3101)
- [#3210](https://github.com/kontourai/station/pull/3210) fix(auth): restrict account observation exception to native proof
- [#3354](https://github.com/kontourai/station/pull/3354) fix(chat): no Scroll to bottom row in a dock too short for the transcript
- [#3351](https://github.com/kontourai/station/pull/3351) fix(chat): one Earlier messages press loads one page (#3288)
- [#3344](https://github.com/kontourai/station/pull/3344) fix: repair main qualification round 2 (#3149): cohort spawn collision, guardrail drift, stale pins
- [#3343](https://github.com/kontourai/station/pull/3343) fix(home): name the Agent and Model Start uses; one-vocabulary follow-ups (#3312)
- [#3321](https://github.com/kontourai/station/pull/3321) fix(chat): read a Station-agent conversation's whole lineage and store what was typed
- [#3314](https://github.com/kontourai/station/pull/3314) fix(test): transfer gate and region-host tests stop failing on a busy host (#3058)
- [#3322](https://github.com/kontourai/station/pull/3322) fix(tests): bound content integrity Git oracle capture
- [#3318](https://github.com/kontourai/station/pull/3318) fix(test): bound the whole-tree git captures in the scan tests (#3305)
- [#3316](https://github.com/kontourai/station/pull/3316) fix(cli,delegation,browser): dogfood friction — not-ready reasons, sessions list paging, viewport errors, bound host (#3304)
- [#3311](https://github.com/kontourai/station/pull/3311) fix(chat): rebuild open approvals from older turns after a reload
- [#3309](https://github.com/kontourai/station/pull/3309) fix(verification): widen local liveness bounds on a host under CPU pressure (#3302)
- [#3296](https://github.com/kontourai/station/pull/3296) fix(chat): repair the mobile composer e2e (#3228); a labelled Discard for a message waiting to retry in a short dock
- [#3300](https://github.com/kontourai/station/pull/3300) fix(usage): reconcile bounded receipt aggregates and peer transfer
- [#3287](https://github.com/kontourai/station/pull/3287) fix(chat): stop a never-used predecessor only when no turn is starting; bind reloaded approvals to their turn
- [#3206](https://github.com/kontourai/station/pull/3206) fix(station-control): agents dispatch without an approval mode (#2377 C3b)
- [#3217](https://github.com/kontourai/station/pull/3217) fix(sdk): load the skill-experience reader statically in the client entry (#3209)
- [#3175](https://github.com/kontourai/station/pull/3175) fix(scripts): bound synchronous child captures past the 1 MiB default (#2787)
- [#3258](https://github.com/kontourai/station/pull/3258) fix: repair main qualification (#3149): account-bound status read and stale fixtures
- [#3272](https://github.com/kontourai/station/pull/3272) fix(ui): the draft model picker returns focus; Home and default-agent journeys follow the New chat draft (#3228)
- [#3172](https://github.com/kontourai/station/pull/3172) fix(ui): Duplicate asks once; every list search field is 44px on touch (#3102)
- [#3178](https://github.com/kontourai/station/pull/3178) fix(activity): the attached session transcript uses chat's part mapping; drop the unused task rank
- [#3248](https://github.com/kontourai/station/pull/3248) fix(chat): Send again resends the typed turn, not the stored model input (#3112)
- [#3197](https://github.com/kontourai/station/pull/3197) fix(native): route relay link events through the Tauri adapter
- [#3205](https://github.com/kontourai/station/pull/3205) fix(chat): contain project badges and qualify phone card geometry
- [#3202](https://github.com/kontourai/station/pull/3202) fix(skills): inspect shared references and expose rich continuation
- [#3236](https://github.com/kontourai/station/pull/3236) fix(verification): retain bounded capture phase diagnostics
- [#3174](https://github.com/kontourai/station/pull/3174) fix(chat): stop a never-used session's engine after a model change; rebuild approvals after a reload
- [#3247](https://github.com/kontourai/station/pull/3247) fix(ui): working-directory paths read and copy as one line, cut at the start (#2799)
- [#3242](https://github.com/kontourai/station/pull/3242) fix(approval): re-confine a running engine at its next turn after a revoke (#2898)
- [#3241](https://github.com/kontourai/station/pull/3241) fix(sdk): identify Station refusals by the x-station-envelope marker; typed SDK refusals (#2842)
- [#3235](https://github.com/kontourai/station/pull/3235) fix(ui): the phone toolbar keeps the app name whole; the composer repeats only send failures; one waiting-on-you count
- [#3187](https://github.com/kontourai/station/pull/3187) fix(station-control): interrupts stay in the caller's scope (#2377 C3)
- [#3234](https://github.com/kontourai/station/pull/3234) fix(security): repoint the typography-note secret-scan exemption
- [#3232](https://github.com/kontourai/station/pull/3232) fix(usage): preserve attached turn ancestry and per-turn observations
- [#3106](https://github.com/kontourai/station/pull/3106) fix(tasks): fence output publication and retain private provenance
- [#3223](https://github.com/kontourai/station/pull/3223) fix(station-control): re-check the dispatch folder at spawn and scope ACP connection defaults (#2873)
- [#3222](https://github.com/kontourai/station/pull/3222) fix(test-changed): trace two-hop top-level uses in the SDK barrel refinement (#2766)
- [#3191](https://github.com/kontourai/station/pull/3191) fix(projects): members can read a shared Task publication
- [#3216](https://github.com/kontourai/station/pull/3216) fix(verification): retain bounded transfer refusal diagnostics
- [#3215](https://github.com/kontourai/station/pull/3215) fix(verification): close settled Windows wrappers during forced cleanup
- [#3200](https://github.com/kontourai/station/pull/3200) fix: consume published Flow Agents 6.5.1
- [#3199](https://github.com/kontourai/station/pull/3199) fix: repair relay recovery and compact native setup
- [#3198](https://github.com/kontourai/station/pull/3198) fix(tests): await lazy composer and repair readiness fixtures
- [#3190](https://github.com/kontourai/station/pull/3190) fix(native): keep Station trust available after Device activation
- [#3180](https://github.com/kontourai/station/pull/3180) fix(approval): a guardian allow answers only plain tool calls (#2947)
- [#3143](https://github.com/kontourai/station/pull/3143) fix(settings): simplify preferences and repair live Activity
- [#3154](https://github.com/kontourai/station/pull/3154) fix(profile): refresh usage and show paired people
- [#3151](https://github.com/kontourai/station/pull/3151) fix(verification): retain request identity in bounded explanations
- [#3148](https://github.com/kontourai/station/pull/3148) fix(registry): preserve nested skill sources and disclose compatibility (#3139)
- [#3126](https://github.com/kontourai/station/pull/3126) fix(chat): simplify status, tool activity, and attention controls
- [#2972](https://github.com/kontourai/station/pull/2972) fix(connections): refuse a create that would overwrite a model connection, and name the CLI's write target
- [#2976](https://github.com/kontourai/station/pull/2976) fix(lab): record the pinned node-datachannel version instead of a restated literal
- [#3125](https://github.com/kontourai/station/pull/3125) fix(native): diagnose queue pressure and retry unsent requests

**CI / workflow**

- [#3392](https://github.com/kontourai/station/pull/3392) ci(review): run the advisory PR review only on request, once per head (#3101 I)
- [#3397](https://github.com/kontourai/station/pull/3397) ci: let qualified main drive Nightly and monitor delivery health
- [#3389](https://github.com/kontourai/station/pull/3389) ci(workflows): group workflow names by trigger (#3101 G)

**Docs**

- [#3404](https://github.com/kontourai/station/pull/3404) docs(design): repoint operator device-access citations so strict freshness is green
- [#3221](https://github.com/kontourai/station/pull/3221) docs(strategy): date the Veritas contract passage as a 2026-07-19 snapshot
- [#3267](https://github.com/kontourai/station/pull/3267) docs(learn): re-capture the Knowledge Library screenshots after the phone toolbar fix
- [#3181](https://github.com/kontourai/station/pull/3181) docs(agents): bare issue numbers refer to this repository
- [#3169](https://github.com/kontourai/station/pull/3169) docs: preserve canonical experience review history
- [#3153](https://github.com/kontourai/station/pull/3153) docs: preserve installed experience review history

**Other**

- [#3408](https://github.com/kontourai/station/pull/3408) test(verification): read scaled heartbeat timeout budgets
- [#3396](https://github.com/kontourai/station/pull/3396) test(e2e): repair first-run, starter, phone dock and file-preview specs; fix native knowledge tool schemas
- [#3401](https://github.com/kontourai/station/pull/3401) test(e2e): declare and wait for the file-preview changes read in task-first-home (#3365)
- [#3400](https://github.com/kontourai/station/pull/3400) test: repair Nightly fixtures and preserve actionable failure reports
- [#3218](https://github.com/kontourai/station/pull/3218) test(e2e): scope the ui-blocks form controls and check filled values before submit
- [#3395](https://github.com/kontourai/station/pull/3395) chore(veritas): record the noreply address in committed attestations
- [#3376](https://github.com/kontourai/station/pull/3376) test(ui): pin other-tab model memory sync and narrow the "Still waiting" scan
- [#3233](https://github.com/kontourai/station/pull/3233) test(docs): run #3101 review-notes tests in parallel from a shared fixture
- [#3359](https://github.com/kontourai/station/pull/3359) test(prepush): name the liveness resolver as a hook setup step in gate-for
- [#3357](https://github.com/kontourai/station/pull/3357) test(projects): expect timeAgo's canonical relative time
- [#3339](https://github.com/kontourai/station/pull/3339) test(activity): feed the cross-surface block typed summaries, not casts
- [#3349](https://github.com/kontourai/station/pull/3349) test(veritas): run the readiness evidence wrapper against a minimal fixture repo
- [#3336](https://github.com/kontourai/station/pull/3336) test(station-control): classify the execution-preparation mode as a reviewed non-posture field
- [#3333](https://github.com/kontourai/station/pull/3333) test(prepush): copy the liveness-scale resolver closure into the push fixture
- [#3317](https://github.com/kontourai/station/pull/3317) test(e2e): drop the task-first journey's own skill-experience stub
- [#3214](https://github.com/kontourai/station/pull/3214) chore(chat): drop the direct-New helpers and comments #3170 left behind
- [#3292](https://github.com/kontourai/station/pull/3292) test(sdk): let the portable client lazy-load literal station-shared subpaths
- [#3264](https://github.com/kontourai/station/pull/3264) test(policy): drive each station-control policy tool through the server its serverIds names
- [#3252](https://github.com/kontourai/station/pull/3252) test(orchestration): follow #3242's revoke report in the task-dispatch full-access test
- [#3250](https://github.com/kontourai/station/pull/3250) test(docs): avoid history replay for ledger cardinality
- [#3237](https://github.com/kontourai/station/pull/3237) test(e2e): model the Project identity read in the task-first-home fixture
- [#3220](https://github.com/kontourai/station/pull/3220) test(ui): follow #3127's engine-silence wording in the dock activity test (#3173)
- [#3219](https://github.com/kontourai/station/pull/3219) test(ui): rate the agent icon a selected row really shows
- [#3207](https://github.com/kontourai/station/pull/3207) refactor(build): deslop plugin-build commentary and diagnostics
- [#3184](https://github.com/kontourai/station/pull/3184) refactor(settings): remove obsolete styles and repair mobile journey checks
- [#3183](https://github.com/kontourai/station/pull/3183) test(cli): remove credential-only test seams
- [#3182](https://github.com/kontourai/station/pull/3182) test: consolidate cleanup coverage and remove test-only seams
- [#3179](https://github.com/kontourai/station/pull/3179) test(e2e): the mobile sweep follows the scrolling chip row and the docked Activity pane
- [#3156](https://github.com/kontourai/station/pull/3156) chore(security): record approved seven-day advisory exceptions
- [#2980](https://github.com/kontourai/station/pull/2980) chore(deps): bump the github-actions-minor-patch group across 1 directory with 2 updates

## 2026-10-02T15:39:03Z · nightly-desktop · 0.1.11-nightly.2466.3

- Ship SHA: `e7fb9b3161de5d6a3e006ad9760ced9c862130c8`
- Artifact built at: `2026-10-02T14:55:33.962Z` (not provider upload/record time)
- Artifact: github-release:nightly-desktop (cohort-finalized)
- Note: ios: TestFlight delivery success (run 37021990417)

### Changelog

Commits since `1c46287` ([full sha](https://github.com/kontourai/station/commit/1c46287e3d2c12adf752e0c8ba9027560a6845ce)):

**Features**

- [#3115](https://github.com/kontourai/station/pull/3115) feat(file-preview): highlighted source and a per-file Changes view
- [#3082](https://github.com/kontourai/station/pull/3082) feat(ui): start with the task and simplify Station switching

## 2026-10-02T15:38:59Z · nightly-android · 0.1.11-nightly.2466.3

- Ship SHA: `e7fb9b3161de5d6a3e006ad9760ced9c862130c8`
- Artifact built at: `2026-10-02T14:55:25.707Z` (not provider upload/record time)
- Artifact: play-internal-aab:cohort-finalized
- Note: ios: TestFlight delivery success (run 37021990417)

### Changelog

Commits since `1c46287` ([full sha](https://github.com/kontourai/station/commit/1c46287e3d2c12adf752e0c8ba9027560a6845ce)):

**Features**

- [#3115](https://github.com/kontourai/station/pull/3115) feat(file-preview): highlighted source and a per-file Changes view
- [#3082](https://github.com/kontourai/station/pull/3082) feat(ui): start with the task and simplify Station switching

## 2026-10-02T15:36:40Z · nightly-npm · 0.7.0-nightly.2466.37021990417

- Ship SHA: `e7fb9b3161de5d6a3e006ad9760ced9c862130c8`
- Artifact built at: `unknown` (no immutable artifact manifest binding)
- Artifact: npm:@kontourai/station-cli@0.7.0-nightly.2466.37021990417 (dist-tag nightly; artifactBuiltAt unknown)
- Note: artifactBuiltAt is null: npm package has no native artifact manifest

### Changelog

Commits since `1c46287` ([full sha](https://github.com/kontourai/station/commit/1c46287e3d2c12adf752e0c8ba9027560a6845ce)):

**Features**

- [#3115](https://github.com/kontourai/station/pull/3115) feat(file-preview): highlighted source and a per-file Changes view
- [#3082](https://github.com/kontourai/station/pull/3082) feat(ui): start with the task and simplify Station switching

## 2026-10-02T13:20:33Z · nightly-desktop · 0.1.11-nightly.2466.2

- Ship SHA: `1c46287e3d2c12adf752e0c8ba9027560a6845ce`
- Artifact built at: `2026-10-02T12:30:06.250Z` (not provider upload/record time)
- Artifact: github-release:nightly-desktop (cohort-finalized)
- Note: ios: TestFlight delivery success (run 37006002202)

### Changelog

Commits since `2ed63fc` ([full sha](https://github.com/kontourai/station/commit/2ed63fc9e7f6c73ef9c7a20cbdc742975dfaf1a9)):

**Features**

- [#3111](https://github.com/kontourai/station/pull/3111) feat(ci): measure merge-queue and runner health over time (#3101 H)
- [#3100](https://github.com/kontourai/station/pull/3100) feat(claude): read the engine's structured ask reasons so grants never answer safety checks or ask rules (#2932)
- [#2974](https://github.com/kontourai/station/pull/2974) feat(install): install.ps1 stages Windows archives through a shared installer core (#2675 W1)

**Fixes**

- [#3108](https://github.com/kontourai/station/pull/3108) fix(chat): phone chat fixes — tool rows and approvals, pane layout, send and attachments

**CI / workflow**

- [#3107](https://github.com/kontourai/station/pull/3107) ci: right-size fast-checks shards for the hosted runner pool (#3101 D)

## 2026-10-02T13:20:31Z · nightly-android · 0.1.11-nightly.2466.2

- Ship SHA: `1c46287e3d2c12adf752e0c8ba9027560a6845ce`
- Artifact built at: `2026-10-02T12:29:43.600Z` (not provider upload/record time)
- Artifact: play-internal-aab:cohort-finalized
- Note: ios: TestFlight delivery success (run 37006002202)

### Changelog

Commits since `2ed63fc` ([full sha](https://github.com/kontourai/station/commit/2ed63fc9e7f6c73ef9c7a20cbdc742975dfaf1a9)):

**Features**

- [#3111](https://github.com/kontourai/station/pull/3111) feat(ci): measure merge-queue and runner health over time (#3101 H)
- [#3100](https://github.com/kontourai/station/pull/3100) feat(claude): read the engine's structured ask reasons so grants never answer safety checks or ask rules (#2932)
- [#2974](https://github.com/kontourai/station/pull/2974) feat(install): install.ps1 stages Windows archives through a shared installer core (#2675 W1)

**Fixes**

- [#3108](https://github.com/kontourai/station/pull/3108) fix(chat): phone chat fixes — tool rows and approvals, pane layout, send and attachments

**CI / workflow**

- [#3107](https://github.com/kontourai/station/pull/3107) ci: right-size fast-checks shards for the hosted runner pool (#3101 D)

## 2026-10-02T13:16:04Z · nightly-npm · 0.7.0-nightly.2466.37006002202

- Ship SHA: `1c46287e3d2c12adf752e0c8ba9027560a6845ce`
- Artifact built at: `unknown` (no immutable artifact manifest binding)
- Artifact: npm:@kontourai/station-cli@0.7.0-nightly.2466.37006002202 (dist-tag nightly; artifactBuiltAt unknown)
- Note: artifactBuiltAt is null: npm package has no native artifact manifest

### Changelog

Commits since `2ed63fc` ([full sha](https://github.com/kontourai/station/commit/2ed63fc9e7f6c73ef9c7a20cbdc742975dfaf1a9)):

**Features**

- [#3111](https://github.com/kontourai/station/pull/3111) feat(ci): measure merge-queue and runner health over time (#3101 H)
- [#3100](https://github.com/kontourai/station/pull/3100) feat(claude): read the engine's structured ask reasons so grants never answer safety checks or ask rules (#2932)
- [#2974](https://github.com/kontourai/station/pull/2974) feat(install): install.ps1 stages Windows archives through a shared installer core (#2675 W1)

**Fixes**

- [#3108](https://github.com/kontourai/station/pull/3108) fix(chat): phone chat fixes — tool rows and approvals, pane layout, send and attachments

**CI / workflow**

- [#3107](https://github.com/kontourai/station/pull/3107) ci: right-size fast-checks shards for the hosted runner pool (#3101 D)

## 2026-10-02T06:39:22Z · nightly-desktop · 0.1.11-nightly.2466.1

- Ship SHA: `2ed63fc9e7f6c73ef9c7a20cbdc742975dfaf1a9`
- Artifact built at: `2026-10-02T05:28:04.530Z` (not provider upload/record time)
- Artifact: github-release:nightly-desktop (cohort-finalized)
- Note: ios: TestFlight delivery success (run 36968209089)

### Changelog

Commits since `a91c50d` ([full sha](https://github.com/kontourai/station/commit/a91c50d32c2d96d89330c31054ca00c72e82d606)):

**Features**

- [#3077](https://github.com/kontourai/station/pull/3077) feat(inbox): one status ladder and a redesigned row
- [#3087](https://github.com/kontourai/station/pull/3087) feat(connections): add provider metadata, allowance history and account trends
- [#3035](https://github.com/kontourai/station/pull/3035) feat(ui): the Coding layout's centre becomes a Chat → drill-in navigation stack
- [#3055](https://github.com/kontourai/station/pull/3055) feat(ui): Activity opens as the main page from the sidebar, and shows as current
- [#3064](https://github.com/kontourai/station/pull/3064) feat(browser): page dialogs, console, screenshots and hand-back in a quiet Browser pane

**Fixes**

- [#3062](https://github.com/kontourai/station/pull/3062) fix(cli): Windows service task has no time limit or battery rules (#2970)
- [#3109](https://github.com/kontourai/station/pull/3109) fix(regions): Back returns from the Activity page, and Move to Main shows the pane (#2986, #2988)
- [#3103](https://github.com/kontourai/station/pull/3103) fix(chat): a failed turn shows one failure card after a reload (#2985)
- [#3094](https://github.com/kontourai/station/pull/3094) fix(pull-requests): match the session conflict chip against the branch's push owner (#2941)
- [#3104](https://github.com/kontourai/station/pull/3104) fix(cli): give the start's TCP listener waits the slow-boot extension (#2964)
- [#3095](https://github.com/kontourai/station/pull/3095) fix(ui): Agents keeps keyboard focus on selection; the list search box is 44px on touch (#2992, #3061)
- [#3081](https://github.com/kontourai/station/pull/3081) fix(server): settle requests when their turn is aborted
- [#3089](https://github.com/kontourai/station/pull/3089) fix(coding): confine git reads, checkpoints and checkouts to the Project's own repository
- [#3091](https://github.com/kontourai/station/pull/3091) fix(claude): network-host, sandbox-override and org-policy asks always reach a person (#2932, part 1)

**Docs**

- [#3105](https://github.com/kontourai/station/pull/3105) docs(ui): comments stop citing the removed Live collaborators section

**Other**

- [#3121](https://github.com/kontourai/station/pull/3121) test(ui): isolate turn-settlement fixture lifetime
- [#3096](https://github.com/kontourai/station/pull/3096) chore(test): neutral placeholders in remaining fixtures; Veritas 1.7.6
- [#3092](https://github.com/kontourai/station/pull/3092) test(ui): scan selected-row contrast after theme transitions settle

## 2026-10-02T06:39:20Z · nightly-android · 0.1.11-nightly.2466.1

- Ship SHA: `2ed63fc9e7f6c73ef9c7a20cbdc742975dfaf1a9`
- Artifact built at: `2026-10-02T05:29:14.116Z` (not provider upload/record time)
- Artifact: play-internal-aab:cohort-finalized
- Note: ios: TestFlight delivery success (run 36968209089)

### Changelog

Commits since `a91c50d` ([full sha](https://github.com/kontourai/station/commit/a91c50d32c2d96d89330c31054ca00c72e82d606)):

**Features**

- [#3077](https://github.com/kontourai/station/pull/3077) feat(inbox): one status ladder and a redesigned row
- [#3087](https://github.com/kontourai/station/pull/3087) feat(connections): add provider metadata, allowance history and account trends
- [#3035](https://github.com/kontourai/station/pull/3035) feat(ui): the Coding layout's centre becomes a Chat → drill-in navigation stack
- [#3055](https://github.com/kontourai/station/pull/3055) feat(ui): Activity opens as the main page from the sidebar, and shows as current
- [#3064](https://github.com/kontourai/station/pull/3064) feat(browser): page dialogs, console, screenshots and hand-back in a quiet Browser pane

**Fixes**

- [#3062](https://github.com/kontourai/station/pull/3062) fix(cli): Windows service task has no time limit or battery rules (#2970)
- [#3109](https://github.com/kontourai/station/pull/3109) fix(regions): Back returns from the Activity page, and Move to Main shows the pane (#2986, #2988)
- [#3103](https://github.com/kontourai/station/pull/3103) fix(chat): a failed turn shows one failure card after a reload (#2985)
- [#3094](https://github.com/kontourai/station/pull/3094) fix(pull-requests): match the session conflict chip against the branch's push owner (#2941)
- [#3104](https://github.com/kontourai/station/pull/3104) fix(cli): give the start's TCP listener waits the slow-boot extension (#2964)
- [#3095](https://github.com/kontourai/station/pull/3095) fix(ui): Agents keeps keyboard focus on selection; the list search box is 44px on touch (#2992, #3061)
- [#3081](https://github.com/kontourai/station/pull/3081) fix(server): settle requests when their turn is aborted
- [#3089](https://github.com/kontourai/station/pull/3089) fix(coding): confine git reads, checkpoints and checkouts to the Project's own repository
- [#3091](https://github.com/kontourai/station/pull/3091) fix(claude): network-host, sandbox-override and org-policy asks always reach a person (#2932, part 1)

**Docs**

- [#3105](https://github.com/kontourai/station/pull/3105) docs(ui): comments stop citing the removed Live collaborators section

**Other**

- [#3121](https://github.com/kontourai/station/pull/3121) test(ui): isolate turn-settlement fixture lifetime
- [#3096](https://github.com/kontourai/station/pull/3096) chore(test): neutral placeholders in remaining fixtures; Veritas 1.7.6
- [#3092](https://github.com/kontourai/station/pull/3092) test(ui): scan selected-row contrast after theme transitions settle

## 2026-10-02T06:29:08Z · nightly-npm · 0.7.0-nightly.2466.36968209089

- Ship SHA: `2ed63fc9e7f6c73ef9c7a20cbdc742975dfaf1a9`
- Artifact built at: `unknown` (no immutable artifact manifest binding)
- Artifact: npm:@kontourai/station-cli@0.7.0-nightly.2466.36968209089 (dist-tag nightly; artifactBuiltAt unknown)
- Note: artifactBuiltAt is null: npm package has no native artifact manifest

### Changelog

Commits since `a91c50d` ([full sha](https://github.com/kontourai/station/commit/a91c50d32c2d96d89330c31054ca00c72e82d606)):

**Features**

- [#3077](https://github.com/kontourai/station/pull/3077) feat(inbox): one status ladder and a redesigned row
- [#3087](https://github.com/kontourai/station/pull/3087) feat(connections): add provider metadata, allowance history and account trends
- [#3035](https://github.com/kontourai/station/pull/3035) feat(ui): the Coding layout's centre becomes a Chat → drill-in navigation stack
- [#3055](https://github.com/kontourai/station/pull/3055) feat(ui): Activity opens as the main page from the sidebar, and shows as current
- [#3064](https://github.com/kontourai/station/pull/3064) feat(browser): page dialogs, console, screenshots and hand-back in a quiet Browser pane

**Fixes**

- [#3062](https://github.com/kontourai/station/pull/3062) fix(cli): Windows service task has no time limit or battery rules (#2970)
- [#3109](https://github.com/kontourai/station/pull/3109) fix(regions): Back returns from the Activity page, and Move to Main shows the pane (#2986, #2988)
- [#3103](https://github.com/kontourai/station/pull/3103) fix(chat): a failed turn shows one failure card after a reload (#2985)
- [#3094](https://github.com/kontourai/station/pull/3094) fix(pull-requests): match the session conflict chip against the branch's push owner (#2941)
- [#3104](https://github.com/kontourai/station/pull/3104) fix(cli): give the start's TCP listener waits the slow-boot extension (#2964)
- [#3095](https://github.com/kontourai/station/pull/3095) fix(ui): Agents keeps keyboard focus on selection; the list search box is 44px on touch (#2992, #3061)
- [#3081](https://github.com/kontourai/station/pull/3081) fix(server): settle requests when their turn is aborted
- [#3089](https://github.com/kontourai/station/pull/3089) fix(coding): confine git reads, checkpoints and checkouts to the Project's own repository
- [#3091](https://github.com/kontourai/station/pull/3091) fix(claude): network-host, sandbox-override and org-policy asks always reach a person (#2932, part 1)

**Docs**

- [#3105](https://github.com/kontourai/station/pull/3105) docs(ui): comments stop citing the removed Live collaborators section

**Other**

- [#3121](https://github.com/kontourai/station/pull/3121) test(ui): isolate turn-settlement fixture lifetime
- [#3096](https://github.com/kontourai/station/pull/3096) chore(test): neutral placeholders in remaining fixtures; Veritas 1.7.6
- [#3092](https://github.com/kontourai/station/pull/3092) test(ui): scan selected-row contrast after theme transitions settle

## 2026-10-01T14:30:43Z · nightly-desktop · 0.1.11-nightly.2465.1

- Ship SHA: `a91c50d32c2d96d89330c31054ca00c72e82d606`
- Artifact built at: `2026-10-01T13:07:39.271Z` (not provider upload/record time)
- Artifact: github-release:nightly-desktop (cohort-finalized)
- Note: ios: TestFlight delivery success (run 36865249714)

### Changelog

Commits since `3b001e5` ([full sha](https://github.com/kontourai/station/commit/3b001e5e54358931bb4c090eec900d4ecb488620)):

**Features**

- [#3078](https://github.com/kontourai/station/pull/3078) feat(connections): add intuitive Codex and Claude account overview
- [#3084](https://github.com/kontourai/station/pull/3084) feat(tasks): show independent agent contributions in room history
- [#3080](https://github.com/kontourai/station/pull/3080) feat(tasks): call agents from shared Task rooms
- [#3069](https://github.com/kontourai/station/pull/3069) feat(ui): bump @kontourai/ui to 1.18.0 and drop Station's redundant brand text rule
- [#3057](https://github.com/kontourai/station/pull/3057) feat(ui): Activity groups by state, with filters, New task and a row menu
- [#3073](https://github.com/kontourai/station/pull/3073) feat(ui): cap labelled actions per row, with a shared ActionRow and eight conversions (#3045)
- [#3038](https://github.com/kontourai/station/pull/3038) feat(ui): Activity's session detail leads with the conversation

**Fixes**

- [#3017](https://github.com/kontourai/station/pull/3017) fix(approvals): autoApprove never covers escalations or plan exits (#2933)

**Docs**

- [#2994](https://github.com/kontourai/station/pull/2994) docs(design): Station as a shell — plugins, trust, layouts, distributions (#2993)

**Other**

- [#3060](https://github.com/kontourai/station/pull/3060) chore(tests): use neutral placeholders in test fixtures

## 2026-10-01T14:30:40Z · nightly-android · 0.1.11-nightly.2465.1

- Ship SHA: `a91c50d32c2d96d89330c31054ca00c72e82d606`
- Artifact built at: `2026-10-01T13:07:16.972Z` (not provider upload/record time)
- Artifact: play-internal-aab:cohort-finalized
- Note: ios: TestFlight delivery success (run 36865249714)

### Changelog

Commits since `3b001e5` ([full sha](https://github.com/kontourai/station/commit/3b001e5e54358931bb4c090eec900d4ecb488620)):

**Features**

- [#3078](https://github.com/kontourai/station/pull/3078) feat(connections): add intuitive Codex and Claude account overview
- [#3084](https://github.com/kontourai/station/pull/3084) feat(tasks): show independent agent contributions in room history
- [#3080](https://github.com/kontourai/station/pull/3080) feat(tasks): call agents from shared Task rooms
- [#3069](https://github.com/kontourai/station/pull/3069) feat(ui): bump @kontourai/ui to 1.18.0 and drop Station's redundant brand text rule
- [#3057](https://github.com/kontourai/station/pull/3057) feat(ui): Activity groups by state, with filters, New task and a row menu
- [#3073](https://github.com/kontourai/station/pull/3073) feat(ui): cap labelled actions per row, with a shared ActionRow and eight conversions (#3045)
- [#3038](https://github.com/kontourai/station/pull/3038) feat(ui): Activity's session detail leads with the conversation

**Fixes**

- [#3017](https://github.com/kontourai/station/pull/3017) fix(approvals): autoApprove never covers escalations or plan exits (#2933)

**Docs**

- [#2994](https://github.com/kontourai/station/pull/2994) docs(design): Station as a shell — plugins, trust, layouts, distributions (#2993)

**Other**

- [#3060](https://github.com/kontourai/station/pull/3060) chore(tests): use neutral placeholders in test fixtures

## 2026-10-01T14:08:22Z · nightly-npm · 0.7.0-nightly.2465.36865249714

- Ship SHA: `a91c50d32c2d96d89330c31054ca00c72e82d606`
- Artifact built at: `unknown` (no immutable artifact manifest binding)
- Artifact: npm:@kontourai/station-cli@0.7.0-nightly.2465.36865249714 (dist-tag nightly; artifactBuiltAt unknown)
- Note: artifactBuiltAt is null: npm package has no native artifact manifest

### Changelog

Commits since `3b001e5` ([full sha](https://github.com/kontourai/station/commit/3b001e5e54358931bb4c090eec900d4ecb488620)):

**Features**

- [#3078](https://github.com/kontourai/station/pull/3078) feat(connections): add intuitive Codex and Claude account overview
- [#3084](https://github.com/kontourai/station/pull/3084) feat(tasks): show independent agent contributions in room history
- [#3080](https://github.com/kontourai/station/pull/3080) feat(tasks): call agents from shared Task rooms
- [#3069](https://github.com/kontourai/station/pull/3069) feat(ui): bump @kontourai/ui to 1.18.0 and drop Station's redundant brand text rule
- [#3057](https://github.com/kontourai/station/pull/3057) feat(ui): Activity groups by state, with filters, New task and a row menu
- [#3073](https://github.com/kontourai/station/pull/3073) feat(ui): cap labelled actions per row, with a shared ActionRow and eight conversions (#3045)
- [#3038](https://github.com/kontourai/station/pull/3038) feat(ui): Activity's session detail leads with the conversation

**Fixes**

- [#3017](https://github.com/kontourai/station/pull/3017) fix(approvals): autoApprove never covers escalations or plan exits (#2933)

**Docs**

- [#2994](https://github.com/kontourai/station/pull/2994) docs(design): Station as a shell — plugins, trust, layouts, distributions (#2993)

**Other**

- [#3060](https://github.com/kontourai/station/pull/3060) chore(tests): use neutral placeholders in test fixtures

## 2026-10-01T07:13:08Z · nightly-desktop · 0.1.11-nightly.2465

- Ship SHA: `3b001e5e54358931bb4c090eec900d4ecb488620`
- Artifact built at: `2026-10-01T06:01:31.378Z` (not provider upload/record time)
- Artifact: github-release:nightly-desktop (cohort-finalized)
- Note: ios: TestFlight delivery success (run 36819975981)

### Changelog

Commits since `4dbf9ac` ([full sha](https://github.com/kontourai/station/commit/4dbf9acbcab04c4695c8ca9799bc1422526cd382)):

**Features**

- [#3037](https://github.com/kontourai/station/pull/3037) feat(tasks): show work on a board and lead with the shared workspace
- [#2896](https://github.com/kontourai/station/pull/2896) feat(relay): add opt-in native Device proof pilot

**Fixes**

- [#3032](https://github.com/kontourai/station/pull/3032) fix(connections): admit delegated sign-in profile reads
- [#2987](https://github.com/kontourai/station/pull/2987) fix(server): say why a Station agent turn failed, and keep provider error text off Station's chat surfaces
- [#2983](https://github.com/kontourai/station/pull/2983) fix(ui): accessible split-pane list rows (AA selection, keyboard, names, touch targets)
- [#3031](https://github.com/kontourai/station/pull/3031) fix(mcp): reconnect built-in tool servers without false stale custody

**Other**

- [#3033](https://github.com/kontourai/station/pull/3033) chore(release): publish Agent SDK 0.8 with verified release closure

## 2026-10-01T07:13:05Z · nightly-android · 0.1.11-nightly.2465

- Ship SHA: `3b001e5e54358931bb4c090eec900d4ecb488620`
- Artifact built at: `2026-10-01T05:42:25.191Z` (not provider upload/record time)
- Artifact: play-internal-aab:cohort-finalized
- Note: ios: TestFlight delivery success (run 36819975981)

### Changelog

Commits since `4dbf9ac` ([full sha](https://github.com/kontourai/station/commit/4dbf9acbcab04c4695c8ca9799bc1422526cd382)):

**Features**

- [#3037](https://github.com/kontourai/station/pull/3037) feat(tasks): show work on a board and lead with the shared workspace
- [#2896](https://github.com/kontourai/station/pull/2896) feat(relay): add opt-in native Device proof pilot

**Fixes**

- [#3032](https://github.com/kontourai/station/pull/3032) fix(connections): admit delegated sign-in profile reads
- [#2987](https://github.com/kontourai/station/pull/2987) fix(server): say why a Station agent turn failed, and keep provider error text off Station's chat surfaces
- [#2983](https://github.com/kontourai/station/pull/2983) fix(ui): accessible split-pane list rows (AA selection, keyboard, names, touch targets)
- [#3031](https://github.com/kontourai/station/pull/3031) fix(mcp): reconnect built-in tool servers without false stale custody

**Other**

- [#3033](https://github.com/kontourai/station/pull/3033) chore(release): publish Agent SDK 0.8 with verified release closure

## 2026-10-01T06:47:09Z · nightly-npm · 0.7.0-nightly.2465.36819975981

- Ship SHA: `3b001e5e54358931bb4c090eec900d4ecb488620`
- Artifact built at: `unknown` (no immutable artifact manifest binding)
- Artifact: npm:@kontourai/station-cli@0.7.0-nightly.2465.36819975981 (dist-tag nightly; artifactBuiltAt unknown)
- Note: artifactBuiltAt is null: npm package has no native artifact manifest

### Changelog

Commits since `4dbf9ac` ([full sha](https://github.com/kontourai/station/commit/4dbf9acbcab04c4695c8ca9799bc1422526cd382)):

**Features**

- [#3037](https://github.com/kontourai/station/pull/3037) feat(tasks): show work on a board and lead with the shared workspace
- [#2896](https://github.com/kontourai/station/pull/2896) feat(relay): add opt-in native Device proof pilot

**Fixes**

- [#3032](https://github.com/kontourai/station/pull/3032) fix(connections): admit delegated sign-in profile reads
- [#2987](https://github.com/kontourai/station/pull/2987) fix(server): say why a Station agent turn failed, and keep provider error text off Station's chat surfaces
- [#2983](https://github.com/kontourai/station/pull/2983) fix(ui): accessible split-pane list rows (AA selection, keyboard, names, touch targets)
- [#3031](https://github.com/kontourai/station/pull/3031) fix(mcp): reconnect built-in tool servers without false stale custody

**Other**

- [#3033](https://github.com/kontourai/station/pull/3033) chore(release): publish Agent SDK 0.8 with verified release closure

## 2026-09-30T23:10:29Z · nightly-desktop · 0.1.11-nightly.2464.3

- Ship SHA: `4dbf9acbcab04c4695c8ca9799bc1422526cd382`
- Artifact built at: `2026-09-30T22:16:49.568Z` (not provider upload/record time)
- Artifact: github-release:nightly-desktop (cohort-finalized)
- Note: ios: TestFlight delivery failure (run 36783703696)

### Changelog

Commits since `5ecd682` ([full sha](https://github.com/kontourai/station/commit/5ecd682d3dda93a00a126e31328fb563f3b427b8)):

**Fixes**

- [#2967](https://github.com/kontourai/station/pull/2967) fix(docs,ci): merge-friendly review ledger, PR/queue parity, and automation token

## 2026-09-30T23:10:26Z · nightly-android · 0.1.11-nightly.2464.3

- Ship SHA: `4dbf9acbcab04c4695c8ca9799bc1422526cd382`
- Artifact built at: `2026-09-30T22:16:36.969Z` (not provider upload/record time)
- Artifact: play-internal-aab:cohort-finalized
- Note: ios: TestFlight delivery failure (run 36783703696)

### Changelog

Commits since `5ecd682` ([full sha](https://github.com/kontourai/station/commit/5ecd682d3dda93a00a126e31328fb563f3b427b8)):

**Fixes**

- [#2967](https://github.com/kontourai/station/pull/2967) fix(docs,ci): merge-friendly review ledger, PR/queue parity, and automation token

## 2026-09-30T23:03:25Z · nightly-npm · 0.6.0-nightly.2464.36783703696

- Ship SHA: `4dbf9acbcab04c4695c8ca9799bc1422526cd382`
- Artifact built at: `unknown` (no immutable artifact manifest binding)
- Artifact: npm:@kontourai/station-cli@0.6.0-nightly.2464.36783703696 (dist-tag nightly; artifactBuiltAt unknown)
- Note: artifactBuiltAt is null: npm package has no native artifact manifest

### Changelog

Commits since `5ecd682` ([full sha](https://github.com/kontourai/station/commit/5ecd682d3dda93a00a126e31328fb563f3b427b8)):

**Fixes**

- [#2967](https://github.com/kontourai/station/pull/2967) fix(docs,ci): merge-friendly review ledger, PR/queue parity, and automation token

## 2026-09-30T20:34:00Z · nightly-desktop · 0.1.11-nightly.2464.2

- Ship SHA: `5ecd682d3dda93a00a126e31328fb563f3b427b8`
- Artifact built at: `2026-09-30T19:54:00.917Z` (not provider upload/record time)
- Artifact: github-release:nightly-desktop (cohort-finalized)
- Note: ios: TestFlight delivery success (run 36767826654)

### Changelog

Commits since `e27600d` ([full sha](https://github.com/kontourai/station/commit/e27600d1fcd3ba8b80f793713e7901c35cba4381)):

**Features**

- [#3023](https://github.com/kontourai/station/pull/3023) feat(sdk): establish a headless Agent development boundary
- [#3021](https://github.com/kontourai/station/pull/3021) feat(chat): answer harness questions with compact cards and batch review
- [#3018](https://github.com/kontourai/station/pull/3018) feat(connections): sign engine credential profiles in from paired devices
- [#2984](https://github.com/kontourai/station/pull/2984) feat(inbox): split live work into Needs you / Running / Idle, and cue unsent composer drafts

**Fixes**

- [#3029](https://github.com/kontourai/station/pull/3029) fix(pairing): make promoted mobile approval actionable
- [#3025](https://github.com/kontourai/station/pull/3025) fix(chat): omit raw failed tool output from outward streams
- [#3019](https://github.com/kontourai/station/pull/3019) fix(native): give chat dispatch a bounded response-header deadline
- [#3020](https://github.com/kontourai/station/pull/3020) fix(deps): patch brace expansion and URI normalization advisories
- [#3013](https://github.com/kontourai/station/pull/3013) fix(nightly): give the rolling-manifest re-verify five minutes to see the new bytes

**Docs**

- [#3022](https://github.com/kontourai/station/pull/3022) docs: record published Knowledge consumer fixes

**Other**

- [#3028](https://github.com/kontourai/station/pull/3028) test(ci): compare one Vitest discovery snapshot

## 2026-09-30T20:33:57Z · nightly-android · 0.1.11-nightly.2464.2

- Ship SHA: `5ecd682d3dda93a00a126e31328fb563f3b427b8`
- Artifact built at: `2026-09-30T19:54:01.809Z` (not provider upload/record time)
- Artifact: play-internal-aab:cohort-finalized
- Note: ios: TestFlight delivery success (run 36767826654)

### Changelog

Commits since `e27600d` ([full sha](https://github.com/kontourai/station/commit/e27600d1fcd3ba8b80f793713e7901c35cba4381)):

**Features**

- [#3023](https://github.com/kontourai/station/pull/3023) feat(sdk): establish a headless Agent development boundary
- [#3021](https://github.com/kontourai/station/pull/3021) feat(chat): answer harness questions with compact cards and batch review
- [#3018](https://github.com/kontourai/station/pull/3018) feat(connections): sign engine credential profiles in from paired devices
- [#2984](https://github.com/kontourai/station/pull/2984) feat(inbox): split live work into Needs you / Running / Idle, and cue unsent composer drafts

**Fixes**

- [#3029](https://github.com/kontourai/station/pull/3029) fix(pairing): make promoted mobile approval actionable
- [#3025](https://github.com/kontourai/station/pull/3025) fix(chat): omit raw failed tool output from outward streams
- [#3019](https://github.com/kontourai/station/pull/3019) fix(native): give chat dispatch a bounded response-header deadline
- [#3020](https://github.com/kontourai/station/pull/3020) fix(deps): patch brace expansion and URI normalization advisories
- [#3013](https://github.com/kontourai/station/pull/3013) fix(nightly): give the rolling-manifest re-verify five minutes to see the new bytes

**Docs**

- [#3022](https://github.com/kontourai/station/pull/3022) docs: record published Knowledge consumer fixes

**Other**

- [#3028](https://github.com/kontourai/station/pull/3028) test(ci): compare one Vitest discovery snapshot

## 2026-09-30T20:29:52Z · nightly-npm · 0.6.0-nightly.2464.36767826654

- Ship SHA: `5ecd682d3dda93a00a126e31328fb563f3b427b8`
- Artifact built at: `unknown` (no immutable artifact manifest binding)
- Artifact: npm:@kontourai/station-cli@0.6.0-nightly.2464.36767826654 (dist-tag nightly; artifactBuiltAt unknown)
- Note: artifactBuiltAt is null: npm package has no native artifact manifest

### Changelog

Commits since `e27600d` ([full sha](https://github.com/kontourai/station/commit/e27600d1fcd3ba8b80f793713e7901c35cba4381)):

**Features**

- [#3023](https://github.com/kontourai/station/pull/3023) feat(sdk): establish a headless Agent development boundary
- [#3021](https://github.com/kontourai/station/pull/3021) feat(chat): answer harness questions with compact cards and batch review
- [#3018](https://github.com/kontourai/station/pull/3018) feat(connections): sign engine credential profiles in from paired devices
- [#2984](https://github.com/kontourai/station/pull/2984) feat(inbox): split live work into Needs you / Running / Idle, and cue unsent composer drafts

**Fixes**

- [#3029](https://github.com/kontourai/station/pull/3029) fix(pairing): make promoted mobile approval actionable
- [#3025](https://github.com/kontourai/station/pull/3025) fix(chat): omit raw failed tool output from outward streams
- [#3019](https://github.com/kontourai/station/pull/3019) fix(native): give chat dispatch a bounded response-header deadline
- [#3020](https://github.com/kontourai/station/pull/3020) fix(deps): patch brace expansion and URI normalization advisories
- [#3013](https://github.com/kontourai/station/pull/3013) fix(nightly): give the rolling-manifest re-verify five minutes to see the new bytes

**Docs**

- [#3022](https://github.com/kontourai/station/pull/3022) docs: record published Knowledge consumer fixes

**Other**

- [#3028](https://github.com/kontourai/station/pull/3028) test(ci): compare one Vitest discovery snapshot

## 2026-09-30T06:25:54Z · nightly-desktop · 0.1.11-nightly.2464

- Ship SHA: `e27600d1fcd3ba8b80f793713e7901c35cba4381`
- Artifact built at: `2026-09-30T05:26:56.248Z` (not provider upload/record time)
- Artifact: github-release:nightly-desktop (cohort-finalized)
- Note: ios: TestFlight delivery success (run 36672468094)

### Changelog

Commits since `fa78d02` ([full sha](https://github.com/kontourai/station/commit/fa78d02a509c2a30a4347130f54de67cd6f30ba1)):

**Features**

- [#2952](https://github.com/kontourai/station/pull/2952) feat(ui): bump @kontourai/ui to 1.16.0 and validate branding themes with its validateBrandOverride

**Fixes**

- [#3015](https://github.com/kontourai/station/pull/3015) fix(chat): keep provider diagnostics off outward chat responses
- [#2942](https://github.com/kontourai/station/pull/2942) fix(claude): keep session grants off escalations and plan exits (#2915, #2916)
- [#2979](https://github.com/kontourai/station/pull/2979) fix(release): admit draft assets from an explicit producer artifact allowlist (#2977)

## 2026-09-30T06:25:51Z · nightly-android · 0.1.11-nightly.2464

- Ship SHA: `e27600d1fcd3ba8b80f793713e7901c35cba4381`
- Artifact built at: `2026-09-30T05:26:39.166Z` (not provider upload/record time)
- Artifact: play-internal-aab:cohort-finalized
- Note: ios: TestFlight delivery success (run 36672468094)

### Changelog

Commits since `fa78d02` ([full sha](https://github.com/kontourai/station/commit/fa78d02a509c2a30a4347130f54de67cd6f30ba1)):

**Features**

- [#2952](https://github.com/kontourai/station/pull/2952) feat(ui): bump @kontourai/ui to 1.16.0 and validate branding themes with its validateBrandOverride

**Fixes**

- [#3015](https://github.com/kontourai/station/pull/3015) fix(chat): keep provider diagnostics off outward chat responses
- [#2942](https://github.com/kontourai/station/pull/2942) fix(claude): keep session grants off escalations and plan exits (#2915, #2916)
- [#2979](https://github.com/kontourai/station/pull/2979) fix(release): admit draft assets from an explicit producer artifact allowlist (#2977)

## 2026-09-30T06:22:05Z · nightly-npm · 0.6.0-nightly.2464.36672468094

- Ship SHA: `e27600d1fcd3ba8b80f793713e7901c35cba4381`
- Artifact built at: `unknown` (no immutable artifact manifest binding)
- Artifact: npm:@kontourai/station-cli@0.6.0-nightly.2464.36672468094 (dist-tag nightly; artifactBuiltAt unknown)
- Note: artifactBuiltAt is null: npm package has no native artifact manifest

### Changelog

Commits since `fa78d02` ([full sha](https://github.com/kontourai/station/commit/fa78d02a509c2a30a4347130f54de67cd6f30ba1)):

**Features**

- [#2952](https://github.com/kontourai/station/pull/2952) feat(ui): bump @kontourai/ui to 1.16.0 and validate branding themes with its validateBrandOverride

**Fixes**

- [#3015](https://github.com/kontourai/station/pull/3015) fix(chat): keep provider diagnostics off outward chat responses
- [#2942](https://github.com/kontourai/station/pull/2942) fix(claude): keep session grants off escalations and plan exits (#2915, #2916)
- [#2979](https://github.com/kontourai/station/pull/2979) fix(release): admit draft assets from an explicit producer artifact allowlist (#2977)

## 2026-09-29T23:54:41Z · nightly-desktop · 0.1.11-nightly.2463.3

- Ship SHA: `fa78d02a509c2a30a4347130f54de67cd6f30ba1`
- Artifact built at: `2026-09-29T22:55:57.445Z` (not provider upload/record time)
- Artifact: github-release:nightly-desktop (cohort-finalized)
- Note: ios: TestFlight delivery success (run 36637714147)

### Changelog

Commits since `0690c93` ([full sha](https://github.com/kontourai/station/commit/0690c93997c7abf1c0e410be6166e5f615cefd4b)):

**Features**

- [#2920](https://github.com/kontourai/station/pull/2920) feat(station-control): one remote-Station forwarding seam, bounded and peer-text-free (#2377 C2b)

**Fixes**

- [#2599](https://github.com/kontourai/station/pull/2599) fix(deps): land the runtime/UI and GitHub Actions bumps with the changes their guards need
- [#2975](https://github.com/kontourai/station/pull/2975) fix(update): follow the https redirects GitHub serves the release manifest through
- [#2954](https://github.com/kontourai/station/pull/2954) fix(cli): keep recorded ports when station upgrade re-runs install.sh

**Docs**

- [#2973](https://github.com/kontourai/station/pull/2973) docs(adr): ADR 0020 distribution — two trains, channels as pointers, installer-first (#2958)
- [#2968](https://github.com/kontourai/station/pull/2968) docs(adr): record packaged-build evidence for ADR 0015 NOT_VERIFIED items (#2957)

**Other**

- [#2955](https://github.com/kontourai/station/pull/2955) chore(veritas): record a repository-relative target_root in the init plan

## 2026-09-29T23:54:39Z · nightly-android · 0.1.11-nightly.2463.3

- Ship SHA: `fa78d02a509c2a30a4347130f54de67cd6f30ba1`
- Artifact built at: `2026-09-29T22:20:22.559Z` (not provider upload/record time)
- Artifact: play-internal-aab:cohort-finalized
- Note: ios: TestFlight delivery success (run 36637714147)

### Changelog

Commits since `0690c93` ([full sha](https://github.com/kontourai/station/commit/0690c93997c7abf1c0e410be6166e5f615cefd4b)):

**Features**

- [#2920](https://github.com/kontourai/station/pull/2920) feat(station-control): one remote-Station forwarding seam, bounded and peer-text-free (#2377 C2b)

**Fixes**

- [#2599](https://github.com/kontourai/station/pull/2599) fix(deps): land the runtime/UI and GitHub Actions bumps with the changes their guards need
- [#2975](https://github.com/kontourai/station/pull/2975) fix(update): follow the https redirects GitHub serves the release manifest through
- [#2954](https://github.com/kontourai/station/pull/2954) fix(cli): keep recorded ports when station upgrade re-runs install.sh

**Docs**

- [#2973](https://github.com/kontourai/station/pull/2973) docs(adr): ADR 0020 distribution — two trains, channels as pointers, installer-first (#2958)
- [#2968](https://github.com/kontourai/station/pull/2968) docs(adr): record packaged-build evidence for ADR 0015 NOT_VERIFIED items (#2957)

**Other**

- [#2955](https://github.com/kontourai/station/pull/2955) chore(veritas): record a repository-relative target_root in the init plan

## 2026-09-29T23:19:11Z · nightly-npm · 0.6.0-nightly.2463.36637714147

- Ship SHA: `fa78d02a509c2a30a4347130f54de67cd6f30ba1`
- Artifact built at: `unknown` (no immutable artifact manifest binding)
- Artifact: npm:@kontourai/station-cli@0.6.0-nightly.2463.36637714147 (dist-tag nightly; artifactBuiltAt unknown)
- Note: artifactBuiltAt is null: npm package has no native artifact manifest

### Changelog

Commits since `0690c93` ([full sha](https://github.com/kontourai/station/commit/0690c93997c7abf1c0e410be6166e5f615cefd4b)):

**Features**

- [#2920](https://github.com/kontourai/station/pull/2920) feat(station-control): one remote-Station forwarding seam, bounded and peer-text-free (#2377 C2b)

**Fixes**

- [#2599](https://github.com/kontourai/station/pull/2599) fix(deps): land the runtime/UI and GitHub Actions bumps with the changes their guards need
- [#2975](https://github.com/kontourai/station/pull/2975) fix(update): follow the https redirects GitHub serves the release manifest through
- [#2954](https://github.com/kontourai/station/pull/2954) fix(cli): keep recorded ports when station upgrade re-runs install.sh

**Docs**

- [#2973](https://github.com/kontourai/station/pull/2973) docs(adr): ADR 0020 distribution — two trains, channels as pointers, installer-first (#2958)
- [#2968](https://github.com/kontourai/station/pull/2968) docs(adr): record packaged-build evidence for ADR 0015 NOT_VERIFIED items (#2957)

**Other**

- [#2955](https://github.com/kontourai/station/pull/2955) chore(veritas): record a repository-relative target_root in the init plan

## 2026-09-29T13:27:53Z · nightly-desktop · 0.1.11-nightly.2463.2

- Ship SHA: `0690c93997c7abf1c0e410be6166e5f615cefd4b`
- Artifact built at: `2026-09-29T12:47:27.096Z` (not provider upload/record time)
- Artifact: github-release:nightly-desktop (cohort-finalized)
- Note: ios: TestFlight delivery success (run 36569268737)

### Changelog

Commits since `e8cbb94` ([full sha](https://github.com/kontourai/station/commit/e8cbb9412176d0fd372de92ef455132e952a409f)):

**Features**

- [#2892](https://github.com/kontourai/station/pull/2892) feat(relay): add opt-in native application signaling bridge

**Fixes**

- [#2943](https://github.com/kontourai/station/pull/2943) fix(container,docs): restore the docs build inputs and the public Pages link

## 2026-09-29T13:27:50Z · nightly-android · 0.1.11-nightly.2463.2

- Ship SHA: `0690c93997c7abf1c0e410be6166e5f615cefd4b`
- Artifact built at: `2026-09-29T12:47:05.040Z` (not provider upload/record time)
- Artifact: play-internal-aab:cohort-finalized
- Note: ios: TestFlight delivery success (run 36569268737)

### Changelog

Commits since `99f9520` ([full sha](https://github.com/kontourai/station/commit/99f9520b0fde970a123c4dabc22137a55747aa17)):

**Features**

- [#2892](https://github.com/kontourai/station/pull/2892) feat(relay): add opt-in native application signaling bridge

**Fixes**

- [#2943](https://github.com/kontourai/station/pull/2943) fix(container,docs): restore the docs build inputs and the public Pages link
- [#2944](https://github.com/kontourai/station/pull/2944) fix(ui): channel brand text meets AA on its real surfaces
- [#2940](https://github.com/kontourai/station/pull/2940) fix(ui): keep the approval card legible at narrow width, with accessible button states (#2917)

**Other**

- [#2951](https://github.com/kontourai/station/pull/2951) test(docs): stop the atlas browser test from dequeuing PRs over another PR's stale review

## 2026-09-29T13:20:39Z · nightly-npm · 0.6.0-nightly.2463.36569268737

- Ship SHA: `0690c93997c7abf1c0e410be6166e5f615cefd4b`
- Artifact built at: `unknown` (no immutable artifact manifest binding)
- Artifact: npm:@kontourai/station-cli@0.6.0-nightly.2463.36569268737 (dist-tag nightly; artifactBuiltAt unknown)
- Note: artifactBuiltAt is null: npm package has no native artifact manifest

### Changelog

Commits since `e8cbb94` ([full sha](https://github.com/kontourai/station/commit/e8cbb9412176d0fd372de92ef455132e952a409f)):

**Features**

- [#2892](https://github.com/kontourai/station/pull/2892) feat(relay): add opt-in native application signaling bridge

**Fixes**

- [#2943](https://github.com/kontourai/station/pull/2943) fix(container,docs): restore the docs build inputs and the public Pages link

## 2026-09-29T06:59:09Z · nightly-desktop · 0.1.11-nightly.2463.1

- Ship SHA: `e8cbb9412176d0fd372de92ef455132e952a409f`
- Artifact built at: `2026-09-29T06:10:14.929Z` (not provider upload/record time)
- Artifact: github-release:nightly-desktop (cohort-finalized)
- Note: ios: TestFlight delivery success (run 36526165983)
- Note: android: NOT_VERIFIED (android provider outcome unknown: unresolved:run:36526165983:play-upload-or-query (the provider effect may already be live))

### Changelog

Commits since `99f9520` ([full sha](https://github.com/kontourai/station/commit/99f9520b0fde970a123c4dabc22137a55747aa17)):

**Fixes**

- [#2944](https://github.com/kontourai/station/pull/2944) fix(ui): channel brand text meets AA on its real surfaces
- [#2940](https://github.com/kontourai/station/pull/2940) fix(ui): keep the approval card legible at narrow width, with accessible button states (#2917)

**Other**

- [#2951](https://github.com/kontourai/station/pull/2951) test(docs): stop the atlas browser test from dequeuing PRs over another PR's stale review

## 2026-09-29T06:54:46Z · nightly-npm · 0.6.0-nightly.2463.36526165983

- Ship SHA: `e8cbb9412176d0fd372de92ef455132e952a409f`
- Artifact built at: `unknown` (no immutable artifact manifest binding)
- Artifact: npm:@kontourai/station-cli@0.6.0-nightly.2463.36526165983 (dist-tag nightly; artifactBuiltAt unknown)
- Note: artifactBuiltAt is null: npm package has no native artifact manifest

### Changelog

Commits since `99f9520` ([full sha](https://github.com/kontourai/station/commit/99f9520b0fde970a123c4dabc22137a55747aa17)):

**Fixes**

- [#2944](https://github.com/kontourai/station/pull/2944) fix(ui): channel brand text meets AA on its real surfaces
- [#2940](https://github.com/kontourai/station/pull/2940) fix(ui): keep the approval card legible at narrow width, with accessible button states (#2917)

**Other**

- [#2951](https://github.com/kontourai/station/pull/2951) test(docs): stop the atlas browser test from dequeuing PRs over another PR's stale review

## 2026-09-29T05:51:27Z · nightly-desktop · 0.1.11-nightly.2463

- Ship SHA: `99f9520b0fde970a123c4dabc22137a55747aa17`
- Artifact built at: `2026-09-29T04:25:21.790Z` (not provider upload/record time)
- Artifact: github-release:nightly-desktop (cohort-finalized)
- Note: ios: TestFlight delivery success (run 36520805311)

### Changelog

Commits since `ec29a87` ([full sha](https://github.com/kontourai/station/commit/ec29a8774f2c138bfd9e9818c0f0cc36fc5ebefe)):

**Features**

- [#2902](https://github.com/kontourai/station/pull/2902) feat(ui): apply validated white-label branding theme; action/focus roles with fallbacks

**Fixes**

- [#2938](https://github.com/kontourai/station/pull/2938) fix(pull-requests): observe session PR conflicts with one narrow, coalesced read per repository (#2937)
- [#2931](https://github.com/kontourai/station/pull/2931) fix(verification): report the narrow-diff fixture's changed paths
- [#2921](https://github.com/kontourai/station/pull/2921) fix(codex): session grants never auto-approve escalations; approval titles cannot be spoofed (#2911)

**Docs**

- [#2946](https://github.com/kontourai/station/pull/2946) docs(agents): point status styling at the kit tones, not hex

**Other**

- [#2945](https://github.com/kontourai/station/pull/2945) refactor: remove dead station-control stdio caller token and isLocalRuntimeCaller; key terminal query-credential failures on the normalized peer
- [#2918](https://github.com/kontourai/station/pull/2918) test: test-audit Server services (batches 42, 43, 44, 51, 54, 56, 60, 65)

## 2026-09-29T05:51:25Z · nightly-android · 0.1.11-nightly.2463

- Ship SHA: `99f9520b0fde970a123c4dabc22137a55747aa17`
- Artifact built at: `2026-09-29T04:24:54.524Z` (not provider upload/record time)
- Artifact: play-internal-aab:cohort-finalized
- Note: ios: TestFlight delivery success (run 36520805311)

### Changelog

Commits since `ec29a87` ([full sha](https://github.com/kontourai/station/commit/ec29a8774f2c138bfd9e9818c0f0cc36fc5ebefe)):

**Features**

- [#2902](https://github.com/kontourai/station/pull/2902) feat(ui): apply validated white-label branding theme; action/focus roles with fallbacks

**Fixes**

- [#2938](https://github.com/kontourai/station/pull/2938) fix(pull-requests): observe session PR conflicts with one narrow, coalesced read per repository (#2937)
- [#2931](https://github.com/kontourai/station/pull/2931) fix(verification): report the narrow-diff fixture's changed paths
- [#2921](https://github.com/kontourai/station/pull/2921) fix(codex): session grants never auto-approve escalations; approval titles cannot be spoofed (#2911)

**Docs**

- [#2946](https://github.com/kontourai/station/pull/2946) docs(agents): point status styling at the kit tones, not hex

**Other**

- [#2945](https://github.com/kontourai/station/pull/2945) refactor: remove dead station-control stdio caller token and isLocalRuntimeCaller; key terminal query-credential failures on the normalized peer
- [#2918](https://github.com/kontourai/station/pull/2918) test: test-audit Server services (batches 42, 43, 44, 51, 54, 56, 60, 65)

## 2026-09-29T05:21:53Z · nightly-npm · 0.6.0-nightly.2463.36520805311

- Ship SHA: `99f9520b0fde970a123c4dabc22137a55747aa17`
- Artifact built at: `unknown` (no immutable artifact manifest binding)
- Artifact: npm:@kontourai/station-cli@0.6.0-nightly.2463.36520805311 (dist-tag nightly; artifactBuiltAt unknown)
- Note: artifactBuiltAt is null: npm package has no native artifact manifest

### Changelog

Commits since `ec29a87` ([full sha](https://github.com/kontourai/station/commit/ec29a8774f2c138bfd9e9818c0f0cc36fc5ebefe)):

**Features**

- [#2902](https://github.com/kontourai/station/pull/2902) feat(ui): apply validated white-label branding theme; action/focus roles with fallbacks

**Fixes**

- [#2938](https://github.com/kontourai/station/pull/2938) fix(pull-requests): observe session PR conflicts with one narrow, coalesced read per repository (#2937)
- [#2931](https://github.com/kontourai/station/pull/2931) fix(verification): report the narrow-diff fixture's changed paths
- [#2921](https://github.com/kontourai/station/pull/2921) fix(codex): session grants never auto-approve escalations; approval titles cannot be spoofed (#2911)

**Docs**

- [#2946](https://github.com/kontourai/station/pull/2946) docs(agents): point status styling at the kit tones, not hex

**Other**

- [#2945](https://github.com/kontourai/station/pull/2945) refactor: remove dead station-control stdio caller token and isLocalRuntimeCaller; key terminal query-credential failures on the normalized peer
- [#2918](https://github.com/kontourai/station/pull/2918) test: test-audit Server services (batches 42, 43, 44, 51, 54, 56, 60, 65)

## 2026-09-29T00:28:17Z · nightly-desktop · 0.1.11-nightly.2462.3

- Ship SHA: `ec29a8774f2c138bfd9e9818c0f0cc36fc5ebefe`
- Artifact built at: `2026-09-28T23:41:47.339Z` (not provider upload/record time)
- Artifact: github-release:nightly-desktop (cohort-finalized)
- Note: ios: TestFlight delivery success (run 36497491629)

### Changelog

Commits since `d0ca944` ([full sha](https://github.com/kontourai/station/commit/d0ca944c58c8dd4de5a17563eb97d06dbdbe3512)):

**Fixes**

- [#2935](https://github.com/kontourai/station/pull/2935) fix(nightly): let the portable publish job read its signing key
- [#2866](https://github.com/kontourai/station/pull/2866) fix(plugins): strip git metadata from proposed remote clones
- [#2934](https://github.com/kontourai/station/pull/2934) fix(docs): scope documentation freshness to each PR, add docs:review:record and a Nightly sweep

**Other**

- [#2929](https://github.com/kontourai/station/pull/2929) test(install): catch an early pipe close on Linux, not only macOS
- [#2906](https://github.com/kontourai/station/pull/2906) test: test-audit Server routes, domain, runtime/mcp and providers (batches 39, 48, 49, 50, 55, 57, 59)

## 2026-09-29T00:28:15Z · nightly-android · 0.1.11-nightly.2462.3

- Ship SHA: `ec29a8774f2c138bfd9e9818c0f0cc36fc5ebefe`
- Artifact built at: `2026-09-28T23:45:22.076Z` (not provider upload/record time)
- Artifact: play-internal-aab:cohort-finalized
- Note: ios: TestFlight delivery success (run 36497491629)

### Changelog

Commits since `d0ca944` ([full sha](https://github.com/kontourai/station/commit/d0ca944c58c8dd4de5a17563eb97d06dbdbe3512)):

**Fixes**

- [#2935](https://github.com/kontourai/station/pull/2935) fix(nightly): let the portable publish job read its signing key
- [#2866](https://github.com/kontourai/station/pull/2866) fix(plugins): strip git metadata from proposed remote clones
- [#2934](https://github.com/kontourai/station/pull/2934) fix(docs): scope documentation freshness to each PR, add docs:review:record and a Nightly sweep

**Other**

- [#2929](https://github.com/kontourai/station/pull/2929) test(install): catch an early pipe close on Linux, not only macOS
- [#2906](https://github.com/kontourai/station/pull/2906) test: test-audit Server routes, domain, runtime/mcp and providers (batches 39, 48, 49, 50, 55, 57, 59)

## 2026-09-29T00:19:44Z · nightly-npm · 0.6.0-nightly.2462.36497491629

- Ship SHA: `ec29a8774f2c138bfd9e9818c0f0cc36fc5ebefe`
- Artifact built at: `unknown` (no immutable artifact manifest binding)
- Artifact: npm:@kontourai/station-cli@0.6.0-nightly.2462.36497491629 (dist-tag nightly; artifactBuiltAt unknown)
- Note: artifactBuiltAt is null: npm package has no native artifact manifest

### Changelog

Commits since `d0ca944` ([full sha](https://github.com/kontourai/station/commit/d0ca944c58c8dd4de5a17563eb97d06dbdbe3512)):

**Fixes**

- [#2935](https://github.com/kontourai/station/pull/2935) fix(nightly): let the portable publish job read its signing key
- [#2866](https://github.com/kontourai/station/pull/2866) fix(plugins): strip git metadata from proposed remote clones
- [#2934](https://github.com/kontourai/station/pull/2934) fix(docs): scope documentation freshness to each PR, add docs:review:record and a Nightly sweep

**Other**

- [#2929](https://github.com/kontourai/station/pull/2929) test(install): catch an early pipe close on Linux, not only macOS
- [#2906](https://github.com/kontourai/station/pull/2906) test: test-audit Server routes, domain, runtime/mcp and providers (batches 39, 48, 49, 50, 55, 57, 59)

## 2026-09-28T20:32:01Z · nightly-desktop · 0.1.11-nightly.2462.2

- Ship SHA: `d0ca944c58c8dd4de5a17563eb97d06dbdbe3512`
- Artifact built at: `2026-09-28T19:27:41.570Z` (not provider upload/record time)
- Artifact: github-release:nightly-desktop (cohort-finalized)
- Note: ios: TestFlight delivery success (run 36471134637)

### Changelog

Commits since `a30f084` ([full sha](https://github.com/kontourai/station/commit/a30f084b3b93f254337127cb18907d041570f9fc)):

**Features**

- [#2886](https://github.com/kontourai/station/pull/2886) feat(docs): add a source-reviewed learning library and maintenance gates
- [#2881](https://github.com/kontourai/station/pull/2881) feat(update): archive installs update themselves: launcher trial/rollback, update requests, Check for server updates (#2675 D)
- [#2912](https://github.com/kontourai/station/pull/2912) feat(approvals): report engine acknowledgement apart from the recorded decision (#2880)

**Fixes**

- [#2913](https://github.com/kontourai/station/pull/2913) fix(codex): grant nothing when a permissions request is declined, cancelled or interrupted (#2909)
- [#2731](https://github.com/kontourai/station/pull/2731) fix(auth): answer a live but unadmitted credential with 403
- [#2910](https://github.com/kontourai/station/pull/2910) fix(test-changed): a product-law path adds its evidence instead of deferring the whole diff (#2887)
- [#2864](https://github.com/kontourai/station/pull/2864) fix(plugins): keep proposal-staged installs stripped on reinstall; CLI consent echo

**Other**

- [#2919](https://github.com/kontourai/station/pull/2919) test: test-audit UI and Playwright e2e specs (batches 37, 38, 41, 46, 63, 58, 62)
- [#2914](https://github.com/kontourai/station/pull/2914) test: test-audit Scripts, CI, release and verification tooling (batches 64, 52, 61, 45)
- [#2907](https://github.com/kontourai/station/pull/2907) test: test-audit CLI and published SDK packages (batches 36, 47, 53, 40)

## 2026-09-28T20:31:58Z · nightly-android · 0.1.11-nightly.2462.2

- Ship SHA: `d0ca944c58c8dd4de5a17563eb97d06dbdbe3512`
- Artifact built at: `2026-09-28T19:27:51.343Z` (not provider upload/record time)
- Artifact: play-internal-aab:cohort-finalized
- Note: ios: TestFlight delivery success (run 36471134637)

### Changelog

Commits since `a30f084` ([full sha](https://github.com/kontourai/station/commit/a30f084b3b93f254337127cb18907d041570f9fc)):

**Features**

- [#2886](https://github.com/kontourai/station/pull/2886) feat(docs): add a source-reviewed learning library and maintenance gates
- [#2881](https://github.com/kontourai/station/pull/2881) feat(update): archive installs update themselves: launcher trial/rollback, update requests, Check for server updates (#2675 D)
- [#2912](https://github.com/kontourai/station/pull/2912) feat(approvals): report engine acknowledgement apart from the recorded decision (#2880)

**Fixes**

- [#2913](https://github.com/kontourai/station/pull/2913) fix(codex): grant nothing when a permissions request is declined, cancelled or interrupted (#2909)
- [#2731](https://github.com/kontourai/station/pull/2731) fix(auth): answer a live but unadmitted credential with 403
- [#2910](https://github.com/kontourai/station/pull/2910) fix(test-changed): a product-law path adds its evidence instead of deferring the whole diff (#2887)
- [#2864](https://github.com/kontourai/station/pull/2864) fix(plugins): keep proposal-staged installs stripped on reinstall; CLI consent echo

**Other**

- [#2919](https://github.com/kontourai/station/pull/2919) test: test-audit UI and Playwright e2e specs (batches 37, 38, 41, 46, 63, 58, 62)
- [#2914](https://github.com/kontourai/station/pull/2914) test: test-audit Scripts, CI, release and verification tooling (batches 64, 52, 61, 45)
- [#2907](https://github.com/kontourai/station/pull/2907) test: test-audit CLI and published SDK packages (batches 36, 47, 53, 40)

## 2026-09-28T20:28:33Z · nightly-npm · 0.6.0-nightly.2462.36471134637

- Ship SHA: `d0ca944c58c8dd4de5a17563eb97d06dbdbe3512`
- Artifact built at: `unknown` (no immutable artifact manifest binding)
- Artifact: npm:@kontourai/station-cli@0.6.0-nightly.2462.36471134637 (dist-tag nightly; artifactBuiltAt unknown)
- Note: artifactBuiltAt is null: npm package has no native artifact manifest

### Changelog

Commits since `a30f084` ([full sha](https://github.com/kontourai/station/commit/a30f084b3b93f254337127cb18907d041570f9fc)):

**Features**

- [#2886](https://github.com/kontourai/station/pull/2886) feat(docs): add a source-reviewed learning library and maintenance gates
- [#2881](https://github.com/kontourai/station/pull/2881) feat(update): archive installs update themselves: launcher trial/rollback, update requests, Check for server updates (#2675 D)
- [#2912](https://github.com/kontourai/station/pull/2912) feat(approvals): report engine acknowledgement apart from the recorded decision (#2880)

**Fixes**

- [#2913](https://github.com/kontourai/station/pull/2913) fix(codex): grant nothing when a permissions request is declined, cancelled or interrupted (#2909)
- [#2731](https://github.com/kontourai/station/pull/2731) fix(auth): answer a live but unadmitted credential with 403
- [#2910](https://github.com/kontourai/station/pull/2910) fix(test-changed): a product-law path adds its evidence instead of deferring the whole diff (#2887)
- [#2864](https://github.com/kontourai/station/pull/2864) fix(plugins): keep proposal-staged installs stripped on reinstall; CLI consent echo

**Other**

- [#2919](https://github.com/kontourai/station/pull/2919) test: test-audit UI and Playwright e2e specs (batches 37, 38, 41, 46, 63, 58, 62)
- [#2914](https://github.com/kontourai/station/pull/2914) test: test-audit Scripts, CI, release and verification tooling (batches 64, 52, 61, 45)
- [#2907](https://github.com/kontourai/station/pull/2907) test: test-audit CLI and published SDK packages (batches 36, 47, 53, 40)

## 2026-09-28T15:27:48Z · nightly-desktop · 0.1.11-nightly.2462.1

- Ship SHA: `a30f084b3b93f254337127cb18907d041570f9fc`
- Artifact built at: `2026-09-28T14:00:15.651Z` (not provider upload/record time)
- Artifact: github-release:nightly-desktop (cohort-finalized)
- Note: ios: TestFlight delivery success (run 36429714384)

### Changelog

Commits since `ef6e2f0` ([full sha](https://github.com/kontourai/station/commit/ef6e2f0eabdb2c7aea77b4b76a485035f4e0c00a)):

**Fixes**

- [#2904](https://github.com/kontourai/station/pull/2904) fix(access): actionable full-access refusals, device scope commands, and revocation that resets what a device granted (#1796)
- [#2840](https://github.com/kontourai/station/pull/2840) fix(plugins): strip git metadata from agent-proposed local installs

**Other**

- [#2877](https://github.com/kontourai/station/pull/2877) test(server): audit batch 29, runtime bootstrap tests reach their seams
- [#2863](https://github.com/kontourai/station/pull/2863) test: audit batch 25 - pin push-gateway ceilings, prove OTel identity and signing transitions, drop test seams
- [#2891](https://github.com/kontourai/station/pull/2891) test(server): audit batch 33, security, voice, adapter and knowledge tests reach their seams
- [#2890](https://github.com/kontourai/station/pull/2890) test(ui): audit batch 34, shell and sidebar suites reach their owners
- [#2900](https://github.com/kontourai/station/pull/2900) chore: test-audit owner decisions (batch 66)

## 2026-09-28T15:27:44Z · nightly-android · 0.1.11-nightly.2462.1

- Ship SHA: `a30f084b3b93f254337127cb18907d041570f9fc`
- Artifact built at: `2026-09-28T13:48:58.795Z` (not provider upload/record time)
- Artifact: play-internal-aab:cohort-finalized
- Note: ios: TestFlight delivery success (run 36429714384)

### Changelog

Commits since `ef6e2f0` ([full sha](https://github.com/kontourai/station/commit/ef6e2f0eabdb2c7aea77b4b76a485035f4e0c00a)):

**Fixes**

- [#2904](https://github.com/kontourai/station/pull/2904) fix(access): actionable full-access refusals, device scope commands, and revocation that resets what a device granted (#1796)
- [#2840](https://github.com/kontourai/station/pull/2840) fix(plugins): strip git metadata from agent-proposed local installs

**Other**

- [#2877](https://github.com/kontourai/station/pull/2877) test(server): audit batch 29, runtime bootstrap tests reach their seams
- [#2863](https://github.com/kontourai/station/pull/2863) test: audit batch 25 - pin push-gateway ceilings, prove OTel identity and signing transitions, drop test seams
- [#2891](https://github.com/kontourai/station/pull/2891) test(server): audit batch 33, security, voice, adapter and knowledge tests reach their seams
- [#2890](https://github.com/kontourai/station/pull/2890) test(ui): audit batch 34, shell and sidebar suites reach their owners
- [#2900](https://github.com/kontourai/station/pull/2900) chore: test-audit owner decisions (batch 66)

## 2026-09-28T14:45:05Z · nightly-npm · 0.6.0-nightly.2462.36429714384

- Ship SHA: `a30f084b3b93f254337127cb18907d041570f9fc`
- Artifact built at: `unknown` (no immutable artifact manifest binding)
- Artifact: npm:@kontourai/station-cli@0.6.0-nightly.2462.36429714384 (dist-tag nightly; artifactBuiltAt unknown)
- Note: artifactBuiltAt is null: npm package has no native artifact manifest

### Changelog

Commits since `ef6e2f0` ([full sha](https://github.com/kontourai/station/commit/ef6e2f0eabdb2c7aea77b4b76a485035f4e0c00a)):

**Fixes**

- [#2904](https://github.com/kontourai/station/pull/2904) fix(access): actionable full-access refusals, device scope commands, and revocation that resets what a device granted (#1796)
- [#2840](https://github.com/kontourai/station/pull/2840) fix(plugins): strip git metadata from agent-proposed local installs

**Other**

- [#2877](https://github.com/kontourai/station/pull/2877) test(server): audit batch 29, runtime bootstrap tests reach their seams
- [#2863](https://github.com/kontourai/station/pull/2863) test: audit batch 25 - pin push-gateway ceilings, prove OTel identity and signing transitions, drop test seams
- [#2891](https://github.com/kontourai/station/pull/2891) test(server): audit batch 33, security, voice, adapter and knowledge tests reach their seams
- [#2890](https://github.com/kontourai/station/pull/2890) test(ui): audit batch 34, shell and sidebar suites reach their owners
- [#2900](https://github.com/kontourai/station/pull/2900) chore: test-audit owner decisions (batch 66)

## 2026-09-28T06:21:17Z · nightly-desktop · 0.1.11-nightly.2462

- Ship SHA: `ef6e2f0eabdb2c7aea77b4b76a485035f4e0c00a`
- Artifact built at: `2026-09-28T05:11:06.893Z` (not provider upload/record time)
- Artifact: github-release:nightly-desktop (cohort-finalized)
- Note: ios: TestFlight delivery success (run 36380121606)

### Changelog

Commits since `9d39d40` ([full sha](https://github.com/kontourai/station/commit/9d39d40b9a11564902f7b8ee33a03a7c99bc9dee)):

**Features**

- [#2867](https://github.com/kontourai/station/pull/2867) feat(service): services run the prebuilt archive through current (#2675 C)
- [#2856](https://github.com/kontourai/station/pull/2856) feat(relay): bind native application sessions to provider and Device
- [#2888](https://github.com/kontourai/station/pull/2888) feat(desktop): expose host-bound native application signaling
- [#2841](https://github.com/kontourai/station/pull/2841) feat(sdk,ui): Agent, execution, Task and Session refusals keep status and code; a proxy's page never drops a queued message (#2708 A-3a)
- [#2884](https://github.com/kontourai/station/pull/2884) feat(desktop): keep native account proof keys in separate host custody
- [#2822](https://github.com/kontourai/station/pull/2822) feat(install): install prebuilt server archives into versions/ (#2675 B2)
- [#2853](https://github.com/kontourai/station/pull/2853) feat(release): portable Nightly publication path, dry-run by default (#2675 E)

**Fixes**

- [#2883](https://github.com/kontourai/station/pull/2883) fix(ui): render reasoning as a quiet activity line, not a card
- [#2885](https://github.com/kontourai/station/pull/2885) fix(test-changed): derive the related-discovery timeout from the caller's budget (#2855)
- [#2882](https://github.com/kontourai/station/pull/2882) fix(codex): echo JSON-RPC request ids with their type, so approvals reach Codex (#562)
- [#2874](https://github.com/kontourai/station/pull/2874) fix(station-control): dispatch stays in the caller's Project or global scope; remote reach needs a bound operator (#2377 C2a)
- [#2865](https://github.com/kontourai/station/pull/2865) fix(test-changed): docs are evidence, not a whole-diff deferral; doc gates run on every PR (#2803)

**Docs**

- [#2852](https://github.com/kontourai/station/pull/2852) docs(agents): point UI work at the Kontour DESIGN.md

**Other**

- [#2879](https://github.com/kontourai/station/pull/2879) test(scripts): audit batch 31 - docs, UI-contract and repo-guardrail gate tests reach their owners
- [#2897](https://github.com/kontourai/station/pull/2897) test(server): audit batch 35, service tests reach their owners; fix indeterminate monitor resolve
- [#2895](https://github.com/kontourai/station/pull/2895) test(e2e): audit batch 32 - prune duplicate specs, make repaired tests reach their seams
- [#2878](https://github.com/kontourai/station/pull/2878) test: route batch-30 server tests through their owning seams
- [#2872](https://github.com/kontourai/station/pull/2872) test: audit batch 26 - agents, settings and connection tests at their owners
- [#2870](https://github.com/kontourai/station/pull/2870) test(ui): test-audit batch 27, settings and connections suites reach their seams
- [#2869](https://github.com/kontourai/station/pull/2869) test(ui): replace CSS-text pins with geometry tests and prune retired sidebar and split-pane tests
- [#2824](https://github.com/kontourai/station/pull/2824) test(contracts): retire literal-echo tests, pin shape contracts at the type level
- [#2871](https://github.com/kontourai/station/pull/2871) test(coding-git): plant the fan-out link at a name the object store does not use
- [#2851](https://github.com/kontourai/station/pull/2851) test(ui): pin plugin revoke confirmation at requestRevokePermission (test-audit b17 follow-up)

## 2026-09-28T06:21:14Z · nightly-android · 0.1.11-nightly.2462

- Ship SHA: `ef6e2f0eabdb2c7aea77b4b76a485035f4e0c00a`
- Artifact built at: `2026-09-28T05:11:20.727Z` (not provider upload/record time)
- Artifact: play-internal-aab:cohort-finalized
- Note: ios: TestFlight delivery success (run 36380121606)

### Changelog

Commits since `9d39d40` ([full sha](https://github.com/kontourai/station/commit/9d39d40b9a11564902f7b8ee33a03a7c99bc9dee)):

**Features**

- [#2867](https://github.com/kontourai/station/pull/2867) feat(service): services run the prebuilt archive through current (#2675 C)
- [#2856](https://github.com/kontourai/station/pull/2856) feat(relay): bind native application sessions to provider and Device
- [#2888](https://github.com/kontourai/station/pull/2888) feat(desktop): expose host-bound native application signaling
- [#2841](https://github.com/kontourai/station/pull/2841) feat(sdk,ui): Agent, execution, Task and Session refusals keep status and code; a proxy's page never drops a queued message (#2708 A-3a)
- [#2884](https://github.com/kontourai/station/pull/2884) feat(desktop): keep native account proof keys in separate host custody
- [#2822](https://github.com/kontourai/station/pull/2822) feat(install): install prebuilt server archives into versions/ (#2675 B2)
- [#2853](https://github.com/kontourai/station/pull/2853) feat(release): portable Nightly publication path, dry-run by default (#2675 E)

**Fixes**

- [#2883](https://github.com/kontourai/station/pull/2883) fix(ui): render reasoning as a quiet activity line, not a card
- [#2885](https://github.com/kontourai/station/pull/2885) fix(test-changed): derive the related-discovery timeout from the caller's budget (#2855)
- [#2882](https://github.com/kontourai/station/pull/2882) fix(codex): echo JSON-RPC request ids with their type, so approvals reach Codex (#562)
- [#2874](https://github.com/kontourai/station/pull/2874) fix(station-control): dispatch stays in the caller's Project or global scope; remote reach needs a bound operator (#2377 C2a)
- [#2865](https://github.com/kontourai/station/pull/2865) fix(test-changed): docs are evidence, not a whole-diff deferral; doc gates run on every PR (#2803)

**Docs**

- [#2852](https://github.com/kontourai/station/pull/2852) docs(agents): point UI work at the Kontour DESIGN.md

**Other**

- [#2879](https://github.com/kontourai/station/pull/2879) test(scripts): audit batch 31 - docs, UI-contract and repo-guardrail gate tests reach their owners
- [#2897](https://github.com/kontourai/station/pull/2897) test(server): audit batch 35, service tests reach their owners; fix indeterminate monitor resolve
- [#2895](https://github.com/kontourai/station/pull/2895) test(e2e): audit batch 32 - prune duplicate specs, make repaired tests reach their seams
- [#2878](https://github.com/kontourai/station/pull/2878) test: route batch-30 server tests through their owning seams
- [#2872](https://github.com/kontourai/station/pull/2872) test: audit batch 26 - agents, settings and connection tests at their owners
- [#2870](https://github.com/kontourai/station/pull/2870) test(ui): test-audit batch 27, settings and connections suites reach their seams
- [#2869](https://github.com/kontourai/station/pull/2869) test(ui): replace CSS-text pins with geometry tests and prune retired sidebar and split-pane tests
- [#2824](https://github.com/kontourai/station/pull/2824) test(contracts): retire literal-echo tests, pin shape contracts at the type level
- [#2871](https://github.com/kontourai/station/pull/2871) test(coding-git): plant the fan-out link at a name the object store does not use
- [#2851](https://github.com/kontourai/station/pull/2851) test(ui): pin plugin revoke confirmation at requestRevokePermission (test-audit b17 follow-up)

## 2026-09-28T06:04:26Z · nightly-npm · 0.6.0-nightly.2462.36380121606

- Ship SHA: `ef6e2f0eabdb2c7aea77b4b76a485035f4e0c00a`
- Artifact built at: `unknown` (no immutable artifact manifest binding)
- Artifact: npm:@kontourai/station-cli@0.6.0-nightly.2462.36380121606 (dist-tag nightly; artifactBuiltAt unknown)
- Note: artifactBuiltAt is null: npm package has no native artifact manifest

### Changelog

Commits since `9d39d40` ([full sha](https://github.com/kontourai/station/commit/9d39d40b9a11564902f7b8ee33a03a7c99bc9dee)):

**Features**

- [#2867](https://github.com/kontourai/station/pull/2867) feat(service): services run the prebuilt archive through current (#2675 C)
- [#2856](https://github.com/kontourai/station/pull/2856) feat(relay): bind native application sessions to provider and Device
- [#2888](https://github.com/kontourai/station/pull/2888) feat(desktop): expose host-bound native application signaling
- [#2841](https://github.com/kontourai/station/pull/2841) feat(sdk,ui): Agent, execution, Task and Session refusals keep status and code; a proxy's page never drops a queued message (#2708 A-3a)
- [#2884](https://github.com/kontourai/station/pull/2884) feat(desktop): keep native account proof keys in separate host custody
- [#2822](https://github.com/kontourai/station/pull/2822) feat(install): install prebuilt server archives into versions/ (#2675 B2)
- [#2853](https://github.com/kontourai/station/pull/2853) feat(release): portable Nightly publication path, dry-run by default (#2675 E)

**Fixes**

- [#2883](https://github.com/kontourai/station/pull/2883) fix(ui): render reasoning as a quiet activity line, not a card
- [#2885](https://github.com/kontourai/station/pull/2885) fix(test-changed): derive the related-discovery timeout from the caller's budget (#2855)
- [#2882](https://github.com/kontourai/station/pull/2882) fix(codex): echo JSON-RPC request ids with their type, so approvals reach Codex (#562)
- [#2874](https://github.com/kontourai/station/pull/2874) fix(station-control): dispatch stays in the caller's Project or global scope; remote reach needs a bound operator (#2377 C2a)
- [#2865](https://github.com/kontourai/station/pull/2865) fix(test-changed): docs are evidence, not a whole-diff deferral; doc gates run on every PR (#2803)

**Docs**

- [#2852](https://github.com/kontourai/station/pull/2852) docs(agents): point UI work at the Kontour DESIGN.md

**Other**

- [#2879](https://github.com/kontourai/station/pull/2879) test(scripts): audit batch 31 - docs, UI-contract and repo-guardrail gate tests reach their owners
- [#2897](https://github.com/kontourai/station/pull/2897) test(server): audit batch 35, service tests reach their owners; fix indeterminate monitor resolve
- [#2895](https://github.com/kontourai/station/pull/2895) test(e2e): audit batch 32 - prune duplicate specs, make repaired tests reach their seams
- [#2878](https://github.com/kontourai/station/pull/2878) test: route batch-30 server tests through their owning seams
- [#2872](https://github.com/kontourai/station/pull/2872) test: audit batch 26 - agents, settings and connection tests at their owners
- [#2870](https://github.com/kontourai/station/pull/2870) test(ui): test-audit batch 27, settings and connections suites reach their seams
- [#2869](https://github.com/kontourai/station/pull/2869) test(ui): replace CSS-text pins with geometry tests and prune retired sidebar and split-pane tests
- [#2824](https://github.com/kontourai/station/pull/2824) test(contracts): retire literal-echo tests, pin shape contracts at the type level
- [#2871](https://github.com/kontourai/station/pull/2871) test(coding-git): plant the fan-out link at a name the object store does not use
- [#2851](https://github.com/kontourai/station/pull/2851) test(ui): pin plugin revoke confirmation at requestRevokePermission (test-audit b17 follow-up)

## 2026-09-27T22:24:20Z · nightly-desktop · 0.1.11-nightly.2461.3

- Ship SHA: `9d39d40b9a11564902f7b8ee33a03a7c99bc9dee`
- Artifact built at: `2026-09-27T21:35:25.448Z` (not provider upload/record time)
- Artifact: github-release:nightly-desktop (cohort-finalized)
- Note: ios: TestFlight delivery success (run 36350925838)

### Changelog

Commits since `73e3cda` ([full sha](https://github.com/kontourai/station/commit/73e3cdac817704360eded65049732a26e9658962)):

**Fixes**

- [#2817](https://github.com/kontourai/station/pull/2817) fix(plugins): bound plugin git discovery and share .git name matching

**Other**

- [#2850](https://github.com/kontourai/station/pull/2850) test(broker): cover multiple scoped Stations on one database
- [#2837](https://github.com/kontourai/station/pull/2837) test: audit batch 22 - prune dead and duplicate tests, strengthen weak assertions, fix DST streak
- [#2835](https://github.com/kontourai/station/pull/2835) test(examples): make batch 23 example-plugin tests reach their seams
- [#2839](https://github.com/kontourai/station/pull/2839) chore(ui): remove the unmounted Coding inspector Reviews tab
- [#2838](https://github.com/kontourai/station/pull/2838) test(relay): qualify two-Station encrypted isolation
- [#2829](https://github.com/kontourai/station/pull/2829) test(server): prune and sharpen agents route tests (test-audit batch 24)
- [#2827](https://github.com/kontourai/station/pull/2827) test(ui): test-audit batch 20, chat dock and composer tests at their owners
- [#2825](https://github.com/kontourai/station/pull/2825) test(ui): test-audit batch 19, settings, plugin and skills tests at their owners
- [#2820](https://github.com/kontourai/station/pull/2820) test(ui): test-audit batch 16 — retire UI test-only seams and measure layout in Chromium
- [#2819](https://github.com/kontourai/station/pull/2819) test(ui): test-audit batch 17, view tests at their owner boundaries
- [#2818](https://github.com/kontourai/station/pull/2818) test(server): route runtime helper tests through their owners (test-audit batch 18)

## 2026-09-27T22:24:17Z · nightly-android · 0.1.11-nightly.2461.3

- Ship SHA: `9d39d40b9a11564902f7b8ee33a03a7c99bc9dee`
- Artifact built at: `2026-09-27T21:34:28.431Z` (not provider upload/record time)
- Artifact: play-internal-aab:cohort-finalized
- Note: ios: TestFlight delivery success (run 36350925838)

### Changelog

Commits since `73e3cda` ([full sha](https://github.com/kontourai/station/commit/73e3cdac817704360eded65049732a26e9658962)):

**Fixes**

- [#2817](https://github.com/kontourai/station/pull/2817) fix(plugins): bound plugin git discovery and share .git name matching

**Other**

- [#2850](https://github.com/kontourai/station/pull/2850) test(broker): cover multiple scoped Stations on one database
- [#2837](https://github.com/kontourai/station/pull/2837) test: audit batch 22 - prune dead and duplicate tests, strengthen weak assertions, fix DST streak
- [#2835](https://github.com/kontourai/station/pull/2835) test(examples): make batch 23 example-plugin tests reach their seams
- [#2839](https://github.com/kontourai/station/pull/2839) chore(ui): remove the unmounted Coding inspector Reviews tab
- [#2838](https://github.com/kontourai/station/pull/2838) test(relay): qualify two-Station encrypted isolation
- [#2829](https://github.com/kontourai/station/pull/2829) test(server): prune and sharpen agents route tests (test-audit batch 24)
- [#2827](https://github.com/kontourai/station/pull/2827) test(ui): test-audit batch 20, chat dock and composer tests at their owners
- [#2825](https://github.com/kontourai/station/pull/2825) test(ui): test-audit batch 19, settings, plugin and skills tests at their owners
- [#2820](https://github.com/kontourai/station/pull/2820) test(ui): test-audit batch 16 — retire UI test-only seams and measure layout in Chromium
- [#2819](https://github.com/kontourai/station/pull/2819) test(ui): test-audit batch 17, view tests at their owner boundaries
- [#2818](https://github.com/kontourai/station/pull/2818) test(server): route runtime helper tests through their owners (test-audit batch 18)

## 2026-09-27T22:14:54Z · nightly-npm · 0.6.0-nightly.2461.36350925838

- Ship SHA: `9d39d40b9a11564902f7b8ee33a03a7c99bc9dee`
- Artifact built at: `unknown` (no immutable artifact manifest binding)
- Artifact: npm:@kontourai/station-cli@0.6.0-nightly.2461.36350925838 (dist-tag nightly; artifactBuiltAt unknown)
- Note: artifactBuiltAt is null: npm package has no native artifact manifest

### Changelog

Commits since `73e3cda` ([full sha](https://github.com/kontourai/station/commit/73e3cdac817704360eded65049732a26e9658962)):

**Fixes**

- [#2817](https://github.com/kontourai/station/pull/2817) fix(plugins): bound plugin git discovery and share .git name matching

**Other**

- [#2850](https://github.com/kontourai/station/pull/2850) test(broker): cover multiple scoped Stations on one database
- [#2837](https://github.com/kontourai/station/pull/2837) test: audit batch 22 - prune dead and duplicate tests, strengthen weak assertions, fix DST streak
- [#2835](https://github.com/kontourai/station/pull/2835) test(examples): make batch 23 example-plugin tests reach their seams
- [#2839](https://github.com/kontourai/station/pull/2839) chore(ui): remove the unmounted Coding inspector Reviews tab
- [#2838](https://github.com/kontourai/station/pull/2838) test(relay): qualify two-Station encrypted isolation
- [#2829](https://github.com/kontourai/station/pull/2829) test(server): prune and sharpen agents route tests (test-audit batch 24)
- [#2827](https://github.com/kontourai/station/pull/2827) test(ui): test-audit batch 20, chat dock and composer tests at their owners
- [#2825](https://github.com/kontourai/station/pull/2825) test(ui): test-audit batch 19, settings, plugin and skills tests at their owners
- [#2820](https://github.com/kontourai/station/pull/2820) test(ui): test-audit batch 16 — retire UI test-only seams and measure layout in Chromium
- [#2819](https://github.com/kontourai/station/pull/2819) test(ui): test-audit batch 17, view tests at their owner boundaries
- [#2818](https://github.com/kontourai/station/pull/2818) test(server): route runtime helper tests through their owners (test-audit batch 18)

## 2026-09-27T18:18:23Z · nightly-desktop · 0.1.11-nightly.2461.2

- Ship SHA: `73e3cdac817704360eded65049732a26e9658962`
- Artifact built at: `2026-09-27T17:04:20.663Z` (not provider upload/record time)
- Artifact: github-release:nightly-desktop (cohort-finalized)
- Note: ios: TestFlight delivery success (run 36334655311)

### Changelog

Commits since `b61a6d5` ([full sha](https://github.com/kontourai/station/commit/b61a6d5e75c0482ed61bd62e9f73045843968832)):

**Features**

- [#2828](https://github.com/kontourai/station/pull/2828) feat(relay): supervise approved native grants on desktop
- [#2811](https://github.com/kontourai/station/pull/2811) feat(relay): renew native routing grants with durable host proof
- [#2801](https://github.com/kontourai/station/pull/2801) feat(sdk,ui): Project and plugin refusals keep status, code, details and Retry-After (#2708 A-2)
- [#2804](https://github.com/kontourai/station/pull/2804) feat(ci): re-land sharded fast-checks, with shards gated on the plan's result (#2709)

**Fixes**

- [#2830](https://github.com/kontourai/station/pull/2830) fix(windows): survive a cold host at archive start: pwsh path, one trust runner, fail fast, platform stop hint
- [#2814](https://github.com/kontourai/station/pull/2814) fix(test-changed): classify changesets and fallow baselines as known paths (#2781)
- [#2816](https://github.com/kontourai/station/pull/2816) fix(station-control,approvals): steer and adopt stay in scope; Default picks and Agent defaults can't reach unconfined full access without the grant (#2377 C1)
- [#2746](https://github.com/kontourai/station/pull/2746) fix(shared): resolve Windows PowerShell by its System32 path for process-birth probes
- [#2747](https://github.com/kontourai/station/pull/2747) fix(install): build the release where it runs so start reuses the install-time build

**Other**

- [#2821](https://github.com/kontourai/station/pull/2821) perf(packaging): prune unused runtime subtrees from the shared server stager
- [#2789](https://github.com/kontourai/station/pull/2789) test: retire duplicate and unfalsifiable tests in audit batch 06
- [#2772](https://github.com/kontourai/station/pull/2772) test(ui): test-audit batch 13 — app-shell and component tests at rendered and Chromium boundaries
- [#2790](https://github.com/kontourai/station/pull/2790) test(shared): test-audit batch 04 — drop duplicate station-shared tests and pin tier and refusal reasons

## 2026-09-27T18:18:20Z · nightly-android · 0.1.11-nightly.2461.2

- Ship SHA: `73e3cdac817704360eded65049732a26e9658962`
- Artifact built at: `2026-09-27T17:13:10.385Z` (not provider upload/record time)
- Artifact: play-internal-aab:cohort-finalized
- Note: ios: TestFlight delivery success (run 36334655311)

### Changelog

Commits since `b61a6d5` ([full sha](https://github.com/kontourai/station/commit/b61a6d5e75c0482ed61bd62e9f73045843968832)):

**Features**

- [#2828](https://github.com/kontourai/station/pull/2828) feat(relay): supervise approved native grants on desktop
- [#2811](https://github.com/kontourai/station/pull/2811) feat(relay): renew native routing grants with durable host proof
- [#2801](https://github.com/kontourai/station/pull/2801) feat(sdk,ui): Project and plugin refusals keep status, code, details and Retry-After (#2708 A-2)
- [#2804](https://github.com/kontourai/station/pull/2804) feat(ci): re-land sharded fast-checks, with shards gated on the plan's result (#2709)

**Fixes**

- [#2830](https://github.com/kontourai/station/pull/2830) fix(windows): survive a cold host at archive start: pwsh path, one trust runner, fail fast, platform stop hint
- [#2814](https://github.com/kontourai/station/pull/2814) fix(test-changed): classify changesets and fallow baselines as known paths (#2781)
- [#2816](https://github.com/kontourai/station/pull/2816) fix(station-control,approvals): steer and adopt stay in scope; Default picks and Agent defaults can't reach unconfined full access without the grant (#2377 C1)
- [#2746](https://github.com/kontourai/station/pull/2746) fix(shared): resolve Windows PowerShell by its System32 path for process-birth probes
- [#2747](https://github.com/kontourai/station/pull/2747) fix(install): build the release where it runs so start reuses the install-time build

**Other**

- [#2821](https://github.com/kontourai/station/pull/2821) perf(packaging): prune unused runtime subtrees from the shared server stager
- [#2789](https://github.com/kontourai/station/pull/2789) test: retire duplicate and unfalsifiable tests in audit batch 06
- [#2772](https://github.com/kontourai/station/pull/2772) test(ui): test-audit batch 13 — app-shell and component tests at rendered and Chromium boundaries
- [#2790](https://github.com/kontourai/station/pull/2790) test(shared): test-audit batch 04 — drop duplicate station-shared tests and pin tier and refusal reasons

## 2026-09-27T17:55:24Z · nightly-npm · 0.6.0-nightly.2461.36334655311

- Ship SHA: `73e3cdac817704360eded65049732a26e9658962`
- Artifact built at: `unknown` (no immutable artifact manifest binding)
- Artifact: npm:@kontourai/station-cli@0.6.0-nightly.2461.36334655311 (dist-tag nightly; artifactBuiltAt unknown)
- Note: artifactBuiltAt is null: npm package has no native artifact manifest

### Changelog

Commits since `b61a6d5` ([full sha](https://github.com/kontourai/station/commit/b61a6d5e75c0482ed61bd62e9f73045843968832)):

**Features**

- [#2828](https://github.com/kontourai/station/pull/2828) feat(relay): supervise approved native grants on desktop
- [#2811](https://github.com/kontourai/station/pull/2811) feat(relay): renew native routing grants with durable host proof
- [#2801](https://github.com/kontourai/station/pull/2801) feat(sdk,ui): Project and plugin refusals keep status, code, details and Retry-After (#2708 A-2)
- [#2804](https://github.com/kontourai/station/pull/2804) feat(ci): re-land sharded fast-checks, with shards gated on the plan's result (#2709)

**Fixes**

- [#2830](https://github.com/kontourai/station/pull/2830) fix(windows): survive a cold host at archive start: pwsh path, one trust runner, fail fast, platform stop hint
- [#2814](https://github.com/kontourai/station/pull/2814) fix(test-changed): classify changesets and fallow baselines as known paths (#2781)
- [#2816](https://github.com/kontourai/station/pull/2816) fix(station-control,approvals): steer and adopt stay in scope; Default picks and Agent defaults can't reach unconfined full access without the grant (#2377 C1)
- [#2746](https://github.com/kontourai/station/pull/2746) fix(shared): resolve Windows PowerShell by its System32 path for process-birth probes
- [#2747](https://github.com/kontourai/station/pull/2747) fix(install): build the release where it runs so start reuses the install-time build

**Other**

- [#2821](https://github.com/kontourai/station/pull/2821) perf(packaging): prune unused runtime subtrees from the shared server stager
- [#2789](https://github.com/kontourai/station/pull/2789) test: retire duplicate and unfalsifiable tests in audit batch 06
- [#2772](https://github.com/kontourai/station/pull/2772) test(ui): test-audit batch 13 — app-shell and component tests at rendered and Chromium boundaries
- [#2790](https://github.com/kontourai/station/pull/2790) test(shared): test-audit batch 04 — drop duplicate station-shared tests and pin tier and refusal reasons

## 2026-09-27T12:43:28Z · nightly-desktop · 0.1.11-nightly.2461.1

- Ship SHA: `b61a6d5e75c0482ed61bd62e9f73045843968832`
- Artifact built at: `2026-09-27T11:59:57.888Z` (not provider upload/record time)
- Artifact: github-release:nightly-desktop (cohort-finalized)
- Note: ios: TestFlight delivery success (run 36317054434)

### Changelog

Commits since `bda38d3` ([full sha](https://github.com/kontourai/station/commit/bda38d3bcb680fddcba6f2e35a43c05d2caefb8a)):

**Features**

- [#2797](https://github.com/kontourai/station/pull/2797) feat(ci): shard fast-checks behind a fail-closed aggregator (#2709)
- [#2798](https://github.com/kontourai/station/pull/2798) feat(sdk,station-control): conversation and orchestration refusals keep status and code; delegation tools relay only local codes (#2708 A-1b)
- [#2792](https://github.com/kontourai/station/pull/2792) feat(sdk): station-control family fetchers keep status, code and details (#2708 A-1a)
- [#2762](https://github.com/kontourai/station/pull/2762) feat(cli): keep prebuilt archive lifecycle state outside the archive (#2675 B1)
- [#2778](https://github.com/kontourai/station/pull/2778) feat(relay): verify native client signaling in local echo lab

**Fixes**

- [#2800](https://github.com/kontourai/station/pull/2800) fix(station-control): every tool failure is an MCP error, so raw invocation never reads a refusal as success (#2795)
- [#2796](https://github.com/kontourai/station/pull/2796) fix(verification): write the final changed-test diagnostic before binding it
- [#2791](https://github.com/kontourai/station/pull/2791) fix(test-changed): refine an SDK import change that cannot alter a barrel load (#2782)
- [#2786](https://github.com/kontourai/station/pull/2786) fix(plugins): confine plugin dependency sources
- [#2724](https://github.com/kontourai/station/pull/2724) fix(cli): stop registry browse crashing on server alias records; prune dead package code and weak tests

**CI / workflow**

- [#2802](https://github.com/kontourai/station/pull/2802) ci: back out sharded fast-checks until PR-event shards run (#2709)

**Other**

- [#2794](https://github.com/kontourai/station/pull/2794) test(scripts): test-audit batch 15 — verification tooling tests at their real boundaries
- [#2788](https://github.com/kontourai/station/pull/2788) test(connect): prune dead connect code and move helper tests to rendered boundaries (test-audit batch 10)
- [#2793](https://github.com/kontourai/station/pull/2793) test(server): test-audit batch 11 — providers part 1
- [#2779](https://github.com/kontourai/station/pull/2779) style(desktop): apply rustfmt and check it in CI
- [#2777](https://github.com/kontourai/station/pull/2777) test(ui): test-audit batch 09 — contexts, lib, utils, platform and regions
- [#2770](https://github.com/kontourai/station/pull/2770) test(ui): prove sessions, Home and notification contracts at their owners
- [#2775](https://github.com/kontourai/station/pull/2775) test(server): test-audit batch 02 — prune station-control tool tests and dead dispatch helpers

## 2026-09-27T12:43:25Z · nightly-android · 0.1.11-nightly.2461.1

- Ship SHA: `b61a6d5e75c0482ed61bd62e9f73045843968832`
- Artifact built at: `2026-09-27T11:59:25.201Z` (not provider upload/record time)
- Artifact: play-internal-aab:cohort-finalized
- Note: ios: TestFlight delivery success (run 36317054434)

### Changelog

Commits since `bda38d3` ([full sha](https://github.com/kontourai/station/commit/bda38d3bcb680fddcba6f2e35a43c05d2caefb8a)):

**Features**

- [#2797](https://github.com/kontourai/station/pull/2797) feat(ci): shard fast-checks behind a fail-closed aggregator (#2709)
- [#2798](https://github.com/kontourai/station/pull/2798) feat(sdk,station-control): conversation and orchestration refusals keep status and code; delegation tools relay only local codes (#2708 A-1b)
- [#2792](https://github.com/kontourai/station/pull/2792) feat(sdk): station-control family fetchers keep status, code and details (#2708 A-1a)
- [#2762](https://github.com/kontourai/station/pull/2762) feat(cli): keep prebuilt archive lifecycle state outside the archive (#2675 B1)
- [#2778](https://github.com/kontourai/station/pull/2778) feat(relay): verify native client signaling in local echo lab

**Fixes**

- [#2800](https://github.com/kontourai/station/pull/2800) fix(station-control): every tool failure is an MCP error, so raw invocation never reads a refusal as success (#2795)
- [#2796](https://github.com/kontourai/station/pull/2796) fix(verification): write the final changed-test diagnostic before binding it
- [#2791](https://github.com/kontourai/station/pull/2791) fix(test-changed): refine an SDK import change that cannot alter a barrel load (#2782)
- [#2786](https://github.com/kontourai/station/pull/2786) fix(plugins): confine plugin dependency sources
- [#2724](https://github.com/kontourai/station/pull/2724) fix(cli): stop registry browse crashing on server alias records; prune dead package code and weak tests

**CI / workflow**

- [#2802](https://github.com/kontourai/station/pull/2802) ci: back out sharded fast-checks until PR-event shards run (#2709)

**Other**

- [#2794](https://github.com/kontourai/station/pull/2794) test(scripts): test-audit batch 15 — verification tooling tests at their real boundaries
- [#2788](https://github.com/kontourai/station/pull/2788) test(connect): prune dead connect code and move helper tests to rendered boundaries (test-audit batch 10)
- [#2793](https://github.com/kontourai/station/pull/2793) test(server): test-audit batch 11 — providers part 1
- [#2779](https://github.com/kontourai/station/pull/2779) style(desktop): apply rustfmt and check it in CI
- [#2777](https://github.com/kontourai/station/pull/2777) test(ui): test-audit batch 09 — contexts, lib, utils, platform and regions
- [#2770](https://github.com/kontourai/station/pull/2770) test(ui): prove sessions, Home and notification contracts at their owners
- [#2775](https://github.com/kontourai/station/pull/2775) test(server): test-audit batch 02 — prune station-control tool tests and dead dispatch helpers

## 2026-09-27T12:39:12Z · nightly-npm · 0.6.0-nightly.2461.36317054434

- Ship SHA: `b61a6d5e75c0482ed61bd62e9f73045843968832`
- Artifact built at: `unknown` (no immutable artifact manifest binding)
- Artifact: npm:@kontourai/station-cli@0.6.0-nightly.2461.36317054434 (dist-tag nightly; artifactBuiltAt unknown)
- Note: artifactBuiltAt is null: npm package has no native artifact manifest

### Changelog

Commits since `bda38d3` ([full sha](https://github.com/kontourai/station/commit/bda38d3bcb680fddcba6f2e35a43c05d2caefb8a)):

**Features**

- [#2797](https://github.com/kontourai/station/pull/2797) feat(ci): shard fast-checks behind a fail-closed aggregator (#2709)
- [#2798](https://github.com/kontourai/station/pull/2798) feat(sdk,station-control): conversation and orchestration refusals keep status and code; delegation tools relay only local codes (#2708 A-1b)
- [#2792](https://github.com/kontourai/station/pull/2792) feat(sdk): station-control family fetchers keep status, code and details (#2708 A-1a)
- [#2762](https://github.com/kontourai/station/pull/2762) feat(cli): keep prebuilt archive lifecycle state outside the archive (#2675 B1)
- [#2778](https://github.com/kontourai/station/pull/2778) feat(relay): verify native client signaling in local echo lab

**Fixes**

- [#2800](https://github.com/kontourai/station/pull/2800) fix(station-control): every tool failure is an MCP error, so raw invocation never reads a refusal as success (#2795)
- [#2796](https://github.com/kontourai/station/pull/2796) fix(verification): write the final changed-test diagnostic before binding it
- [#2791](https://github.com/kontourai/station/pull/2791) fix(test-changed): refine an SDK import change that cannot alter a barrel load (#2782)
- [#2786](https://github.com/kontourai/station/pull/2786) fix(plugins): confine plugin dependency sources
- [#2724](https://github.com/kontourai/station/pull/2724) fix(cli): stop registry browse crashing on server alias records; prune dead package code and weak tests

**CI / workflow**

- [#2802](https://github.com/kontourai/station/pull/2802) ci: back out sharded fast-checks until PR-event shards run (#2709)

**Other**

- [#2794](https://github.com/kontourai/station/pull/2794) test(scripts): test-audit batch 15 — verification tooling tests at their real boundaries
- [#2788](https://github.com/kontourai/station/pull/2788) test(connect): prune dead connect code and move helper tests to rendered boundaries (test-audit batch 10)
- [#2793](https://github.com/kontourai/station/pull/2793) test(server): test-audit batch 11 — providers part 1
- [#2779](https://github.com/kontourai/station/pull/2779) style(desktop): apply rustfmt and check it in CI
- [#2777](https://github.com/kontourai/station/pull/2777) test(ui): test-audit batch 09 — contexts, lib, utils, platform and regions
- [#2770](https://github.com/kontourai/station/pull/2770) test(ui): prove sessions, Home and notification contracts at their owners
- [#2775](https://github.com/kontourai/station/pull/2775) test(server): test-audit batch 02 — prune station-control tool tests and dead dispatch helpers

## 2026-09-27T06:24:37Z · nightly-desktop · 0.1.11-nightly.2461

- Ship SHA: `bda38d3bcb680fddcba6f2e35a43c05d2caefb8a`
- Artifact built at: `2026-09-27T05:17:46.392Z` (not provider upload/record time)
- Artifact: github-release:nightly-desktop (cohort-finalized)
- Note: ios: TestFlight delivery success (run 36295895609)

### Changelog

Commits since `719e004` ([full sha](https://github.com/kontourai/station/commit/719e0042f6f2941fbc47b402c1df60de2bfc4915)):

**Features**

- [#2740](https://github.com/kontourai/station/pull/2740) feat(ios): open sealed alerts in a Notification Service Extension (#2590)
- [#2743](https://github.com/kontourai/station/pull/2743) feat(sdk): one envelope-to-error helper keeping status, code and details (#2708 A-0)
- [#2723](https://github.com/kontourai/station/pull/2723) feat(release): per-platform manifest v2 with one shared verifier (#2675 slice A)
- [#2711](https://github.com/kontourai/station/pull/2711) feat(desktop): native consumer for the notification delivery feed (#2608)
- [#2726](https://github.com/kontourai/station/pull/2726) feat(relay): add native signal host and opt-in echo lab
- [#2725](https://github.com/kontourai/station/pull/2725) feat(relay): add native grant custody and diagnostic signaling
- [#2705](https://github.com/kontourai/station/pull/2705) feat(packaging): build and smoke prebuilt per-platform server archives (#2675 PR3a)
- [#2688](https://github.com/kontourai/station/pull/2688) feat(install): nightly release ring for the portable installer (plumbing, nothing published)
- [#2555](https://github.com/kontourai/station/pull/2555) feat(relay): approve Station keys in native desktop
- [#2677](https://github.com/kontourai/station/pull/2677) feat(notifications): iOS alert push through APNs, fixed-text interim (#2589)
- [#2699](https://github.com/kontourai/station/pull/2699) feat(station-control): agent reads act for the session's owner (#2377 slice B)

**Fixes**

- [#2768](https://github.com/kontourai/station/pull/2768) fix(registry): confine manifest plugin sources to the registry root
- [#2765](https://github.com/kontourai/station/pull/2765) fix(test-changed): refine SDK barrel fan-out in related test selection (#2707)
- [#2744](https://github.com/kontourai/station/pull/2744) fix(ci): provision JS pnpm on Intel macOS legs (#2675)
- [#2710](https://github.com/kontourai/station/pull/2710) fix(dogfood): keep the installed health helper import-free
- [#2712](https://github.com/kontourai/station/pull/2712) fix(chat-dock): check-again way out of a stale busy wait; copy IDs on the phone sheet
- [#2706](https://github.com/kontourai/station/pull/2706) fix(chat): follow projected streaming turns and honor any scroll device
- [#2704](https://github.com/kontourai/station/pull/2704) fix(release): run publish-time release policy from the default branch
- [#2702](https://github.com/kontourai/station/pull/2702) fix(engines): adopt native CLIs with the spawn's lookup, and spawn them with its PATH
- [#2698](https://github.com/kontourai/station/pull/2698) fix(scripts): decide the entry point by realpath through one helper
- [#2697](https://github.com/kontourai/station/pull/2697) fix(service): rebuild or refuse an unstamped source install; name checkout services after their dev home

**Other**

- [#2774](https://github.com/kontourai/station/pull/2774) test(server): test-audit batch 03 — prune capability and intent-binding replays
- [#2773](https://github.com/kontourai/station/pull/2773) test(server): test-audit batch 07 — plugin routes and the mounted plugin-event gate
- [#2761](https://github.com/kontourai/station/pull/2761) test(android): drop vacuous mobile specs and fold split-pane checks into the sweep
- [#2748](https://github.com/kontourai/station/pull/2748) test(server): replace source greps and test-only seams with behavioural proofs
- [#2757](https://github.com/kontourai/station/pull/2757) test(scripts): give the whole-tree a11y ratchet test its spawn's budget
- [#2749](https://github.com/kontourai/station/pull/2749) test(server): prove project route contracts at real boundaries (audit batch 05)
- [#2739](https://github.com/kontourai/station/pull/2739) test(ui): consolidate UI hook tests through their owners and drop test-only seams
- [#2754](https://github.com/kontourai/station/pull/2754) test(server): prune agent/skill service tautologies and dead methods
- [#2714](https://github.com/kontourai/station/pull/2714) test(scripts): prove the type-laundering gate runs from spaced paths; cover the policy-gate chain
- [#2738](https://github.com/kontourai/station/pull/2738) refactor(notifications): Android alerts use the shared card-alerted mark (#2588, #2589)
- [#2742](https://github.com/kontourai/station/pull/2742) test(scripts): move audit-flagged gate tests onto their production boundaries
- [#2715](https://github.com/kontourai/station/pull/2715) test(ui): replace source-text tests with rendered proofs and delete dead UI code
- [#2690](https://github.com/kontourai/station/pull/2690) chore(skills): add a test-audit skill adapted from OpenClaw

## 2026-09-27T06:24:34Z · nightly-android · 0.1.11-nightly.2461

- Ship SHA: `bda38d3bcb680fddcba6f2e35a43c05d2caefb8a`
- Artifact built at: `2026-09-27T05:16:34.844Z` (not provider upload/record time)
- Artifact: play-internal-aab:cohort-finalized
- Note: ios: TestFlight delivery success (run 36295895609)

### Changelog

Commits since `719e004` ([full sha](https://github.com/kontourai/station/commit/719e0042f6f2941fbc47b402c1df60de2bfc4915)):

**Features**

- [#2740](https://github.com/kontourai/station/pull/2740) feat(ios): open sealed alerts in a Notification Service Extension (#2590)
- [#2743](https://github.com/kontourai/station/pull/2743) feat(sdk): one envelope-to-error helper keeping status, code and details (#2708 A-0)
- [#2723](https://github.com/kontourai/station/pull/2723) feat(release): per-platform manifest v2 with one shared verifier (#2675 slice A)
- [#2711](https://github.com/kontourai/station/pull/2711) feat(desktop): native consumer for the notification delivery feed (#2608)
- [#2726](https://github.com/kontourai/station/pull/2726) feat(relay): add native signal host and opt-in echo lab
- [#2725](https://github.com/kontourai/station/pull/2725) feat(relay): add native grant custody and diagnostic signaling
- [#2705](https://github.com/kontourai/station/pull/2705) feat(packaging): build and smoke prebuilt per-platform server archives (#2675 PR3a)
- [#2688](https://github.com/kontourai/station/pull/2688) feat(install): nightly release ring for the portable installer (plumbing, nothing published)
- [#2555](https://github.com/kontourai/station/pull/2555) feat(relay): approve Station keys in native desktop
- [#2677](https://github.com/kontourai/station/pull/2677) feat(notifications): iOS alert push through APNs, fixed-text interim (#2589)
- [#2699](https://github.com/kontourai/station/pull/2699) feat(station-control): agent reads act for the session's owner (#2377 slice B)

**Fixes**

- [#2768](https://github.com/kontourai/station/pull/2768) fix(registry): confine manifest plugin sources to the registry root
- [#2765](https://github.com/kontourai/station/pull/2765) fix(test-changed): refine SDK barrel fan-out in related test selection (#2707)
- [#2744](https://github.com/kontourai/station/pull/2744) fix(ci): provision JS pnpm on Intel macOS legs (#2675)
- [#2710](https://github.com/kontourai/station/pull/2710) fix(dogfood): keep the installed health helper import-free
- [#2712](https://github.com/kontourai/station/pull/2712) fix(chat-dock): check-again way out of a stale busy wait; copy IDs on the phone sheet
- [#2706](https://github.com/kontourai/station/pull/2706) fix(chat): follow projected streaming turns and honor any scroll device
- [#2704](https://github.com/kontourai/station/pull/2704) fix(release): run publish-time release policy from the default branch
- [#2702](https://github.com/kontourai/station/pull/2702) fix(engines): adopt native CLIs with the spawn's lookup, and spawn them with its PATH
- [#2698](https://github.com/kontourai/station/pull/2698) fix(scripts): decide the entry point by realpath through one helper
- [#2697](https://github.com/kontourai/station/pull/2697) fix(service): rebuild or refuse an unstamped source install; name checkout services after their dev home

**Other**

- [#2774](https://github.com/kontourai/station/pull/2774) test(server): test-audit batch 03 — prune capability and intent-binding replays
- [#2773](https://github.com/kontourai/station/pull/2773) test(server): test-audit batch 07 — plugin routes and the mounted plugin-event gate
- [#2761](https://github.com/kontourai/station/pull/2761) test(android): drop vacuous mobile specs and fold split-pane checks into the sweep
- [#2748](https://github.com/kontourai/station/pull/2748) test(server): replace source greps and test-only seams with behavioural proofs
- [#2757](https://github.com/kontourai/station/pull/2757) test(scripts): give the whole-tree a11y ratchet test its spawn's budget
- [#2749](https://github.com/kontourai/station/pull/2749) test(server): prove project route contracts at real boundaries (audit batch 05)
- [#2739](https://github.com/kontourai/station/pull/2739) test(ui): consolidate UI hook tests through their owners and drop test-only seams
- [#2754](https://github.com/kontourai/station/pull/2754) test(server): prune agent/skill service tautologies and dead methods
- [#2714](https://github.com/kontourai/station/pull/2714) test(scripts): prove the type-laundering gate runs from spaced paths; cover the policy-gate chain
- [#2738](https://github.com/kontourai/station/pull/2738) refactor(notifications): Android alerts use the shared card-alerted mark (#2588, #2589)
- [#2742](https://github.com/kontourai/station/pull/2742) test(scripts): move audit-flagged gate tests onto their production boundaries
- [#2715](https://github.com/kontourai/station/pull/2715) test(ui): replace source-text tests with rendered proofs and delete dead UI code
- [#2690](https://github.com/kontourai/station/pull/2690) chore(skills): add a test-audit skill adapted from OpenClaw

## 2026-09-27T06:04:02Z · nightly-npm · 0.6.0-nightly.2461.36295895609

- Ship SHA: `bda38d3bcb680fddcba6f2e35a43c05d2caefb8a`
- Artifact built at: `unknown` (no immutable artifact manifest binding)
- Artifact: npm:@kontourai/station-cli@0.6.0-nightly.2461.36295895609 (dist-tag nightly; artifactBuiltAt unknown)
- Note: artifactBuiltAt is null: npm package has no native artifact manifest

### Changelog

Commits since `719e004` ([full sha](https://github.com/kontourai/station/commit/719e0042f6f2941fbc47b402c1df60de2bfc4915)):

**Features**

- [#2740](https://github.com/kontourai/station/pull/2740) feat(ios): open sealed alerts in a Notification Service Extension (#2590)
- [#2743](https://github.com/kontourai/station/pull/2743) feat(sdk): one envelope-to-error helper keeping status, code and details (#2708 A-0)
- [#2723](https://github.com/kontourai/station/pull/2723) feat(release): per-platform manifest v2 with one shared verifier (#2675 slice A)
- [#2711](https://github.com/kontourai/station/pull/2711) feat(desktop): native consumer for the notification delivery feed (#2608)
- [#2726](https://github.com/kontourai/station/pull/2726) feat(relay): add native signal host and opt-in echo lab
- [#2725](https://github.com/kontourai/station/pull/2725) feat(relay): add native grant custody and diagnostic signaling
- [#2705](https://github.com/kontourai/station/pull/2705) feat(packaging): build and smoke prebuilt per-platform server archives (#2675 PR3a)
- [#2688](https://github.com/kontourai/station/pull/2688) feat(install): nightly release ring for the portable installer (plumbing, nothing published)
- [#2555](https://github.com/kontourai/station/pull/2555) feat(relay): approve Station keys in native desktop
- [#2677](https://github.com/kontourai/station/pull/2677) feat(notifications): iOS alert push through APNs, fixed-text interim (#2589)
- [#2699](https://github.com/kontourai/station/pull/2699) feat(station-control): agent reads act for the session's owner (#2377 slice B)

**Fixes**

- [#2768](https://github.com/kontourai/station/pull/2768) fix(registry): confine manifest plugin sources to the registry root
- [#2765](https://github.com/kontourai/station/pull/2765) fix(test-changed): refine SDK barrel fan-out in related test selection (#2707)
- [#2744](https://github.com/kontourai/station/pull/2744) fix(ci): provision JS pnpm on Intel macOS legs (#2675)
- [#2710](https://github.com/kontourai/station/pull/2710) fix(dogfood): keep the installed health helper import-free
- [#2712](https://github.com/kontourai/station/pull/2712) fix(chat-dock): check-again way out of a stale busy wait; copy IDs on the phone sheet
- [#2706](https://github.com/kontourai/station/pull/2706) fix(chat): follow projected streaming turns and honor any scroll device
- [#2704](https://github.com/kontourai/station/pull/2704) fix(release): run publish-time release policy from the default branch
- [#2702](https://github.com/kontourai/station/pull/2702) fix(engines): adopt native CLIs with the spawn's lookup, and spawn them with its PATH
- [#2698](https://github.com/kontourai/station/pull/2698) fix(scripts): decide the entry point by realpath through one helper
- [#2697](https://github.com/kontourai/station/pull/2697) fix(service): rebuild or refuse an unstamped source install; name checkout services after their dev home

**Other**

- [#2774](https://github.com/kontourai/station/pull/2774) test(server): test-audit batch 03 — prune capability and intent-binding replays
- [#2773](https://github.com/kontourai/station/pull/2773) test(server): test-audit batch 07 — plugin routes and the mounted plugin-event gate
- [#2761](https://github.com/kontourai/station/pull/2761) test(android): drop vacuous mobile specs and fold split-pane checks into the sweep
- [#2748](https://github.com/kontourai/station/pull/2748) test(server): replace source greps and test-only seams with behavioural proofs
- [#2757](https://github.com/kontourai/station/pull/2757) test(scripts): give the whole-tree a11y ratchet test its spawn's budget
- [#2749](https://github.com/kontourai/station/pull/2749) test(server): prove project route contracts at real boundaries (audit batch 05)
- [#2739](https://github.com/kontourai/station/pull/2739) test(ui): consolidate UI hook tests through their owners and drop test-only seams
- [#2754](https://github.com/kontourai/station/pull/2754) test(server): prune agent/skill service tautologies and dead methods
- [#2714](https://github.com/kontourai/station/pull/2714) test(scripts): prove the type-laundering gate runs from spaced paths; cover the policy-gate chain
- [#2738](https://github.com/kontourai/station/pull/2738) refactor(notifications): Android alerts use the shared card-alerted mark (#2588, #2589)
- [#2742](https://github.com/kontourai/station/pull/2742) test(scripts): move audit-flagged gate tests onto their production boundaries
- [#2715](https://github.com/kontourai/station/pull/2715) test(ui): replace source-text tests with rendered proofs and delete dead UI code
- [#2690](https://github.com/kontourai/station/pull/2690) chore(skills): add a test-audit skill adapted from OpenClaw

## 2026-09-26T17:34:01Z · nightly-desktop · 0.1.11-nightly.2460.4

- Ship SHA: `719e0042f6f2941fbc47b402c1df60de2bfc4915`
- Artifact built at: `2026-09-26T16:33:45.047Z` (not provider upload/record time)
- Artifact: github-release:nightly-desktop (cohort-finalized)
- Note: ios: TestFlight delivery success (run 36254706366)

### Changelog

Commits since `3c43c43` ([full sha](https://github.com/kontourai/station/commit/3c43c43a71ba9908bcb1030326491320a0b90d1f)):

**Features**

- [#2685](https://github.com/kontourai/station/pull/2685) feat(station-control): per-call authority for every station-control tool (#2377 slice A)

**Fixes**

- [#2695](https://github.com/kontourai/station/pull/2695) fix(service): report service PATH drift in status, with a faithful reinstall hint
- [#2693](https://github.com/kontourai/station/pull/2693) fix(ci): build the CLI before the repository source scans

## 2026-09-26T17:33:59Z · nightly-android · 0.1.11-nightly.2460.4

- Ship SHA: `719e0042f6f2941fbc47b402c1df60de2bfc4915`
- Artifact built at: `2026-09-26T16:33:38.109Z` (not provider upload/record time)
- Artifact: play-internal-aab:cohort-finalized
- Note: ios: TestFlight delivery success (run 36254706366)

### Changelog

Commits since `3c43c43` ([full sha](https://github.com/kontourai/station/commit/3c43c43a71ba9908bcb1030326491320a0b90d1f)):

**Features**

- [#2685](https://github.com/kontourai/station/pull/2685) feat(station-control): per-call authority for every station-control tool (#2377 slice A)

**Fixes**

- [#2695](https://github.com/kontourai/station/pull/2695) fix(service): report service PATH drift in status, with a faithful reinstall hint
- [#2693](https://github.com/kontourai/station/pull/2693) fix(ci): build the CLI before the repository source scans

## 2026-09-26T17:18:51Z · nightly-npm · 0.6.0-nightly.2460.36254706366

- Ship SHA: `719e0042f6f2941fbc47b402c1df60de2bfc4915`
- Artifact built at: `unknown` (no immutable artifact manifest binding)
- Artifact: npm:@kontourai/station-cli@0.6.0-nightly.2460.36254706366 (dist-tag nightly; artifactBuiltAt unknown)
- Note: artifactBuiltAt is null: npm package has no native artifact manifest

### Changelog

Commits since `3c43c43` ([full sha](https://github.com/kontourai/station/commit/3c43c43a71ba9908bcb1030326491320a0b90d1f)):

**Features**

- [#2685](https://github.com/kontourai/station/pull/2685) feat(station-control): per-call authority for every station-control tool (#2377 slice A)

**Fixes**

- [#2695](https://github.com/kontourai/station/pull/2695) fix(service): report service PATH drift in status, with a faithful reinstall hint
- [#2693](https://github.com/kontourai/station/pull/2693) fix(ci): build the CLI before the repository source scans

## 2026-09-26T16:24:11Z · nightly-desktop · 0.1.11-nightly.2460.3

- Ship SHA: `3c43c43a71ba9908bcb1030326491320a0b90d1f`
- Artifact built at: `2026-09-26T15:50:20.340Z` (not provider upload/record time)
- Artifact: github-release:nightly-desktop (cohort-finalized)
- Note: ios: TestFlight delivery success (run 36252766737)

### Changelog

Commits since `a279a57` ([full sha](https://github.com/kontourai/station/commit/a279a57fe966178b1fa26419fdc6a6fc4b6c35f7)):

**Features**

- [#2537](https://github.com/kontourai/station/pull/2537) feat(relay): add pre-grant Station key discovery and native trust foundations
- [#2680](https://github.com/kontourai/station/pull/2680) feat(install): verify portable release manifests against pinned signing keys (#2675)
- [#2670](https://github.com/kontourai/station/pull/2670) feat(notifications): Android FCM alerts via a sealed station_notification kind (#2588)
- [#2638](https://github.com/kontourai/station/pull/2638) feat(notifications): desktop OS alerts from the delivery feed, with inbox attribution (#2587)
- [#2666](https://github.com/kontourai/station/pull/2666) feat(ios): register iPhones for agent activity from the web layer (#2660)
- [#2661](https://github.com/kontourai/station/pull/2661) feat(notifications): quiet other surfaces only while the focused document's stream is live (#2620)

**Fixes**

- [#2692](https://github.com/kontourai/station/pull/2692) fix(ci): build the CLI bundle before repository source scans
- [#2691](https://github.com/kontourai/station/pull/2691) fix(ios): drop Tauri-rendered signing keys before injecting the manual block
- [#2593](https://github.com/kontourai/station/pull/2593) fix(guidance): in-app equivalents for CLI/env-var disclosures (device helper setting, workflows UI, reconnect)
- [#2679](https://github.com/kontourai/station/pull/2679) fix(update): refuse in-app server updates under a supervisor; build through buildApplication (#2673, #2674)
- [#2672](https://github.com/kontourai/station/pull/2672) fix(delegation): derive delegation lineage from the verified caller (#2601)
- [#2668](https://github.com/kontourai/station/pull/2668) fix(connections): readiness honours a connection's env and configHome (proxy-routed Claude/Codex)
- [#2667](https://github.com/kontourai/station/pull/2667) fix(approvals): make unattended tool use an explicit opt-in (#2613)
- [#2651](https://github.com/kontourai/station/pull/2651) fix(verification): select unmodelled-input suites on the PR lane; run whole-tree scans per PR (#2176)
- [#2662](https://github.com/kontourai/station/pull/2662) fix(orchestration): principal-only session ownership — no ownerless or OS-alias session access

**CI / workflow**

- [#2664](https://github.com/kontourai/station/pull/2664) ci(ios): build, sign and audit the Live Activity in Beta and Nightly TestFlight (#2513)

**Docs**

- [#2629](https://github.com/kontourai/station/pull/2629) docs: adopt deslop skill and codify flake/queue operating rules

**Other**

- [#2687](https://github.com/kontourai/station/pull/2687) refactor(update): share the owned dependency-installer check
- [#2669](https://github.com/kontourai/station/pull/2669) chore: remove references to an external product and gate them out
- [#2645](https://github.com/kontourai/station/pull/2645) perf(ui): load slash built-ins and brand marks on demand (−6.3 KB entry JS)

## 2026-09-26T16:24:09Z · nightly-android · 0.1.11-nightly.2460.3

- Ship SHA: `3c43c43a71ba9908bcb1030326491320a0b90d1f`
- Artifact built at: `2026-09-26T15:50:19.539Z` (not provider upload/record time)
- Artifact: play-internal-aab:cohort-finalized
- Note: ios: TestFlight delivery success (run 36252766737)

### Changelog

Commits since `a279a57` ([full sha](https://github.com/kontourai/station/commit/a279a57fe966178b1fa26419fdc6a6fc4b6c35f7)):

**Features**

- [#2537](https://github.com/kontourai/station/pull/2537) feat(relay): add pre-grant Station key discovery and native trust foundations
- [#2680](https://github.com/kontourai/station/pull/2680) feat(install): verify portable release manifests against pinned signing keys (#2675)
- [#2670](https://github.com/kontourai/station/pull/2670) feat(notifications): Android FCM alerts via a sealed station_notification kind (#2588)
- [#2638](https://github.com/kontourai/station/pull/2638) feat(notifications): desktop OS alerts from the delivery feed, with inbox attribution (#2587)
- [#2666](https://github.com/kontourai/station/pull/2666) feat(ios): register iPhones for agent activity from the web layer (#2660)
- [#2661](https://github.com/kontourai/station/pull/2661) feat(notifications): quiet other surfaces only while the focused document's stream is live (#2620)

**Fixes**

- [#2692](https://github.com/kontourai/station/pull/2692) fix(ci): build the CLI bundle before repository source scans
- [#2691](https://github.com/kontourai/station/pull/2691) fix(ios): drop Tauri-rendered signing keys before injecting the manual block
- [#2593](https://github.com/kontourai/station/pull/2593) fix(guidance): in-app equivalents for CLI/env-var disclosures (device helper setting, workflows UI, reconnect)
- [#2679](https://github.com/kontourai/station/pull/2679) fix(update): refuse in-app server updates under a supervisor; build through buildApplication (#2673, #2674)
- [#2672](https://github.com/kontourai/station/pull/2672) fix(delegation): derive delegation lineage from the verified caller (#2601)
- [#2668](https://github.com/kontourai/station/pull/2668) fix(connections): readiness honours a connection's env and configHome (proxy-routed Claude/Codex)
- [#2667](https://github.com/kontourai/station/pull/2667) fix(approvals): make unattended tool use an explicit opt-in (#2613)
- [#2651](https://github.com/kontourai/station/pull/2651) fix(verification): select unmodelled-input suites on the PR lane; run whole-tree scans per PR (#2176)
- [#2662](https://github.com/kontourai/station/pull/2662) fix(orchestration): principal-only session ownership — no ownerless or OS-alias session access

**CI / workflow**

- [#2664](https://github.com/kontourai/station/pull/2664) ci(ios): build, sign and audit the Live Activity in Beta and Nightly TestFlight (#2513)

**Docs**

- [#2629](https://github.com/kontourai/station/pull/2629) docs: adopt deslop skill and codify flake/queue operating rules

**Other**

- [#2687](https://github.com/kontourai/station/pull/2687) refactor(update): share the owned dependency-installer check
- [#2669](https://github.com/kontourai/station/pull/2669) chore: remove references to an external product and gate them out
- [#2645](https://github.com/kontourai/station/pull/2645) perf(ui): load slash built-ins and brand marks on demand (−6.3 KB entry JS)

## 2026-09-26T16:21:23Z · nightly-npm · 0.6.0-nightly.2460.36252766737

- Ship SHA: `3c43c43a71ba9908bcb1030326491320a0b90d1f`
- Artifact built at: `unknown` (no immutable artifact manifest binding)
- Artifact: npm:@kontourai/station-cli@0.6.0-nightly.2460.36252766737 (dist-tag nightly; artifactBuiltAt unknown)
- Note: artifactBuiltAt is null: npm package has no native artifact manifest

### Changelog

Commits since `fe8660d` ([full sha](https://github.com/kontourai/station/commit/fe8660dd9bc0b4e5e69be8afdce3500befe49e3d)):

**Features**

- [#2537](https://github.com/kontourai/station/pull/2537) feat(relay): add pre-grant Station key discovery and native trust foundations

**Fixes**

- [#2692](https://github.com/kontourai/station/pull/2692) fix(ci): build the CLI bundle before repository source scans
- [#2691](https://github.com/kontourai/station/pull/2691) fix(ios): drop Tauri-rendered signing keys before injecting the manual block

**Other**

- [#2687](https://github.com/kontourai/station/pull/2687) refactor(update): share the owned dependency-installer check
- [#2669](https://github.com/kontourai/station/pull/2669) chore: remove references to an external product and gate them out

## 2026-09-26T12:10:51Z · nightly-npm · 0.6.0-nightly.2460.36238106182

- Ship SHA: `fe8660dd9bc0b4e5e69be8afdce3500befe49e3d`
- Artifact built at: `unknown` (no immutable artifact manifest binding)
- Artifact: npm:@kontourai/station-cli@0.6.0-nightly.2460.36238106182 (dist-tag nightly; artifactBuiltAt unknown)
- Note: artifactBuiltAt is null: npm package has no native artifact manifest

### Changelog

Commits since `73b5db6` ([full sha](https://github.com/kontourai/station/commit/73b5db6ff8728a1bc9e5f722f91161ad98885a7d)):

_No user-visible changes recorded for this slice._

## 2026-09-26T06:19:12Z · nightly-npm · 0.6.0-nightly.2460.36218473798

- Ship SHA: `73b5db6ff8728a1bc9e5f722f91161ad98885a7d`
- Artifact built at: `unknown` (no immutable artifact manifest binding)
- Artifact: npm:@kontourai/station-cli@0.6.0-nightly.2460.36218473798 (dist-tag nightly; artifactBuiltAt unknown)
- Note: artifactBuiltAt is null: npm package has no native artifact manifest

### Changelog

Commits since `a279a57` ([full sha](https://github.com/kontourai/station/commit/a279a57fe966178b1fa26419fdc6a6fc4b6c35f7)):

**Features**

- [#2680](https://github.com/kontourai/station/pull/2680) feat(install): verify portable release manifests against pinned signing keys (#2675)
- [#2670](https://github.com/kontourai/station/pull/2670) feat(notifications): Android FCM alerts via a sealed station_notification kind (#2588)
- [#2638](https://github.com/kontourai/station/pull/2638) feat(notifications): desktop OS alerts from the delivery feed, with inbox attribution (#2587)
- [#2666](https://github.com/kontourai/station/pull/2666) feat(ios): register iPhones for agent activity from the web layer (#2660)
- [#2661](https://github.com/kontourai/station/pull/2661) feat(notifications): quiet other surfaces only while the focused document's stream is live (#2620)

**Fixes**

- [#2593](https://github.com/kontourai/station/pull/2593) fix(guidance): in-app equivalents for CLI/env-var disclosures (device helper setting, workflows UI, reconnect)
- [#2679](https://github.com/kontourai/station/pull/2679) fix(update): refuse in-app server updates under a supervisor; build through buildApplication (#2673, #2674)
- [#2672](https://github.com/kontourai/station/pull/2672) fix(delegation): derive delegation lineage from the verified caller (#2601)
- [#2668](https://github.com/kontourai/station/pull/2668) fix(connections): readiness honours a connection's env and configHome (proxy-routed Claude/Codex)
- [#2667](https://github.com/kontourai/station/pull/2667) fix(approvals): make unattended tool use an explicit opt-in (#2613)
- [#2651](https://github.com/kontourai/station/pull/2651) fix(verification): select unmodelled-input suites on the PR lane; run whole-tree scans per PR (#2176)
- [#2662](https://github.com/kontourai/station/pull/2662) fix(orchestration): principal-only session ownership — no ownerless or OS-alias session access

**CI / workflow**

- [#2664](https://github.com/kontourai/station/pull/2664) ci(ios): build, sign and audit the Live Activity in Beta and Nightly TestFlight (#2513)

**Docs**

- [#2629](https://github.com/kontourai/station/pull/2629) docs: adopt deslop skill and codify flake/queue operating rules

**Other**

- [#2645](https://github.com/kontourai/station/pull/2645) perf(ui): load slash built-ins and brand marks on demand (−6.3 KB entry JS)

## 2026-09-25T23:08:06Z · nightly-desktop · 0.1.11-nightly.2459.3

- Ship SHA: `a279a57fe966178b1fa26419fdc6a6fc4b6c35f7`
- Artifact built at: `2026-09-25T21:35:15.287Z` (not provider upload/record time)
- Artifact: github-release:nightly-desktop (cohort-finalized)
- Note: ios: TestFlight delivery success (run 36191456945)

### Changelog

Commits since `20c6e65` ([full sha](https://github.com/kontourai/station/commit/20c6e651f7b7403fbbbf46f10400f627a9dba95b)):

**Features**

- [#2630](https://github.com/kontourai/station/pull/2630) feat(governance): adopt remaining OpenClaw practices (todo sweep, duplicate sweep, type gate)

**Fixes**

- [#2655](https://github.com/kontourai/station/pull/2655) fix(chat): child-work banner reads turn liveness; pin the route's child-work binding (#2654)

**Other**

- [#2665](https://github.com/kontourai/station/pull/2665) test(gallery): re-baseline overlay-mobile-sheet for the current main render

## 2026-09-25T23:08:02Z · nightly-android · 0.1.11-nightly.2459.3

- Ship SHA: `a279a57fe966178b1fa26419fdc6a6fc4b6c35f7`
- Artifact built at: `2026-09-25T21:34:57.734Z` (not provider upload/record time)
- Artifact: play-internal-aab:cohort-finalized
- Note: ios: TestFlight delivery success (run 36191456945)

### Changelog

Commits since `20c6e65` ([full sha](https://github.com/kontourai/station/commit/20c6e651f7b7403fbbbf46f10400f627a9dba95b)):

**Features**

- [#2630](https://github.com/kontourai/station/pull/2630) feat(governance): adopt remaining OpenClaw practices (todo sweep, duplicate sweep, type gate)

**Fixes**

- [#2655](https://github.com/kontourai/station/pull/2655) fix(chat): child-work banner reads turn liveness; pin the route's child-work binding (#2654)

**Other**

- [#2665](https://github.com/kontourai/station/pull/2665) test(gallery): re-baseline overlay-mobile-sheet for the current main render

## 2026-09-25T22:16:16Z · nightly-npm · 0.6.0-nightly.2459.36191456945

- Ship SHA: `a279a57fe966178b1fa26419fdc6a6fc4b6c35f7`
- Artifact built at: `unknown` (no immutable artifact manifest binding)
- Artifact: npm:@kontourai/station-cli@0.6.0-nightly.2459.36191456945 (dist-tag nightly; artifactBuiltAt unknown)
- Note: artifactBuiltAt is null: npm package has no native artifact manifest

### Changelog

Commits since `20c6e65` ([full sha](https://github.com/kontourai/station/commit/20c6e651f7b7403fbbbf46f10400f627a9dba95b)):

**Features**

- [#2630](https://github.com/kontourai/station/pull/2630) feat(governance): adopt remaining OpenClaw practices (todo sweep, duplicate sweep, type gate)

**Fixes**

- [#2655](https://github.com/kontourai/station/pull/2655) fix(chat): child-work banner reads turn liveness; pin the route's child-work binding (#2654)

**Other**

- [#2665](https://github.com/kontourai/station/pull/2665) test(gallery): re-baseline overlay-mobile-sheet for the current main render

## 2026-09-25T18:47:12Z · nightly-desktop · 0.1.11-nightly.2459.2

- Ship SHA: `20c6e651f7b7403fbbbf46f10400f627a9dba95b`
- Artifact built at: `2026-09-25T17:14:42.110Z` (not provider upload/record time)
- Artifact: github-release:nightly-desktop (cohort-finalized)
- Note: ios: TestFlight delivery success (run 36164412979)

### Changelog

Commits since `73fd03c` ([full sha](https://github.com/kontourai/station/commit/73fd03ce808e7ece843fb81574cd7cc440251ab2)):

**Features**

- [#2622](https://github.com/kontourai/station/pull/2622) feat(notifications): delivery router with family audience, per-session read, preferences and a desktop feed
- [#2553](https://github.com/kontourai/station/pull/2553) feat(activity): a thread with running child work reads active on every surface (#2464)
- [#2289](https://github.com/kontourai/station/pull/2289) feat(projects): place delegated tasks by portable identity
- [#2644](https://github.com/kontourai/station/pull/2644) feat(ios): the Live Activity widget extension and plugin, off until enabled (#2513)
- [#2619](https://github.com/kontourai/station/pull/2619) feat(notifications): notify_user tool for agents, auto-approved by exact built-in identity

**Fixes**

- [#2653](https://github.com/kontourai/station/pull/2653) fix(action-operations): a Tailscale Serve principal can own an action operation
- [#2649](https://github.com/kontourai/station/pull/2649) fix(scripts): retire the listener lease by rename so a waiter cannot claim it mid-delete (#2648)
- [#2618](https://github.com/kontourai/station/pull/2618) fix: attachment-preview follow-ups: event-store impact boundary (#2610), legacy-owner policy docs (#2611), used sign-in links (#2612), preview polish
- [#2527](https://github.com/kontourai/station/pull/2527) fix(mobile): chat keyboard layout, run-together messages, unconfirmed-start retry, task switcher rows
- [#2594](https://github.com/kontourai/station/pull/2594) fix(chat): exact client catch-up across replay, snapshot, reload, remount and resume
- [#2548](https://github.com/kontourai/station/pull/2548) fix(home): keep Home and its dialogs' history intact across the first project's load
- [#2642](https://github.com/kontourai/station/pull/2642) fix(chat-dock): reach Background tasks on a phone; retire the dead Activity mode; fix main-red specs (#2510)

**CI / workflow**

- [#2650](https://github.com/kontourai/station/pull/2650) ci: retire the bundle merge driver and pre-push build; report each PR's bundle delta
- [#2556](https://github.com/kontourai/station/pull/2556) ci(extended): parallelize coverage across hosted shards, bound e2e buckets by deadline
- [#2631](https://github.com/kontourai/station/pull/2631) ci: stop exact baselines from dequeuing sibling PRs; one-shot queue confirm

**Other**

- [#2652](https://github.com/kontourai/station/pull/2652) test(gallery): re-baseline mobile-activity-compact for the phone pane layer (#2632)
- [#2643](https://github.com/kontourai/station/pull/2643) test(gallery): re-baseline mobile-activity-compact for #2549's pane-over-Chat
- [#2640](https://github.com/kontourai/station/pull/2640) test(e2e): gallery toasts and notifications.spec stop sending a caller-chosen source (#2639)

## 2026-09-25T18:47:08Z · nightly-android · 0.1.11-nightly.2459.2

- Ship SHA: `20c6e651f7b7403fbbbf46f10400f627a9dba95b`
- Artifact built at: `2026-09-25T17:20:57.167Z` (not provider upload/record time)
- Artifact: play-internal-aab:cohort-finalized
- Note: ios: TestFlight delivery success (run 36164412979)

### Changelog

Commits since `73fd03c` ([full sha](https://github.com/kontourai/station/commit/73fd03ce808e7ece843fb81574cd7cc440251ab2)):

**Features**

- [#2622](https://github.com/kontourai/station/pull/2622) feat(notifications): delivery router with family audience, per-session read, preferences and a desktop feed
- [#2553](https://github.com/kontourai/station/pull/2553) feat(activity): a thread with running child work reads active on every surface (#2464)
- [#2289](https://github.com/kontourai/station/pull/2289) feat(projects): place delegated tasks by portable identity
- [#2644](https://github.com/kontourai/station/pull/2644) feat(ios): the Live Activity widget extension and plugin, off until enabled (#2513)
- [#2619](https://github.com/kontourai/station/pull/2619) feat(notifications): notify_user tool for agents, auto-approved by exact built-in identity

**Fixes**

- [#2653](https://github.com/kontourai/station/pull/2653) fix(action-operations): a Tailscale Serve principal can own an action operation
- [#2649](https://github.com/kontourai/station/pull/2649) fix(scripts): retire the listener lease by rename so a waiter cannot claim it mid-delete (#2648)
- [#2618](https://github.com/kontourai/station/pull/2618) fix: attachment-preview follow-ups: event-store impact boundary (#2610), legacy-owner policy docs (#2611), used sign-in links (#2612), preview polish
- [#2527](https://github.com/kontourai/station/pull/2527) fix(mobile): chat keyboard layout, run-together messages, unconfirmed-start retry, task switcher rows
- [#2594](https://github.com/kontourai/station/pull/2594) fix(chat): exact client catch-up across replay, snapshot, reload, remount and resume
- [#2548](https://github.com/kontourai/station/pull/2548) fix(home): keep Home and its dialogs' history intact across the first project's load
- [#2642](https://github.com/kontourai/station/pull/2642) fix(chat-dock): reach Background tasks on a phone; retire the dead Activity mode; fix main-red specs (#2510)

**CI / workflow**

- [#2650](https://github.com/kontourai/station/pull/2650) ci: retire the bundle merge driver and pre-push build; report each PR's bundle delta
- [#2556](https://github.com/kontourai/station/pull/2556) ci(extended): parallelize coverage across hosted shards, bound e2e buckets by deadline
- [#2631](https://github.com/kontourai/station/pull/2631) ci: stop exact baselines from dequeuing sibling PRs; one-shot queue confirm

**Other**

- [#2652](https://github.com/kontourai/station/pull/2652) test(gallery): re-baseline mobile-activity-compact for the phone pane layer (#2632)
- [#2643](https://github.com/kontourai/station/pull/2643) test(gallery): re-baseline mobile-activity-compact for #2549's pane-over-Chat
- [#2640](https://github.com/kontourai/station/pull/2640) test(e2e): gallery toasts and notifications.spec stop sending a caller-chosen source (#2639)

## 2026-09-25T18:06:31Z · nightly-npm · 0.6.0-nightly.2459.36164412979

- Ship SHA: `20c6e651f7b7403fbbbf46f10400f627a9dba95b`
- Artifact built at: `unknown` (no immutable artifact manifest binding)
- Artifact: npm:@kontourai/station-cli@0.6.0-nightly.2459.36164412979 (dist-tag nightly; artifactBuiltAt unknown)
- Note: artifactBuiltAt is null: npm package has no native artifact manifest

### Changelog

Commits since `73fd03c` ([full sha](https://github.com/kontourai/station/commit/73fd03ce808e7ece843fb81574cd7cc440251ab2)):

**Features**

- [#2622](https://github.com/kontourai/station/pull/2622) feat(notifications): delivery router with family audience, per-session read, preferences and a desktop feed
- [#2553](https://github.com/kontourai/station/pull/2553) feat(activity): a thread with running child work reads active on every surface (#2464)
- [#2289](https://github.com/kontourai/station/pull/2289) feat(projects): place delegated tasks by portable identity
- [#2644](https://github.com/kontourai/station/pull/2644) feat(ios): the Live Activity widget extension and plugin, off until enabled (#2513)
- [#2619](https://github.com/kontourai/station/pull/2619) feat(notifications): notify_user tool for agents, auto-approved by exact built-in identity

**Fixes**

- [#2653](https://github.com/kontourai/station/pull/2653) fix(action-operations): a Tailscale Serve principal can own an action operation
- [#2649](https://github.com/kontourai/station/pull/2649) fix(scripts): retire the listener lease by rename so a waiter cannot claim it mid-delete (#2648)
- [#2618](https://github.com/kontourai/station/pull/2618) fix: attachment-preview follow-ups: event-store impact boundary (#2610), legacy-owner policy docs (#2611), used sign-in links (#2612), preview polish
- [#2527](https://github.com/kontourai/station/pull/2527) fix(mobile): chat keyboard layout, run-together messages, unconfirmed-start retry, task switcher rows
- [#2594](https://github.com/kontourai/station/pull/2594) fix(chat): exact client catch-up across replay, snapshot, reload, remount and resume
- [#2548](https://github.com/kontourai/station/pull/2548) fix(home): keep Home and its dialogs' history intact across the first project's load
- [#2642](https://github.com/kontourai/station/pull/2642) fix(chat-dock): reach Background tasks on a phone; retire the dead Activity mode; fix main-red specs (#2510)

**CI / workflow**

- [#2650](https://github.com/kontourai/station/pull/2650) ci: retire the bundle merge driver and pre-push build; report each PR's bundle delta
- [#2556](https://github.com/kontourai/station/pull/2556) ci(extended): parallelize coverage across hosted shards, bound e2e buckets by deadline
- [#2631](https://github.com/kontourai/station/pull/2631) ci: stop exact baselines from dequeuing sibling PRs; one-shot queue confirm

**Other**

- [#2652](https://github.com/kontourai/station/pull/2652) test(gallery): re-baseline mobile-activity-compact for the phone pane layer (#2632)
- [#2643](https://github.com/kontourai/station/pull/2643) test(gallery): re-baseline mobile-activity-compact for #2549's pane-over-Chat
- [#2640](https://github.com/kontourai/station/pull/2640) test(e2e): gallery toasts and notifications.spec stop sending a caller-chosen source (#2639)

## 2026-09-25T13:13:53Z · nightly-desktop · 0.1.11-nightly.2459.1

- Ship SHA: `73fd03ce808e7ece843fb81574cd7cc440251ab2`
- Artifact built at: `2026-09-25T11:54:13.553Z` (not provider upload/record time)
- Artifact: github-release:nightly-desktop (cohort-finalized)
- Note: ios: TestFlight delivery success (run 36130497746)

### Changelog

Commits since `bdc00df` ([full sha](https://github.com/kontourai/station/commit/bdc00df5187d5cdd96e662cc087b16cd8c991425)):

**Features**

- [#2641](https://github.com/kontourai/station/pull/2641) feat(notifications): tapping an agent-activity card opens the session it names (#2515)
- [#2566](https://github.com/kontourai/station/pull/2566) feat(connect): forget a shared saved Station from the app
- [#2616](https://github.com/kontourai/station/pull/2616) feat(notifications): envelope contracts and a trusted write path; refuse cross-source dedupe
- [#2602](https://github.com/kontourai/station/pull/2602) feat(notifications): iOS Live Activities through the push gateway (server + gateway)
- [#2603](https://github.com/kontourai/station/pull/2603) feat(approvals): separate approval mode from confinement; confine every start that could not grant full access (#2493, #2559, #2569)
- [#2604](https://github.com/kontourai/station/pull/2604) feat(presence): per-surface focus reports for notification routing
- [#2576](https://github.com/kontourai/station/pull/2576) feat(agent-activity): use Station's mark for the status-bar icon (#2518)

**Fixes**

- [#2623](https://github.com/kontourai/station/pull/2623) fix(tests): redirect TMPDIR into the vitest run root so every temp dir is removed with the run
- [#2633](https://github.com/kontourai/station/pull/2633) fix(tests,agents): skills-root concurrent-create race and installer test budget
- [#2605](https://github.com/kontourai/station/pull/2605) fix(regions): close the phone layer's disclosed gaps — reload, scoped guards, same-tick Back, fold-open return
- [#2579](https://github.com/kontourai/station/pull/2579) fix(runtime): session reads across 13 route families decide with the request's principal, not the OS alias
- [#2617](https://github.com/kontourai/station/pull/2617) fix(ui): let a cookie session read its own Station's Projects; relay and native reads keep requiring the enrolled credential

**CI / workflow**

- [#2637](https://github.com/kontourai/station/pull/2637) ci: name the stalled typecheck lane and give hosted typecheck 4 slots
- [#2615](https://github.com/kontourai/station/pull/2615) ci: size the ci:fast budget to measured runs and fence every job that runs it
- [#2539](https://github.com/kontourai/station/pull/2539) ci(gallery): run the exact-pixel gallery diff on gallery-relevant PRs

**Other**

- [#2635](https://github.com/kontourai/station/pull/2635) test(relay): wait for admission, not the accept callback (#2557)
- [#2606](https://github.com/kontourai/station/pull/2606) test(authority): scope the no-refetch restore claim to A's shelf and force both Default orderings

## 2026-09-25T13:13:50Z · nightly-android · 0.1.11-nightly.2459.1

- Ship SHA: `73fd03ce808e7ece843fb81574cd7cc440251ab2`
- Artifact built at: `2026-09-25T11:58:37.785Z` (not provider upload/record time)
- Artifact: play-internal-aab:cohort-finalized
- Note: ios: TestFlight delivery success (run 36130497746)

### Changelog

Commits since `bdc00df` ([full sha](https://github.com/kontourai/station/commit/bdc00df5187d5cdd96e662cc087b16cd8c991425)):

**Features**

- [#2641](https://github.com/kontourai/station/pull/2641) feat(notifications): tapping an agent-activity card opens the session it names (#2515)
- [#2566](https://github.com/kontourai/station/pull/2566) feat(connect): forget a shared saved Station from the app
- [#2616](https://github.com/kontourai/station/pull/2616) feat(notifications): envelope contracts and a trusted write path; refuse cross-source dedupe
- [#2602](https://github.com/kontourai/station/pull/2602) feat(notifications): iOS Live Activities through the push gateway (server + gateway)
- [#2603](https://github.com/kontourai/station/pull/2603) feat(approvals): separate approval mode from confinement; confine every start that could not grant full access (#2493, #2559, #2569)
- [#2604](https://github.com/kontourai/station/pull/2604) feat(presence): per-surface focus reports for notification routing
- [#2576](https://github.com/kontourai/station/pull/2576) feat(agent-activity): use Station's mark for the status-bar icon (#2518)

**Fixes**

- [#2623](https://github.com/kontourai/station/pull/2623) fix(tests): redirect TMPDIR into the vitest run root so every temp dir is removed with the run
- [#2633](https://github.com/kontourai/station/pull/2633) fix(tests,agents): skills-root concurrent-create race and installer test budget
- [#2605](https://github.com/kontourai/station/pull/2605) fix(regions): close the phone layer's disclosed gaps — reload, scoped guards, same-tick Back, fold-open return
- [#2579](https://github.com/kontourai/station/pull/2579) fix(runtime): session reads across 13 route families decide with the request's principal, not the OS alias
- [#2617](https://github.com/kontourai/station/pull/2617) fix(ui): let a cookie session read its own Station's Projects; relay and native reads keep requiring the enrolled credential

**CI / workflow**

- [#2637](https://github.com/kontourai/station/pull/2637) ci: name the stalled typecheck lane and give hosted typecheck 4 slots
- [#2615](https://github.com/kontourai/station/pull/2615) ci: size the ci:fast budget to measured runs and fence every job that runs it
- [#2539](https://github.com/kontourai/station/pull/2539) ci(gallery): run the exact-pixel gallery diff on gallery-relevant PRs

**Other**

- [#2635](https://github.com/kontourai/station/pull/2635) test(relay): wait for admission, not the accept callback (#2557)
- [#2606](https://github.com/kontourai/station/pull/2606) test(authority): scope the no-refetch restore claim to A's shelf and force both Default orderings

## 2026-09-25T12:32:31Z · nightly-npm · 0.6.0-nightly.2459.36130497746

- Ship SHA: `73fd03ce808e7ece843fb81574cd7cc440251ab2`
- Artifact built at: `unknown` (no immutable artifact manifest binding)
- Artifact: npm:@kontourai/station-cli@0.6.0-nightly.2459.36130497746 (dist-tag nightly; artifactBuiltAt unknown)
- Note: artifactBuiltAt is null: npm package has no native artifact manifest

### Changelog

Commits since `bdc00df` ([full sha](https://github.com/kontourai/station/commit/bdc00df5187d5cdd96e662cc087b16cd8c991425)):

**Features**

- [#2641](https://github.com/kontourai/station/pull/2641) feat(notifications): tapping an agent-activity card opens the session it names (#2515)
- [#2566](https://github.com/kontourai/station/pull/2566) feat(connect): forget a shared saved Station from the app
- [#2616](https://github.com/kontourai/station/pull/2616) feat(notifications): envelope contracts and a trusted write path; refuse cross-source dedupe
- [#2602](https://github.com/kontourai/station/pull/2602) feat(notifications): iOS Live Activities through the push gateway (server + gateway)
- [#2603](https://github.com/kontourai/station/pull/2603) feat(approvals): separate approval mode from confinement; confine every start that could not grant full access (#2493, #2559, #2569)
- [#2604](https://github.com/kontourai/station/pull/2604) feat(presence): per-surface focus reports for notification routing
- [#2576](https://github.com/kontourai/station/pull/2576) feat(agent-activity): use Station's mark for the status-bar icon (#2518)

**Fixes**

- [#2623](https://github.com/kontourai/station/pull/2623) fix(tests): redirect TMPDIR into the vitest run root so every temp dir is removed with the run
- [#2633](https://github.com/kontourai/station/pull/2633) fix(tests,agents): skills-root concurrent-create race and installer test budget
- [#2605](https://github.com/kontourai/station/pull/2605) fix(regions): close the phone layer's disclosed gaps — reload, scoped guards, same-tick Back, fold-open return
- [#2579](https://github.com/kontourai/station/pull/2579) fix(runtime): session reads across 13 route families decide with the request's principal, not the OS alias
- [#2617](https://github.com/kontourai/station/pull/2617) fix(ui): let a cookie session read its own Station's Projects; relay and native reads keep requiring the enrolled credential

**CI / workflow**

- [#2637](https://github.com/kontourai/station/pull/2637) ci: name the stalled typecheck lane and give hosted typecheck 4 slots
- [#2615](https://github.com/kontourai/station/pull/2615) ci: size the ci:fast budget to measured runs and fence every job that runs it
- [#2539](https://github.com/kontourai/station/pull/2539) ci(gallery): run the exact-pixel gallery diff on gallery-relevant PRs

**Other**

- [#2635](https://github.com/kontourai/station/pull/2635) test(relay): wait for admission, not the accept callback (#2557)
- [#2606](https://github.com/kontourai/station/pull/2606) test(authority): scope the no-refetch restore claim to A's shelf and force both Default orderings

## 2026-09-25T05:50:30Z · nightly-desktop · 0.1.11-nightly.2459

- Ship SHA: `bdc00df5187d5cdd96e662cc087b16cd8c991425`
- Artifact built at: `2026-09-25T04:47:12.166Z` (not provider upload/record time)
- Artifact: github-release:nightly-desktop (cohort-finalized)
- Note: ios: TestFlight delivery success (run 36095097383)

### Changelog

Commits since `f18562c` ([full sha](https://github.com/kontourai/station/commit/f18562c4fc01edf17abdeaec88ff150ae80edf3e)):

**Features**

- [#2581](https://github.com/kontourai/station/pull/2581) feat(sessions): a turn outcome never ends its session; park idle engines (#2540 slice 4)
- [#2549](https://github.com/kontourai/station/pull/2549) feat(regions): on a phone, panes open over Chat and Back returns to it
- [#2545](https://github.com/kontourai/station/pull/2545) feat(muse): drive sessions through muse serve so approvals and subagents reach Station (#2452)
- [#2571](https://github.com/kontourai/station/pull/2571) feat(sessions): keep one live engine session per conversation (#2540 slices 2-3)
- [#2560](https://github.com/kontourai/station/pull/2560) feat(bench): measure conversation continuation per engine (#2540 slice 1)
- [#2558](https://github.com/kontourai/station/pull/2558) feat(codex): stop a Codex subagent, ending the parent turn that started it (#2486)

**Fixes**

- [#2564](https://github.com/kontourai/station/pull/2564) fix(chat): link host badges, slash-branch forge links, session-scoped path links and worktree preview titles
- [#2580](https://github.com/kontourai/station/pull/2580) fix(scripts): give each fallow audit a private temp directory so base checkouts stop filling the disk (#2529)
- [#2563](https://github.com/kontourai/station/pull/2563) fix(pull-requests): decide conversation and session reads with the request's principal, across the whole lineage
- [#2575](https://github.com/kontourai/station/pull/2575) fix(desktop): let saved-Station and pairing writes carry an unchanged unobserved credential
- [#2574](https://github.com/kontourai/station/pull/2574) fix(notifications): send the final empty card when a device loses read access
- [#2562](https://github.com/kontourai/station/pull/2562) fix(ui): preview Download as a toolbar icon; text previews fit their content
- [#2552](https://github.com/kontourai/station/pull/2552) fix(desktop,scripts): mobile relay grants stop re-locking profiles.json; gate skips build-output symlinks
- [#2505](https://github.com/kontourai/station/pull/2505) fix(ui): toast turn ends in background chats, and tool calls only on failure
- [#2544](https://github.com/kontourai/station/pull/2544) fix(desktop,cli): run saved-Station commands off the main thread; lock birth via the shared resolver

**CI / workflow**

- [#2573](https://github.com/kontourai/station/pull/2573) ci(android): run the agent-activity plugin's Kotlin tests

**Other**

- [#2595](https://github.com/kontourai/station/pull/2595) test(devices): order session A's exit after session B's record write in L-b

## 2026-09-25T05:50:26Z · nightly-android · 0.1.11-nightly.2459

- Ship SHA: `bdc00df5187d5cdd96e662cc087b16cd8c991425`
- Artifact built at: `2026-09-25T04:49:29.565Z` (not provider upload/record time)
- Artifact: play-internal-aab:cohort-finalized
- Note: ios: TestFlight delivery success (run 36095097383)

### Changelog

Commits since `f18562c` ([full sha](https://github.com/kontourai/station/commit/f18562c4fc01edf17abdeaec88ff150ae80edf3e)):

**Features**

- [#2581](https://github.com/kontourai/station/pull/2581) feat(sessions): a turn outcome never ends its session; park idle engines (#2540 slice 4)
- [#2549](https://github.com/kontourai/station/pull/2549) feat(regions): on a phone, panes open over Chat and Back returns to it
- [#2545](https://github.com/kontourai/station/pull/2545) feat(muse): drive sessions through muse serve so approvals and subagents reach Station (#2452)
- [#2571](https://github.com/kontourai/station/pull/2571) feat(sessions): keep one live engine session per conversation (#2540 slices 2-3)
- [#2560](https://github.com/kontourai/station/pull/2560) feat(bench): measure conversation continuation per engine (#2540 slice 1)
- [#2558](https://github.com/kontourai/station/pull/2558) feat(codex): stop a Codex subagent, ending the parent turn that started it (#2486)

**Fixes**

- [#2564](https://github.com/kontourai/station/pull/2564) fix(chat): link host badges, slash-branch forge links, session-scoped path links and worktree preview titles
- [#2580](https://github.com/kontourai/station/pull/2580) fix(scripts): give each fallow audit a private temp directory so base checkouts stop filling the disk (#2529)
- [#2563](https://github.com/kontourai/station/pull/2563) fix(pull-requests): decide conversation and session reads with the request's principal, across the whole lineage
- [#2575](https://github.com/kontourai/station/pull/2575) fix(desktop): let saved-Station and pairing writes carry an unchanged unobserved credential
- [#2574](https://github.com/kontourai/station/pull/2574) fix(notifications): send the final empty card when a device loses read access
- [#2562](https://github.com/kontourai/station/pull/2562) fix(ui): preview Download as a toolbar icon; text previews fit their content
- [#2552](https://github.com/kontourai/station/pull/2552) fix(desktop,scripts): mobile relay grants stop re-locking profiles.json; gate skips build-output symlinks
- [#2505](https://github.com/kontourai/station/pull/2505) fix(ui): toast turn ends in background chats, and tool calls only on failure
- [#2544](https://github.com/kontourai/station/pull/2544) fix(desktop,cli): run saved-Station commands off the main thread; lock birth via the shared resolver

**CI / workflow**

- [#2573](https://github.com/kontourai/station/pull/2573) ci(android): run the agent-activity plugin's Kotlin tests

**Other**

- [#2595](https://github.com/kontourai/station/pull/2595) test(devices): order session A's exit after session B's record write in L-b

## 2026-09-25T05:37:05Z · nightly-npm · 0.6.0-nightly.2459.36095097383

- Ship SHA: `bdc00df5187d5cdd96e662cc087b16cd8c991425`
- Artifact built at: `unknown` (no immutable artifact manifest binding)
- Artifact: npm:@kontourai/station-cli@0.6.0-nightly.2459.36095097383 (dist-tag nightly; artifactBuiltAt unknown)
- Note: artifactBuiltAt is null: npm package has no native artifact manifest

### Changelog

Commits since `f18562c` ([full sha](https://github.com/kontourai/station/commit/f18562c4fc01edf17abdeaec88ff150ae80edf3e)):

**Features**

- [#2581](https://github.com/kontourai/station/pull/2581) feat(sessions): a turn outcome never ends its session; park idle engines (#2540 slice 4)
- [#2549](https://github.com/kontourai/station/pull/2549) feat(regions): on a phone, panes open over Chat and Back returns to it
- [#2545](https://github.com/kontourai/station/pull/2545) feat(muse): drive sessions through muse serve so approvals and subagents reach Station (#2452)
- [#2571](https://github.com/kontourai/station/pull/2571) feat(sessions): keep one live engine session per conversation (#2540 slices 2-3)
- [#2560](https://github.com/kontourai/station/pull/2560) feat(bench): measure conversation continuation per engine (#2540 slice 1)
- [#2558](https://github.com/kontourai/station/pull/2558) feat(codex): stop a Codex subagent, ending the parent turn that started it (#2486)

**Fixes**

- [#2564](https://github.com/kontourai/station/pull/2564) fix(chat): link host badges, slash-branch forge links, session-scoped path links and worktree preview titles
- [#2580](https://github.com/kontourai/station/pull/2580) fix(scripts): give each fallow audit a private temp directory so base checkouts stop filling the disk (#2529)
- [#2563](https://github.com/kontourai/station/pull/2563) fix(pull-requests): decide conversation and session reads with the request's principal, across the whole lineage
- [#2575](https://github.com/kontourai/station/pull/2575) fix(desktop): let saved-Station and pairing writes carry an unchanged unobserved credential
- [#2574](https://github.com/kontourai/station/pull/2574) fix(notifications): send the final empty card when a device loses read access
- [#2562](https://github.com/kontourai/station/pull/2562) fix(ui): preview Download as a toolbar icon; text previews fit their content
- [#2552](https://github.com/kontourai/station/pull/2552) fix(desktop,scripts): mobile relay grants stop re-locking profiles.json; gate skips build-output symlinks
- [#2505](https://github.com/kontourai/station/pull/2505) fix(ui): toast turn ends in background chats, and tool calls only on failure
- [#2544](https://github.com/kontourai/station/pull/2544) fix(desktop,cli): run saved-Station commands off the main thread; lock birth via the shared resolver

**CI / workflow**

- [#2573](https://github.com/kontourai/station/pull/2573) ci(android): run the agent-activity plugin's Kotlin tests

**Other**

- [#2595](https://github.com/kontourai/station/pull/2595) test(devices): order session A's exit after session B's record write in L-b

## 2026-09-24T22:28:31Z · nightly-desktop · 0.1.11-nightly.2458.6

- Ship SHA: `f18562c4fc01edf17abdeaec88ff150ae80edf3e`
- Artifact built at: `2026-09-24T21:40:10.415Z` (not provider upload/record time)
- Artifact: github-release:nightly-desktop (cohort-finalized)
- Note: ios: TestFlight delivery success (run 36061294532)

### Changelog

Commits since `e390f5a` ([full sha](https://github.com/kontourai/station/commit/e390f5a83b50b2aa97e4287f43b4a5fc986697e8)):

**Features**

- [#2511](https://github.com/kontourai/station/pull/2511) feat(mobile): reopen last selected Station on launch
- [#2533](https://github.com/kontourai/station/pull/2533) feat(claude): report subagents on the child-work contract (#2457)

**Fixes**

- [#2550](https://github.com/kontourai/station/pull/2550) fix(server): stored attachments load on every device
- [#2554](https://github.com/kontourai/station/pull/2554) fix(ui): iOS and iPadOS draw attachment PDFs with pdf.js
- [#2538](https://github.com/kontourai/station/pull/2538) fix(test): remove test temp dirs in hooks and ratchet raw mkdtemp calls
- [#2551](https://github.com/kontourai/station/pull/2551) fix(cli,scripts): process identity follow-ups — fail-safe stop, lease upgrade window, missing tests
- [#2546](https://github.com/kontourai/station/pull/2546) fix(claude): stop spawning a CLI to validate every Claude start's model (#2482)

**Other**

- [#2547](https://github.com/kontourai/station/pull/2547) test(e2e): name the Project on coding calls, as the #2471 confinement requires

## 2026-09-24T22:28:28Z · nightly-android · 0.1.11-nightly.2458.6

- Ship SHA: `f18562c4fc01edf17abdeaec88ff150ae80edf3e`
- Artifact built at: `2026-09-24T21:37:49.290Z` (not provider upload/record time)
- Artifact: play-internal-aab:cohort-finalized
- Note: ios: TestFlight delivery success (run 36061294532)

### Changelog

Commits since `847ec8d` ([full sha](https://github.com/kontourai/station/commit/847ec8d05e6cea06d33706e8eb8bbd168f875bfb)):

**Features**

- [#2511](https://github.com/kontourai/station/pull/2511) feat(mobile): reopen last selected Station on launch
- [#2533](https://github.com/kontourai/station/pull/2533) feat(claude): report subagents on the child-work contract (#2457)
- [#2512](https://github.com/kontourai/station/pull/2512) feat: agent activity on the phone — Android Live Updates via a Station-signed push gateway
- [#2519](https://github.com/kontourai/station/pull/2519) feat(agents-pane): render child work for any engine, per chat and across conversations (#2459)
- [#2524](https://github.com/kontourai/station/pull/2524) feat(relay): add native proof client and Station key candidates
- [#2522](https://github.com/kontourai/station/pull/2522) feat(relay): proof-bound native signaling and renewal

**Fixes**

- [#2550](https://github.com/kontourai/station/pull/2550) fix(server): stored attachments load on every device
- [#2554](https://github.com/kontourai/station/pull/2554) fix(ui): iOS and iPadOS draw attachment PDFs with pdf.js
- [#2538](https://github.com/kontourai/station/pull/2538) fix(test): remove test temp dirs in hooks and ratchet raw mkdtemp calls
- [#2551](https://github.com/kontourai/station/pull/2551) fix(cli,scripts): process identity follow-ups — fail-safe stop, lease upgrade window, missing tests
- [#2546](https://github.com/kontourai/station/pull/2546) fix(claude): stop spawning a CLI to validate every Claude start's model (#2482)
- [#2532](https://github.com/kontourai/station/pull/2532) fix(desktop): open any https link the user clicks, not only GitHub issue URLs
- [#2288](https://github.com/kontourai/station/pull/2288) fix(delegation): surface supported provider quota failures
- [#2531](https://github.com/kontourai/station/pull/2531) fix(pull-requests,file-preview): reads without a pushed branch, umbrella projects, and worktree sessions preview their own files
- [#2508](https://github.com/kontourai/station/pull/2508) fix(chat): keep draft focusable during active continuation
- [#2528](https://github.com/kontourai/station/pull/2528) fix(release): make the packaged Android permission audit read real build output (#2473)
- [#2526](https://github.com/kontourai/station/pull/2526) fix(attachments): bind a bare turn.started reference only when this store wrote it (#2483)
- [#2471](https://github.com/kontourai/station/pull/2471) fix: server-ordered approval posture, coding exec grant and confinement, plugin publish export, typed SDK contexts (#2436 #2412 #2374 #2399 and 7 more)

**Other**

- [#2547](https://github.com/kontourai/station/pull/2547) test(e2e): name the Project on coding calls, as the #2471 confinement requires
- [#2536](https://github.com/kontourai/station/pull/2536) test(gallery): expect #2426's compact Station label and re-baseline

## 2026-09-24T22:24:13Z · nightly-npm · 0.6.0-nightly.2458.36061294532

- Ship SHA: `f18562c4fc01edf17abdeaec88ff150ae80edf3e`
- Artifact built at: `unknown` (no immutable artifact manifest binding)
- Artifact: npm:@kontourai/station-cli@0.6.0-nightly.2458.36061294532 (dist-tag nightly; artifactBuiltAt unknown)
- Note: artifactBuiltAt is null: npm package has no native artifact manifest

### Changelog

Commits since `e390f5a` ([full sha](https://github.com/kontourai/station/commit/e390f5a83b50b2aa97e4287f43b4a5fc986697e8)):

**Features**

- [#2511](https://github.com/kontourai/station/pull/2511) feat(mobile): reopen last selected Station on launch
- [#2533](https://github.com/kontourai/station/pull/2533) feat(claude): report subagents on the child-work contract (#2457)

**Fixes**

- [#2550](https://github.com/kontourai/station/pull/2550) fix(server): stored attachments load on every device
- [#2554](https://github.com/kontourai/station/pull/2554) fix(ui): iOS and iPadOS draw attachment PDFs with pdf.js
- [#2538](https://github.com/kontourai/station/pull/2538) fix(test): remove test temp dirs in hooks and ratchet raw mkdtemp calls
- [#2551](https://github.com/kontourai/station/pull/2551) fix(cli,scripts): process identity follow-ups — fail-safe stop, lease upgrade window, missing tests
- [#2546](https://github.com/kontourai/station/pull/2546) fix(claude): stop spawning a CLI to validate every Claude start's model (#2482)

**Other**

- [#2547](https://github.com/kontourai/station/pull/2547) test(e2e): name the Project on coding calls, as the #2471 confinement requires

## 2026-09-24T17:56:23Z · nightly-desktop · 0.1.11-nightly.2458.5

- Ship SHA: `e390f5a83b50b2aa97e4287f43b4a5fc986697e8`
- Artifact built at: `2026-09-24T17:08:03.868Z` (not provider upload/record time)
- Artifact: github-release:nightly-desktop (cohort-finalized)
- Note: ios: TestFlight delivery success (run 36031064921)
- Note: android: NOT_VERIFIED (android provider outcome unknown: unresolved:run:36031064921:play-upload-or-query (the provider effect may already be live))

### Changelog

Commits since `847ec8d` ([full sha](https://github.com/kontourai/station/commit/847ec8d05e6cea06d33706e8eb8bbd168f875bfb)):

**Features**

- [#2512](https://github.com/kontourai/station/pull/2512) feat: agent activity on the phone — Android Live Updates via a Station-signed push gateway
- [#2519](https://github.com/kontourai/station/pull/2519) feat(agents-pane): render child work for any engine, per chat and across conversations (#2459)
- [#2524](https://github.com/kontourai/station/pull/2524) feat(relay): add native proof client and Station key candidates
- [#2522](https://github.com/kontourai/station/pull/2522) feat(relay): proof-bound native signaling and renewal

**Fixes**

- [#2532](https://github.com/kontourai/station/pull/2532) fix(desktop): open any https link the user clicks, not only GitHub issue URLs
- [#2288](https://github.com/kontourai/station/pull/2288) fix(delegation): surface supported provider quota failures
- [#2531](https://github.com/kontourai/station/pull/2531) fix(pull-requests,file-preview): reads without a pushed branch, umbrella projects, and worktree sessions preview their own files
- [#2508](https://github.com/kontourai/station/pull/2508) fix(chat): keep draft focusable during active continuation
- [#2528](https://github.com/kontourai/station/pull/2528) fix(release): make the packaged Android permission audit read real build output (#2473)
- [#2526](https://github.com/kontourai/station/pull/2526) fix(attachments): bind a bare turn.started reference only when this store wrote it (#2483)
- [#2471](https://github.com/kontourai/station/pull/2471) fix: server-ordered approval posture, coding exec grant and confinement, plugin publish export, typed SDK contexts (#2436 #2412 #2374 #2399 and 7 more)

**Other**

- [#2536](https://github.com/kontourai/station/pull/2536) test(gallery): expect #2426's compact Station label and re-baseline

## 2026-09-24T17:49:08Z · nightly-npm · 0.6.0-nightly.2458.36031064921

- Ship SHA: `e390f5a83b50b2aa97e4287f43b4a5fc986697e8`
- Artifact built at: `unknown` (no immutable artifact manifest binding)
- Artifact: npm:@kontourai/station-cli@0.6.0-nightly.2458.36031064921 (dist-tag nightly; artifactBuiltAt unknown)
- Note: artifactBuiltAt is null: npm package has no native artifact manifest

### Changelog

Commits since `847ec8d` ([full sha](https://github.com/kontourai/station/commit/847ec8d05e6cea06d33706e8eb8bbd168f875bfb)):

**Features**

- [#2512](https://github.com/kontourai/station/pull/2512) feat: agent activity on the phone — Android Live Updates via a Station-signed push gateway
- [#2519](https://github.com/kontourai/station/pull/2519) feat(agents-pane): render child work for any engine, per chat and across conversations (#2459)
- [#2524](https://github.com/kontourai/station/pull/2524) feat(relay): add native proof client and Station key candidates
- [#2522](https://github.com/kontourai/station/pull/2522) feat(relay): proof-bound native signaling and renewal

**Fixes**

- [#2532](https://github.com/kontourai/station/pull/2532) fix(desktop): open any https link the user clicks, not only GitHub issue URLs
- [#2288](https://github.com/kontourai/station/pull/2288) fix(delegation): surface supported provider quota failures
- [#2531](https://github.com/kontourai/station/pull/2531) fix(pull-requests,file-preview): reads without a pushed branch, umbrella projects, and worktree sessions preview their own files
- [#2508](https://github.com/kontourai/station/pull/2508) fix(chat): keep draft focusable during active continuation
- [#2528](https://github.com/kontourai/station/pull/2528) fix(release): make the packaged Android permission audit read real build output (#2473)
- [#2526](https://github.com/kontourai/station/pull/2526) fix(attachments): bind a bare turn.started reference only when this store wrote it (#2483)
- [#2471](https://github.com/kontourai/station/pull/2471) fix: server-ordered approval posture, coding exec grant and confinement, plugin publish export, typed SDK contexts (#2436 #2412 #2374 #2399 and 7 more)

**Other**

- [#2536](https://github.com/kontourai/station/pull/2536) test(gallery): expect #2426's compact Station label and re-baseline

## 2026-09-24T12:31:36Z · nightly-desktop · 0.1.11-nightly.2458.4

- Ship SHA: `847ec8d05e6cea06d33706e8eb8bbd168f875bfb`
- Artifact built at: `2026-09-24T11:42:11.280Z` (not provider upload/record time)
- Artifact: github-release:nightly-desktop (cohort-finalized)
- Note: ios: TestFlight delivery success (run 35993578648)

### Changelog

Commits since `3ab9ce1` ([full sha](https://github.com/kontourai/station/commit/3ab9ce1ba0024c97ed5aa3c73461e3bea1a2758f)):

**Features**

- [#2502](https://github.com/kontourai/station/pull/2502) feat(relay): add gated native v2 signaling and custody
- [#2504](https://github.com/kontourai/station/pull/2504) feat(chat): persist and show images that tools return to the model
- [#2503](https://github.com/kontourai/station/pull/2503) feat(devices): device follow-ups: Tools drawer on SSH hosts, busy-host honesty, cleanup and pane placement (#2442, #2433, #2443, #2465)
- [#2500](https://github.com/kontourai/station/pull/2500) feat(ui): draw attachment PDFs with pdf.js where the engine has no viewer
- [#2498](https://github.com/kontourai/station/pull/2498) feat(codex): map Codex subagents onto the child-work contract (#2458)
- [#2477](https://github.com/kontourai/station/pull/2477) feat(ui): preview every chat attachment type and model-returned markdown images
- [#2467](https://github.com/kontourai/station/pull/2467) feat(devices): a live Device pane, device tools, SSH device hosts and device float over chat
- [#2478](https://github.com/kontourai/station/pull/2478) feat(child-work): provider-neutral child-work contract for subagents and delegates (#2456)
- [#2451](https://github.com/kontourai/station/pull/2451) feat(relay): onboard browsers through trusted encrypted Station routes

**Fixes**

- [#2491](https://github.com/kontourai/station/pull/2491) fix: turn-liveness follow-ups — Draft discard/aging, definitive concurrent-send refusals, no silent-turn kill, provider-triggered Claude turns
- [#2499](https://github.com/kontourai/station/pull/2499) fix: follow-ups from the browser and device batches (#2423, #2424, #2441)
- [#2489](https://github.com/kontourai/station/pull/2489) fix(desktop): keep relay grant custody responsive and pairing writes recoverable

**CI / workflow**

- [#2490](https://github.com/kontourai/station/pull/2490) ci(test): warn on real-time waits added to tests

**Other**

- [#2520](https://github.com/kontourai/station/pull/2520) test(devices): track the registry's own timers, not every Timeout in the process

## 2026-09-24T12:31:32Z · nightly-android · 0.1.11-nightly.2458.4

- Ship SHA: `847ec8d05e6cea06d33706e8eb8bbd168f875bfb`
- Artifact built at: `2026-09-24T11:42:32.676Z` (not provider upload/record time)
- Artifact: play-internal-aab:cohort-finalized
- Note: ios: TestFlight delivery success (run 35993578648)

### Changelog

Commits since `3ab9ce1` ([full sha](https://github.com/kontourai/station/commit/3ab9ce1ba0024c97ed5aa3c73461e3bea1a2758f)):

**Features**

- [#2502](https://github.com/kontourai/station/pull/2502) feat(relay): add gated native v2 signaling and custody
- [#2504](https://github.com/kontourai/station/pull/2504) feat(chat): persist and show images that tools return to the model
- [#2503](https://github.com/kontourai/station/pull/2503) feat(devices): device follow-ups: Tools drawer on SSH hosts, busy-host honesty, cleanup and pane placement (#2442, #2433, #2443, #2465)
- [#2500](https://github.com/kontourai/station/pull/2500) feat(ui): draw attachment PDFs with pdf.js where the engine has no viewer
- [#2498](https://github.com/kontourai/station/pull/2498) feat(codex): map Codex subagents onto the child-work contract (#2458)
- [#2477](https://github.com/kontourai/station/pull/2477) feat(ui): preview every chat attachment type and model-returned markdown images
- [#2467](https://github.com/kontourai/station/pull/2467) feat(devices): a live Device pane, device tools, SSH device hosts and device float over chat
- [#2478](https://github.com/kontourai/station/pull/2478) feat(child-work): provider-neutral child-work contract for subagents and delegates (#2456)
- [#2451](https://github.com/kontourai/station/pull/2451) feat(relay): onboard browsers through trusted encrypted Station routes

**Fixes**

- [#2491](https://github.com/kontourai/station/pull/2491) fix: turn-liveness follow-ups — Draft discard/aging, definitive concurrent-send refusals, no silent-turn kill, provider-triggered Claude turns
- [#2499](https://github.com/kontourai/station/pull/2499) fix: follow-ups from the browser and device batches (#2423, #2424, #2441)
- [#2489](https://github.com/kontourai/station/pull/2489) fix(desktop): keep relay grant custody responsive and pairing writes recoverable

**CI / workflow**

- [#2490](https://github.com/kontourai/station/pull/2490) ci(test): warn on real-time waits added to tests

**Other**

- [#2520](https://github.com/kontourai/station/pull/2520) test(devices): track the registry's own timers, not every Timeout in the process

## 2026-09-24T12:27:21Z · nightly-npm · 0.6.0-nightly.2458.35993578648

- Ship SHA: `847ec8d05e6cea06d33706e8eb8bbd168f875bfb`
- Artifact built at: `unknown` (no immutable artifact manifest binding)
- Artifact: npm:@kontourai/station-cli@0.6.0-nightly.2458.35993578648 (dist-tag nightly; artifactBuiltAt unknown)
- Note: artifactBuiltAt is null: npm package has no native artifact manifest

### Changelog

Commits since `3ab9ce1` ([full sha](https://github.com/kontourai/station/commit/3ab9ce1ba0024c97ed5aa3c73461e3bea1a2758f)):

**Features**

- [#2502](https://github.com/kontourai/station/pull/2502) feat(relay): add gated native v2 signaling and custody
- [#2504](https://github.com/kontourai/station/pull/2504) feat(chat): persist and show images that tools return to the model
- [#2503](https://github.com/kontourai/station/pull/2503) feat(devices): device follow-ups: Tools drawer on SSH hosts, busy-host honesty, cleanup and pane placement (#2442, #2433, #2443, #2465)
- [#2500](https://github.com/kontourai/station/pull/2500) feat(ui): draw attachment PDFs with pdf.js where the engine has no viewer
- [#2498](https://github.com/kontourai/station/pull/2498) feat(codex): map Codex subagents onto the child-work contract (#2458)
- [#2477](https://github.com/kontourai/station/pull/2477) feat(ui): preview every chat attachment type and model-returned markdown images
- [#2467](https://github.com/kontourai/station/pull/2467) feat(devices): a live Device pane, device tools, SSH device hosts and device float over chat
- [#2478](https://github.com/kontourai/station/pull/2478) feat(child-work): provider-neutral child-work contract for subagents and delegates (#2456)
- [#2451](https://github.com/kontourai/station/pull/2451) feat(relay): onboard browsers through trusted encrypted Station routes

**Fixes**

- [#2491](https://github.com/kontourai/station/pull/2491) fix: turn-liveness follow-ups — Draft discard/aging, definitive concurrent-send refusals, no silent-turn kill, provider-triggered Claude turns
- [#2499](https://github.com/kontourai/station/pull/2499) fix: follow-ups from the browser and device batches (#2423, #2424, #2441)
- [#2489](https://github.com/kontourai/station/pull/2489) fix(desktop): keep relay grant custody responsive and pairing writes recoverable

**CI / workflow**

- [#2490](https://github.com/kontourai/station/pull/2490) ci(test): warn on real-time waits added to tests

**Other**

- [#2520](https://github.com/kontourai/station/pull/2520) test(devices): track the registry's own timers, not every Timeout in the process

## 2026-09-24T05:19:34Z · nightly-desktop · 0.1.11-nightly.2458.3

- Ship SHA: `3ab9ce1ba0024c97ed5aa3c73461e3bea1a2758f`
- Artifact built at: `2026-09-24T04:34:45.607Z` (not provider upload/record time)
- Artifact: github-release:nightly-desktop (cohort-finalized)
- Note: ios: TestFlight delivery success (run 35955520672)

### Changelog

Commits since `7bc3cc6` ([full sha](https://github.com/kontourai/station/commit/7bc3cc6dfb7947f68ab7c4884b189e71101e7061)):

**Fixes**

- [#2479](https://github.com/kontourai/station/pull/2479) fix(pull-requests,chat): the PR review loads on a two-remote checkout, and chat links become chips
- [#2472](https://github.com/kontourai/station/pull/2472) fix(profiles): bound every saved Station lock wait by wall clock
- [#2468](https://github.com/kontourai/station/pull/2468) fix(search): name the cause of a refused message read in the server log
- [#2449](https://github.com/kontourai/station/pull/2449) fix: plugin-workbench follow-ups: approval pick truth, untrusted plugin trees, pane honesty, examples typecheck, hardened git (#2334 #2342 #2343 #2344 #2345 #2348 #2363)

## 2026-09-24T05:19:31Z · nightly-android · 0.1.11-nightly.2458.3

- Ship SHA: `3ab9ce1ba0024c97ed5aa3c73461e3bea1a2758f`
- Artifact built at: `2026-09-24T04:34:31.219Z` (not provider upload/record time)
- Artifact: play-internal-aab:cohort-finalized
- Note: ios: TestFlight delivery success (run 35955520672)

### Changelog

Commits since `7bc3cc6` ([full sha](https://github.com/kontourai/station/commit/7bc3cc6dfb7947f68ab7c4884b189e71101e7061)):

**Fixes**

- [#2479](https://github.com/kontourai/station/pull/2479) fix(pull-requests,chat): the PR review loads on a two-remote checkout, and chat links become chips
- [#2472](https://github.com/kontourai/station/pull/2472) fix(profiles): bound every saved Station lock wait by wall clock
- [#2468](https://github.com/kontourai/station/pull/2468) fix(search): name the cause of a refused message read in the server log
- [#2449](https://github.com/kontourai/station/pull/2449) fix: plugin-workbench follow-ups: approval pick truth, untrusted plugin trees, pane honesty, examples typecheck, hardened git (#2334 #2342 #2343 #2344 #2345 #2348 #2363)

## 2026-09-24T05:16:07Z · nightly-npm · 0.6.0-nightly.2458.35955520672

- Ship SHA: `3ab9ce1ba0024c97ed5aa3c73461e3bea1a2758f`
- Artifact built at: `unknown` (no immutable artifact manifest binding)
- Artifact: npm:@kontourai/station-cli@0.6.0-nightly.2458.35955520672 (dist-tag nightly; artifactBuiltAt unknown)
- Note: artifactBuiltAt is null: npm package has no native artifact manifest

### Changelog

Commits since `7bc3cc6` ([full sha](https://github.com/kontourai/station/commit/7bc3cc6dfb7947f68ab7c4884b189e71101e7061)):

**Fixes**

- [#2479](https://github.com/kontourai/station/pull/2479) fix(pull-requests,chat): the PR review loads on a two-remote checkout, and chat links become chips
- [#2472](https://github.com/kontourai/station/pull/2472) fix(profiles): bound every saved Station lock wait by wall clock
- [#2468](https://github.com/kontourai/station/pull/2468) fix(search): name the cause of a refused message read in the server log
- [#2449](https://github.com/kontourai/station/pull/2449) fix: plugin-workbench follow-ups: approval pick truth, untrusted plugin trees, pane honesty, examples typecheck, hardened git (#2334 #2342 #2343 #2344 #2345 #2348 #2363)

## 2026-09-24T03:22:42Z · nightly-desktop · 0.1.11-nightly.2458.2

- Ship SHA: `7bc3cc6dfb7947f68ab7c4884b189e71101e7061`
- Artifact built at: `2026-09-24T02:40:17.047Z` (not provider upload/record time)
- Artifact: github-release:nightly-desktop (cohort-finalized)
- Note: ios: TestFlight delivery success (run 35945178538)

### Changelog

Commits since `1bfdde4` ([full sha](https://github.com/kontourai/station/commit/1bfdde4c7935155996e685e582cff9c5a0551c6e)):

**Other**

- [#2466](https://github.com/kontourai/station/pull/2466) test(browser): drive the control lease clock by hand in hold tests
- [#2454](https://github.com/kontourai/station/pull/2454) perf(windows): skip ACL setter for freshly verified paths

## 2026-09-24T03:22:39Z · nightly-android · 0.1.11-nightly.2458.2

- Ship SHA: `7bc3cc6dfb7947f68ab7c4884b189e71101e7061`
- Artifact built at: `2026-09-24T02:40:10.399Z` (not provider upload/record time)
- Artifact: play-internal-aab:cohort-finalized
- Note: ios: TestFlight delivery success (run 35945178538)

### Changelog

Commits since `1bfdde4` ([full sha](https://github.com/kontourai/station/commit/1bfdde4c7935155996e685e582cff9c5a0551c6e)):

**Other**

- [#2466](https://github.com/kontourai/station/pull/2466) test(browser): drive the control lease clock by hand in hold tests
- [#2454](https://github.com/kontourai/station/pull/2454) perf(windows): skip ACL setter for freshly verified paths

## 2026-09-24T03:16:24Z · nightly-npm · 0.6.0-nightly.2458.35945178538

- Ship SHA: `7bc3cc6dfb7947f68ab7c4884b189e71101e7061`
- Artifact built at: `unknown` (no immutable artifact manifest binding)
- Artifact: npm:@kontourai/station-cli@0.6.0-nightly.2458.35945178538 (dist-tag nightly; artifactBuiltAt unknown)
- Note: artifactBuiltAt is null: npm package has no native artifact manifest

### Changelog

Commits since `1bfdde4` ([full sha](https://github.com/kontourai/station/commit/1bfdde4c7935155996e685e582cff9c5a0551c6e)):

**Other**

- [#2466](https://github.com/kontourai/station/pull/2466) test(browser): drive the control lease clock by hand in hold tests
- [#2454](https://github.com/kontourai/station/pull/2454) perf(windows): skip ACL setter for freshly verified paths

## 2026-09-24T02:27:24Z · nightly-desktop · 0.1.11-nightly.2458.1

- Ship SHA: `1bfdde4c7935155996e685e582cff9c5a0551c6e`
- Artifact built at: `2026-09-24T01:40:05.976Z` (not provider upload/record time)
- Artifact: github-release:nightly-desktop (cohort-finalized)
- Note: ios: TestFlight delivery success (run 35941621675)

### Changelog

Commits since `ac819b5` ([full sha](https://github.com/kontourai/station/commit/ac819b5ab35b7bc449a0501c4691a61935cbfc76)):

**Features**

- [#2382](https://github.com/kontourai/station/pull/2382) feat: enforce evidence for recurring session and background-work bugs
- [#2444](https://github.com/kontourai/station/pull/2444) feat(browser): a Browser pane Station and its agents can drive
- [#2341](https://github.com/kontourai/station/pull/2341) feat: server-authoritative turn activity, end to end (#2309 Phase A + B)
- [#2447](https://github.com/kontourai/station/pull/2447) feat(relay): enroll independently revocable broker routing grants
- [#2408](https://github.com/kontourai/station/pull/2408) feat(connections): save broker routes without direct fallback

**Fixes**

- [#2462](https://github.com/kontourai/station/pull/2462) fix(ci): fix two intermittent Nightly failures at their cause
- [#2453](https://github.com/kontourai/station/pull/2453) fix(muse): run headless exec with --approval-mode never so escalated approvals cannot hang a turn
- [#2450](https://github.com/kontourai/station/pull/2450) fix(nightly): read signed media entitlements as plist
- [#2448](https://github.com/kontourai/station/pull/2448) fix(chat): give the orchestration event stream the current authority's QueryClient (#2307)
- [#2445](https://github.com/kontourai/station/pull/2445) fix(ci): give broad-graph SDK modules explicit impact boundaries (#2326)
- [#2434](https://github.com/kontourai/station/pull/2434) fix(native): preserve media permissions and Android backup policy
- [#2446](https://github.com/kontourai/station/pull/2446) fix: publish lab relay readiness atomically; scope the authority-isolation key check (#2440)
- [#2431](https://github.com/kontourai/station/pull/2431) fix(chat): a turn running in a lineage child reseeds its conversation chat on reconnect (#2303)
- [#2437](https://github.com/kontourai/station/pull/2437) fix(muse): hold the turn open while muse background work runs, and deliver its follow-up on the same turn (#2300)
- [#2438](https://github.com/kontourai/station/pull/2438) fix(nightly): wait out npm registry read lag before binding the CLI receipt
- [#2426](https://github.com/kontourai/station/pull/2426) fix(ui): show the active Station in compact connection chrome
- [#2429](https://github.com/kontourai/station/pull/2429) fix(plugins): load shared modules in strict-mode plugin bundles
- [#2378](https://github.com/kontourai/station/pull/2378) fix(chat): state a turn's working duration only from its known start; keep an open turn's prompt above its activity (#2304)

**CI / workflow**

- [#2422](https://github.com/kontourai/station/pull/2422) ci: disable account-dependent checks in CI until #2318

**Other**

- [#2432](https://github.com/kontourai/station/pull/2432) test(e2e): model the authority observation in the shared shell fixture
- [#2430](https://github.com/kontourai/station/pull/2430) test(gallery): re-baseline plugins for the New plugin action (#2375)

## 2026-09-24T02:27:21Z · nightly-android · 0.1.11-nightly.2458.1

- Ship SHA: `1bfdde4c7935155996e685e582cff9c5a0551c6e`
- Artifact built at: `2026-09-24T01:40:10.068Z` (not provider upload/record time)
- Artifact: play-internal-aab:cohort-finalized
- Note: ios: TestFlight delivery success (run 35941621675)

### Changelog

Commits since `ac819b5` ([full sha](https://github.com/kontourai/station/commit/ac819b5ab35b7bc449a0501c4691a61935cbfc76)):

**Features**

- [#2382](https://github.com/kontourai/station/pull/2382) feat: enforce evidence for recurring session and background-work bugs
- [#2444](https://github.com/kontourai/station/pull/2444) feat(browser): a Browser pane Station and its agents can drive
- [#2341](https://github.com/kontourai/station/pull/2341) feat: server-authoritative turn activity, end to end (#2309 Phase A + B)
- [#2447](https://github.com/kontourai/station/pull/2447) feat(relay): enroll independently revocable broker routing grants
- [#2408](https://github.com/kontourai/station/pull/2408) feat(connections): save broker routes without direct fallback

**Fixes**

- [#2462](https://github.com/kontourai/station/pull/2462) fix(ci): fix two intermittent Nightly failures at their cause
- [#2453](https://github.com/kontourai/station/pull/2453) fix(muse): run headless exec with --approval-mode never so escalated approvals cannot hang a turn
- [#2450](https://github.com/kontourai/station/pull/2450) fix(nightly): read signed media entitlements as plist
- [#2448](https://github.com/kontourai/station/pull/2448) fix(chat): give the orchestration event stream the current authority's QueryClient (#2307)
- [#2445](https://github.com/kontourai/station/pull/2445) fix(ci): give broad-graph SDK modules explicit impact boundaries (#2326)
- [#2434](https://github.com/kontourai/station/pull/2434) fix(native): preserve media permissions and Android backup policy
- [#2446](https://github.com/kontourai/station/pull/2446) fix: publish lab relay readiness atomically; scope the authority-isolation key check (#2440)
- [#2431](https://github.com/kontourai/station/pull/2431) fix(chat): a turn running in a lineage child reseeds its conversation chat on reconnect (#2303)
- [#2437](https://github.com/kontourai/station/pull/2437) fix(muse): hold the turn open while muse background work runs, and deliver its follow-up on the same turn (#2300)
- [#2438](https://github.com/kontourai/station/pull/2438) fix(nightly): wait out npm registry read lag before binding the CLI receipt
- [#2426](https://github.com/kontourai/station/pull/2426) fix(ui): show the active Station in compact connection chrome
- [#2429](https://github.com/kontourai/station/pull/2429) fix(plugins): load shared modules in strict-mode plugin bundles
- [#2378](https://github.com/kontourai/station/pull/2378) fix(chat): state a turn's working duration only from its known start; keep an open turn's prompt above its activity (#2304)

**CI / workflow**

- [#2422](https://github.com/kontourai/station/pull/2422) ci: disable account-dependent checks in CI until #2318

**Other**

- [#2432](https://github.com/kontourai/station/pull/2432) test(e2e): model the authority observation in the shared shell fixture
- [#2430](https://github.com/kontourai/station/pull/2430) test(gallery): re-baseline plugins for the New plugin action (#2375)

## 2026-09-24T02:23:57Z · nightly-npm · 0.6.0-nightly.2458.35941621675

- Ship SHA: `1bfdde4c7935155996e685e582cff9c5a0551c6e`
- Artifact built at: `unknown` (no immutable artifact manifest binding)
- Artifact: npm:@kontourai/station-cli@0.6.0-nightly.2458.35941621675 (dist-tag nightly; artifactBuiltAt unknown)
- Note: artifactBuiltAt is null: npm package has no native artifact manifest

### Changelog

Commits since `0015690` ([full sha](https://github.com/kontourai/station/commit/0015690b78f76eb2b397a08e6ec86ee755678b9b)):

**Features**

- [#2382](https://github.com/kontourai/station/pull/2382) feat: enforce evidence for recurring session and background-work bugs
- [#2444](https://github.com/kontourai/station/pull/2444) feat(browser): a Browser pane Station and its agents can drive
- [#2341](https://github.com/kontourai/station/pull/2341) feat: server-authoritative turn activity, end to end (#2309 Phase A + B)
- [#2447](https://github.com/kontourai/station/pull/2447) feat(relay): enroll independently revocable broker routing grants
- [#2408](https://github.com/kontourai/station/pull/2408) feat(connections): save broker routes without direct fallback
- [#2413](https://github.com/kontourai/station/pull/2413) feat(relay): adopt cookie-paired Devices onto encrypted broker routes
- [#2394](https://github.com/kontourai/station/pull/2394) feat(relay): enroll fresh clients over encrypted application channel
- [#2358](https://github.com/kontourai/station/pull/2358) feat(station-control): verified caller identity and custody-bound child ownership
- [#2384](https://github.com/kontourai/station/pull/2384) feat(relay): add private enrollment recovery foundation (#2274)
- [#2371](https://github.com/kontourai/station/pull/2371) feat(identity): add provider-owned pending enrollment sessions
- [#2375](https://github.com/kontourai/station/pull/2375) feat(plugins): plugin workbench — authoring, scaffold, draft preview, local redeploy, proposals (#2323 S1–S5, #2316, #2319)
- [#2360](https://github.com/kontourai/station/pull/2360) feat(relay): report self-hosted broker lifecycle status
- [#2349](https://github.com/kontourai/station/pull/2349) feat(live-surface): host-neutral live surface primitive for the Browser pane
- [#2346](https://github.com/kontourai/station/pull/2346) feat(browser): server Chromium host for the Browser pane

**Fixes**

- [#2462](https://github.com/kontourai/station/pull/2462) fix(ci): fix two intermittent Nightly failures at their cause
- [#2453](https://github.com/kontourai/station/pull/2453) fix(muse): run headless exec with --approval-mode never so escalated approvals cannot hang a turn
- [#2450](https://github.com/kontourai/station/pull/2450) fix(nightly): read signed media entitlements as plist
- [#2448](https://github.com/kontourai/station/pull/2448) fix(chat): give the orchestration event stream the current authority's QueryClient (#2307)
- [#2445](https://github.com/kontourai/station/pull/2445) fix(ci): give broad-graph SDK modules explicit impact boundaries (#2326)
- [#2434](https://github.com/kontourai/station/pull/2434) fix(native): preserve media permissions and Android backup policy
- [#2446](https://github.com/kontourai/station/pull/2446) fix: publish lab relay readiness atomically; scope the authority-isolation key check (#2440)
- [#2431](https://github.com/kontourai/station/pull/2431) fix(chat): a turn running in a lineage child reseeds its conversation chat on reconnect (#2303)
- [#2437](https://github.com/kontourai/station/pull/2437) fix(muse): hold the turn open while muse background work runs, and deliver its follow-up on the same turn (#2300)
- [#2438](https://github.com/kontourai/station/pull/2438) fix(nightly): wait out npm registry read lag before binding the CLI receipt
- [#2426](https://github.com/kontourai/station/pull/2426) fix(ui): show the active Station in compact connection chrome
- [#2429](https://github.com/kontourai/station/pull/2429) fix(plugins): load shared modules in strict-mode plugin bundles
- [#2378](https://github.com/kontourai/station/pull/2378) fix(chat): state a turn's working duration only from its known start; keep an open turn's prompt above its activity (#2304)
- [#2420](https://github.com/kontourai/station/pull/2420) fix(pairing): admit desktop local grants to host pairing routes
- [#2311](https://github.com/kontourai/station/pull/2311) fix(orchestration): re-arm the chat event stream after any abort, stall or auth stop (#2301)
- [#2405](https://github.com/kontourai/station/pull/2405) fix(desktop): release a cancelled native read's slot while its call is blocked
- [#2397](https://github.com/kontourai/station/pull/2397) fix(cli): report a slow readiness identity check as degraded, not unavailable
- [#2387](https://github.com/kontourai/station/pull/2387) fix(relay): recover optional broker registration after startup outages
- [#2390](https://github.com/kontourai/station/pull/2390) fix(ci,ui): restore queue gate inventory and surface contrast
- [#2367](https://github.com/kontourai/station/pull/2367) fix(transfer-gate): reuse exact baselines and prune stale ones on --prepare-baseline
- [#2361](https://github.com/kontourai/station/pull/2361) fix(connect): show a queued Station as busy and let the health probe skip the queue
- [#2366](https://github.com/kontourai/station/pull/2366) fix(pairing): revalidate account session at exchange (#2274)
- [#2353](https://github.com/kontourai/station/pull/2353) fix(relay): recover transient broker control and offer reads
- [#2372](https://github.com/kontourai/station/pull/2372) fix: clear three main reds caught by the shadow merge-queue regression gate
- [#2369](https://github.com/kontourai/station/pull/2369) fix(deps): give install-time probes a cold-start allowance and silent-timeout retry
- [#2352](https://github.com/kontourai/station/pull/2352) fix(pairing): enforce issued session scope subset
- [#2340](https://github.com/kontourai/station/pull/2340) fix(windows): cut cold process starts behind the Windows PR floor timeouts
- [#2338](https://github.com/kontourai/station/pull/2338) fix(inbox): never-prompted sessions are Drafts, not Active now; failed first sends read Failed
- [#2339](https://github.com/kontourai/station/pull/2339) fix(security): require a Station origin for browser WebSocket upgrades on loopback
- [#2335](https://github.com/kontourai/station/pull/2335) fix(plugins): authoring papercuts: truthful install preview, broken examples, docs install claims (#2321)
- [#2320](https://github.com/kontourai/station/pull/2320) fix(ci): give the SDK transport an explicit impact boundary so fast-checks can complete
- [#2331](https://github.com/kontourai/station/pull/2331) fix(server): keep a live desktop's server running when the supervisor probe fails
- [#2329](https://github.com/kontourai/station/pull/2329) fix(gallery): isolate persisted query cache per screen and re-baseline from the pinned renderer
- [#2328](https://github.com/kontourai/station/pull/2328) fix(muse): show running tool calls and stop ending live turns on a Station-chosen schedule
- [#2325](https://github.com/kontourai/station/pull/2325) fix(ci-extended): stable Linux process birth, lean MCP apps, perf provisioning races

**CI / workflow**

- [#2422](https://github.com/kontourai/station/pull/2422) ci: disable account-dependent checks in CI until #2318
- [#2381](https://github.com/kontourai/station/pull/2381) ci(actions): follow callees and allowlist cache actions in untrusted workflows
- [#2380](https://github.com/kontourai/station/pull/2380) ci(coverage): shard the coverage lane through the resource-profiled corpus
- [#2370](https://github.com/kontourai/station/pull/2370) ci: harden the merge-queue gate and add a test quarantine
- [#2368](https://github.com/kontourai/station/pull/2368) ci(security): guard product code against importing CodeQL-ignored test paths
- [#2364](https://github.com/kontourai/station/pull/2364) ci(ios): restore-only Rust cache for the iOS verification build
- [#2322](https://github.com/kontourai/station/pull/2322) ci: add shadow merge-queue regression gate
- [#2330](https://github.com/kontourai/station/pull/2330) ci: cut duplicate work from the PR and merge-queue critical path
- [#2314](https://github.com/kontourai/station/pull/2314) ci: remove duplicated and never-green workflow runs

**Docs**

- [#2393](https://github.com/kontourai/station/pull/2393) docs: list Merge-queue regression as a required check
- [#2359](https://github.com/kontourai/station/pull/2359) docs(adr): host the Browser pane server-side behind a host adapter

**Other**

- [#2432](https://github.com/kontourai/station/pull/2432) test(e2e): model the authority observation in the shared shell fixture
- [#2430](https://github.com/kontourai/station/pull/2430) test(gallery): re-baseline plugins for the New plugin action (#2375)
- [#2417](https://github.com/kontourai/station/pull/2417) test(perf-bridge): settle first run before provisioning browses
- [#2392](https://github.com/kontourai/station/pull/2392) test(relay): prove optional broker startup at the real entrypoint
- [#2379](https://github.com/kontourai/station/pull/2379) test(cli): pin reconciler deadline outcomes with a controlled clock
- [#2362](https://github.com/kontourai/station/pull/2362) test(connections): isolate enrolment integration environment (#2131)
- [#2354](https://github.com/kontourai/station/pull/2354) test: qualify packaged runtime listener ownership (#2016)
- [#2336](https://github.com/kontourai/station/pull/2336) perf(typecheck): host-wide tsc slots and incremental compiles
- [#2317](https://github.com/kontourai/station/pull/2317) test(android): reach mobile Settings through the drawer footer

## 2026-09-23T17:38:49Z · nightly-desktop · 0.1.11-nightly.2457.2

- Ship SHA: `ac819b5ab35b7bc449a0501c4691a61935cbfc76`
- Artifact built at: `2026-09-23T16:49:19.602Z` (not provider upload/record time)
- Artifact: github-release:nightly-desktop (cohort-finalized)
- Note: ios: TestFlight delivery success (run 35890429058)

### Changelog

Commits since `0015690` ([full sha](https://github.com/kontourai/station/commit/0015690b78f76eb2b397a08e6ec86ee755678b9b)):

**Features**

- [#2413](https://github.com/kontourai/station/pull/2413) feat(relay): adopt cookie-paired Devices onto encrypted broker routes
- [#2394](https://github.com/kontourai/station/pull/2394) feat(relay): enroll fresh clients over encrypted application channel
- [#2358](https://github.com/kontourai/station/pull/2358) feat(station-control): verified caller identity and custody-bound child ownership
- [#2384](https://github.com/kontourai/station/pull/2384) feat(relay): add private enrollment recovery foundation (#2274)
- [#2371](https://github.com/kontourai/station/pull/2371) feat(identity): add provider-owned pending enrollment sessions
- [#2375](https://github.com/kontourai/station/pull/2375) feat(plugins): plugin workbench — authoring, scaffold, draft preview, local redeploy, proposals (#2323 S1–S5, #2316, #2319)
- [#2360](https://github.com/kontourai/station/pull/2360) feat(relay): report self-hosted broker lifecycle status
- [#2349](https://github.com/kontourai/station/pull/2349) feat(live-surface): host-neutral live surface primitive for the Browser pane
- [#2346](https://github.com/kontourai/station/pull/2346) feat(browser): server Chromium host for the Browser pane

**Fixes**

- [#2420](https://github.com/kontourai/station/pull/2420) fix(pairing): admit desktop local grants to host pairing routes
- [#2311](https://github.com/kontourai/station/pull/2311) fix(orchestration): re-arm the chat event stream after any abort, stall or auth stop (#2301)
- [#2405](https://github.com/kontourai/station/pull/2405) fix(desktop): release a cancelled native read's slot while its call is blocked
- [#2397](https://github.com/kontourai/station/pull/2397) fix(cli): report a slow readiness identity check as degraded, not unavailable
- [#2387](https://github.com/kontourai/station/pull/2387) fix(relay): recover optional broker registration after startup outages
- [#2390](https://github.com/kontourai/station/pull/2390) fix(ci,ui): restore queue gate inventory and surface contrast
- [#2367](https://github.com/kontourai/station/pull/2367) fix(transfer-gate): reuse exact baselines and prune stale ones on --prepare-baseline
- [#2361](https://github.com/kontourai/station/pull/2361) fix(connect): show a queued Station as busy and let the health probe skip the queue
- [#2366](https://github.com/kontourai/station/pull/2366) fix(pairing): revalidate account session at exchange (#2274)
- [#2353](https://github.com/kontourai/station/pull/2353) fix(relay): recover transient broker control and offer reads
- [#2372](https://github.com/kontourai/station/pull/2372) fix: clear three main reds caught by the shadow merge-queue regression gate
- [#2369](https://github.com/kontourai/station/pull/2369) fix(deps): give install-time probes a cold-start allowance and silent-timeout retry
- [#2352](https://github.com/kontourai/station/pull/2352) fix(pairing): enforce issued session scope subset
- [#2340](https://github.com/kontourai/station/pull/2340) fix(windows): cut cold process starts behind the Windows PR floor timeouts
- [#2338](https://github.com/kontourai/station/pull/2338) fix(inbox): never-prompted sessions are Drafts, not Active now; failed first sends read Failed
- [#2339](https://github.com/kontourai/station/pull/2339) fix(security): require a Station origin for browser WebSocket upgrades on loopback
- [#2335](https://github.com/kontourai/station/pull/2335) fix(plugins): authoring papercuts: truthful install preview, broken examples, docs install claims (#2321)
- [#2320](https://github.com/kontourai/station/pull/2320) fix(ci): give the SDK transport an explicit impact boundary so fast-checks can complete
- [#2331](https://github.com/kontourai/station/pull/2331) fix(server): keep a live desktop's server running when the supervisor probe fails
- [#2329](https://github.com/kontourai/station/pull/2329) fix(gallery): isolate persisted query cache per screen and re-baseline from the pinned renderer
- [#2328](https://github.com/kontourai/station/pull/2328) fix(muse): show running tool calls and stop ending live turns on a Station-chosen schedule
- [#2325](https://github.com/kontourai/station/pull/2325) fix(ci-extended): stable Linux process birth, lean MCP apps, perf provisioning races

**CI / workflow**

- [#2381](https://github.com/kontourai/station/pull/2381) ci(actions): follow callees and allowlist cache actions in untrusted workflows
- [#2380](https://github.com/kontourai/station/pull/2380) ci(coverage): shard the coverage lane through the resource-profiled corpus
- [#2370](https://github.com/kontourai/station/pull/2370) ci: harden the merge-queue gate and add a test quarantine
- [#2368](https://github.com/kontourai/station/pull/2368) ci(security): guard product code against importing CodeQL-ignored test paths
- [#2364](https://github.com/kontourai/station/pull/2364) ci(ios): restore-only Rust cache for the iOS verification build
- [#2322](https://github.com/kontourai/station/pull/2322) ci: add shadow merge-queue regression gate
- [#2330](https://github.com/kontourai/station/pull/2330) ci: cut duplicate work from the PR and merge-queue critical path
- [#2314](https://github.com/kontourai/station/pull/2314) ci: remove duplicated and never-green workflow runs

**Docs**

- [#2393](https://github.com/kontourai/station/pull/2393) docs: list Merge-queue regression as a required check
- [#2359](https://github.com/kontourai/station/pull/2359) docs(adr): host the Browser pane server-side behind a host adapter

**Other**

- [#2417](https://github.com/kontourai/station/pull/2417) test(perf-bridge): settle first run before provisioning browses
- [#2392](https://github.com/kontourai/station/pull/2392) test(relay): prove optional broker startup at the real entrypoint
- [#2379](https://github.com/kontourai/station/pull/2379) test(cli): pin reconciler deadline outcomes with a controlled clock
- [#2362](https://github.com/kontourai/station/pull/2362) test(connections): isolate enrolment integration environment (#2131)
- [#2354](https://github.com/kontourai/station/pull/2354) test: qualify packaged runtime listener ownership (#2016)
- [#2336](https://github.com/kontourai/station/pull/2336) perf(typecheck): host-wide tsc slots and incremental compiles
- [#2317](https://github.com/kontourai/station/pull/2317) test(android): reach mobile Settings through the drawer footer

## 2026-09-23T17:38:45Z · nightly-android · 0.1.11-nightly.2457.2

- Ship SHA: `ac819b5ab35b7bc449a0501c4691a61935cbfc76`
- Artifact built at: `2026-09-23T16:50:06.332Z` (not provider upload/record time)
- Artifact: play-internal-aab:cohort-finalized
- Note: ios: TestFlight delivery success (run 35890429058)

### Changelog

Commits since `0015690` ([full sha](https://github.com/kontourai/station/commit/0015690b78f76eb2b397a08e6ec86ee755678b9b)):

**Features**

- [#2413](https://github.com/kontourai/station/pull/2413) feat(relay): adopt cookie-paired Devices onto encrypted broker routes
- [#2394](https://github.com/kontourai/station/pull/2394) feat(relay): enroll fresh clients over encrypted application channel
- [#2358](https://github.com/kontourai/station/pull/2358) feat(station-control): verified caller identity and custody-bound child ownership
- [#2384](https://github.com/kontourai/station/pull/2384) feat(relay): add private enrollment recovery foundation (#2274)
- [#2371](https://github.com/kontourai/station/pull/2371) feat(identity): add provider-owned pending enrollment sessions
- [#2375](https://github.com/kontourai/station/pull/2375) feat(plugins): plugin workbench — authoring, scaffold, draft preview, local redeploy, proposals (#2323 S1–S5, #2316, #2319)
- [#2360](https://github.com/kontourai/station/pull/2360) feat(relay): report self-hosted broker lifecycle status
- [#2349](https://github.com/kontourai/station/pull/2349) feat(live-surface): host-neutral live surface primitive for the Browser pane
- [#2346](https://github.com/kontourai/station/pull/2346) feat(browser): server Chromium host for the Browser pane

**Fixes**

- [#2420](https://github.com/kontourai/station/pull/2420) fix(pairing): admit desktop local grants to host pairing routes
- [#2311](https://github.com/kontourai/station/pull/2311) fix(orchestration): re-arm the chat event stream after any abort, stall or auth stop (#2301)
- [#2405](https://github.com/kontourai/station/pull/2405) fix(desktop): release a cancelled native read's slot while its call is blocked
- [#2397](https://github.com/kontourai/station/pull/2397) fix(cli): report a slow readiness identity check as degraded, not unavailable
- [#2387](https://github.com/kontourai/station/pull/2387) fix(relay): recover optional broker registration after startup outages
- [#2390](https://github.com/kontourai/station/pull/2390) fix(ci,ui): restore queue gate inventory and surface contrast
- [#2367](https://github.com/kontourai/station/pull/2367) fix(transfer-gate): reuse exact baselines and prune stale ones on --prepare-baseline
- [#2361](https://github.com/kontourai/station/pull/2361) fix(connect): show a queued Station as busy and let the health probe skip the queue
- [#2366](https://github.com/kontourai/station/pull/2366) fix(pairing): revalidate account session at exchange (#2274)
- [#2353](https://github.com/kontourai/station/pull/2353) fix(relay): recover transient broker control and offer reads
- [#2372](https://github.com/kontourai/station/pull/2372) fix: clear three main reds caught by the shadow merge-queue regression gate
- [#2369](https://github.com/kontourai/station/pull/2369) fix(deps): give install-time probes a cold-start allowance and silent-timeout retry
- [#2352](https://github.com/kontourai/station/pull/2352) fix(pairing): enforce issued session scope subset
- [#2340](https://github.com/kontourai/station/pull/2340) fix(windows): cut cold process starts behind the Windows PR floor timeouts
- [#2338](https://github.com/kontourai/station/pull/2338) fix(inbox): never-prompted sessions are Drafts, not Active now; failed first sends read Failed
- [#2339](https://github.com/kontourai/station/pull/2339) fix(security): require a Station origin for browser WebSocket upgrades on loopback
- [#2335](https://github.com/kontourai/station/pull/2335) fix(plugins): authoring papercuts: truthful install preview, broken examples, docs install claims (#2321)
- [#2320](https://github.com/kontourai/station/pull/2320) fix(ci): give the SDK transport an explicit impact boundary so fast-checks can complete
- [#2331](https://github.com/kontourai/station/pull/2331) fix(server): keep a live desktop's server running when the supervisor probe fails
- [#2329](https://github.com/kontourai/station/pull/2329) fix(gallery): isolate persisted query cache per screen and re-baseline from the pinned renderer
- [#2328](https://github.com/kontourai/station/pull/2328) fix(muse): show running tool calls and stop ending live turns on a Station-chosen schedule
- [#2325](https://github.com/kontourai/station/pull/2325) fix(ci-extended): stable Linux process birth, lean MCP apps, perf provisioning races

**CI / workflow**

- [#2381](https://github.com/kontourai/station/pull/2381) ci(actions): follow callees and allowlist cache actions in untrusted workflows
- [#2380](https://github.com/kontourai/station/pull/2380) ci(coverage): shard the coverage lane through the resource-profiled corpus
- [#2370](https://github.com/kontourai/station/pull/2370) ci: harden the merge-queue gate and add a test quarantine
- [#2368](https://github.com/kontourai/station/pull/2368) ci(security): guard product code against importing CodeQL-ignored test paths
- [#2364](https://github.com/kontourai/station/pull/2364) ci(ios): restore-only Rust cache for the iOS verification build
- [#2322](https://github.com/kontourai/station/pull/2322) ci: add shadow merge-queue regression gate
- [#2330](https://github.com/kontourai/station/pull/2330) ci: cut duplicate work from the PR and merge-queue critical path
- [#2314](https://github.com/kontourai/station/pull/2314) ci: remove duplicated and never-green workflow runs

**Docs**

- [#2393](https://github.com/kontourai/station/pull/2393) docs: list Merge-queue regression as a required check
- [#2359](https://github.com/kontourai/station/pull/2359) docs(adr): host the Browser pane server-side behind a host adapter

**Other**

- [#2417](https://github.com/kontourai/station/pull/2417) test(perf-bridge): settle first run before provisioning browses
- [#2392](https://github.com/kontourai/station/pull/2392) test(relay): prove optional broker startup at the real entrypoint
- [#2379](https://github.com/kontourai/station/pull/2379) test(cli): pin reconciler deadline outcomes with a controlled clock
- [#2362](https://github.com/kontourai/station/pull/2362) test(connections): isolate enrolment integration environment (#2131)
- [#2354](https://github.com/kontourai/station/pull/2354) test: qualify packaged runtime listener ownership (#2016)
- [#2336](https://github.com/kontourai/station/pull/2336) perf(typecheck): host-wide tsc slots and incremental compiles
- [#2317](https://github.com/kontourai/station/pull/2317) test(android): reach mobile Settings through the drawer footer

## 2026-09-22T22:04:19Z · nightly-desktop · 0.1.11-nightly.2456.1

- Ship SHA: `0015690b78f76eb2b397a08e6ec86ee755678b9b`
- Artifact built at: `2026-09-22T21:18:42.564Z` (not provider upload/record time)
- Artifact: github-release:nightly-desktop (cohort-finalized)
- Note: ios: TestFlight delivery success (run 35784910501)

### Changelog

Commits since `8b599ec` ([full sha](https://github.com/kontourai/station/commit/8b599ecbf8de37fde7439ccf185393f3a0571ee3)):

**Fixes**

- [#2306](https://github.com/kontourai/station/pull/2306) fix(chat): reconcile timed-out send when its turn starts late
- [#2297](https://github.com/kontourai/station/pull/2297) fix(server): keep transcript text in window reads past the per-event ceiling
- [#2302](https://github.com/kontourai/station/pull/2302) fix(orchestration): surface adapter pre-send refusals honestly instead of indeterminate
- [#2296](https://github.com/kontourai/station/pull/2296) fix(server): pin event-window cursors by lineage hash, not embedded ids
- [#2299](https://github.com/kontourai/station/pull/2299) fix(approvals): trust the tool, not the call, for session grants
- [#2295](https://github.com/kontourai/station/pull/2295) fix(chat): read sessions refetch window as pending, not absent

**Other**

- [#2298](https://github.com/kontourai/station/pull/2298) chore(ios): regenerate gen/apple from the base config

## 2026-09-22T22:04:15Z · nightly-android · 0.1.11-nightly.2456.1

- Ship SHA: `0015690b78f76eb2b397a08e6ec86ee755678b9b`
- Artifact built at: `2026-09-22T21:18:39.346Z` (not provider upload/record time)
- Artifact: play-internal-aab:cohort-finalized
- Note: ios: TestFlight delivery success (run 35784910501)

### Changelog

Commits since `8b599ec` ([full sha](https://github.com/kontourai/station/commit/8b599ecbf8de37fde7439ccf185393f3a0571ee3)):

**Fixes**

- [#2306](https://github.com/kontourai/station/pull/2306) fix(chat): reconcile timed-out send when its turn starts late
- [#2297](https://github.com/kontourai/station/pull/2297) fix(server): keep transcript text in window reads past the per-event ceiling
- [#2302](https://github.com/kontourai/station/pull/2302) fix(orchestration): surface adapter pre-send refusals honestly instead of indeterminate
- [#2296](https://github.com/kontourai/station/pull/2296) fix(server): pin event-window cursors by lineage hash, not embedded ids
- [#2299](https://github.com/kontourai/station/pull/2299) fix(approvals): trust the tool, not the call, for session grants
- [#2295](https://github.com/kontourai/station/pull/2295) fix(chat): read sessions refetch window as pending, not absent

**Other**

- [#2298](https://github.com/kontourai/station/pull/2298) chore(ios): regenerate gen/apple from the base config

## 2026-09-22T21:59:05Z · nightly-npm · 0.6.0-nightly.2456.35784910501

- Ship SHA: `0015690b78f76eb2b397a08e6ec86ee755678b9b`
- Artifact built at: `unknown` (no immutable artifact manifest binding)
- Artifact: npm:@kontourai/station-cli@0.6.0-nightly.2456.35784910501 (dist-tag nightly; artifactBuiltAt unknown)
- Note: artifactBuiltAt is null: npm package has no native artifact manifest

### Changelog

Commits since `a294ead` ([full sha](https://github.com/kontourai/station/commit/a294eada0deb430689b5bed916da43c6d020f1a6)):

**Fixes**

- [#2306](https://github.com/kontourai/station/pull/2306) fix(chat): reconcile timed-out send when its turn starts late
- [#2297](https://github.com/kontourai/station/pull/2297) fix(server): keep transcript text in window reads past the per-event ceiling
- [#2302](https://github.com/kontourai/station/pull/2302) fix(orchestration): surface adapter pre-send refusals honestly instead of indeterminate
- [#2296](https://github.com/kontourai/station/pull/2296) fix(server): pin event-window cursors by lineage hash, not embedded ids
- [#2299](https://github.com/kontourai/station/pull/2299) fix(approvals): trust the tool, not the call, for session grants
- [#2295](https://github.com/kontourai/station/pull/2295) fix(chat): read sessions refetch window as pending, not absent

**Other**

- [#2298](https://github.com/kontourai/station/pull/2298) chore(ios): regenerate gen/apple from the base config

## 2026-09-22T17:34:38Z · nightly-npm · 0.6.0-nightly.2456.35756143372

- Ship SHA: `a294eada0deb430689b5bed916da43c6d020f1a6`
- Artifact built at: `unknown` (no immutable artifact manifest binding)
- Artifact: npm:@kontourai/station-cli@0.6.0-nightly.2456.35756143372 (dist-tag nightly; artifactBuiltAt unknown)
- Note: artifactBuiltAt is null: npm package has no native artifact manifest

### Changelog

Commits since `3d3b656` ([full sha](https://github.com/kontourai/station/commit/3d3b65649e88d83f9491b3b2fc14526628c5c22c)):

_No user-visible changes recorded for this slice._

## 2026-09-22T12:10:11Z · nightly-npm · 0.6.0-nightly.2456.35721103767

- Ship SHA: `3d3b65649e88d83f9491b3b2fc14526628c5c22c`
- Artifact built at: `unknown` (no immutable artifact manifest binding)
- Artifact: npm:@kontourai/station-cli@0.6.0-nightly.2456.35721103767 (dist-tag nightly; artifactBuiltAt unknown)
- Note: artifactBuiltAt is null: npm package has no native artifact manifest

### Changelog

Commits since `8b599ec` ([full sha](https://github.com/kontourai/station/commit/8b599ecbf8de37fde7439ccf185393f3a0571ee3)):

_No user-visible changes recorded for this slice._

## 2026-09-22T05:16:09Z · nightly-desktop · 0.1.11-nightly.2456

- Ship SHA: `8b599ecbf8de37fde7439ccf185393f3a0571ee3`
- Artifact built at: `2026-09-22T04:40:02.955Z` (not provider upload/record time)
- Artifact: github-release:nightly-desktop (cohort-finalized)
- Note: ios: TestFlight delivery success (run 35687186254)

### Changelog

Commits since `79b6112` ([full sha](https://github.com/kontourai/station/commit/79b6112cabedf1b2dccd9e3690dc7b363bf090f3)):

**Features**

- [#2287](https://github.com/kontourai/station/pull/2287) feat(projects): claim portable delegation attempts before execution
- [#2278](https://github.com/kontourai/station/pull/2278) feat(projects): isolate query persistence by verified authority
- [#2285](https://github.com/kontourai/station/pull/2285) feat(projects): reauthorize portable conversation follow-ups
- [#2281](https://github.com/kontourai/station/pull/2281) feat(cli): wait for delegated work without controlling execution
- [#2279](https://github.com/kontourai/station/pull/2279) feat(projects): let invited admins manage scoped access
- [#2273](https://github.com/kontourai/station/pull/2273) feat(projects): execute portable resources through receiver-owned admission
- [#2276](https://github.com/kontourai/station/pull/2276) feat(connections): configure optional broker startup and offline identity
- [#2268](https://github.com/kontourai/station/pull/2268) feat(projects): scope app reads and optimistic reordering to captured authority
- [#2275](https://github.com/kontourai/station/pull/2275) feat(connections): compose encrypted broker transport and qualify the real browser path
- [#2272](https://github.com/kontourai/station/pull/2272) feat(projects): permit scoped invited-admin access and guard response delivery
- [#2267](https://github.com/kontourai/station/pull/2267) feat(chat): complete history, reference and recovery controls
- [#2270](https://github.com/kontourai/station/pull/2270) feat(auth): expose credential-bound authority observations for multi-home clients
- [#2245](https://github.com/kontourai/station/pull/2245) feat(connections): qualify production Pion application transport
- [#2254](https://github.com/kontourai/station/pull/2254) feat(projects): scope catalogue reads to connection authority
- [#2258](https://github.com/kontourai/station/pull/2258) feat(projects): add reviewed Task sharing controls
- [#2263](https://github.com/kontourai/station/pull/2263) feat(projects): add explicit receiver-local execution offers
- [#2257](https://github.com/kontourai/station/pull/2257) feat(accounts): read shared Tasks from the guest Project view
- [#2252](https://github.com/kontourai/station/pull/2252) feat(projects): edit portable execution roots with revision guards
- [#2248](https://github.com/kontourai/station/pull/2248) feat(projects): authorize explicitly shared Task reads
- [#2250](https://github.com/kontourai/station/pull/2250) feat(broker): add self-hosted signaling and connector lifecycle
- [#2249](https://github.com/kontourai/station/pull/2249) feat(accounts): complete restricted guest Project entry
- [#2247](https://github.com/kontourai/station/pull/2247) feat(projects): support portable repository-relative execution roots

**Fixes**

- [#2294](https://github.com/kontourai/station/pull/2294) fix(tests): retarget the boot-seed ordering pin and de-clock the runtime import
- [#2293](https://github.com/kontourai/station/pull/2293) fix(e2e): prefer the toolbar chip over setup-launcher in openConnections
- [#2291](https://github.com/kontourai/station/pull/2291) fix(pipeline): clear the six Nightly full-regression reds on main
- [#2284](https://github.com/kontourai/station/pull/2284) fix(deps): preserve pnpm shim invocation names with canonical drivers
- [#2283](https://github.com/kontourai/station/pull/2283) fix(orchestration): preserve active turns after event observation errors
- [#2271](https://github.com/kontourai/station/pull/2271) fix(delegation): separate progress stalls from finite turn budgets
- [#2255](https://github.com/kontourai/station/pull/2255) fix(agents): show current failure after a previously passing smoke
- [#2261](https://github.com/kontourai/station/pull/2261) fix(ui): make the mobile navigation close target reliably tappable
- [#2259](https://github.com/kontourai/station/pull/2259) fix(acp): report actionable delegation and reconnect failures
- [#2246](https://github.com/kontourai/station/pull/2246) fix(auth): bind collaborator Devices to Project authority

**Docs**

- [#2244](https://github.com/kontourai/station/pull/2244) docs(connectivity): select the self-operated broker implementation path

**Other**

- [#2286](https://github.com/kontourai/station/pull/2286) test(orchestration): assert trusted follow-up forwarding context
- [#2277](https://github.com/kontourai/station/pull/2277) test(connections): qualify encrypted shared work across isolated machines
- [#2262](https://github.com/kontourai/station/pull/2262) test(projects): exercise real guest invitation and shared Task access
- [#2239](https://github.com/kontourai/station/pull/2239) build(deps): bump adm-zip from 0.6.0 to 0.6.1

## 2026-09-22T05:16:06Z · nightly-android · 0.1.11-nightly.2456

- Ship SHA: `8b599ecbf8de37fde7439ccf185393f3a0571ee3`
- Artifact built at: `2026-09-22T04:39:25.810Z` (not provider upload/record time)
- Artifact: play-internal-aab:cohort-finalized
- Note: ios: TestFlight delivery success (run 35687186254)

### Changelog

Commits since `79b6112` ([full sha](https://github.com/kontourai/station/commit/79b6112cabedf1b2dccd9e3690dc7b363bf090f3)):

**Features**

- [#2287](https://github.com/kontourai/station/pull/2287) feat(projects): claim portable delegation attempts before execution
- [#2278](https://github.com/kontourai/station/pull/2278) feat(projects): isolate query persistence by verified authority
- [#2285](https://github.com/kontourai/station/pull/2285) feat(projects): reauthorize portable conversation follow-ups
- [#2281](https://github.com/kontourai/station/pull/2281) feat(cli): wait for delegated work without controlling execution
- [#2279](https://github.com/kontourai/station/pull/2279) feat(projects): let invited admins manage scoped access
- [#2273](https://github.com/kontourai/station/pull/2273) feat(projects): execute portable resources through receiver-owned admission
- [#2276](https://github.com/kontourai/station/pull/2276) feat(connections): configure optional broker startup and offline identity
- [#2268](https://github.com/kontourai/station/pull/2268) feat(projects): scope app reads and optimistic reordering to captured authority
- [#2275](https://github.com/kontourai/station/pull/2275) feat(connections): compose encrypted broker transport and qualify the real browser path
- [#2272](https://github.com/kontourai/station/pull/2272) feat(projects): permit scoped invited-admin access and guard response delivery
- [#2267](https://github.com/kontourai/station/pull/2267) feat(chat): complete history, reference and recovery controls
- [#2270](https://github.com/kontourai/station/pull/2270) feat(auth): expose credential-bound authority observations for multi-home clients
- [#2245](https://github.com/kontourai/station/pull/2245) feat(connections): qualify production Pion application transport
- [#2254](https://github.com/kontourai/station/pull/2254) feat(projects): scope catalogue reads to connection authority
- [#2258](https://github.com/kontourai/station/pull/2258) feat(projects): add reviewed Task sharing controls
- [#2263](https://github.com/kontourai/station/pull/2263) feat(projects): add explicit receiver-local execution offers
- [#2257](https://github.com/kontourai/station/pull/2257) feat(accounts): read shared Tasks from the guest Project view
- [#2252](https://github.com/kontourai/station/pull/2252) feat(projects): edit portable execution roots with revision guards
- [#2248](https://github.com/kontourai/station/pull/2248) feat(projects): authorize explicitly shared Task reads
- [#2250](https://github.com/kontourai/station/pull/2250) feat(broker): add self-hosted signaling and connector lifecycle
- [#2249](https://github.com/kontourai/station/pull/2249) feat(accounts): complete restricted guest Project entry
- [#2247](https://github.com/kontourai/station/pull/2247) feat(projects): support portable repository-relative execution roots

**Fixes**

- [#2294](https://github.com/kontourai/station/pull/2294) fix(tests): retarget the boot-seed ordering pin and de-clock the runtime import
- [#2293](https://github.com/kontourai/station/pull/2293) fix(e2e): prefer the toolbar chip over setup-launcher in openConnections
- [#2291](https://github.com/kontourai/station/pull/2291) fix(pipeline): clear the six Nightly full-regression reds on main
- [#2284](https://github.com/kontourai/station/pull/2284) fix(deps): preserve pnpm shim invocation names with canonical drivers
- [#2283](https://github.com/kontourai/station/pull/2283) fix(orchestration): preserve active turns after event observation errors
- [#2271](https://github.com/kontourai/station/pull/2271) fix(delegation): separate progress stalls from finite turn budgets
- [#2255](https://github.com/kontourai/station/pull/2255) fix(agents): show current failure after a previously passing smoke
- [#2261](https://github.com/kontourai/station/pull/2261) fix(ui): make the mobile navigation close target reliably tappable
- [#2259](https://github.com/kontourai/station/pull/2259) fix(acp): report actionable delegation and reconnect failures
- [#2246](https://github.com/kontourai/station/pull/2246) fix(auth): bind collaborator Devices to Project authority

**Docs**

- [#2244](https://github.com/kontourai/station/pull/2244) docs(connectivity): select the self-operated broker implementation path

**Other**

- [#2286](https://github.com/kontourai/station/pull/2286) test(orchestration): assert trusted follow-up forwarding context
- [#2277](https://github.com/kontourai/station/pull/2277) test(connections): qualify encrypted shared work across isolated machines
- [#2262](https://github.com/kontourai/station/pull/2262) test(projects): exercise real guest invitation and shared Task access
- [#2239](https://github.com/kontourai/station/pull/2239) build(deps): bump adm-zip from 0.6.0 to 0.6.1

## 2026-09-22T05:12:56Z · nightly-npm · 0.6.0-nightly.2456.35687186254

- Ship SHA: `8b599ecbf8de37fde7439ccf185393f3a0571ee3`
- Artifact built at: `unknown` (no immutable artifact manifest binding)
- Artifact: npm:@kontourai/station-cli@0.6.0-nightly.2456.35687186254 (dist-tag nightly; artifactBuiltAt unknown)
- Note: artifactBuiltAt is null: npm package has no native artifact manifest

### Changelog

Commits since `6a52072` ([full sha](https://github.com/kontourai/station/commit/6a520727248c26dd616682f94712bd33a8c7acb9)):

**Features**

- [#2287](https://github.com/kontourai/station/pull/2287) feat(projects): claim portable delegation attempts before execution
- [#2278](https://github.com/kontourai/station/pull/2278) feat(projects): isolate query persistence by verified authority
- [#2285](https://github.com/kontourai/station/pull/2285) feat(projects): reauthorize portable conversation follow-ups
- [#2281](https://github.com/kontourai/station/pull/2281) feat(cli): wait for delegated work without controlling execution
- [#2279](https://github.com/kontourai/station/pull/2279) feat(projects): let invited admins manage scoped access
- [#2273](https://github.com/kontourai/station/pull/2273) feat(projects): execute portable resources through receiver-owned admission
- [#2276](https://github.com/kontourai/station/pull/2276) feat(connections): configure optional broker startup and offline identity
- [#2268](https://github.com/kontourai/station/pull/2268) feat(projects): scope app reads and optimistic reordering to captured authority
- [#2275](https://github.com/kontourai/station/pull/2275) feat(connections): compose encrypted broker transport and qualify the real browser path
- [#2272](https://github.com/kontourai/station/pull/2272) feat(projects): permit scoped invited-admin access and guard response delivery
- [#2267](https://github.com/kontourai/station/pull/2267) feat(chat): complete history, reference and recovery controls
- [#2270](https://github.com/kontourai/station/pull/2270) feat(auth): expose credential-bound authority observations for multi-home clients
- [#2245](https://github.com/kontourai/station/pull/2245) feat(connections): qualify production Pion application transport
- [#2254](https://github.com/kontourai/station/pull/2254) feat(projects): scope catalogue reads to connection authority
- [#2258](https://github.com/kontourai/station/pull/2258) feat(projects): add reviewed Task sharing controls
- [#2263](https://github.com/kontourai/station/pull/2263) feat(projects): add explicit receiver-local execution offers
- [#2257](https://github.com/kontourai/station/pull/2257) feat(accounts): read shared Tasks from the guest Project view
- [#2252](https://github.com/kontourai/station/pull/2252) feat(projects): edit portable execution roots with revision guards
- [#2248](https://github.com/kontourai/station/pull/2248) feat(projects): authorize explicitly shared Task reads
- [#2250](https://github.com/kontourai/station/pull/2250) feat(broker): add self-hosted signaling and connector lifecycle
- [#2249](https://github.com/kontourai/station/pull/2249) feat(accounts): complete restricted guest Project entry
- [#2247](https://github.com/kontourai/station/pull/2247) feat(projects): support portable repository-relative execution roots

**Fixes**

- [#2294](https://github.com/kontourai/station/pull/2294) fix(tests): retarget the boot-seed ordering pin and de-clock the runtime import
- [#2293](https://github.com/kontourai/station/pull/2293) fix(e2e): prefer the toolbar chip over setup-launcher in openConnections
- [#2291](https://github.com/kontourai/station/pull/2291) fix(pipeline): clear the six Nightly full-regression reds on main
- [#2284](https://github.com/kontourai/station/pull/2284) fix(deps): preserve pnpm shim invocation names with canonical drivers
- [#2283](https://github.com/kontourai/station/pull/2283) fix(orchestration): preserve active turns after event observation errors
- [#2271](https://github.com/kontourai/station/pull/2271) fix(delegation): separate progress stalls from finite turn budgets
- [#2255](https://github.com/kontourai/station/pull/2255) fix(agents): show current failure after a previously passing smoke
- [#2261](https://github.com/kontourai/station/pull/2261) fix(ui): make the mobile navigation close target reliably tappable
- [#2259](https://github.com/kontourai/station/pull/2259) fix(acp): report actionable delegation and reconnect failures
- [#2246](https://github.com/kontourai/station/pull/2246) fix(auth): bind collaborator Devices to Project authority

**Docs**

- [#2244](https://github.com/kontourai/station/pull/2244) docs(connectivity): select the self-operated broker implementation path

**Other**

- [#2286](https://github.com/kontourai/station/pull/2286) test(orchestration): assert trusted follow-up forwarding context
- [#2277](https://github.com/kontourai/station/pull/2277) test(connections): qualify encrypted shared work across isolated machines
- [#2262](https://github.com/kontourai/station/pull/2262) test(projects): exercise real guest invitation and shared Task access
- [#2239](https://github.com/kontourai/station/pull/2239) build(deps): bump adm-zip from 0.6.0 to 0.6.1

## 2026-09-20T11:53:33Z · nightly-npm · 0.6.0-nightly.2454.35506930127

- Ship SHA: `6a520727248c26dd616682f94712bd33a8c7acb9`
- Artifact built at: `unknown` (no immutable artifact manifest binding)
- Artifact: npm:@kontourai/station-cli@0.6.0-nightly.2454.35506930127 (dist-tag nightly; artifactBuiltAt unknown)
- Note: artifactBuiltAt is null: npm package has no native artifact manifest

### Changelog

Commits since `49543b7` ([full sha](https://github.com/kontourai/station/commit/49543b7760b31414411f5301e15b4a3ef0ac1a2d)):

_No user-visible changes recorded for this slice._

## 2026-09-20T05:15:52Z · nightly-npm · 0.6.0-nightly.2454.35489589152

- Ship SHA: `49543b7760b31414411f5301e15b4a3ef0ac1a2d`
- Artifact built at: `unknown` (no immutable artifact manifest binding)
- Artifact: npm:@kontourai/station-cli@0.6.0-nightly.2454.35489589152 (dist-tag nightly; artifactBuiltAt unknown)
- Note: artifactBuiltAt is null: npm package has no native artifact manifest

### Changelog

Commits since `d0ab3de` ([full sha](https://github.com/kontourai/station/commit/d0ab3de3211a46cc4a7881c50974806a3713f4f4)):

_No user-visible changes recorded for this slice._

## 2026-09-19T21:13:57Z · nightly-npm · 0.6.0-nightly.2453.35467424270

- Ship SHA: `d0ab3de3211a46cc4a7881c50974806a3713f4f4`
- Artifact built at: `unknown` (no immutable artifact manifest binding)
- Artifact: npm:@kontourai/station-cli@0.6.0-nightly.2453.35467424270 (dist-tag nightly; artifactBuiltAt unknown)
- Note: artifactBuiltAt is null: npm package has no native artifact manifest

### Changelog

Commits since `79b6112` ([full sha](https://github.com/kontourai/station/commit/79b6112cabedf1b2dccd9e3690dc7b363bf090f3)):

_No user-visible changes recorded for this slice._

## 2026-09-19T18:36:05Z · nightly-desktop · 0.1.11-nightly.2453.5

- Ship SHA: `79b6112cabedf1b2dccd9e3690dc7b363bf090f3`
- Artifact built at: `2026-09-19T17:58:06.066Z` (not provider upload/record time)
- Artifact: github-release:nightly-desktop (cohort-finalized)
- Note: ios: TestFlight delivery success (run 35459320578)

### Changelog

Commits since `1ad69f6` ([full sha](https://github.com/kontourai/station/commit/1ad69f653d52fb6b8da9d123d2bf2abec404f4e1)):

**Fixes**

- [#2243](https://github.com/kontourai/station/pull/2243) fix(tests): wire SDK transport mocks into offline-settling suite
- [#2242](https://github.com/kontourai/station/pull/2242) fix(tests): wire SDK transport mocks into reconnect catch-up suite
- [#2241](https://github.com/kontourai/station/pull/2241) fix(auth): route every request through the authenticated transport (#2236)
- [#2240](https://github.com/kontourai/station/pull/2240) fix(chat): settle crashed turns and name approvals honestly (#2235)

## 2026-09-19T18:36:02Z · nightly-android · 0.1.11-nightly.2453.5

- Ship SHA: `79b6112cabedf1b2dccd9e3690dc7b363bf090f3`
- Artifact built at: `2026-09-19T17:58:07.565Z` (not provider upload/record time)
- Artifact: play-internal-aab:cohort-finalized
- Note: ios: TestFlight delivery success (run 35459320578)

### Changelog

Commits since `1ad69f6` ([full sha](https://github.com/kontourai/station/commit/1ad69f653d52fb6b8da9d123d2bf2abec404f4e1)):

**Fixes**

- [#2243](https://github.com/kontourai/station/pull/2243) fix(tests): wire SDK transport mocks into offline-settling suite
- [#2242](https://github.com/kontourai/station/pull/2242) fix(tests): wire SDK transport mocks into reconnect catch-up suite
- [#2241](https://github.com/kontourai/station/pull/2241) fix(auth): route every request through the authenticated transport (#2236)
- [#2240](https://github.com/kontourai/station/pull/2240) fix(chat): settle crashed turns and name approvals honestly (#2235)

## 2026-09-19T18:29:37Z · nightly-npm · 0.6.0-nightly.2453.35459320578

- Ship SHA: `79b6112cabedf1b2dccd9e3690dc7b363bf090f3`
- Artifact built at: `unknown` (no immutable artifact manifest binding)
- Artifact: npm:@kontourai/station-cli@0.6.0-nightly.2453.35459320578 (dist-tag nightly; artifactBuiltAt unknown)
- Note: artifactBuiltAt is null: npm package has no native artifact manifest

### Changelog

Commits since `1ad69f6` ([full sha](https://github.com/kontourai/station/commit/1ad69f653d52fb6b8da9d123d2bf2abec404f4e1)):

**Fixes**

- [#2243](https://github.com/kontourai/station/pull/2243) fix(tests): wire SDK transport mocks into offline-settling suite
- [#2242](https://github.com/kontourai/station/pull/2242) fix(tests): wire SDK transport mocks into reconnect catch-up suite
- [#2241](https://github.com/kontourai/station/pull/2241) fix(auth): route every request through the authenticated transport (#2236)
- [#2240](https://github.com/kontourai/station/pull/2240) fix(chat): settle crashed turns and name approvals honestly (#2235)

## 2026-09-19T11:35:25Z · nightly-desktop · 0.1.11-nightly.2453.1

- Ship SHA: `1ad69f653d52fb6b8da9d123d2bf2abec404f4e1`
- Artifact built at: `2026-09-19T10:52:57.661Z` (not provider upload/record time)
- Artifact: github-release:nightly-desktop (cohort-finalized)
- Note: ios: TestFlight delivery success (run 35438202313)

### Changelog

Commits since `5b6383e` ([full sha](https://github.com/kontourai/station/commit/5b6383e769445474c55c43464127161ccabe78ee)):

**Fixes**

- [#2237](https://github.com/kontourai/station/pull/2237) fix(ui): restore the SessionsView row's host authority mock (Refs #2234)

## 2026-09-19T11:35:22Z · nightly-android · 0.1.11-nightly.2453.1

- Ship SHA: `1ad69f653d52fb6b8da9d123d2bf2abec404f4e1`
- Artifact built at: `2026-09-19T10:52:50.494Z` (not provider upload/record time)
- Artifact: play-internal-aab:cohort-finalized
- Note: ios: TestFlight delivery success (run 35438202313)

### Changelog

Commits since `5b6383e` ([full sha](https://github.com/kontourai/station/commit/5b6383e769445474c55c43464127161ccabe78ee)):

**Fixes**

- [#2237](https://github.com/kontourai/station/pull/2237) fix(ui): restore the SessionsView row's host authority mock (Refs #2234)

## 2026-09-19T11:30:29Z · nightly-npm · 0.6.0-nightly.2453.35438202313

- Ship SHA: `1ad69f653d52fb6b8da9d123d2bf2abec404f4e1`
- Artifact built at: `unknown` (no immutable artifact manifest binding)
- Artifact: npm:@kontourai/station-cli@0.6.0-nightly.2453.35438202313 (dist-tag nightly; artifactBuiltAt unknown)
- Note: artifactBuiltAt is null: npm package has no native artifact manifest

### Changelog

Commits since `5b6383e` ([full sha](https://github.com/kontourai/station/commit/5b6383e769445474c55c43464127161ccabe78ee)):

**Fixes**

- [#2237](https://github.com/kontourai/station/pull/2237) fix(ui): restore the SessionsView row's host authority mock (Refs #2234)

## 2026-09-19T05:00:18Z · nightly-desktop · 0.1.11-nightly.2453

- Ship SHA: `5b6383e769445474c55c43464127161ccabe78ee`
- Artifact built at: `2026-09-19T04:25:53.163Z` (not provider upload/record time)
- Artifact: github-release:nightly-desktop (cohort-finalized)
- Note: ios: TestFlight delivery success (run 35420920112)

### Changelog

Commits since `26b4dec` ([full sha](https://github.com/kontourai/station/commit/26b4deca1ba2e2c2d2c3c4a722df314daf6c948b)):

**Features**

- [#2224](https://github.com/kontourai/station/pull/2224) feat(governance): the style standard becomes a required evidence check

**Fixes**

- [#2233](https://github.com/kontourai/station/pull/2233) fix: unblock nightly — docs hygiene, mobile chip pins, veritas timeouts
- [#2225](https://github.com/kontourai/station/pull/2225) fix: live engine catalogs and persist New Chat picker on relaunch
- [#2232](https://github.com/kontourai/station/pull/2232) fix(pairing): decisive local-grant eligibility answers so a dead desktop credential self-heals (#2228)
- [#2230](https://github.com/kontourai/station/pull/2230) fix(ui): a region bar drags like chat's header, and a collapsed dock is the bar alone
- [#2231](https://github.com/kontourai/station/pull/2231) fix(acp): contain failed terminal spawns, honor resumed model retention, copy session id
- [#2227](https://github.com/kontourai/station/pull/2227) fix(acp,ui): no Agent for an engine that cannot onboard; New Chat picker row hierarchy
- [#2229](https://github.com/kontourai/station/pull/2229) fix(ui): side-dock chat alignment and clipped turn overflow menu
- [#2226](https://github.com/kontourai/station/pull/2226) fix(projects): cross-platform folder picker with Windows drive switching
- [#2221](https://github.com/kontourai/station/pull/2221) fix(mobile): dot-only header chip, drawer-owned settings, gated notification prime
- [#2222](https://github.com/kontourai/station/pull/2222) fix: B10 follow-ups for Ready honesty, user-turn recovery, and host workspaces

## 2026-09-19T05:00:15Z · nightly-android · 0.1.11-nightly.2453

- Ship SHA: `5b6383e769445474c55c43464127161ccabe78ee`
- Artifact built at: `2026-09-19T04:25:41.506Z` (not provider upload/record time)
- Artifact: play-internal-aab:cohort-finalized
- Note: ios: TestFlight delivery success (run 35420920112)

### Changelog

Commits since `26b4dec` ([full sha](https://github.com/kontourai/station/commit/26b4deca1ba2e2c2d2c3c4a722df314daf6c948b)):

**Features**

- [#2224](https://github.com/kontourai/station/pull/2224) feat(governance): the style standard becomes a required evidence check

**Fixes**

- [#2233](https://github.com/kontourai/station/pull/2233) fix: unblock nightly — docs hygiene, mobile chip pins, veritas timeouts
- [#2225](https://github.com/kontourai/station/pull/2225) fix: live engine catalogs and persist New Chat picker on relaunch
- [#2232](https://github.com/kontourai/station/pull/2232) fix(pairing): decisive local-grant eligibility answers so a dead desktop credential self-heals (#2228)
- [#2230](https://github.com/kontourai/station/pull/2230) fix(ui): a region bar drags like chat's header, and a collapsed dock is the bar alone
- [#2231](https://github.com/kontourai/station/pull/2231) fix(acp): contain failed terminal spawns, honor resumed model retention, copy session id
- [#2227](https://github.com/kontourai/station/pull/2227) fix(acp,ui): no Agent for an engine that cannot onboard; New Chat picker row hierarchy
- [#2229](https://github.com/kontourai/station/pull/2229) fix(ui): side-dock chat alignment and clipped turn overflow menu
- [#2226](https://github.com/kontourai/station/pull/2226) fix(projects): cross-platform folder picker with Windows drive switching
- [#2221](https://github.com/kontourai/station/pull/2221) fix(mobile): dot-only header chip, drawer-owned settings, gated notification prime
- [#2222](https://github.com/kontourai/station/pull/2222) fix: B10 follow-ups for Ready honesty, user-turn recovery, and host workspaces

## 2026-09-19T04:56:00Z · nightly-npm · 0.6.0-nightly.2453.35420920112

- Ship SHA: `5b6383e769445474c55c43464127161ccabe78ee`
- Artifact built at: `unknown` (no immutable artifact manifest binding)
- Artifact: npm:@kontourai/station-cli@0.6.0-nightly.2453.35420920112 (dist-tag nightly; artifactBuiltAt unknown)
- Note: artifactBuiltAt is null: npm package has no native artifact manifest

### Changelog

Commits since `26b4dec` ([full sha](https://github.com/kontourai/station/commit/26b4deca1ba2e2c2d2c3c4a722df314daf6c948b)):

**Features**

- [#2224](https://github.com/kontourai/station/pull/2224) feat(governance): the style standard becomes a required evidence check

**Fixes**

- [#2233](https://github.com/kontourai/station/pull/2233) fix: unblock nightly — docs hygiene, mobile chip pins, veritas timeouts
- [#2225](https://github.com/kontourai/station/pull/2225) fix: live engine catalogs and persist New Chat picker on relaunch
- [#2232](https://github.com/kontourai/station/pull/2232) fix(pairing): decisive local-grant eligibility answers so a dead desktop credential self-heals (#2228)
- [#2230](https://github.com/kontourai/station/pull/2230) fix(ui): a region bar drags like chat's header, and a collapsed dock is the bar alone
- [#2231](https://github.com/kontourai/station/pull/2231) fix(acp): contain failed terminal spawns, honor resumed model retention, copy session id
- [#2227](https://github.com/kontourai/station/pull/2227) fix(acp,ui): no Agent for an engine that cannot onboard; New Chat picker row hierarchy
- [#2229](https://github.com/kontourai/station/pull/2229) fix(ui): side-dock chat alignment and clipped turn overflow menu
- [#2226](https://github.com/kontourai/station/pull/2226) fix(projects): cross-platform folder picker with Windows drive switching
- [#2221](https://github.com/kontourai/station/pull/2221) fix(mobile): dot-only header chip, drawer-owned settings, gated notification prime
- [#2222](https://github.com/kontourai/station/pull/2222) fix: B10 follow-ups for Ready honesty, user-turn recovery, and host workspaces

## 2026-09-18T05:12:07Z · nightly-desktop · 0.1.11-nightly.2452

- Ship SHA: `26b4deca1ba2e2c2d2c3c4a722df314daf6c948b`
- Artifact built at: `2026-09-18T04:28:15.060Z` (not provider upload/record time)
- Artifact: github-release:nightly-desktop (cohort-finalized)
- Note: ios: TestFlight delivery success (run 35306644320)

### Changelog

Commits since `c479c21` ([full sha](https://github.com/kontourai/station/commit/c479c218bef24ca5268700fd571a2998ef4f131d)):

**Fixes**

- [#2212](https://github.com/kontourai/station/pull/2212) fix(nightly): retry timed-out desktop asset uploads with readback adoption
- [#2218](https://github.com/kontourai/station/pull/2218) fix(server): bound attached-transcript mapping so no event can wedge the poll loop
- [#2214](https://github.com/kontourai/station/pull/2214) fix(ui): B10 phone chat honesty, fullscreen continue, and client copy
- [#2213](https://github.com/kontourai/station/pull/2213) fix(ui): focus the transcript on answers — turn record moves to the overflow menu (#2211)
- [#2209](https://github.com/kontourai/station/pull/2209) fix(desktop): stop the native broker's 1s total body budget from killing every SSE stream

**Other**

- [#2219](https://github.com/kontourai/station/pull/2219) chore(deps): upgrade @kontourai/veritas to 1.6.1 — the readiness report states its rollup's derivation
- [#2206](https://github.com/kontourai/station/pull/2206) build(deps): bump the desktop-crates group across 1 directory with 2 updates

## 2026-09-18T05:12:04Z · nightly-android · 0.1.11-nightly.2452

- Ship SHA: `26b4deca1ba2e2c2d2c3c4a722df314daf6c948b`
- Artifact built at: `2026-09-18T04:28:32.795Z` (not provider upload/record time)
- Artifact: play-internal-aab:cohort-finalized
- Note: ios: TestFlight delivery success (run 35306644320)

### Changelog

Commits since `c479c21` ([full sha](https://github.com/kontourai/station/commit/c479c218bef24ca5268700fd571a2998ef4f131d)):

**Fixes**

- [#2212](https://github.com/kontourai/station/pull/2212) fix(nightly): retry timed-out desktop asset uploads with readback adoption
- [#2218](https://github.com/kontourai/station/pull/2218) fix(server): bound attached-transcript mapping so no event can wedge the poll loop
- [#2214](https://github.com/kontourai/station/pull/2214) fix(ui): B10 phone chat honesty, fullscreen continue, and client copy
- [#2213](https://github.com/kontourai/station/pull/2213) fix(ui): focus the transcript on answers — turn record moves to the overflow menu (#2211)
- [#2209](https://github.com/kontourai/station/pull/2209) fix(desktop): stop the native broker's 1s total body budget from killing every SSE stream

**Other**

- [#2219](https://github.com/kontourai/station/pull/2219) chore(deps): upgrade @kontourai/veritas to 1.6.1 — the readiness report states its rollup's derivation
- [#2206](https://github.com/kontourai/station/pull/2206) build(deps): bump the desktop-crates group across 1 directory with 2 updates

## 2026-09-18T05:06:29Z · nightly-npm · 0.6.0-nightly.2452.35306644320

- Ship SHA: `26b4deca1ba2e2c2d2c3c4a722df314daf6c948b`
- Artifact built at: `unknown` (no immutable artifact manifest binding)
- Artifact: npm:@kontourai/station-cli@0.6.0-nightly.2452.35306644320 (dist-tag nightly; artifactBuiltAt unknown)
- Note: artifactBuiltAt is null: npm package has no native artifact manifest

### Changelog

Commits since `c479c21` ([full sha](https://github.com/kontourai/station/commit/c479c218bef24ca5268700fd571a2998ef4f131d)):

**Fixes**

- [#2212](https://github.com/kontourai/station/pull/2212) fix(nightly): retry timed-out desktop asset uploads with readback adoption
- [#2218](https://github.com/kontourai/station/pull/2218) fix(server): bound attached-transcript mapping so no event can wedge the poll loop
- [#2214](https://github.com/kontourai/station/pull/2214) fix(ui): B10 phone chat honesty, fullscreen continue, and client copy
- [#2213](https://github.com/kontourai/station/pull/2213) fix(ui): focus the transcript on answers — turn record moves to the overflow menu (#2211)
- [#2209](https://github.com/kontourai/station/pull/2209) fix(desktop): stop the native broker's 1s total body budget from killing every SSE stream

**Other**

- [#2219](https://github.com/kontourai/station/pull/2219) chore(deps): upgrade @kontourai/veritas to 1.6.1 — the readiness report states its rollup's derivation
- [#2206](https://github.com/kontourai/station/pull/2206) build(deps): bump the desktop-crates group across 1 directory with 2 updates

## 2026-09-17T22:12:01Z · nightly-desktop · 0.1.11-nightly.2451.3

- Ship SHA: `c479c218bef24ca5268700fd571a2998ef4f131d`
- Artifact built at: `2026-09-17T21:22:04.919Z` (not provider upload/record time)
- Artifact: github-release:nightly-desktop (cohort-finalized)
- Note: ios: TestFlight delivery success (run 35275391814)

### Changelog

Commits since `ea101d6` ([full sha](https://github.com/kontourai/station/commit/ea101d69eb1d3773b02672f919e99514396bb52d)):

**Fixes**

- [#2207](https://github.com/kontourai/station/pull/2207) fix(connect): hide host-only Station management on client-only devices (#2205)

## 2026-09-17T22:11:58Z · nightly-android · 0.1.11-nightly.2451.3

- Ship SHA: `c479c218bef24ca5268700fd571a2998ef4f131d`
- Artifact built at: `2026-09-17T21:22:05.796Z` (not provider upload/record time)
- Artifact: play-internal-aab:cohort-finalized
- Note: ios: TestFlight delivery success (run 35275391814)

### Changelog

Commits since `adfba3a` ([full sha](https://github.com/kontourai/station/commit/adfba3aa360ea13f5b7309d9c501a8e75ae4cff0)):

_No user-visible changes recorded for this slice._

## 2026-09-17T21:59:18Z · nightly-npm · 0.6.0-nightly.2451.35275391814

- Ship SHA: `c479c218bef24ca5268700fd571a2998ef4f131d`
- Artifact built at: `unknown` (no immutable artifact manifest binding)
- Artifact: npm:@kontourai/station-cli@0.6.0-nightly.2451.35275391814 (dist-tag nightly; artifactBuiltAt unknown)
- Note: artifactBuiltAt is null: npm package has no native artifact manifest

### Changelog

Commits since `adfba3a` ([full sha](https://github.com/kontourai/station/commit/adfba3aa360ea13f5b7309d9c501a8e75ae4cff0)):

_No user-visible changes recorded for this slice._

## 2026-09-17T20:25:45Z · nightly-android · 0.1.11-nightly.2451.2

- Ship SHA: `adfba3aa360ea13f5b7309d9c501a8e75ae4cff0`
- Artifact built at: `2026-09-17T19:35:52.749Z` (not provider upload/record time)
- Artifact: play-internal-aab:cohort-finalized
- Note: ios: TestFlight delivery success (run 35265013644)
- Note: macos: NOT_VERIFIED (macos provider outcome unknown: unresolved:run:35265013644:github-release-upload-or-readback (the provider effect may already be live))
- Note: windows: NOT_VERIFIED (windows provider outcome unknown: unresolved:run:35265013644:desktop-upload-or-readback (the provider effect may already be live))

### Changelog

Commits since `fa83684` ([full sha](https://github.com/kontourai/station/commit/fa83684ed1c6dd5bc3e5d78184565b35c995a916)):

_No user-visible changes recorded for this slice._

## 2026-09-17T20:13:41Z · nightly-npm · 0.6.0-nightly.2451.35265013644

- Ship SHA: `adfba3aa360ea13f5b7309d9c501a8e75ae4cff0`
- Artifact built at: `unknown` (no immutable artifact manifest binding)
- Artifact: npm:@kontourai/station-cli@0.6.0-nightly.2451.35265013644 (dist-tag nightly; artifactBuiltAt unknown)
- Note: artifactBuiltAt is null: npm package has no native artifact manifest

### Changelog

Commits since `fa83684` ([full sha](https://github.com/kontourai/station/commit/fa83684ed1c6dd5bc3e5d78184565b35c995a916)):

_No user-visible changes recorded for this slice._

## 2026-09-17T17:54:52Z · nightly-android · 0.1.11-nightly.2451.1

- Ship SHA: `fa83684ed1c6dd5bc3e5d78184565b35c995a916`
- Artifact built at: `2026-09-17T16:54:38.802Z` (not provider upload/record time)
- Artifact: play-internal-aab:cohort-finalized
- Note: ios: TestFlight delivery success (run 35248613245)
- Note: macos: NOT_VERIFIED (macos provider outcome unknown: unresolved:run:35248613245:github-release-upload-or-readback (the provider effect may already be live))
- Note: windows: NOT_VERIFIED (windows provider outcome unknown: unresolved:run:35248613245:desktop-upload-or-readback (the provider effect may already be live))

### Changelog

Commits since `ea101d6` ([full sha](https://github.com/kontourai/station/commit/ea101d69eb1d3773b02672f919e99514396bb52d)):

**Fixes**

- [#2207](https://github.com/kontourai/station/pull/2207) fix(connect): hide host-only Station management on client-only devices (#2205)

## 2026-09-17T17:30:49Z · nightly-npm · 0.6.0-nightly.2451.35248613245

- Ship SHA: `fa83684ed1c6dd5bc3e5d78184565b35c995a916`
- Artifact built at: `unknown` (no immutable artifact manifest binding)
- Artifact: npm:@kontourai/station-cli@0.6.0-nightly.2451.35248613245 (dist-tag nightly; artifactBuiltAt unknown)
- Note: artifactBuiltAt is null: npm package has no native artifact manifest

### Changelog

Commits since `d858401` ([full sha](https://github.com/kontourai/station/commit/d858401c088291804a9b1ff4855cfe7f9f166a95)):

**Fixes**

- [#2207](https://github.com/kontourai/station/pull/2207) fix(connect): hide host-only Station management on client-only devices (#2205)

## 2026-09-17T12:05:26Z · nightly-npm · 0.6.0-nightly.2451.35215764545

- Ship SHA: `d858401c088291804a9b1ff4855cfe7f9f166a95`
- Artifact built at: `unknown` (no immutable artifact manifest binding)
- Artifact: npm:@kontourai/station-cli@0.6.0-nightly.2451.35215764545 (dist-tag nightly; artifactBuiltAt unknown)
- Note: artifactBuiltAt is null: npm package has no native artifact manifest

### Changelog

Commits since `9a437a4` ([full sha](https://github.com/kontourai/station/commit/9a437a4a5a73daab509d311d84a55c5a944e9c12)):

_No user-visible changes recorded for this slice._

## 2026-09-17T05:13:39Z · nightly-npm · 0.6.0-nightly.2451.35182540277

- Ship SHA: `9a437a4a5a73daab509d311d84a55c5a944e9c12`
- Artifact built at: `unknown` (no immutable artifact manifest binding)
- Artifact: npm:@kontourai/station-cli@0.6.0-nightly.2451.35182540277 (dist-tag nightly; artifactBuiltAt unknown)
- Note: artifactBuiltAt is null: npm package has no native artifact manifest

### Changelog

Commits since `ea101d6` ([full sha](https://github.com/kontourai/station/commit/ea101d69eb1d3773b02672f919e99514396bb52d)):

_No user-visible changes recorded for this slice._

## 2026-09-17T02:50:36Z · nightly-desktop · 0.1.11-nightly.2451

- Ship SHA: `ea101d69eb1d3773b02672f919e99514396bb52d`
- Artifact built at: `2026-09-17T02:07:32.130Z` (not provider upload/record time)
- Artifact: github-release:nightly-desktop (cohort-finalized)
- Note: ios: TestFlight delivery success (run 35172665354)

### Changelog

Commits since `b9f05fe` ([full sha](https://github.com/kontourai/station/commit/b9f05fe2666c46b9e882726a758a3c6f5a5a3a8a)):

**Features**

- [#2204](https://github.com/kontourai/station/pull/2204) feat(settings): the Station configuration junk drawer becomes Sources, Telemetry, Permissions and Agent runs, and a caption only prints over something (#2182)
- [#1663](https://github.com/kontourai/station/pull/1663) feat: reconcile room admissions from durable receipts
- [#2190](https://github.com/kontourai/station/pull/2190) feat(regions): the record parser reads an instance pane held by two regions — #2159 slice A, behaviour-neutral
- [#2189](https://github.com/kontourai/station/pull/2189) feat(settings): a vertical rail that shows every group, a scope chip that only draws a difference, and headings above the cards (#2144)
- [#1653](https://github.com/kontourai/station/pull/1653) feat: connect controlled home sessions to room writes
- [#2184](https://github.com/kontourai/station/pull/2184) feat(regions): the region toggles only show and hide; the chooser is a hold away (#2155)
- [#1659](https://github.com/kontourai/station/pull/1659) feat: expose personal home-control session endpoints
- [#2180](https://github.com/kontourai/station/pull/2180) feat(sidebar): a pill's context menu opens its Board or Layout into a dock region (#2158)
- [#2179](https://github.com/kontourai/station/pull/2179) feat(settings): one navigation that names what each group is for, and Chat's settings get a home (#2144)
- [#1579](https://github.com/kontourai/station/pull/1579) feat(plugins): bind registry trust to installation and recovery
- [#1550](https://github.com/kontourai/station/pull/1550) feat(plugins): migrate coding starter to portable Project Panes
- [#1640](https://github.com/kontourai/station/pull/1640) feat: fence home-control sessions and reconcile durable receipts
- [#2174](https://github.com/kontourai/station/pull/2174) feat(regions): an empty region is a chooser, and the region's + opens the same rows (#2154)
- [#1542](https://github.com/kontourai/station/pull/1542) feat(plugins): migrate the minimal example to a portable Project Pane
- [#2172](https://github.com/kontourai/station/pull/2172) feat(regions): a dock region holds a Board or a project Layout beside Chat (#2157)
- [#2169](https://github.com/kontourai/station/pull/2169) feat(settings): six settings that were missing, and the ones that were labels become derivations
- [#2166](https://github.com/kontourai/station/pull/2166) feat(regions): an empty dock region may stay visible; a close keeps it, a move hides it (#2153)
- [#2167](https://github.com/kontourai/station/pull/2167) feat(settings): every row says which scope decides it, and a project overrides a Station setting from the row itself
- [#2165](https://github.com/kontourai/station/pull/2165) feat(regions): a lone pane reaches any region from its own bar (#2160)
- [#2163](https://github.com/kontourai/station/pull/2163) feat(regions): Bottom is Chat's — Terminal joins it and a taken default falls right (#2156)
- [#2161](https://github.com/kontourai/station/pull/2161) feat(settings): search reads every setting's consequence, and agents get a generated registry of deep links
- [#2149](https://github.com/kontourai/station/pull/2149) feat(settings): every setting states its consequence, and a project overrides three Station settings by name
- [#2147](https://github.com/kontourai/station/pull/2147) feat(regions): the toolbar is one toggle per dock region; a pane moves from its tab (#2143)

**Fixes**

- [#2201](https://github.com/kontourai/station/pull/2201) fix(tests): the font-size persistence guard asserts behaviour, not indentation
- [#2198](https://github.com/kontourai/station/pull/2198) fix(home-authority): a negative revision is malformed (400), not a conflict (409)
- [#2199](https://github.com/kontourai/station/pull/2199) fix(layouts): a docked Layout renders no prompt control it cannot run, and a project plugin record's stored actions are dropped (#2171)
- [#2197](https://github.com/kontourai/station/pull/2197) fix(environments): expectedRevision 0 is a first write, not a malformed one (#2196)
- [#2097](https://github.com/kontourai/station/pull/2097) fix(ui): resume code highlighting from completed lines while streaming
- [#2183](https://github.com/kontourai/station/pull/2183) fix(tests): the local collaboration lab supplies the operator currency callback
- [#2177](https://github.com/kontourai/station/pull/2177) fix(orchestration): admit a room write only once its transaction can finish
- [#2178](https://github.com/kontourai/station/pull/2178) fix(tests): derive the accent ratchet's scratch roots from the gate's own list
- [#2173](https://github.com/kontourai/station/pull/2173) fix(tests): classify the settings-registry gate, and regenerate the registry the catalog outran
- [#2170](https://github.com/kontourai/station/pull/2170) fix(tests): the three nightly load failures each get a derivation where a literal was
- [#2164](https://github.com/kontourai/station/pull/2164) fix(layouts): sweeps see through symlinks and past directories named *.json
- [#2162](https://github.com/kontourai/station/pull/2162) fix(dock): the first-run nudge opens the dock only onto a known, non-empty inbox
- [#2152](https://github.com/kontourai/station/pull/2152) fix(sidebar): six gaps between the built panel and design record D3
- [#2145](https://github.com/kontourai/station/pull/2145) fix(settings): controls that persisted nothing stop claiming they do

**Other**

- [#2188](https://github.com/kontourai/station/pull/2188) refactor(regions): the placement drag is one shared gesture, and a wandered drag is no longer a click (#2185)
- [#2187](https://github.com/kontourai/station/pull/2187) refactor(pairing): operator currency revalidation is required, not optional

## 2026-09-17T02:50:33Z · nightly-android · 0.1.11-nightly.2451

- Ship SHA: `ea101d69eb1d3773b02672f919e99514396bb52d`
- Artifact built at: `2026-09-17T02:07:58.308Z` (not provider upload/record time)
- Artifact: play-internal-aab:cohort-finalized
- Note: ios: TestFlight delivery success (run 35172665354)

### Changelog

Commits since `b9f05fe` ([full sha](https://github.com/kontourai/station/commit/b9f05fe2666c46b9e882726a758a3c6f5a5a3a8a)):

**Features**

- [#2204](https://github.com/kontourai/station/pull/2204) feat(settings): the Station configuration junk drawer becomes Sources, Telemetry, Permissions and Agent runs, and a caption only prints over something (#2182)
- [#1663](https://github.com/kontourai/station/pull/1663) feat: reconcile room admissions from durable receipts
- [#2190](https://github.com/kontourai/station/pull/2190) feat(regions): the record parser reads an instance pane held by two regions — #2159 slice A, behaviour-neutral
- [#2189](https://github.com/kontourai/station/pull/2189) feat(settings): a vertical rail that shows every group, a scope chip that only draws a difference, and headings above the cards (#2144)
- [#1653](https://github.com/kontourai/station/pull/1653) feat: connect controlled home sessions to room writes
- [#2184](https://github.com/kontourai/station/pull/2184) feat(regions): the region toggles only show and hide; the chooser is a hold away (#2155)
- [#1659](https://github.com/kontourai/station/pull/1659) feat: expose personal home-control session endpoints
- [#2180](https://github.com/kontourai/station/pull/2180) feat(sidebar): a pill's context menu opens its Board or Layout into a dock region (#2158)
- [#2179](https://github.com/kontourai/station/pull/2179) feat(settings): one navigation that names what each group is for, and Chat's settings get a home (#2144)
- [#1579](https://github.com/kontourai/station/pull/1579) feat(plugins): bind registry trust to installation and recovery
- [#1550](https://github.com/kontourai/station/pull/1550) feat(plugins): migrate coding starter to portable Project Panes
- [#1640](https://github.com/kontourai/station/pull/1640) feat: fence home-control sessions and reconcile durable receipts
- [#2174](https://github.com/kontourai/station/pull/2174) feat(regions): an empty region is a chooser, and the region's + opens the same rows (#2154)
- [#1542](https://github.com/kontourai/station/pull/1542) feat(plugins): migrate the minimal example to a portable Project Pane
- [#2172](https://github.com/kontourai/station/pull/2172) feat(regions): a dock region holds a Board or a project Layout beside Chat (#2157)
- [#2169](https://github.com/kontourai/station/pull/2169) feat(settings): six settings that were missing, and the ones that were labels become derivations
- [#2166](https://github.com/kontourai/station/pull/2166) feat(regions): an empty dock region may stay visible; a close keeps it, a move hides it (#2153)
- [#2167](https://github.com/kontourai/station/pull/2167) feat(settings): every row says which scope decides it, and a project overrides a Station setting from the row itself
- [#2165](https://github.com/kontourai/station/pull/2165) feat(regions): a lone pane reaches any region from its own bar (#2160)
- [#2163](https://github.com/kontourai/station/pull/2163) feat(regions): Bottom is Chat's — Terminal joins it and a taken default falls right (#2156)
- [#2161](https://github.com/kontourai/station/pull/2161) feat(settings): search reads every setting's consequence, and agents get a generated registry of deep links
- [#2149](https://github.com/kontourai/station/pull/2149) feat(settings): every setting states its consequence, and a project overrides three Station settings by name
- [#2147](https://github.com/kontourai/station/pull/2147) feat(regions): the toolbar is one toggle per dock region; a pane moves from its tab (#2143)

**Fixes**

- [#2201](https://github.com/kontourai/station/pull/2201) fix(tests): the font-size persistence guard asserts behaviour, not indentation
- [#2198](https://github.com/kontourai/station/pull/2198) fix(home-authority): a negative revision is malformed (400), not a conflict (409)
- [#2199](https://github.com/kontourai/station/pull/2199) fix(layouts): a docked Layout renders no prompt control it cannot run, and a project plugin record's stored actions are dropped (#2171)
- [#2197](https://github.com/kontourai/station/pull/2197) fix(environments): expectedRevision 0 is a first write, not a malformed one (#2196)
- [#2097](https://github.com/kontourai/station/pull/2097) fix(ui): resume code highlighting from completed lines while streaming
- [#2183](https://github.com/kontourai/station/pull/2183) fix(tests): the local collaboration lab supplies the operator currency callback
- [#2177](https://github.com/kontourai/station/pull/2177) fix(orchestration): admit a room write only once its transaction can finish
- [#2178](https://github.com/kontourai/station/pull/2178) fix(tests): derive the accent ratchet's scratch roots from the gate's own list
- [#2173](https://github.com/kontourai/station/pull/2173) fix(tests): classify the settings-registry gate, and regenerate the registry the catalog outran
- [#2170](https://github.com/kontourai/station/pull/2170) fix(tests): the three nightly load failures each get a derivation where a literal was
- [#2164](https://github.com/kontourai/station/pull/2164) fix(layouts): sweeps see through symlinks and past directories named *.json
- [#2162](https://github.com/kontourai/station/pull/2162) fix(dock): the first-run nudge opens the dock only onto a known, non-empty inbox
- [#2152](https://github.com/kontourai/station/pull/2152) fix(sidebar): six gaps between the built panel and design record D3
- [#2145](https://github.com/kontourai/station/pull/2145) fix(settings): controls that persisted nothing stop claiming they do

**Other**

- [#2188](https://github.com/kontourai/station/pull/2188) refactor(regions): the placement drag is one shared gesture, and a wandered drag is no longer a click (#2185)
- [#2187](https://github.com/kontourai/station/pull/2187) refactor(pairing): operator currency revalidation is required, not optional

## 2026-09-17T02:45:30Z · nightly-npm · 0.6.0-nightly.2451.35172665354

- Ship SHA: `ea101d69eb1d3773b02672f919e99514396bb52d`
- Artifact built at: `unknown` (no immutable artifact manifest binding)
- Artifact: npm:@kontourai/station-cli@0.6.0-nightly.2451.35172665354 (dist-tag nightly; artifactBuiltAt unknown)
- Note: artifactBuiltAt is null: npm package has no native artifact manifest

### Changelog

Commits since `b9f05fe` ([full sha](https://github.com/kontourai/station/commit/b9f05fe2666c46b9e882726a758a3c6f5a5a3a8a)):

**Features**

- [#2204](https://github.com/kontourai/station/pull/2204) feat(settings): the Station configuration junk drawer becomes Sources, Telemetry, Permissions and Agent runs, and a caption only prints over something (#2182)
- [#1663](https://github.com/kontourai/station/pull/1663) feat: reconcile room admissions from durable receipts
- [#2190](https://github.com/kontourai/station/pull/2190) feat(regions): the record parser reads an instance pane held by two regions — #2159 slice A, behaviour-neutral
- [#2189](https://github.com/kontourai/station/pull/2189) feat(settings): a vertical rail that shows every group, a scope chip that only draws a difference, and headings above the cards (#2144)
- [#1653](https://github.com/kontourai/station/pull/1653) feat: connect controlled home sessions to room writes
- [#2184](https://github.com/kontourai/station/pull/2184) feat(regions): the region toggles only show and hide; the chooser is a hold away (#2155)
- [#1659](https://github.com/kontourai/station/pull/1659) feat: expose personal home-control session endpoints
- [#2180](https://github.com/kontourai/station/pull/2180) feat(sidebar): a pill's context menu opens its Board or Layout into a dock region (#2158)
- [#2179](https://github.com/kontourai/station/pull/2179) feat(settings): one navigation that names what each group is for, and Chat's settings get a home (#2144)
- [#1579](https://github.com/kontourai/station/pull/1579) feat(plugins): bind registry trust to installation and recovery
- [#1550](https://github.com/kontourai/station/pull/1550) feat(plugins): migrate coding starter to portable Project Panes
- [#1640](https://github.com/kontourai/station/pull/1640) feat: fence home-control sessions and reconcile durable receipts
- [#2174](https://github.com/kontourai/station/pull/2174) feat(regions): an empty region is a chooser, and the region's + opens the same rows (#2154)
- [#1542](https://github.com/kontourai/station/pull/1542) feat(plugins): migrate the minimal example to a portable Project Pane
- [#2172](https://github.com/kontourai/station/pull/2172) feat(regions): a dock region holds a Board or a project Layout beside Chat (#2157)
- [#2169](https://github.com/kontourai/station/pull/2169) feat(settings): six settings that were missing, and the ones that were labels become derivations
- [#2166](https://github.com/kontourai/station/pull/2166) feat(regions): an empty dock region may stay visible; a close keeps it, a move hides it (#2153)
- [#2167](https://github.com/kontourai/station/pull/2167) feat(settings): every row says which scope decides it, and a project overrides a Station setting from the row itself
- [#2165](https://github.com/kontourai/station/pull/2165) feat(regions): a lone pane reaches any region from its own bar (#2160)
- [#2163](https://github.com/kontourai/station/pull/2163) feat(regions): Bottom is Chat's — Terminal joins it and a taken default falls right (#2156)
- [#2161](https://github.com/kontourai/station/pull/2161) feat(settings): search reads every setting's consequence, and agents get a generated registry of deep links
- [#2149](https://github.com/kontourai/station/pull/2149) feat(settings): every setting states its consequence, and a project overrides three Station settings by name
- [#2147](https://github.com/kontourai/station/pull/2147) feat(regions): the toolbar is one toggle per dock region; a pane moves from its tab (#2143)

**Fixes**

- [#2201](https://github.com/kontourai/station/pull/2201) fix(tests): the font-size persistence guard asserts behaviour, not indentation
- [#2198](https://github.com/kontourai/station/pull/2198) fix(home-authority): a negative revision is malformed (400), not a conflict (409)
- [#2199](https://github.com/kontourai/station/pull/2199) fix(layouts): a docked Layout renders no prompt control it cannot run, and a project plugin record's stored actions are dropped (#2171)
- [#2197](https://github.com/kontourai/station/pull/2197) fix(environments): expectedRevision 0 is a first write, not a malformed one (#2196)
- [#2097](https://github.com/kontourai/station/pull/2097) fix(ui): resume code highlighting from completed lines while streaming
- [#2183](https://github.com/kontourai/station/pull/2183) fix(tests): the local collaboration lab supplies the operator currency callback
- [#2177](https://github.com/kontourai/station/pull/2177) fix(orchestration): admit a room write only once its transaction can finish
- [#2178](https://github.com/kontourai/station/pull/2178) fix(tests): derive the accent ratchet's scratch roots from the gate's own list
- [#2173](https://github.com/kontourai/station/pull/2173) fix(tests): classify the settings-registry gate, and regenerate the registry the catalog outran
- [#2170](https://github.com/kontourai/station/pull/2170) fix(tests): the three nightly load failures each get a derivation where a literal was
- [#2164](https://github.com/kontourai/station/pull/2164) fix(layouts): sweeps see through symlinks and past directories named *.json
- [#2162](https://github.com/kontourai/station/pull/2162) fix(dock): the first-run nudge opens the dock only onto a known, non-empty inbox
- [#2152](https://github.com/kontourai/station/pull/2152) fix(sidebar): six gaps between the built panel and design record D3
- [#2145](https://github.com/kontourai/station/pull/2145) fix(settings): controls that persisted nothing stop claiming they do

**Other**

- [#2188](https://github.com/kontourai/station/pull/2188) refactor(regions): the placement drag is one shared gesture, and a wandered drag is no longer a click (#2185)
- [#2187](https://github.com/kontourai/station/pull/2187) refactor(pairing): operator currency revalidation is required, not optional

## 2026-09-15T21:22:59Z · nightly-desktop · 0.1.11-nightly.2449.5

- Ship SHA: `b9f05fe2666c46b9e882726a758a3c6f5a5a3a8a`
- Artifact built at: `2026-09-15T20:40:09.548Z` (not provider upload/record time)
- Artifact: github-release:nightly-desktop (cohort-finalized)
- Note: ios: TestFlight delivery success (run 35020162279)

### Changelog

Commits since `e8c0b1b` ([full sha](https://github.com/kontourai/station/commit/e8c0b1bfee9de86703c91b7bd136d229ddab056c)):

**Fixes**

- [#2142](https://github.com/kontourai/station/pull/2142) fix(ui): the light theme stops rendering dark-theme literals
- [#2141](https://github.com/kontourai/station/pull/2141) fix(ui): three components stop painting dark-theme literals the light theme cannot reach
- [#2138](https://github.com/kontourai/station/pull/2138) fix(scripts): taskkill's process-not-found status stops being a termination failure
- [#2139](https://github.com/kontourai/station/pull/2139) fix(tests): the desktop lane's per-attempt bound drops below the budgets wrapping it

**CI / workflow**

- [#2135](https://github.com/kontourai/station/pull/2135) ci(regression): a red gate enumerates every failure, not just the first

**Other**

- [#2137](https://github.com/kontourai/station/pull/2137) test(claude): two adapter assertions stop depending on the developer's environment

## 2026-09-15T21:22:56Z · nightly-android · 0.1.11-nightly.2449.5

- Ship SHA: `b9f05fe2666c46b9e882726a758a3c6f5a5a3a8a`
- Artifact built at: `2026-09-15T20:40:15.679Z` (not provider upload/record time)
- Artifact: play-internal-aab:cohort-finalized
- Note: ios: TestFlight delivery success (run 35020162279)

### Changelog

Commits since `e8c0b1b` ([full sha](https://github.com/kontourai/station/commit/e8c0b1bfee9de86703c91b7bd136d229ddab056c)):

**Fixes**

- [#2142](https://github.com/kontourai/station/pull/2142) fix(ui): the light theme stops rendering dark-theme literals
- [#2141](https://github.com/kontourai/station/pull/2141) fix(ui): three components stop painting dark-theme literals the light theme cannot reach
- [#2138](https://github.com/kontourai/station/pull/2138) fix(scripts): taskkill's process-not-found status stops being a termination failure
- [#2139](https://github.com/kontourai/station/pull/2139) fix(tests): the desktop lane's per-attempt bound drops below the budgets wrapping it

**CI / workflow**

- [#2135](https://github.com/kontourai/station/pull/2135) ci(regression): a red gate enumerates every failure, not just the first

**Other**

- [#2137](https://github.com/kontourai/station/pull/2137) test(claude): two adapter assertions stop depending on the developer's environment

## 2026-09-15T21:16:27Z · nightly-npm · 0.6.0-nightly.2449.35020162279

- Ship SHA: `b9f05fe2666c46b9e882726a758a3c6f5a5a3a8a`
- Artifact built at: `unknown` (no immutable artifact manifest binding)
- Artifact: npm:@kontourai/station-cli@0.6.0-nightly.2449.35020162279 (dist-tag nightly; artifactBuiltAt unknown)
- Note: artifactBuiltAt is null: npm package has no native artifact manifest

### Changelog

Commits since `e8c0b1b` ([full sha](https://github.com/kontourai/station/commit/e8c0b1bfee9de86703c91b7bd136d229ddab056c)):

**Fixes**

- [#2142](https://github.com/kontourai/station/pull/2142) fix(ui): the light theme stops rendering dark-theme literals
- [#2141](https://github.com/kontourai/station/pull/2141) fix(ui): three components stop painting dark-theme literals the light theme cannot reach
- [#2138](https://github.com/kontourai/station/pull/2138) fix(scripts): taskkill's process-not-found status stops being a termination failure
- [#2139](https://github.com/kontourai/station/pull/2139) fix(tests): the desktop lane's per-attempt bound drops below the budgets wrapping it

**CI / workflow**

- [#2135](https://github.com/kontourai/station/pull/2135) ci(regression): a red gate enumerates every failure, not just the first

**Other**

- [#2137](https://github.com/kontourai/station/pull/2137) test(claude): two adapter assertions stop depending on the developer's environment

## 2026-09-15T17:35:14Z · nightly-desktop · 0.1.11-nightly.2449.4

- Ship SHA: `e8c0b1bfee9de86703c91b7bd136d229ddab056c`
- Artifact built at: `2026-09-15T16:54:22.179Z` (not provider upload/record time)
- Artifact: github-release:nightly-desktop (cohort-finalized)
- Note: ios: TestFlight delivery success (run 34997120268)

### Changelog

Commits since `1701011` ([full sha](https://github.com/kontourai/station/commit/1701011de1ca23ef0fbf73f259fb3a786752ad01)):

**Fixes**

- [#2134](https://github.com/kontourai/station/pull/2134) fix(scripts): a child that exits before SIGTERM stops being a termination failure

## 2026-09-15T17:35:12Z · nightly-android · 0.1.11-nightly.2449.4

- Ship SHA: `e8c0b1bfee9de86703c91b7bd136d229ddab056c`
- Artifact built at: `2026-09-15T16:54:44.284Z` (not provider upload/record time)
- Artifact: play-internal-aab:cohort-finalized
- Note: ios: TestFlight delivery success (run 34997120268)

### Changelog

Commits since `1701011` ([full sha](https://github.com/kontourai/station/commit/1701011de1ca23ef0fbf73f259fb3a786752ad01)):

**Fixes**

- [#2134](https://github.com/kontourai/station/pull/2134) fix(scripts): a child that exits before SIGTERM stops being a termination failure

## 2026-09-15T17:28:29Z · nightly-npm · 0.6.0-nightly.2449.34997120268

- Ship SHA: `e8c0b1bfee9de86703c91b7bd136d229ddab056c`
- Artifact built at: `unknown` (no immutable artifact manifest binding)
- Artifact: npm:@kontourai/station-cli@0.6.0-nightly.2449.34997120268 (dist-tag nightly; artifactBuiltAt unknown)
- Note: artifactBuiltAt is null: npm package has no native artifact manifest

### Changelog

Commits since `1701011` ([full sha](https://github.com/kontourai/station/commit/1701011de1ca23ef0fbf73f259fb3a786752ad01)):

**Fixes**

- [#2134](https://github.com/kontourai/station/pull/2134) fix(scripts): a child that exits before SIGTERM stops being a termination failure

## 2026-09-15T16:06:17Z · nightly-desktop · 0.1.11-nightly.2449.3

- Ship SHA: `1701011de1ca23ef0fbf73f259fb3a786752ad01`
- Artifact built at: `2026-09-15T15:24:46.172Z` (not provider upload/record time)
- Artifact: github-release:nightly-desktop (cohort-finalized)
- Note: ios: TestFlight delivery success (run 34987268974)

### Changelog

Commits since `9f05d7a` ([full sha](https://github.com/kontourai/station/commit/9f05d7aa0dd78c227e53250fed973a39a3cec0c8)):

**Fixes**

- [#2132](https://github.com/kontourai/station/pull/2132) fix(backlog): a truncated read of the backlog stops passing as a clean one
- [#2129](https://github.com/kontourai/station/pull/2129) fix(search): a provider that throws stops being indistinguishable from one that timed out

**Docs**

- [#2130](https://github.com/kontourai/station/pull/2130) docs(ui): the Manage group stops advertising a destination #2065 retired

**Other**

- [#2125](https://github.com/kontourai/station/pull/2125) test(ui): the Boards row menu joins the cascade fixture, and a dropped row stops being invisible (#2113)

## 2026-09-15T16:06:14Z · nightly-android · 0.1.11-nightly.2449.3

- Ship SHA: `1701011de1ca23ef0fbf73f259fb3a786752ad01`
- Artifact built at: `2026-09-15T15:24:26.031Z` (not provider upload/record time)
- Artifact: play-internal-aab:cohort-finalized
- Note: ios: TestFlight delivery success (run 34987268974)

### Changelog

Commits since `9f05d7a` ([full sha](https://github.com/kontourai/station/commit/9f05d7aa0dd78c227e53250fed973a39a3cec0c8)):

**Fixes**

- [#2132](https://github.com/kontourai/station/pull/2132) fix(backlog): a truncated read of the backlog stops passing as a clean one
- [#2129](https://github.com/kontourai/station/pull/2129) fix(search): a provider that throws stops being indistinguishable from one that timed out

**Docs**

- [#2130](https://github.com/kontourai/station/pull/2130) docs(ui): the Manage group stops advertising a destination #2065 retired

**Other**

- [#2125](https://github.com/kontourai/station/pull/2125) test(ui): the Boards row menu joins the cascade fixture, and a dropped row stops being invisible (#2113)

## 2026-09-15T15:59:32Z · nightly-npm · 0.6.0-nightly.2449.34987268974

- Ship SHA: `1701011de1ca23ef0fbf73f259fb3a786752ad01`
- Artifact built at: `unknown` (no immutable artifact manifest binding)
- Artifact: npm:@kontourai/station-cli@0.6.0-nightly.2449.34987268974 (dist-tag nightly; artifactBuiltAt unknown)
- Note: artifactBuiltAt is null: npm package has no native artifact manifest

### Changelog

Commits since `9f05d7a` ([full sha](https://github.com/kontourai/station/commit/9f05d7aa0dd78c227e53250fed973a39a3cec0c8)):

**Fixes**

- [#2132](https://github.com/kontourai/station/pull/2132) fix(backlog): a truncated read of the backlog stops passing as a clean one
- [#2129](https://github.com/kontourai/station/pull/2129) fix(search): a provider that throws stops being indistinguishable from one that timed out

**Docs**

- [#2130](https://github.com/kontourai/station/pull/2130) docs(ui): the Manage group stops advertising a destination #2065 retired

**Other**

- [#2125](https://github.com/kontourai/station/pull/2125) test(ui): the Boards row menu joins the cascade fixture, and a dropped row stops being invisible (#2113)

## 2026-09-15T12:24:07Z · nightly-desktop · 0.1.11-nightly.2449.2

- Ship SHA: `9f05d7aa0dd78c227e53250fed973a39a3cec0c8`
- Artifact built at: `2026-09-15T11:41:31.970Z` (not provider upload/record time)
- Artifact: github-release:nightly-desktop (cohort-finalized)
- Note: ios: TestFlight delivery success (run 34963886217)

### Changelog

Commits since `f4ee278` ([full sha](https://github.com/kontourai/station/commit/f4ee278e2b47462e4f4969326f00a95f82f58530)):

**Features**

- [#2095](https://github.com/kontourai/station/pull/2095) feat(shell): Boards as a place, Review as a layout kind, and per-principal plugin visibility (#2062, #2065, #2067)
- [#2088](https://github.com/kontourai/station/pull/2088) feat(device): a shared web and desktop Device workspace pane (#1969)
- [#2087](https://github.com/kontourai/station/pull/2087) feat(regions): chat links open pull-request and file-preview panes, and an Agents pane over the background-tasks store (#2049, #2050)
- [#2084](https://github.com/kontourai/station/pull/2084) feat(shell): personal layout store, project layout chips, and presence as a footer tray (#2061, #2063, #2066)
- [#2080](https://github.com/kontourai/station/pull/2080) feat(shell): left panel as places only — destination re-section, layout owner, wider attention inbox (#2059, #2060, #2064)
- [#2075](https://github.com/kontourai/station/pull/2075) feat(regions): dock admission for the coding panes, the region "+" catalog, and openInRegion (#2047, #2048)
- [#2074](https://github.com/kontourai/station/pull/2074) feat(connections): per-connection env + config-home overrides for Claude/Codex adapters
- [#2069](https://github.com/kontourai/station/pull/2069) feat(regions): a dock region holds a tabbed set of panes (#2046)
- [#2056](https://github.com/kontourai/station/pull/2056) feat(inbox): metadata hover card on chat rows
- [#2055](https://github.com/kontourai/station/pull/2055) feat(regions): render dock occupants through a per-region pane host
- [#1634](https://github.com/kontourai/station/pull/1634) feat: admit controlled room writes before durable commit
- [#2035](https://github.com/kontourai/station/pull/2035) feat(connections): start engine device-code logins from Station
- [#1949](https://github.com/kontourai/station/pull/1949) feat(acp): honor advertised session modes
- [#2033](https://github.com/kontourai/station/pull/2033) feat(projects): expose portable identity export and attachment in the CLI
- [#2028](https://github.com/kontourai/station/pull/2028) feat(auth): offer optional OIDC alongside local Station accounts
- [#2034](https://github.com/kontourai/station/pull/2034) feat(tray): separate desktop and server update destinations
- [#2032](https://github.com/kontourai/station/pull/2032) feat(updates): route update UI by connection ownership; render comparison states truthfully
- [#2029](https://github.com/kontourai/station/pull/2029) feat(connect): carry bounded SDK requests over application channels
- [#2018](https://github.com/kontourai/station/pull/2018) feat(projects): preview invitations and preserve incoming-link intent
- [#2026](https://github.com/kontourai/station/pull/2026) feat(connections): fence virtual requests at the protected application
- [#2022](https://github.com/kontourai/station/pull/2022) feat(updates): publish server identity and provenance diagnostics
- [#2020](https://github.com/kontourai/station/pull/2020) feat(projects): run sessions from receiver-local resource bindings
- [#2015](https://github.com/kontourai/station/pull/2015) feat(updates): name desktop and server update paths distinctly
- [#2019](https://github.com/kontourai/station/pull/2019) feat(auth): continue device-bound accounts over virtual transports
- [#2012](https://github.com/kontourai/station/pull/2012) feat(connectivity): persist Station and Device signing trust
- [#1857](https://github.com/kontourai/station/pull/1857) feat(nightly): deliver Windows through Tauri NSIS and the shared desktop feed
- [#2006](https://github.com/kontourai/station/pull/2006) feat(connectivity): verify signed Station connection bindings
- [#2013](https://github.com/kontourai/station/pull/2013) feat(projects): add local accounts and invitation management
- [#2001](https://github.com/kontourai/station/pull/2001) feat(dev): qualify encrypted browser TCP relay with Pion
- [#1988](https://github.com/kontourai/station/pull/1988) feat(projects): attach portable identities to local Projects atomically
- [#1998](https://github.com/kontourai/station/pull/1998) feat(auth): support operator-installed account authentication providers
- [#1997](https://github.com/kontourai/station/pull/1997) feat(dev): verify browser encryption through a free local TURN lab
- [#1987](https://github.com/kontourai/station/pull/1987) feat(dev): add free local encrypted enrollment lab
- [#1976](https://github.com/kontourai/station/pull/1976) feat: add authenticated mobile device inspection
- [#1980](https://github.com/kontourai/station/pull/1980) feat(identity): recognize verified people across paired devices
- [#1854](https://github.com/kontourai/station/pull/1854) feat(chat): quote answer excerpts with exact source references
- [#1957](https://github.com/kontourai/station/pull/1957) feat(review): link conversations and show dependency stacks
- [#1956](https://github.com/kontourai/station/pull/1956) feat(review): finish revision-bound pull-request review
- [#1658](https://github.com/kontourai/station/pull/1658) feat: continue native Codex and Claude sessions through shared adoption

**Fixes**

- [#2127](https://github.com/kontourai/station/pull/2127) fix: clear every red the full-regression corpus has, and stop two pins rotting silently
- [#2115](https://github.com/kontourai/station/pull/2115) fix(sidebar): the Boards row menu adopts the shared menu primitive (#2083)
- [#2118](https://github.com/kontourai/station/pull/2118) fix(plugins): close the layout-route enumeration oracle, and render a causeless placeholder (#2103)
- [#2105](https://github.com/kontourai/station/pull/2105) fix(tests): the sidebar suite provides the QueryClient its real footer needs
- [#2114](https://github.com/kontourai/station/pull/2114) fix(ui): a pointer click on a menu trigger closes the menu it opened (#2081)
- [#2108](https://github.com/kontourai/station/pull/2108) fix(scripts): the pre-push gate runs every gate the CI UI-contract chain does (#2096)
- [#2107](https://github.com/kontourai/station/pull/2107) fix(tests): the plugin-host security lane had stopped testing anything
- [#2104](https://github.com/kontourai/station/pull/2104) fix(governance): review three per-principal plugin-visibility refusals (#2062, #2065, #2067)
- [#2101](https://github.com/kontourai/station/pull/2101) fix: measurements and errors that were being destroyed before anyone could read them
- [#2098](https://github.com/kontourai/station/pull/2098) fix: clear main's completion-gate reds and the follow-ups from the dock arc
- [#1672](https://github.com/kontourai/station/pull/1672) fix(ci): retain Windows settlement evidence
- [#2041](https://github.com/kontourai/station/pull/2041) fix(connect): let the device access editor grant engine sign-in
- [#1934](https://github.com/kontourai/station/pull/1934) fix(composer): show requested approval mode on the chip
- [#2003](https://github.com/kontourai/station/pull/2003) fix(chat): complete replay diagnostics and repair full-regression failures
- [#2023](https://github.com/kontourai/station/pull/2023) fix(ios): make development simulator builds pairable
- [#2011](https://github.com/kontourai/station/pull/2011) fix(android): keep chat controls above the software keyboard
- [#1989](https://github.com/kontourai/station/pull/1989) fix(projects): hold Project revision through checkout rebinding
- [#2002](https://github.com/kontourai/station/pull/2002) fix: settle desktop development process trees before exit
- [#2007](https://github.com/kontourai/station/pull/2007) fix(android): align pairing schemes across build and runtime identity
- [#2005](https://github.com/kontourai/station/pull/2005) fix(deps): keep node-pty handshake failure text informative on empty stderr
- [#1996](https://github.com/kontourai/station/pull/1996) fix: preserve Station ownership of shutdown signals
- [#1994](https://github.com/kontourai/station/pull/1994) fix: accept empty streamed pairing approvals
- [#1990](https://github.com/kontourai/station/pull/1990) fix(chat): restore cold replies and harden replay and Station editing
- [#1979](https://github.com/kontourai/station/pull/1979) fix(ci): reconcile unique complexity attribution keys
- [#1978](https://github.com/kontourai/station/pull/1978) fix(projects): preserve remote execution selection while loading
- [#1975](https://github.com/kontourai/station/pull/1975) fix(projects): compare SSH remotes without rewriting identity
- [#1962](https://github.com/kontourai/station/pull/1962) fix: preserve feedback freshness and isolate diagnostics
- [#1961](https://github.com/kontourai/station/pull/1961) fix: bound catalog discovery and own verification fixtures
- [#1960](https://github.com/kontourai/station/pull/1960) fix: close usability audit and continuation model gaps

**CI / workflow**

- [#2116](https://github.com/kontourai/station/pull/2116) ci(android): stop installing the removed SDK 'tools' package
- [#2100](https://github.com/kontourai/station/pull/2100) ci: governance, Veritas readiness and lint run everywhere, not only in nightly
- [#2051](https://github.com/kontourai/station/pull/2051) ci(deps): ignore dependabot majors blocked on migrations
- [#1966](https://github.com/kontourai/station/pull/1966) ci: review new code-health debt before merge

**Docs**

- [#2078](https://github.com/kontourai/station/pull/2078) docs(connections): warn that model proxies re-identify requests upstream
- [#2068](https://github.com/kontourai/station/pull/2068) docs(design): record shell ownership scopes, Boards, and the places-only left panel
- [#1984](https://github.com/kontourai/station/pull/1984) docs: distinguish Station access, Project membership and execution

**Other**

- [#2123](https://github.com/kontourai/station/pull/2123) test(ui): the menu family's coarse-pointer touch floor is measured, not text-pinned (#2113)
- [#2122](https://github.com/kontourai/station/pull/2122) test(ui): pin the dismiss-backdrop invariant four menus depend on (#2112)
- [#2119](https://github.com/kontourai/station/pull/2119) test(e2e): model-visibility builds and runs again (#2110)
- [#2121](https://github.com/kontourai/station/pull/2121) test(e2e): the product lane's banner and transcript reds were two fixtures asserting against states nothing produces (#2111)
- [#2117](https://github.com/kontourai/station/pull/2117) test(shell): drop two palette expectations for a destination that was removed (#2062, #2065, #2067)
- [#2106](https://github.com/kontourai/station/pull/2106) test(e2e): model the conversation pull-request and personal-Board reads, and drive the dock's tab join (#2071)
- [#2057](https://github.com/kontourai/station/pull/2057) test(regions): wait for the dock's expand control before clicking it
- [#2039](https://github.com/kontourai/station/pull/2039) build(deps): bump @kontourai/flow-agents to 6.2.0 and retire its stale esbuild approval
- [#2040](https://github.com/kontourai/station/pull/2040) build(deps): bump @napi-rs/keyring to 2.0.0 and update the CLI bundle pin
- [#2037](https://github.com/kontourai/station/pull/2037) test(app): repair AppHomeRoute after the connected-server update context
- [#2027](https://github.com/kontourai/station/pull/2027) test(projects): make the binding caller fixture portable
- [#2024](https://github.com/kontourai/station/pull/2024) test(collaboration): exercise real local accounts and Project membership
- [#1986](https://github.com/kontourai/station/pull/1986) refactor(server): remove audited unused export visibility
- [#1991](https://github.com/kontourai/station/pull/1991) test(ui): accept SkeletonList's aria-hidden status label in the initial-read contract

## 2026-09-15T12:24:03Z · nightly-android · 0.1.11-nightly.2449.2

- Ship SHA: `9f05d7aa0dd78c227e53250fed973a39a3cec0c8`
- Artifact built at: `2026-09-15T11:41:27.782Z` (not provider upload/record time)
- Artifact: play-internal-aab:cohort-finalized
- Note: ios: TestFlight delivery success (run 34963886217)

### Changelog

Commits since `f4ee278` ([full sha](https://github.com/kontourai/station/commit/f4ee278e2b47462e4f4969326f00a95f82f58530)):

**Features**

- [#2095](https://github.com/kontourai/station/pull/2095) feat(shell): Boards as a place, Review as a layout kind, and per-principal plugin visibility (#2062, #2065, #2067)
- [#2088](https://github.com/kontourai/station/pull/2088) feat(device): a shared web and desktop Device workspace pane (#1969)
- [#2087](https://github.com/kontourai/station/pull/2087) feat(regions): chat links open pull-request and file-preview panes, and an Agents pane over the background-tasks store (#2049, #2050)
- [#2084](https://github.com/kontourai/station/pull/2084) feat(shell): personal layout store, project layout chips, and presence as a footer tray (#2061, #2063, #2066)
- [#2080](https://github.com/kontourai/station/pull/2080) feat(shell): left panel as places only — destination re-section, layout owner, wider attention inbox (#2059, #2060, #2064)
- [#2075](https://github.com/kontourai/station/pull/2075) feat(regions): dock admission for the coding panes, the region "+" catalog, and openInRegion (#2047, #2048)
- [#2074](https://github.com/kontourai/station/pull/2074) feat(connections): per-connection env + config-home overrides for Claude/Codex adapters
- [#2069](https://github.com/kontourai/station/pull/2069) feat(regions): a dock region holds a tabbed set of panes (#2046)
- [#2056](https://github.com/kontourai/station/pull/2056) feat(inbox): metadata hover card on chat rows
- [#2055](https://github.com/kontourai/station/pull/2055) feat(regions): render dock occupants through a per-region pane host
- [#1634](https://github.com/kontourai/station/pull/1634) feat: admit controlled room writes before durable commit
- [#2035](https://github.com/kontourai/station/pull/2035) feat(connections): start engine device-code logins from Station
- [#1949](https://github.com/kontourai/station/pull/1949) feat(acp): honor advertised session modes
- [#2033](https://github.com/kontourai/station/pull/2033) feat(projects): expose portable identity export and attachment in the CLI
- [#2028](https://github.com/kontourai/station/pull/2028) feat(auth): offer optional OIDC alongside local Station accounts
- [#2034](https://github.com/kontourai/station/pull/2034) feat(tray): separate desktop and server update destinations
- [#2032](https://github.com/kontourai/station/pull/2032) feat(updates): route update UI by connection ownership; render comparison states truthfully
- [#2029](https://github.com/kontourai/station/pull/2029) feat(connect): carry bounded SDK requests over application channels
- [#2018](https://github.com/kontourai/station/pull/2018) feat(projects): preview invitations and preserve incoming-link intent
- [#2026](https://github.com/kontourai/station/pull/2026) feat(connections): fence virtual requests at the protected application
- [#2022](https://github.com/kontourai/station/pull/2022) feat(updates): publish server identity and provenance diagnostics
- [#2020](https://github.com/kontourai/station/pull/2020) feat(projects): run sessions from receiver-local resource bindings
- [#2015](https://github.com/kontourai/station/pull/2015) feat(updates): name desktop and server update paths distinctly
- [#2019](https://github.com/kontourai/station/pull/2019) feat(auth): continue device-bound accounts over virtual transports
- [#2012](https://github.com/kontourai/station/pull/2012) feat(connectivity): persist Station and Device signing trust
- [#1857](https://github.com/kontourai/station/pull/1857) feat(nightly): deliver Windows through Tauri NSIS and the shared desktop feed
- [#2006](https://github.com/kontourai/station/pull/2006) feat(connectivity): verify signed Station connection bindings
- [#2013](https://github.com/kontourai/station/pull/2013) feat(projects): add local accounts and invitation management
- [#2001](https://github.com/kontourai/station/pull/2001) feat(dev): qualify encrypted browser TCP relay with Pion
- [#1988](https://github.com/kontourai/station/pull/1988) feat(projects): attach portable identities to local Projects atomically
- [#1998](https://github.com/kontourai/station/pull/1998) feat(auth): support operator-installed account authentication providers
- [#1997](https://github.com/kontourai/station/pull/1997) feat(dev): verify browser encryption through a free local TURN lab
- [#1987](https://github.com/kontourai/station/pull/1987) feat(dev): add free local encrypted enrollment lab
- [#1976](https://github.com/kontourai/station/pull/1976) feat: add authenticated mobile device inspection
- [#1980](https://github.com/kontourai/station/pull/1980) feat(identity): recognize verified people across paired devices
- [#1854](https://github.com/kontourai/station/pull/1854) feat(chat): quote answer excerpts with exact source references
- [#1957](https://github.com/kontourai/station/pull/1957) feat(review): link conversations and show dependency stacks
- [#1956](https://github.com/kontourai/station/pull/1956) feat(review): finish revision-bound pull-request review
- [#1658](https://github.com/kontourai/station/pull/1658) feat: continue native Codex and Claude sessions through shared adoption

**Fixes**

- [#2127](https://github.com/kontourai/station/pull/2127) fix: clear every red the full-regression corpus has, and stop two pins rotting silently
- [#2115](https://github.com/kontourai/station/pull/2115) fix(sidebar): the Boards row menu adopts the shared menu primitive (#2083)
- [#2118](https://github.com/kontourai/station/pull/2118) fix(plugins): close the layout-route enumeration oracle, and render a causeless placeholder (#2103)
- [#2105](https://github.com/kontourai/station/pull/2105) fix(tests): the sidebar suite provides the QueryClient its real footer needs
- [#2114](https://github.com/kontourai/station/pull/2114) fix(ui): a pointer click on a menu trigger closes the menu it opened (#2081)
- [#2108](https://github.com/kontourai/station/pull/2108) fix(scripts): the pre-push gate runs every gate the CI UI-contract chain does (#2096)
- [#2107](https://github.com/kontourai/station/pull/2107) fix(tests): the plugin-host security lane had stopped testing anything
- [#2104](https://github.com/kontourai/station/pull/2104) fix(governance): review three per-principal plugin-visibility refusals (#2062, #2065, #2067)
- [#2101](https://github.com/kontourai/station/pull/2101) fix: measurements and errors that were being destroyed before anyone could read them
- [#2098](https://github.com/kontourai/station/pull/2098) fix: clear main's completion-gate reds and the follow-ups from the dock arc
- [#1672](https://github.com/kontourai/station/pull/1672) fix(ci): retain Windows settlement evidence
- [#2041](https://github.com/kontourai/station/pull/2041) fix(connect): let the device access editor grant engine sign-in
- [#1934](https://github.com/kontourai/station/pull/1934) fix(composer): show requested approval mode on the chip
- [#2003](https://github.com/kontourai/station/pull/2003) fix(chat): complete replay diagnostics and repair full-regression failures
- [#2023](https://github.com/kontourai/station/pull/2023) fix(ios): make development simulator builds pairable
- [#2011](https://github.com/kontourai/station/pull/2011) fix(android): keep chat controls above the software keyboard
- [#1989](https://github.com/kontourai/station/pull/1989) fix(projects): hold Project revision through checkout rebinding
- [#2002](https://github.com/kontourai/station/pull/2002) fix: settle desktop development process trees before exit
- [#2007](https://github.com/kontourai/station/pull/2007) fix(android): align pairing schemes across build and runtime identity
- [#2005](https://github.com/kontourai/station/pull/2005) fix(deps): keep node-pty handshake failure text informative on empty stderr
- [#1996](https://github.com/kontourai/station/pull/1996) fix: preserve Station ownership of shutdown signals
- [#1994](https://github.com/kontourai/station/pull/1994) fix: accept empty streamed pairing approvals
- [#1990](https://github.com/kontourai/station/pull/1990) fix(chat): restore cold replies and harden replay and Station editing
- [#1979](https://github.com/kontourai/station/pull/1979) fix(ci): reconcile unique complexity attribution keys
- [#1978](https://github.com/kontourai/station/pull/1978) fix(projects): preserve remote execution selection while loading
- [#1975](https://github.com/kontourai/station/pull/1975) fix(projects): compare SSH remotes without rewriting identity
- [#1962](https://github.com/kontourai/station/pull/1962) fix: preserve feedback freshness and isolate diagnostics
- [#1961](https://github.com/kontourai/station/pull/1961) fix: bound catalog discovery and own verification fixtures
- [#1960](https://github.com/kontourai/station/pull/1960) fix: close usability audit and continuation model gaps

**CI / workflow**

- [#2116](https://github.com/kontourai/station/pull/2116) ci(android): stop installing the removed SDK 'tools' package
- [#2100](https://github.com/kontourai/station/pull/2100) ci: governance, Veritas readiness and lint run everywhere, not only in nightly
- [#2051](https://github.com/kontourai/station/pull/2051) ci(deps): ignore dependabot majors blocked on migrations
- [#1966](https://github.com/kontourai/station/pull/1966) ci: review new code-health debt before merge

**Docs**

- [#2078](https://github.com/kontourai/station/pull/2078) docs(connections): warn that model proxies re-identify requests upstream
- [#2068](https://github.com/kontourai/station/pull/2068) docs(design): record shell ownership scopes, Boards, and the places-only left panel
- [#1984](https://github.com/kontourai/station/pull/1984) docs: distinguish Station access, Project membership and execution

**Other**

- [#2123](https://github.com/kontourai/station/pull/2123) test(ui): the menu family's coarse-pointer touch floor is measured, not text-pinned (#2113)
- [#2122](https://github.com/kontourai/station/pull/2122) test(ui): pin the dismiss-backdrop invariant four menus depend on (#2112)
- [#2119](https://github.com/kontourai/station/pull/2119) test(e2e): model-visibility builds and runs again (#2110)
- [#2121](https://github.com/kontourai/station/pull/2121) test(e2e): the product lane's banner and transcript reds were two fixtures asserting against states nothing produces (#2111)
- [#2117](https://github.com/kontourai/station/pull/2117) test(shell): drop two palette expectations for a destination that was removed (#2062, #2065, #2067)
- [#2106](https://github.com/kontourai/station/pull/2106) test(e2e): model the conversation pull-request and personal-Board reads, and drive the dock's tab join (#2071)
- [#2057](https://github.com/kontourai/station/pull/2057) test(regions): wait for the dock's expand control before clicking it
- [#2039](https://github.com/kontourai/station/pull/2039) build(deps): bump @kontourai/flow-agents to 6.2.0 and retire its stale esbuild approval
- [#2040](https://github.com/kontourai/station/pull/2040) build(deps): bump @napi-rs/keyring to 2.0.0 and update the CLI bundle pin
- [#2037](https://github.com/kontourai/station/pull/2037) test(app): repair AppHomeRoute after the connected-server update context
- [#2027](https://github.com/kontourai/station/pull/2027) test(projects): make the binding caller fixture portable
- [#2024](https://github.com/kontourai/station/pull/2024) test(collaboration): exercise real local accounts and Project membership
- [#1986](https://github.com/kontourai/station/pull/1986) refactor(server): remove audited unused export visibility
- [#1991](https://github.com/kontourai/station/pull/1991) test(ui): accept SkeletonList's aria-hidden status label in the initial-read contract

## 2026-09-15T12:15:41Z · nightly-npm · 0.6.0-nightly.2449.34963886217

- Ship SHA: `9f05d7aa0dd78c227e53250fed973a39a3cec0c8`
- Artifact built at: `unknown` (no immutable artifact manifest binding)
- Artifact: npm:@kontourai/station-cli@0.6.0-nightly.2449.34963886217 (dist-tag nightly; artifactBuiltAt unknown)
- Note: artifactBuiltAt is null: npm package has no native artifact manifest

### Changelog

Commits since `eb93cd4` ([full sha](https://github.com/kontourai/station/commit/eb93cd47213c8c6eebb54621aee911ae4a220a68)):

**Features**

- [#2095](https://github.com/kontourai/station/pull/2095) feat(shell): Boards as a place, Review as a layout kind, and per-principal plugin visibility (#2062, #2065, #2067)
- [#2088](https://github.com/kontourai/station/pull/2088) feat(device): a shared web and desktop Device workspace pane (#1969)
- [#2087](https://github.com/kontourai/station/pull/2087) feat(regions): chat links open pull-request and file-preview panes, and an Agents pane over the background-tasks store (#2049, #2050)
- [#2084](https://github.com/kontourai/station/pull/2084) feat(shell): personal layout store, project layout chips, and presence as a footer tray (#2061, #2063, #2066)
- [#2080](https://github.com/kontourai/station/pull/2080) feat(shell): left panel as places only — destination re-section, layout owner, wider attention inbox (#2059, #2060, #2064)
- [#2075](https://github.com/kontourai/station/pull/2075) feat(regions): dock admission for the coding panes, the region "+" catalog, and openInRegion (#2047, #2048)
- [#2074](https://github.com/kontourai/station/pull/2074) feat(connections): per-connection env + config-home overrides for Claude/Codex adapters
- [#2069](https://github.com/kontourai/station/pull/2069) feat(regions): a dock region holds a tabbed set of panes (#2046)
- [#2056](https://github.com/kontourai/station/pull/2056) feat(inbox): metadata hover card on chat rows
- [#2055](https://github.com/kontourai/station/pull/2055) feat(regions): render dock occupants through a per-region pane host
- [#1634](https://github.com/kontourai/station/pull/1634) feat: admit controlled room writes before durable commit
- [#2035](https://github.com/kontourai/station/pull/2035) feat(connections): start engine device-code logins from Station
- [#1949](https://github.com/kontourai/station/pull/1949) feat(acp): honor advertised session modes
- [#2033](https://github.com/kontourai/station/pull/2033) feat(projects): expose portable identity export and attachment in the CLI
- [#2028](https://github.com/kontourai/station/pull/2028) feat(auth): offer optional OIDC alongside local Station accounts
- [#2034](https://github.com/kontourai/station/pull/2034) feat(tray): separate desktop and server update destinations
- [#2032](https://github.com/kontourai/station/pull/2032) feat(updates): route update UI by connection ownership; render comparison states truthfully
- [#2029](https://github.com/kontourai/station/pull/2029) feat(connect): carry bounded SDK requests over application channels
- [#2018](https://github.com/kontourai/station/pull/2018) feat(projects): preview invitations and preserve incoming-link intent
- [#2026](https://github.com/kontourai/station/pull/2026) feat(connections): fence virtual requests at the protected application
- [#2022](https://github.com/kontourai/station/pull/2022) feat(updates): publish server identity and provenance diagnostics
- [#2020](https://github.com/kontourai/station/pull/2020) feat(projects): run sessions from receiver-local resource bindings
- [#2015](https://github.com/kontourai/station/pull/2015) feat(updates): name desktop and server update paths distinctly
- [#2019](https://github.com/kontourai/station/pull/2019) feat(auth): continue device-bound accounts over virtual transports
- [#2012](https://github.com/kontourai/station/pull/2012) feat(connectivity): persist Station and Device signing trust
- [#1857](https://github.com/kontourai/station/pull/1857) feat(nightly): deliver Windows through Tauri NSIS and the shared desktop feed
- [#2006](https://github.com/kontourai/station/pull/2006) feat(connectivity): verify signed Station connection bindings
- [#2013](https://github.com/kontourai/station/pull/2013) feat(projects): add local accounts and invitation management
- [#2001](https://github.com/kontourai/station/pull/2001) feat(dev): qualify encrypted browser TCP relay with Pion
- [#1988](https://github.com/kontourai/station/pull/1988) feat(projects): attach portable identities to local Projects atomically
- [#1998](https://github.com/kontourai/station/pull/1998) feat(auth): support operator-installed account authentication providers
- [#1997](https://github.com/kontourai/station/pull/1997) feat(dev): verify browser encryption through a free local TURN lab
- [#1987](https://github.com/kontourai/station/pull/1987) feat(dev): add free local encrypted enrollment lab
- [#1976](https://github.com/kontourai/station/pull/1976) feat: add authenticated mobile device inspection
- [#1980](https://github.com/kontourai/station/pull/1980) feat(identity): recognize verified people across paired devices
- [#1854](https://github.com/kontourai/station/pull/1854) feat(chat): quote answer excerpts with exact source references
- [#1957](https://github.com/kontourai/station/pull/1957) feat(review): link conversations and show dependency stacks
- [#1956](https://github.com/kontourai/station/pull/1956) feat(review): finish revision-bound pull-request review
- [#1658](https://github.com/kontourai/station/pull/1658) feat: continue native Codex and Claude sessions through shared adoption

**Fixes**

- [#2127](https://github.com/kontourai/station/pull/2127) fix: clear every red the full-regression corpus has, and stop two pins rotting silently
- [#2115](https://github.com/kontourai/station/pull/2115) fix(sidebar): the Boards row menu adopts the shared menu primitive (#2083)
- [#2118](https://github.com/kontourai/station/pull/2118) fix(plugins): close the layout-route enumeration oracle, and render a causeless placeholder (#2103)
- [#2105](https://github.com/kontourai/station/pull/2105) fix(tests): the sidebar suite provides the QueryClient its real footer needs
- [#2114](https://github.com/kontourai/station/pull/2114) fix(ui): a pointer click on a menu trigger closes the menu it opened (#2081)
- [#2108](https://github.com/kontourai/station/pull/2108) fix(scripts): the pre-push gate runs every gate the CI UI-contract chain does (#2096)
- [#2107](https://github.com/kontourai/station/pull/2107) fix(tests): the plugin-host security lane had stopped testing anything
- [#2104](https://github.com/kontourai/station/pull/2104) fix(governance): review three per-principal plugin-visibility refusals (#2062, #2065, #2067)
- [#2101](https://github.com/kontourai/station/pull/2101) fix: measurements and errors that were being destroyed before anyone could read them
- [#2098](https://github.com/kontourai/station/pull/2098) fix: clear main's completion-gate reds and the follow-ups from the dock arc
- [#1672](https://github.com/kontourai/station/pull/1672) fix(ci): retain Windows settlement evidence
- [#2041](https://github.com/kontourai/station/pull/2041) fix(connect): let the device access editor grant engine sign-in
- [#1934](https://github.com/kontourai/station/pull/1934) fix(composer): show requested approval mode on the chip
- [#2003](https://github.com/kontourai/station/pull/2003) fix(chat): complete replay diagnostics and repair full-regression failures
- [#2023](https://github.com/kontourai/station/pull/2023) fix(ios): make development simulator builds pairable
- [#2011](https://github.com/kontourai/station/pull/2011) fix(android): keep chat controls above the software keyboard
- [#1989](https://github.com/kontourai/station/pull/1989) fix(projects): hold Project revision through checkout rebinding
- [#2002](https://github.com/kontourai/station/pull/2002) fix: settle desktop development process trees before exit
- [#2007](https://github.com/kontourai/station/pull/2007) fix(android): align pairing schemes across build and runtime identity
- [#2005](https://github.com/kontourai/station/pull/2005) fix(deps): keep node-pty handshake failure text informative on empty stderr
- [#1996](https://github.com/kontourai/station/pull/1996) fix: preserve Station ownership of shutdown signals
- [#1994](https://github.com/kontourai/station/pull/1994) fix: accept empty streamed pairing approvals
- [#1990](https://github.com/kontourai/station/pull/1990) fix(chat): restore cold replies and harden replay and Station editing
- [#1979](https://github.com/kontourai/station/pull/1979) fix(ci): reconcile unique complexity attribution keys
- [#1978](https://github.com/kontourai/station/pull/1978) fix(projects): preserve remote execution selection while loading
- [#1975](https://github.com/kontourai/station/pull/1975) fix(projects): compare SSH remotes without rewriting identity
- [#1962](https://github.com/kontourai/station/pull/1962) fix: preserve feedback freshness and isolate diagnostics
- [#1961](https://github.com/kontourai/station/pull/1961) fix: bound catalog discovery and own verification fixtures
- [#1960](https://github.com/kontourai/station/pull/1960) fix: close usability audit and continuation model gaps

**CI / workflow**

- [#2116](https://github.com/kontourai/station/pull/2116) ci(android): stop installing the removed SDK 'tools' package
- [#2100](https://github.com/kontourai/station/pull/2100) ci: governance, Veritas readiness and lint run everywhere, not only in nightly
- [#2051](https://github.com/kontourai/station/pull/2051) ci(deps): ignore dependabot majors blocked on migrations
- [#1966](https://github.com/kontourai/station/pull/1966) ci: review new code-health debt before merge

**Docs**

- [#2078](https://github.com/kontourai/station/pull/2078) docs(connections): warn that model proxies re-identify requests upstream
- [#2068](https://github.com/kontourai/station/pull/2068) docs(design): record shell ownership scopes, Boards, and the places-only left panel
- [#1984](https://github.com/kontourai/station/pull/1984) docs: distinguish Station access, Project membership and execution

**Other**

- [#2123](https://github.com/kontourai/station/pull/2123) test(ui): the menu family's coarse-pointer touch floor is measured, not text-pinned (#2113)
- [#2122](https://github.com/kontourai/station/pull/2122) test(ui): pin the dismiss-backdrop invariant four menus depend on (#2112)
- [#2119](https://github.com/kontourai/station/pull/2119) test(e2e): model-visibility builds and runs again (#2110)
- [#2121](https://github.com/kontourai/station/pull/2121) test(e2e): the product lane's banner and transcript reds were two fixtures asserting against states nothing produces (#2111)
- [#2117](https://github.com/kontourai/station/pull/2117) test(shell): drop two palette expectations for a destination that was removed (#2062, #2065, #2067)
- [#2106](https://github.com/kontourai/station/pull/2106) test(e2e): model the conversation pull-request and personal-Board reads, and drive the dock's tab join (#2071)
- [#2057](https://github.com/kontourai/station/pull/2057) test(regions): wait for the dock's expand control before clicking it
- [#2039](https://github.com/kontourai/station/pull/2039) build(deps): bump @kontourai/flow-agents to 6.2.0 and retire its stale esbuild approval
- [#2040](https://github.com/kontourai/station/pull/2040) build(deps): bump @napi-rs/keyring to 2.0.0 and update the CLI bundle pin
- [#2037](https://github.com/kontourai/station/pull/2037) test(app): repair AppHomeRoute after the connected-server update context
- [#2027](https://github.com/kontourai/station/pull/2027) test(projects): make the binding caller fixture portable
- [#2024](https://github.com/kontourai/station/pull/2024) test(collaboration): exercise real local accounts and Project membership
- [#1986](https://github.com/kontourai/station/pull/1986) refactor(server): remove audited unused export visibility
- [#1991](https://github.com/kontourai/station/pull/1991) test(ui): accept SkeletonList's aria-hidden status label in the initial-read contract

## 2026-09-12T16:03:48Z · nightly-npm · 0.6.0-nightly.2446.34702144379

- Ship SHA: `eb93cd47213c8c6eebb54621aee911ae4a220a68`
- Artifact built at: `unknown` (no immutable artifact manifest binding)
- Artifact: npm:@kontourai/station-cli@0.6.0-nightly.2446.34702144379 (dist-tag nightly; artifactBuiltAt unknown)
- Note: artifactBuiltAt is null: npm package has no native artifact manifest

### Changelog

Commits since `f4ee278` ([full sha](https://github.com/kontourai/station/commit/f4ee278e2b47462e4f4969326f00a95f82f58530)):

_No user-visible changes recorded for this slice._

## 2026-09-12T15:12:53Z · nightly-desktop · 0.1.11-nightly.2446

- Ship SHA: `f4ee278e2b47462e4f4969326f00a95f82f58530`
- Artifact built at: `2026-09-12T14:33:40.077Z` (not provider upload/record time)
- Artifact: github-release:nightly-desktop (cohort-finalized)
- Note: ios: TestFlight delivery success (run 34699081987)

### Changelog

Commits since `71e0381` ([full sha](https://github.com/kontourai/station/commit/71e0381f78e903cd81fc9d2d21266986103f6f39)):

**Fixes**

- [#1859](https://github.com/kontourai/station/pull/1859) fix: close residual dependency, lifecycle, and test gaps

## 2026-09-12T15:12:50Z · nightly-android · 0.1.11-nightly.2446

- Ship SHA: `f4ee278e2b47462e4f4969326f00a95f82f58530`
- Artifact built at: `2026-09-12T14:35:23.777Z` (not provider upload/record time)
- Artifact: play-internal-aab:cohort-finalized
- Note: ios: TestFlight delivery success (run 34699081987)

### Changelog

Commits since `71e0381` ([full sha](https://github.com/kontourai/station/commit/71e0381f78e903cd81fc9d2d21266986103f6f39)):

**Fixes**

- [#1859](https://github.com/kontourai/station/pull/1859) fix: close residual dependency, lifecycle, and test gaps

## 2026-09-12T15:05:54Z · nightly-npm · 0.6.0-nightly.2446.34699081987

- Ship SHA: `f4ee278e2b47462e4f4969326f00a95f82f58530`
- Artifact built at: `unknown` (no immutable artifact manifest binding)
- Artifact: npm:@kontourai/station-cli@0.6.0-nightly.2446.34699081987 (dist-tag nightly; artifactBuiltAt unknown)
- Note: artifactBuiltAt is null: npm package has no native artifact manifest

### Changelog

Commits since `e330d3e` ([full sha](https://github.com/kontourai/station/commit/e330d3ee74290a4c4649a6eecdb4be8a5d961f1c)):

**Fixes**

- [#1859](https://github.com/kontourai/station/pull/1859) fix: close residual dependency, lifecycle, and test gaps

## 2026-09-12T11:13:24Z · nightly-npm · 0.6.0-nightly.2446.34688699784

- Ship SHA: `e330d3ee74290a4c4649a6eecdb4be8a5d961f1c`
- Artifact built at: `unknown` (no immutable artifact manifest binding)
- Artifact: npm:@kontourai/station-cli@0.6.0-nightly.2446.34688699784 (dist-tag nightly; artifactBuiltAt unknown)
- Note: artifactBuiltAt is null: npm package has no native artifact manifest

### Changelog

Commits since `6ed7890` ([full sha](https://github.com/kontourai/station/commit/6ed78908e3992fabe492cf91178d4a27ac15680f)):

_No user-visible changes recorded for this slice._

## 2026-09-12T04:47:15Z · nightly-npm · 0.6.0-nightly.2446.34672535343

- Ship SHA: `6ed78908e3992fabe492cf91178d4a27ac15680f`
- Artifact built at: `unknown` (no immutable artifact manifest binding)
- Artifact: npm:@kontourai/station-cli@0.6.0-nightly.2446.34672535343 (dist-tag nightly; artifactBuiltAt unknown)
- Note: artifactBuiltAt is null: npm package has no native artifact manifest

### Changelog

Commits since `71e0381` ([full sha](https://github.com/kontourai/station/commit/71e0381f78e903cd81fc9d2d21266986103f6f39)):

_No user-visible changes recorded for this slice._

## 2026-09-12T00:02:24Z · nightly-desktop · 0.1.11-nightly.2445.8

- Ship SHA: `71e0381f78e903cd81fc9d2d21266986103f6f39`
- Artifact built at: `2026-09-11T23:23:28.092Z` (not provider upload/record time)
- Artifact: github-release:nightly-desktop (cohort-finalized)
- Note: ios: TestFlight delivery success (run 34657340502)

### Changelog

Commits since `4e7ccc7` ([full sha](https://github.com/kontourai/station/commit/4e7ccc76b9cab9335d600333ec4256e180611ba3)):

**Features**

- [#1953](https://github.com/kontourai/station/pull/1953) feat(chat): session tape replay in the live dock
- [#1936](https://github.com/kontourai/station/pull/1936) feat(ui): collapse consecutive tool calls to one updating line
- [#1858](https://github.com/kontourai/station/pull/1858) feat(chat): drop sidebar files into the destination draft

**Fixes**

- [#1954](https://github.com/kontourai/station/pull/1954) fix(ui): guard unsaved engine connection edits
- [#1951](https://github.com/kontourai/station/pull/1951) fix(engines): inherit Claude/Codex approval defaults (#1950)
- [#1947](https://github.com/kontourai/station/pull/1947) fix(ui): make the connection page say what is actually wrong, and on which machine

**Other**

- [#1955](https://github.com/kontourai/station/pull/1955) test(ui): restore the full-regression lane on main
- [#1948](https://github.com/kontourai/station/pull/1948) refactor(ui): one readiness notice for every kind of connection
- [#1866](https://github.com/kontourai/station/pull/1866) build(deps): bump ai from 6.0.235 to 6.0.280
- [#1922](https://github.com/kontourai/station/pull/1922) build(deps): bump dirs from 6.0.0 to 7.0.0 in /src-desktop
- [#1926](https://github.com/kontourai/station/pull/1926) build(deps-dev): bump node-gyp from 11.5.0 to 13.0.2
- [#1929](https://github.com/kontourai/station/pull/1929) build(deps): bump the desktop-crates group across 1 directory with 3 updates

## 2026-09-12T00:02:22Z · nightly-android · 0.1.11-nightly.2445.8

- Ship SHA: `71e0381f78e903cd81fc9d2d21266986103f6f39`
- Artifact built at: `2026-09-11T23:23:18.976Z` (not provider upload/record time)
- Artifact: play-internal-aab:cohort-finalized
- Note: ios: TestFlight delivery success (run 34657340502)

### Changelog

Commits since `4e7ccc7` ([full sha](https://github.com/kontourai/station/commit/4e7ccc76b9cab9335d600333ec4256e180611ba3)):

**Features**

- [#1953](https://github.com/kontourai/station/pull/1953) feat(chat): session tape replay in the live dock
- [#1936](https://github.com/kontourai/station/pull/1936) feat(ui): collapse consecutive tool calls to one updating line
- [#1858](https://github.com/kontourai/station/pull/1858) feat(chat): drop sidebar files into the destination draft

**Fixes**

- [#1954](https://github.com/kontourai/station/pull/1954) fix(ui): guard unsaved engine connection edits
- [#1951](https://github.com/kontourai/station/pull/1951) fix(engines): inherit Claude/Codex approval defaults (#1950)
- [#1947](https://github.com/kontourai/station/pull/1947) fix(ui): make the connection page say what is actually wrong, and on which machine

**Other**

- [#1955](https://github.com/kontourai/station/pull/1955) test(ui): restore the full-regression lane on main
- [#1948](https://github.com/kontourai/station/pull/1948) refactor(ui): one readiness notice for every kind of connection
- [#1866](https://github.com/kontourai/station/pull/1866) build(deps): bump ai from 6.0.235 to 6.0.280
- [#1922](https://github.com/kontourai/station/pull/1922) build(deps): bump dirs from 6.0.0 to 7.0.0 in /src-desktop
- [#1926](https://github.com/kontourai/station/pull/1926) build(deps-dev): bump node-gyp from 11.5.0 to 13.0.2
- [#1929](https://github.com/kontourai/station/pull/1929) build(deps): bump the desktop-crates group across 1 directory with 3 updates

## 2026-09-11T23:55:13Z · nightly-npm · 0.6.0-nightly.2445.34657340502

- Ship SHA: `71e0381f78e903cd81fc9d2d21266986103f6f39`
- Artifact built at: `unknown` (no immutable artifact manifest binding)
- Artifact: npm:@kontourai/station-cli@0.6.0-nightly.2445.34657340502 (dist-tag nightly; artifactBuiltAt unknown)
- Note: artifactBuiltAt is null: npm package has no native artifact manifest

### Changelog

Commits since `4e7ccc7` ([full sha](https://github.com/kontourai/station/commit/4e7ccc76b9cab9335d600333ec4256e180611ba3)):

**Features**

- [#1953](https://github.com/kontourai/station/pull/1953) feat(chat): session tape replay in the live dock
- [#1936](https://github.com/kontourai/station/pull/1936) feat(ui): collapse consecutive tool calls to one updating line
- [#1858](https://github.com/kontourai/station/pull/1858) feat(chat): drop sidebar files into the destination draft

**Fixes**

- [#1954](https://github.com/kontourai/station/pull/1954) fix(ui): guard unsaved engine connection edits
- [#1951](https://github.com/kontourai/station/pull/1951) fix(engines): inherit Claude/Codex approval defaults (#1950)
- [#1947](https://github.com/kontourai/station/pull/1947) fix(ui): make the connection page say what is actually wrong, and on which machine

**Other**

- [#1955](https://github.com/kontourai/station/pull/1955) test(ui): restore the full-regression lane on main
- [#1948](https://github.com/kontourai/station/pull/1948) refactor(ui): one readiness notice for every kind of connection
- [#1866](https://github.com/kontourai/station/pull/1866) build(deps): bump ai from 6.0.235 to 6.0.280
- [#1922](https://github.com/kontourai/station/pull/1922) build(deps): bump dirs from 6.0.0 to 7.0.0 in /src-desktop
- [#1926](https://github.com/kontourai/station/pull/1926) build(deps-dev): bump node-gyp from 11.5.0 to 13.0.2
- [#1929](https://github.com/kontourai/station/pull/1929) build(deps): bump the desktop-crates group across 1 directory with 3 updates

## 2026-09-11T11:49:49Z · nightly-desktop · 0.1.11-nightly.2445.5

- Ship SHA: `4e7ccc76b9cab9335d600333ec4256e180611ba3`
- Artifact built at: `2026-09-11T11:11:27.612Z` (not provider upload/record time)
- Artifact: github-release:nightly-desktop (cohort-finalized)
- Note: ios: TestFlight delivery success (run 34592166222)

### Changelog

Commits since `49cfa59` ([full sha](https://github.com/kontourai/station/commit/49cfa59dd6d037208595040721e0e7bbff114840)):

**Features**

- [#1909](https://github.com/kontourai/station/pull/1909) feat(subagents): stop one subagent without killing its siblings (#1877)
- [#1908](https://github.com/kontourai/station/pull/1908) feat(contracts): declare per-engine subagent observability and control (#1877)
- [#1906](https://github.com/kontourai/station/pull/1906) feat(subagents): enable progress summaries and track spawn depth (#1877)
- [#1856](https://github.com/kontourai/station/pull/1856) feat(connect): invite phones to the selected Station from onboarding
- [#1855](https://github.com/kontourai/station/pull/1855) feat(attention): answer exact input requests with staged files
- [#1853](https://github.com/kontourai/station/pull/1853) feat(ui): keep copy reachable after long code blocks
- [#1852](https://github.com/kontourai/station/pull/1852) feat(ui): change provider model visibility in bulk
- [#1851](https://github.com/kontourai/station/pull/1851) feat(ui): inspect images with zoom and pan

**Fixes**

- [#1898](https://github.com/kontourai/station/pull/1898) fix(ci): pin secret-scan at the reviewed revision that retries its download (#1337)
- [#1930](https://github.com/kontourai/station/pull/1930) fix(config): restore the .veritas formatter exclusion to the glob form
- [#1920](https://github.com/kontourai/station/pull/1920) fix(tests): repair two more latent main-reds the local full-regression peel surfaced
- [#1916](https://github.com/kontourai/station/pull/1916) fix(tests): take createConsoleHubServer from the console root export
- [#1912](https://github.com/kontourai/station/pull/1912) fix(test): assert the coordinator snapshot that satisfied the wait
- [#1911](https://github.com/kontourai/station/pull/1911) fix(verification): re-measure the pin-scan ratchet after #1836 moved its pins; declare the #1855 input-request pairing leaf
- [#1905](https://github.com/kontourai/station/pull/1905) fix(subagents): publish one attributable settle per subagent (#1892)
- [#1904](https://github.com/kontourai/station/pull/1904) fix(ui): say 'a Station' where an instance is meant; bind the copy and workflow ratchets to PR selection
- [#1891](https://github.com/kontourai/station/pull/1891) fix(subagents): carry the SDK output_file and usage on a task settle (#1879)
- [#1902](https://github.com/kontourai/station/pull/1902) fix(verification): resolve the three main-reds the nightly uncovered under the docs break
- [#1887](https://github.com/kontourai/station/pull/1887) fix(subagents): publish the live task registry on every mutation (#1877)
- [#1897](https://github.com/kontourai/station/pull/1897) fix(hygiene): name transfer-gate baselines in the worktree inventory (#516)
- [#1896](https://github.com/kontourai/station/pull/1896) fix(docs): document the open verb; enforce CLI-doc parity on the PR lane
- [#1893](https://github.com/kontourai/station/pull/1893) fix(veritas): restore the attested protected-standards bytes (#1888)
- [#1836](https://github.com/kontourai/station/pull/1836) fix: harden Station runtime, desktop updates, and verification
- [#1872](https://github.com/kontourai/station/pull/1872) fix(deps): return jni to 0.21.1 until android_dns is migrated (#1871)
- [#1863](https://github.com/kontourai/station/pull/1863) fix(ci): read the pnpm bootstrap pin from one reviewed constant (#1042)
- [#1860](https://github.com/kontourai/station/pull/1860) fix(ci): resolve Android build-tools binaries by path, not PATH (#1322)
- [#1861](https://github.com/kontourai/station/pull/1861) fix(ci): identify the fast-checks concurrency group by commit, not by PR (#1445)
- [#1839](https://github.com/kontourai/station/pull/1839) fix(desktop): keep local browser access available through the tray
- [#1841](https://github.com/kontourai/station/pull/1841) fix(ui): align mobile chat context and repair command menus
- [#1840](https://github.com/kontourai/station/pull/1840) fix(ui): drop the build age from the sidebar wordmark
- [#1838](https://github.com/kontourai/station/pull/1838) fix(scripts): report the ci:fast budget kill's own cause, not a scanned line
- [#1837](https://github.com/kontourai/station/pull/1837) fix(runtime): hold the home lease until the adoption writer settles
- [#1795](https://github.com/kontourai/station/pull/1795) fix: unify chat UX and repair local and mobile access
- [#1826](https://github.com/kontourai/station/pull/1826) fix(nightly): derive the native ledger changelog from real history
- [#1824](https://github.com/kontourai/station/pull/1824) fix(scripts): select the tests that pin source by path
- [#1822](https://github.com/kontourai/station/pull/1822) fix(ci): comment on the main-health tracker when the state changes, not on every red run
- [#1820](https://github.com/kontourai/station/pull/1820) fix(deps): bump esbuild to 0.28.2 and approve the copies its exact-pin split materializes (#1719)
- [#1819](https://github.com/kontourai/station/pull/1819) fix(icons): canonicalize icns member order so regeneration is byte-stable (#1797)
- [#1813](https://github.com/kontourai/station/pull/1813) fix(scripts): bound the link-local detector's first group the way #1804 bounded the ULA one

**CI / workflow**

- [#1889](https://github.com/kontourai/station/pull/1889) ci: hold the Android toolchain pins and declare every main-only lane
- [#1874](https://github.com/kontourai/station/pull/1874) ci: type-check the Android-only code paths on pull requests

**Other**

- [#1932](https://github.com/kontourai/station/pull/1932) build(basis): re-ground the MCP App resource budgets to measured sizes
- [#1737](https://github.com/kontourai/station/pull/1737) build(deps-dev): bump commander from 11.1.0 to 15.0.0
- [#1886](https://github.com/kontourai/station/pull/1886) build(deps): bump zod from 4.4.3 to 4.5.4
- [#1914](https://github.com/kontourai/station/pull/1914) test(verification): pin the path-read census by identity; report what actually ran (#1911)
- [#1928](https://github.com/kontourai/station/pull/1928) test(cli): repoint the stale triage-help assertion at its successor (#1795)
- [#1880](https://github.com/kontourai/station/pull/1880) build(deps): bump tauri-plugin-wdio-webdriver from 1.3.0 to 1.4.0 in /src-desktop
- [#1918](https://github.com/kontourai/station/pull/1918) chore(deps): group minor/patch bumps to cut merge-queue serialization
- [#1917](https://github.com/kontourai/station/pull/1917) test(chat): stub ResizeObserver for the highlight suite (#1853)
- [#1882](https://github.com/kontourai/station/pull/1882) build(deps): bump ureq from 3.4.0 to 3.4.1 in /src-desktop
- [#1881](https://github.com/kontourai/station/pull/1881) build(deps): bump tauri-plugin-haptics in /src-desktop
- [#1913](https://github.com/kontourai/station/pull/1913) test(verification): put the two whole-repo census guards on the prepush floor (#1911)
- [#1727](https://github.com/kontourai/station/pull/1727) build(deps): bump tauri-plugin-updater from 2.10.1 to 2.11.0 in /src-desktop
- [#1725](https://github.com/kontourai/station/pull/1725) build(deps): bump pnpm/setup from 2.0.0 to 2.1.0
- [#1890](https://github.com/kontourai/station/pull/1890) test(providers): add muse to the image-input declaration join (#1877)
- [#1873](https://github.com/kontourai/station/pull/1873) chore(nightly): schedule the cohort every six hours
- [#1729](https://github.com/kontourai/station/pull/1729) build(deps): bump tauri-plugin-notification from 2.3.3 to 2.4.0 in /src-desktop
- [#1869](https://github.com/kontourai/station/pull/1869) build(deps): bump google-auth-library from 10.9.1 to 11.0.2
- [#1868](https://github.com/kontourai/station/pull/1868) build(deps): bump @tauri-apps/plugin-deep-link from 2.4.9 to 2.4.10
- [#1867](https://github.com/kontourai/station/pull/1867) build(deps-dev): bump jsdom from 29.1.1 to 30.0.1
- [#1864](https://github.com/kontourai/station/pull/1864) build(deps): bump changesets/action from 2.1.1 to 2.1.2
- [#1862](https://github.com/kontourai/station/pull/1862) test(ios): recover a dropped WKWebView tap instead of asserting once (#1174)
- [#1787](https://github.com/kontourai/station/pull/1787) refactor: drop the export keyword on 949 symbols nothing imports
- [#1722](https://github.com/kontourai/station/pull/1722) build(deps): bump kontourai/flow-agents/.github/actions/codex-pr-review
- [#1723](https://github.com/kontourai/station/pull/1723) build(deps): bump docker/setup-qemu-action from 4.2.0 to 4.3.0
- [#1724](https://github.com/kontourai/station/pull/1724) build(deps): bump tauri-plugin-deep-link in /src-desktop
- [#1726](https://github.com/kontourai/station/pull/1726) build(deps): bump jni from 0.21.1 to 0.22.4 in /src-desktop
- [#1728](https://github.com/kontourai/station/pull/1728) build(deps): bump tauri-plugin-log from 2.9.0 to 2.9.1 in /src-desktop
- [#1731](https://github.com/kontourai/station/pull/1731) build(deps): bump Swatinem/rust-cache
- [#1733](https://github.com/kontourai/station/pull/1733) build(deps): bump the aws group across 1 directory with 6 updates
- [#1735](https://github.com/kontourai/station/pull/1735) build(deps): bump @tauri-apps/plugin-haptics from 2.3.2 to 2.3.3
- [#1736](https://github.com/kontourai/station/pull/1736) build(deps-dev): bump @biomejs/biome from 2.5.11 to 2.5.12
- [#1738](https://github.com/kontourai/station/pull/1738) build(deps-dev): bump fallow from 3.19.0 to 3.22.0
- [#1739](https://github.com/kontourai/station/pull/1739) build(deps-dev): bump @kontourai/console from 0.3.0 to 2.8.0
- [#1741](https://github.com/kontourai/station/pull/1741) build(deps): bump @kontourai/surface from 2.18.0 to 3.2.0
- [#1828](https://github.com/kontourai/station/pull/1828) build(deps): bump dompurify from 3.4.13 to 3.4.15
- [#1842](https://github.com/kontourai/station/pull/1842) chore(backlog): stop deriving P1 from the bug label
- [#1821](https://github.com/kontourai/station/pull/1821) test: own test temp roots instead of shared fixed paths

## 2026-09-11T11:49:47Z · nightly-android · 0.1.11-nightly.2445.5

- Ship SHA: `4e7ccc76b9cab9335d600333ec4256e180611ba3`
- Artifact built at: `2026-09-11T11:11:41.191Z` (not provider upload/record time)
- Artifact: play-internal-aab:cohort-finalized
- Note: ios: TestFlight delivery success (run 34592166222)

### Changelog

Commits since `49cfa59` ([full sha](https://github.com/kontourai/station/commit/49cfa59dd6d037208595040721e0e7bbff114840)):

**Features**

- [#1909](https://github.com/kontourai/station/pull/1909) feat(subagents): stop one subagent without killing its siblings (#1877)
- [#1908](https://github.com/kontourai/station/pull/1908) feat(contracts): declare per-engine subagent observability and control (#1877)
- [#1906](https://github.com/kontourai/station/pull/1906) feat(subagents): enable progress summaries and track spawn depth (#1877)
- [#1856](https://github.com/kontourai/station/pull/1856) feat(connect): invite phones to the selected Station from onboarding
- [#1855](https://github.com/kontourai/station/pull/1855) feat(attention): answer exact input requests with staged files
- [#1853](https://github.com/kontourai/station/pull/1853) feat(ui): keep copy reachable after long code blocks
- [#1852](https://github.com/kontourai/station/pull/1852) feat(ui): change provider model visibility in bulk
- [#1851](https://github.com/kontourai/station/pull/1851) feat(ui): inspect images with zoom and pan

**Fixes**

- [#1898](https://github.com/kontourai/station/pull/1898) fix(ci): pin secret-scan at the reviewed revision that retries its download (#1337)
- [#1930](https://github.com/kontourai/station/pull/1930) fix(config): restore the .veritas formatter exclusion to the glob form
- [#1920](https://github.com/kontourai/station/pull/1920) fix(tests): repair two more latent main-reds the local full-regression peel surfaced
- [#1916](https://github.com/kontourai/station/pull/1916) fix(tests): take createConsoleHubServer from the console root export
- [#1912](https://github.com/kontourai/station/pull/1912) fix(test): assert the coordinator snapshot that satisfied the wait
- [#1911](https://github.com/kontourai/station/pull/1911) fix(verification): re-measure the pin-scan ratchet after #1836 moved its pins; declare the #1855 input-request pairing leaf
- [#1905](https://github.com/kontourai/station/pull/1905) fix(subagents): publish one attributable settle per subagent (#1892)
- [#1904](https://github.com/kontourai/station/pull/1904) fix(ui): say 'a Station' where an instance is meant; bind the copy and workflow ratchets to PR selection
- [#1891](https://github.com/kontourai/station/pull/1891) fix(subagents): carry the SDK output_file and usage on a task settle (#1879)
- [#1902](https://github.com/kontourai/station/pull/1902) fix(verification): resolve the three main-reds the nightly uncovered under the docs break
- [#1887](https://github.com/kontourai/station/pull/1887) fix(subagents): publish the live task registry on every mutation (#1877)
- [#1897](https://github.com/kontourai/station/pull/1897) fix(hygiene): name transfer-gate baselines in the worktree inventory (#516)
- [#1896](https://github.com/kontourai/station/pull/1896) fix(docs): document the open verb; enforce CLI-doc parity on the PR lane
- [#1893](https://github.com/kontourai/station/pull/1893) fix(veritas): restore the attested protected-standards bytes (#1888)
- [#1836](https://github.com/kontourai/station/pull/1836) fix: harden Station runtime, desktop updates, and verification
- [#1872](https://github.com/kontourai/station/pull/1872) fix(deps): return jni to 0.21.1 until android_dns is migrated (#1871)
- [#1863](https://github.com/kontourai/station/pull/1863) fix(ci): read the pnpm bootstrap pin from one reviewed constant (#1042)
- [#1860](https://github.com/kontourai/station/pull/1860) fix(ci): resolve Android build-tools binaries by path, not PATH (#1322)
- [#1861](https://github.com/kontourai/station/pull/1861) fix(ci): identify the fast-checks concurrency group by commit, not by PR (#1445)
- [#1839](https://github.com/kontourai/station/pull/1839) fix(desktop): keep local browser access available through the tray
- [#1841](https://github.com/kontourai/station/pull/1841) fix(ui): align mobile chat context and repair command menus
- [#1840](https://github.com/kontourai/station/pull/1840) fix(ui): drop the build age from the sidebar wordmark
- [#1838](https://github.com/kontourai/station/pull/1838) fix(scripts): report the ci:fast budget kill's own cause, not a scanned line
- [#1837](https://github.com/kontourai/station/pull/1837) fix(runtime): hold the home lease until the adoption writer settles
- [#1795](https://github.com/kontourai/station/pull/1795) fix: unify chat UX and repair local and mobile access
- [#1826](https://github.com/kontourai/station/pull/1826) fix(nightly): derive the native ledger changelog from real history
- [#1824](https://github.com/kontourai/station/pull/1824) fix(scripts): select the tests that pin source by path
- [#1822](https://github.com/kontourai/station/pull/1822) fix(ci): comment on the main-health tracker when the state changes, not on every red run
- [#1820](https://github.com/kontourai/station/pull/1820) fix(deps): bump esbuild to 0.28.2 and approve the copies its exact-pin split materializes (#1719)
- [#1819](https://github.com/kontourai/station/pull/1819) fix(icons): canonicalize icns member order so regeneration is byte-stable (#1797)
- [#1813](https://github.com/kontourai/station/pull/1813) fix(scripts): bound the link-local detector's first group the way #1804 bounded the ULA one

**CI / workflow**

- [#1889](https://github.com/kontourai/station/pull/1889) ci: hold the Android toolchain pins and declare every main-only lane
- [#1874](https://github.com/kontourai/station/pull/1874) ci: type-check the Android-only code paths on pull requests

**Other**

- [#1932](https://github.com/kontourai/station/pull/1932) build(basis): re-ground the MCP App resource budgets to measured sizes
- [#1737](https://github.com/kontourai/station/pull/1737) build(deps-dev): bump commander from 11.1.0 to 15.0.0
- [#1886](https://github.com/kontourai/station/pull/1886) build(deps): bump zod from 4.4.3 to 4.5.4
- [#1914](https://github.com/kontourai/station/pull/1914) test(verification): pin the path-read census by identity; report what actually ran (#1911)
- [#1928](https://github.com/kontourai/station/pull/1928) test(cli): repoint the stale triage-help assertion at its successor (#1795)
- [#1880](https://github.com/kontourai/station/pull/1880) build(deps): bump tauri-plugin-wdio-webdriver from 1.3.0 to 1.4.0 in /src-desktop
- [#1918](https://github.com/kontourai/station/pull/1918) chore(deps): group minor/patch bumps to cut merge-queue serialization
- [#1917](https://github.com/kontourai/station/pull/1917) test(chat): stub ResizeObserver for the highlight suite (#1853)
- [#1882](https://github.com/kontourai/station/pull/1882) build(deps): bump ureq from 3.4.0 to 3.4.1 in /src-desktop
- [#1881](https://github.com/kontourai/station/pull/1881) build(deps): bump tauri-plugin-haptics in /src-desktop
- [#1913](https://github.com/kontourai/station/pull/1913) test(verification): put the two whole-repo census guards on the prepush floor (#1911)
- [#1727](https://github.com/kontourai/station/pull/1727) build(deps): bump tauri-plugin-updater from 2.10.1 to 2.11.0 in /src-desktop
- [#1725](https://github.com/kontourai/station/pull/1725) build(deps): bump pnpm/setup from 2.0.0 to 2.1.0
- [#1890](https://github.com/kontourai/station/pull/1890) test(providers): add muse to the image-input declaration join (#1877)
- [#1873](https://github.com/kontourai/station/pull/1873) chore(nightly): schedule the cohort every six hours
- [#1729](https://github.com/kontourai/station/pull/1729) build(deps): bump tauri-plugin-notification from 2.3.3 to 2.4.0 in /src-desktop
- [#1869](https://github.com/kontourai/station/pull/1869) build(deps): bump google-auth-library from 10.9.1 to 11.0.2
- [#1868](https://github.com/kontourai/station/pull/1868) build(deps): bump @tauri-apps/plugin-deep-link from 2.4.9 to 2.4.10
- [#1867](https://github.com/kontourai/station/pull/1867) build(deps-dev): bump jsdom from 29.1.1 to 30.0.1
- [#1864](https://github.com/kontourai/station/pull/1864) build(deps): bump changesets/action from 2.1.1 to 2.1.2
- [#1862](https://github.com/kontourai/station/pull/1862) test(ios): recover a dropped WKWebView tap instead of asserting once (#1174)
- [#1787](https://github.com/kontourai/station/pull/1787) refactor: drop the export keyword on 949 symbols nothing imports
- [#1722](https://github.com/kontourai/station/pull/1722) build(deps): bump kontourai/flow-agents/.github/actions/codex-pr-review
- [#1723](https://github.com/kontourai/station/pull/1723) build(deps): bump docker/setup-qemu-action from 4.2.0 to 4.3.0
- [#1724](https://github.com/kontourai/station/pull/1724) build(deps): bump tauri-plugin-deep-link in /src-desktop
- [#1726](https://github.com/kontourai/station/pull/1726) build(deps): bump jni from 0.21.1 to 0.22.4 in /src-desktop
- [#1728](https://github.com/kontourai/station/pull/1728) build(deps): bump tauri-plugin-log from 2.9.0 to 2.9.1 in /src-desktop
- [#1731](https://github.com/kontourai/station/pull/1731) build(deps): bump Swatinem/rust-cache
- [#1733](https://github.com/kontourai/station/pull/1733) build(deps): bump the aws group across 1 directory with 6 updates
- [#1735](https://github.com/kontourai/station/pull/1735) build(deps): bump @tauri-apps/plugin-haptics from 2.3.2 to 2.3.3
- [#1736](https://github.com/kontourai/station/pull/1736) build(deps-dev): bump @biomejs/biome from 2.5.11 to 2.5.12
- [#1738](https://github.com/kontourai/station/pull/1738) build(deps-dev): bump fallow from 3.19.0 to 3.22.0
- [#1739](https://github.com/kontourai/station/pull/1739) build(deps-dev): bump @kontourai/console from 0.3.0 to 2.8.0
- [#1741](https://github.com/kontourai/station/pull/1741) build(deps): bump @kontourai/surface from 2.18.0 to 3.2.0
- [#1828](https://github.com/kontourai/station/pull/1828) build(deps): bump dompurify from 3.4.13 to 3.4.15
- [#1842](https://github.com/kontourai/station/pull/1842) chore(backlog): stop deriving P1 from the bug label
- [#1821](https://github.com/kontourai/station/pull/1821) test: own test temp roots instead of shared fixed paths

## 2026-09-11T11:43:48Z · nightly-npm · 0.6.0-nightly.2445.34592166222

- Ship SHA: `4e7ccc76b9cab9335d600333ec4256e180611ba3`
- Artifact built at: `unknown` (no immutable artifact manifest binding)
- Artifact: npm:@kontourai/station-cli@0.6.0-nightly.2445.34592166222 (dist-tag nightly; artifactBuiltAt unknown)
- Note: artifactBuiltAt is null: npm package has no native artifact manifest

### Changelog

Commits since `49cfa59` ([full sha](https://github.com/kontourai/station/commit/49cfa59dd6d037208595040721e0e7bbff114840)):

**Features**

- [#1909](https://github.com/kontourai/station/pull/1909) feat(subagents): stop one subagent without killing its siblings (#1877)
- [#1908](https://github.com/kontourai/station/pull/1908) feat(contracts): declare per-engine subagent observability and control (#1877)
- [#1906](https://github.com/kontourai/station/pull/1906) feat(subagents): enable progress summaries and track spawn depth (#1877)
- [#1856](https://github.com/kontourai/station/pull/1856) feat(connect): invite phones to the selected Station from onboarding
- [#1855](https://github.com/kontourai/station/pull/1855) feat(attention): answer exact input requests with staged files
- [#1853](https://github.com/kontourai/station/pull/1853) feat(ui): keep copy reachable after long code blocks
- [#1852](https://github.com/kontourai/station/pull/1852) feat(ui): change provider model visibility in bulk
- [#1851](https://github.com/kontourai/station/pull/1851) feat(ui): inspect images with zoom and pan

**Fixes**

- [#1898](https://github.com/kontourai/station/pull/1898) fix(ci): pin secret-scan at the reviewed revision that retries its download (#1337)
- [#1930](https://github.com/kontourai/station/pull/1930) fix(config): restore the .veritas formatter exclusion to the glob form
- [#1920](https://github.com/kontourai/station/pull/1920) fix(tests): repair two more latent main-reds the local full-regression peel surfaced
- [#1916](https://github.com/kontourai/station/pull/1916) fix(tests): take createConsoleHubServer from the console root export
- [#1912](https://github.com/kontourai/station/pull/1912) fix(test): assert the coordinator snapshot that satisfied the wait
- [#1911](https://github.com/kontourai/station/pull/1911) fix(verification): re-measure the pin-scan ratchet after #1836 moved its pins; declare the #1855 input-request pairing leaf
- [#1905](https://github.com/kontourai/station/pull/1905) fix(subagents): publish one attributable settle per subagent (#1892)
- [#1904](https://github.com/kontourai/station/pull/1904) fix(ui): say 'a Station' where an instance is meant; bind the copy and workflow ratchets to PR selection
- [#1891](https://github.com/kontourai/station/pull/1891) fix(subagents): carry the SDK output_file and usage on a task settle (#1879)
- [#1902](https://github.com/kontourai/station/pull/1902) fix(verification): resolve the three main-reds the nightly uncovered under the docs break
- [#1887](https://github.com/kontourai/station/pull/1887) fix(subagents): publish the live task registry on every mutation (#1877)
- [#1897](https://github.com/kontourai/station/pull/1897) fix(hygiene): name transfer-gate baselines in the worktree inventory (#516)
- [#1896](https://github.com/kontourai/station/pull/1896) fix(docs): document the open verb; enforce CLI-doc parity on the PR lane
- [#1893](https://github.com/kontourai/station/pull/1893) fix(veritas): restore the attested protected-standards bytes (#1888)
- [#1836](https://github.com/kontourai/station/pull/1836) fix: harden Station runtime, desktop updates, and verification
- [#1872](https://github.com/kontourai/station/pull/1872) fix(deps): return jni to 0.21.1 until android_dns is migrated (#1871)
- [#1863](https://github.com/kontourai/station/pull/1863) fix(ci): read the pnpm bootstrap pin from one reviewed constant (#1042)
- [#1860](https://github.com/kontourai/station/pull/1860) fix(ci): resolve Android build-tools binaries by path, not PATH (#1322)
- [#1861](https://github.com/kontourai/station/pull/1861) fix(ci): identify the fast-checks concurrency group by commit, not by PR (#1445)
- [#1839](https://github.com/kontourai/station/pull/1839) fix(desktop): keep local browser access available through the tray
- [#1841](https://github.com/kontourai/station/pull/1841) fix(ui): align mobile chat context and repair command menus
- [#1840](https://github.com/kontourai/station/pull/1840) fix(ui): drop the build age from the sidebar wordmark
- [#1838](https://github.com/kontourai/station/pull/1838) fix(scripts): report the ci:fast budget kill's own cause, not a scanned line
- [#1837](https://github.com/kontourai/station/pull/1837) fix(runtime): hold the home lease until the adoption writer settles
- [#1795](https://github.com/kontourai/station/pull/1795) fix: unify chat UX and repair local and mobile access
- [#1826](https://github.com/kontourai/station/pull/1826) fix(nightly): derive the native ledger changelog from real history
- [#1824](https://github.com/kontourai/station/pull/1824) fix(scripts): select the tests that pin source by path
- [#1822](https://github.com/kontourai/station/pull/1822) fix(ci): comment on the main-health tracker when the state changes, not on every red run
- [#1820](https://github.com/kontourai/station/pull/1820) fix(deps): bump esbuild to 0.28.2 and approve the copies its exact-pin split materializes (#1719)
- [#1819](https://github.com/kontourai/station/pull/1819) fix(icons): canonicalize icns member order so regeneration is byte-stable (#1797)
- [#1813](https://github.com/kontourai/station/pull/1813) fix(scripts): bound the link-local detector's first group the way #1804 bounded the ULA one

**CI / workflow**

- [#1889](https://github.com/kontourai/station/pull/1889) ci: hold the Android toolchain pins and declare every main-only lane
- [#1874](https://github.com/kontourai/station/pull/1874) ci: type-check the Android-only code paths on pull requests

**Other**

- [#1932](https://github.com/kontourai/station/pull/1932) build(basis): re-ground the MCP App resource budgets to measured sizes
- [#1737](https://github.com/kontourai/station/pull/1737) build(deps-dev): bump commander from 11.1.0 to 15.0.0
- [#1886](https://github.com/kontourai/station/pull/1886) build(deps): bump zod from 4.4.3 to 4.5.4
- [#1914](https://github.com/kontourai/station/pull/1914) test(verification): pin the path-read census by identity; report what actually ran (#1911)
- [#1928](https://github.com/kontourai/station/pull/1928) test(cli): repoint the stale triage-help assertion at its successor (#1795)
- [#1880](https://github.com/kontourai/station/pull/1880) build(deps): bump tauri-plugin-wdio-webdriver from 1.3.0 to 1.4.0 in /src-desktop
- [#1918](https://github.com/kontourai/station/pull/1918) chore(deps): group minor/patch bumps to cut merge-queue serialization
- [#1917](https://github.com/kontourai/station/pull/1917) test(chat): stub ResizeObserver for the highlight suite (#1853)
- [#1882](https://github.com/kontourai/station/pull/1882) build(deps): bump ureq from 3.4.0 to 3.4.1 in /src-desktop
- [#1881](https://github.com/kontourai/station/pull/1881) build(deps): bump tauri-plugin-haptics in /src-desktop
- [#1913](https://github.com/kontourai/station/pull/1913) test(verification): put the two whole-repo census guards on the prepush floor (#1911)
- [#1727](https://github.com/kontourai/station/pull/1727) build(deps): bump tauri-plugin-updater from 2.10.1 to 2.11.0 in /src-desktop
- [#1725](https://github.com/kontourai/station/pull/1725) build(deps): bump pnpm/setup from 2.0.0 to 2.1.0
- [#1890](https://github.com/kontourai/station/pull/1890) test(providers): add muse to the image-input declaration join (#1877)
- [#1873](https://github.com/kontourai/station/pull/1873) chore(nightly): schedule the cohort every six hours
- [#1729](https://github.com/kontourai/station/pull/1729) build(deps): bump tauri-plugin-notification from 2.3.3 to 2.4.0 in /src-desktop
- [#1869](https://github.com/kontourai/station/pull/1869) build(deps): bump google-auth-library from 10.9.1 to 11.0.2
- [#1868](https://github.com/kontourai/station/pull/1868) build(deps): bump @tauri-apps/plugin-deep-link from 2.4.9 to 2.4.10
- [#1867](https://github.com/kontourai/station/pull/1867) build(deps-dev): bump jsdom from 29.1.1 to 30.0.1
- [#1864](https://github.com/kontourai/station/pull/1864) build(deps): bump changesets/action from 2.1.1 to 2.1.2
- [#1862](https://github.com/kontourai/station/pull/1862) test(ios): recover a dropped WKWebView tap instead of asserting once (#1174)
- [#1787](https://github.com/kontourai/station/pull/1787) refactor: drop the export keyword on 949 symbols nothing imports
- [#1722](https://github.com/kontourai/station/pull/1722) build(deps): bump kontourai/flow-agents/.github/actions/codex-pr-review
- [#1723](https://github.com/kontourai/station/pull/1723) build(deps): bump docker/setup-qemu-action from 4.2.0 to 4.3.0
- [#1724](https://github.com/kontourai/station/pull/1724) build(deps): bump tauri-plugin-deep-link in /src-desktop
- [#1726](https://github.com/kontourai/station/pull/1726) build(deps): bump jni from 0.21.1 to 0.22.4 in /src-desktop
- [#1728](https://github.com/kontourai/station/pull/1728) build(deps): bump tauri-plugin-log from 2.9.0 to 2.9.1 in /src-desktop
- [#1731](https://github.com/kontourai/station/pull/1731) build(deps): bump Swatinem/rust-cache
- [#1733](https://github.com/kontourai/station/pull/1733) build(deps): bump the aws group across 1 directory with 6 updates
- [#1735](https://github.com/kontourai/station/pull/1735) build(deps): bump @tauri-apps/plugin-haptics from 2.3.2 to 2.3.3
- [#1736](https://github.com/kontourai/station/pull/1736) build(deps-dev): bump @biomejs/biome from 2.5.11 to 2.5.12
- [#1738](https://github.com/kontourai/station/pull/1738) build(deps-dev): bump fallow from 3.19.0 to 3.22.0
- [#1739](https://github.com/kontourai/station/pull/1739) build(deps-dev): bump @kontourai/console from 0.3.0 to 2.8.0
- [#1741](https://github.com/kontourai/station/pull/1741) build(deps): bump @kontourai/surface from 2.18.0 to 3.2.0
- [#1828](https://github.com/kontourai/station/pull/1828) build(deps): bump dompurify from 3.4.13 to 3.4.15
- [#1842](https://github.com/kontourai/station/pull/1842) chore(backlog): stop deriving P1 from the bug label
- [#1821](https://github.com/kontourai/station/pull/1821) test: own test temp roots instead of shared fixed paths

## 2026-09-09T14:00:58Z · nightly-desktop · 0.1.11-nightly.2443.2

- Ship SHA: `49cfa59dd6d037208595040721e0e7bbff114840`
- Artifact built at: `2026-09-09T13:20:45.758Z` (not provider upload/record time)
- Artifact: github-release:nightly-desktop (cohort-finalized)
- Note: ios: TestFlight delivery success (run 34355735437)

### Changelog

> Changelog slice omitted: previous ship SHA a7935a4 is not reachable in this repository's history, so no commit range exists to derive.

## 2026-09-09T14:00:51Z · nightly-android · 0.1.11-nightly.2443.2

- Ship SHA: `49cfa59dd6d037208595040721e0e7bbff114840`
- Artifact built at: `2026-09-09T13:21:32.047Z` (not provider upload/record time)
- Artifact: play-internal-aab:cohort-finalized
- Note: ios: TestFlight delivery success (run 34355735437)

### Changelog

> Changelog slice omitted: previous ship SHA a7935a4 is not reachable in this repository's history, so no commit range exists to derive.

## 2026-09-09T13:52:04Z · nightly-npm · 0.6.0-nightly.2443.34355735437

- Ship SHA: `49cfa59dd6d037208595040721e0e7bbff114840`
- Artifact built at: `unknown` (no immutable artifact manifest binding)
- Artifact: npm:@kontourai/station-cli@0.6.0-nightly.2443.34355735437 (dist-tag nightly; artifactBuiltAt unknown)
- Note: artifactBuiltAt is null: npm package has no native artifact manifest

### Changelog

Commits since `a7935a4` ([full sha](https://github.com/kontourai/station/commit/a7935a4cf5297db2eea11364badf96f8ce1d106b)):

**Other**

- [#1818](https://github.com/kontourai/station/pull/1818) test(runtime): wait on the cold-start harness's own event instead of a wall clock
- [#1788](https://github.com/kontourai/station/pull/1788) test(scripts): execute every composed guardrail, dedupe verify:static linting, pin the copied CI classify jobs

## 2026-09-09T02:49:16Z · nightly-desktop · 0.1.11-nightly.2443.1

- Ship SHA: `a7935a4cf5297db2eea11364badf96f8ce1d106b`
- Artifact built at: `2026-09-09T02:14:34.403Z` (not provider upload/record time)
- Artifact: github-release:nightly-desktop (cohort-finalized)
- Note: ios: TestFlight delivery success (run 34301435508)

### Changelog

> Changelog slice omitted: previous ship SHA fd2c04e is not reachable in this repository's history, so no commit range exists to derive.

## 2026-09-09T02:49:10Z · nightly-android · 0.1.11-nightly.2443.1

- Ship SHA: `a7935a4cf5297db2eea11364badf96f8ce1d106b`
- Artifact built at: `2026-09-09T02:12:04.311Z` (not provider upload/record time)
- Artifact: play-internal-aab:cohort-finalized
- Note: ios: TestFlight delivery success (run 34301435508)

### Changelog

> Changelog slice omitted: previous ship SHA fd2c04e is not reachable in this repository's history, so no commit range exists to derive.

## 2026-09-09T02:43:48Z · nightly-npm · 0.6.0-nightly.2443.34301435508

- Ship SHA: `a7935a4cf5297db2eea11364badf96f8ce1d106b`
- Artifact built at: `unknown` (no immutable artifact manifest binding)
- Artifact: npm:@kontourai/station-cli@0.6.0-nightly.2443.34301435508 (dist-tag nightly; artifactBuiltAt unknown)
- Note: artifactBuiltAt is null: npm package has no native artifact manifest

### Changelog

Commits since `fd2c04e` ([full sha](https://github.com/kontourai/station/commit/fd2c04e8632d40e6e9c53dd13a558a1764375800)):

**Features**

- [#1805](https://github.com/kontourai/station/pull/1805) feat(server): one route error contract at the boundary, with the workflow routes as the template

**Fixes**

- [#1800](https://github.com/kontourai/station/pull/1800) fix(deps): resolve csv-parse, js-yaml and hono to their patched releases
- [#1808](https://github.com/kontourai/station/pull/1808) fix(ui): point the outbound-queue call-site pin at the dock hook that now makes the call
- [#1803](https://github.com/kontourai/station/pull/1803) fix(deps): let the lifecycle allowlist name workspace-importer package paths (#1718)
- [#1804](https://github.com/kontourai/station/pull/1804) fix(scripts): derive IPv6 ULA private-ip findings from address shape, not a fc/fd prefix
- [#1801](https://github.com/kontourai/station/pull/1801) fix(testflight): page through the internal-group membership readback (#1782)
- [#1799](https://github.com/kontourai/station/pull/1799) fix(ios): name the overlay receipt's desktop master fields as desktopBundleIcon* (#1776)
- [#1789](https://github.com/kontourai/station/pull/1789) fix(deps): drop the obsolete provider-utils advisory residual

**CI / workflow**

- [#1812](https://github.com/kontourai/station/pull/1812) ci(deps): scan the advisory floor four times a day and pin the workflow's shape
- [#1802](https://github.com/kontourai/station/pull/1802) ci(nightly): decide a rebuild from ledger evidence, not marker position (#1780)

**Other**

- [#1809](https://github.com/kontourai/station/pull/1809) refactor(server): publish ten json writers through the shared durable seams, which gain a serialization option
- [#1798](https://github.com/kontourai/station/pull/1798) perf(ui): navigation selectors and an actions-only read; delete dead entry CSS
- [#1794](https://github.com/kontourai/station/pull/1794) refactor(orchestration): extract turn-dedup and adoption sqlite persistence from the event store
- [#1785](https://github.com/kontourai/station/pull/1785) refactor(chat-dock): extract overlay flags and boundary dialogs, load the dialogs as one on-demand chunk

## 2026-09-08T17:23:06Z · nightly-desktop · 0.1.11-nightly.2442.5

- Ship SHA: `fd2c04e8632d40e6e9c53dd13a558a1764375800`
- Artifact built at: `2026-09-08T16:43:43.338Z` (not provider upload/record time)
- Artifact: github-release:nightly-desktop (cohort-finalized)
- Note: ios: TestFlight delivery success (run 34252063142)

### Changelog

> Changelog slice omitted: previous ship SHA f1073fa is not reachable in this repository's history, so no commit range exists to derive.

## 2026-09-08T17:23:00Z · nightly-android · 0.1.11-nightly.2442.5

- Ship SHA: `fd2c04e8632d40e6e9c53dd13a558a1764375800`
- Artifact built at: `2026-09-08T16:43:50.381Z` (not provider upload/record time)
- Artifact: play-internal-aab:cohort-finalized
- Note: ios: TestFlight delivery success (run 34252063142)

### Changelog

> Changelog slice omitted: previous ship SHA 9ef6da4 is not reachable in this repository's history, so no commit range exists to derive.

## 2026-09-08T17:13:07Z · nightly-npm · 0.6.0-nightly.2442.34252063142

- Ship SHA: `fd2c04e8632d40e6e9c53dd13a558a1764375800`
- Artifact built at: `unknown` (no immutable artifact manifest binding)
- Artifact: npm:@kontourai/station-cli@0.6.0-nightly.2442.34252063142 (dist-tag nightly; artifactBuiltAt unknown)
- Note: artifactBuiltAt is null: npm package has no native artifact manifest

### Changelog

Commits since `9ef6da4` ([full sha](https://github.com/kontourai/station/commit/9ef6da41656621fb1c4b7b8fca1e528521df127e)):

**Fixes**

- [#1781](https://github.com/kontourai/station/pull/1781) fix(ios): ship the channel app icon and fail closed when the catalog is not derived from it (#1776)

## 2026-09-08T16:34:52Z · nightly-android · 0.1.11-nightly.2442.4

- Ship SHA: `9ef6da41656621fb1c4b7b8fca1e528521df127e`
- Artifact built at: `2026-09-08T15:57:01.936Z` (not provider upload/record time)
- Artifact: play-internal-aab:cohort-finalized
- Note: ios: TestFlight delivery failure (run 34247229018)
- Note: macos: NOT_VERIFIED (macos provider outcome unknown: unresolved:run:34247229018:macos-state-absent:failure (the provider effect may already be live))

### Changelog

> Changelog slice omitted: previous ship SHA f1073fa is not reachable in this repository's history, so no commit range exists to derive.

## 2026-09-08T16:28:03Z · nightly-npm · 0.6.0-nightly.2442.34247229018

- Ship SHA: `9ef6da41656621fb1c4b7b8fca1e528521df127e`
- Artifact built at: `unknown` (no immutable artifact manifest binding)
- Artifact: npm:@kontourai/station-cli@0.6.0-nightly.2442.34247229018 (dist-tag nightly; artifactBuiltAt unknown)
- Note: artifactBuiltAt is null: npm package has no native artifact manifest

### Changelog

Commits since `92b5e7b` ([full sha](https://github.com/kontourai/station/commit/92b5e7b30978b0c40c4d5c1424662f6e7e8900b5)):

**Fixes**

- [#1778](https://github.com/kontourai/station/pull/1778) fix(release): derive TestFlight internal-group membership instead of posting it (#1777)

**CI / workflow**

- [#1779](https://github.com/kontourai/station/pull/1779) ci(nightly): publish Android and macOS per platform with a disclosed-partial receipt (#1774)
- [#1775](https://github.com/kontourai/station/pull/1775) ci(nightly): deliver iOS beside the native cohort, not inside it (#1774)

## 2026-09-08T14:27:53Z · nightly-npm · 0.6.0-nightly.2442.34234368088

- Ship SHA: `92b5e7b30978b0c40c4d5c1424662f6e7e8900b5`
- Artifact built at: `unknown` (no immutable artifact manifest binding)
- Artifact: npm:@kontourai/station-cli@0.6.0-nightly.2442.34234368088 (dist-tag nightly; artifactBuiltAt unknown)
- Note: artifactBuiltAt is null: npm package has no native artifact manifest

### Changelog

Commits since `5dda86f` ([full sha](https://github.com/kontourai/station/commit/5dda86fbc3e79535929a00097c35c7b25451d3a1)):

_No user-visible changes recorded for this slice._

## 2026-09-08T13:45:30Z · nightly-npm · 0.6.0-nightly.2442.34230188430

- Ship SHA: `5dda86fbc3e79535929a00097c35c7b25451d3a1`
- Artifact built at: `unknown` (no immutable artifact manifest binding)
- Artifact: npm:@kontourai/station-cli@0.6.0-nightly.2442.34230188430 (dist-tag nightly; artifactBuiltAt unknown)
- Note: artifactBuiltAt is null: npm package has no native artifact manifest

### Changelog

Commits since `370c33e` ([full sha](https://github.com/kontourai/station/commit/370c33eed4b501243663ce13ac216832312feb78)):

**Fixes**

- [#1773](https://github.com/kontourai/station/pull/1773) fix(orchestration): bind session barriers to their runtime and take search worker boot off read budgets
- [#1772](https://github.com/kontourai/station/pull/1772) fix(release): name the App Store Connect error when beta-group assignment fails

## 2026-09-08T10:24:53Z · nightly-npm · 0.6.0-nightly.2442.34211909749

- Ship SHA: `370c33eed4b501243663ce13ac216832312feb78`
- Artifact built at: `unknown` (no immutable artifact manifest binding)
- Artifact: npm:@kontourai/station-cli@0.6.0-nightly.2442.34211909749 (dist-tag nightly; artifactBuiltAt unknown)
- Note: artifactBuiltAt is null: npm package has no native artifact manifest

### Changelog

> First recorded entry for this channel; no previous ship SHA exists in the ledger, so no changelog slice was derived.

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
