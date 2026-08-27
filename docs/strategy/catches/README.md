# The catch log

`catches.jsonl` is one record per event where a defect was caught **before it
shipped**, and — the part that matters — **what caught it**.

It exists because this repo already had the material and could not use it. The
incident record in `s1c-dogfood-log.md` (repository archive) is rich,
honest, and 787 lines of prose. Its "Caught-by-the-gate log" section is framed
as *"every time a gate refused something that would otherwise have shipped —
this column is the product's reason to exist"*. Nothing consulted it. So a
pipe-masked exit code recorded on 2026-06-12
(`s1c-dogfood-log.md:193`, repository archive) recurred on 2026-07-29 in a
sibling repo, and again on 2026-08-01 in this one — three times, in a workspace
whose written history names the failure mode precisely. Prose you have to
already know about is not a record; it is a memoir.

## What this is not

**It is not a gate, and it must not become one.** This repo's own learning is
that every ceremonial gate teaches agents which gates are ceremony. Nothing
blocks on a missing catch record, nothing counts them, no merge is refused for
an unlogged catch. `catch-log.test.ts` checks only that the file is still
valid JSON Lines against its own schema — file integrity, not practice
enforcement. If you find yourself adding a check that a delivery *produced* a
catch row, you have misread this document.

It is also not a bug tracker. A bug that reached a user is not a catch; it is
an escape. This file records the ones that did not get out, so the question
"is any of this working, and which part" has an answer that is not a vibe.

## The `caught_by_machine: false` rows are the valuable ones

**The ratio is the point.**

| | count |
| --- | ---: |
| records (2026-06-12 → 2026-08-03) | **55** |
| counted toward the ratio (`confidence` ≠ `low`) | **54** |
| `caught_by_machine: true` | **13** (24%) |
| `caught_by_machine: false` | **41** (76%) |

A `false` row is not a failure to record. It names something **only a human
lens could see** — a reviewer reading source, a fault injection that came back
green, a red-team probe, someone noticing that a log's mtime predates the fix
it claims to cover. Three quarters of the defects in this file were invisible
to every automated check in three repositories at the moment they were found.

That number is the honest answer to "why do we run independent review at all",
and it is also the honest answer to "which guardrails have earned the right to
block". Read it in both directions:

- **`true` rows tell you which gates pay rent.** Thirteen of them, and they
  cluster: `verify:e2e:full` and the real-browser lanes account for four, CI
  portability for two, bundle and count ratchets for two, a pre-armed
  regression test for one. Every one of those is a gate that has caught
  something real.
- **`false` rows tell you where a machine cannot help yet.** Look at
  `vacuous-assertion`: **nine records, zero machine catches.** That is not an
  accident and it is not fixable by adding tests — a test that asserts nothing
  cannot fail, so no suite can report on it. Only deliberate fault injection
  finds those, which is why the delivery protocol treats an uncaught injection
  as a stop signal rather than a shrug. `pipe-masked-exit` is the same story
  from the other end: **four records, zero machine catches**, the first written
  down on 2026-06-12 and the fourth produced on 2026-08-03 by an agent that had
  read the rule an hour earlier.

If this file ever reads 90% machine, that is not victory — it almost certainly
means people stopped recording the catches a machine could not make.

## Class table

The enum is **derived from the recorded events**, not designed in advance. Add
a value only when a real event does not fit an existing one, and update this
table. Singletons are allowed; an invented category with no member is not.

| class | records | of which machine | what it means |
| --- | ---: | ---: | --- |
| `absence-as-success` | 12 | 4 | A missing, empty, or unevaluable signal rendered as a pass. Includes an unenforced suite (nothing failed because nothing ran) and an empty `grep` read as "nothing there". |
| `vacuous-assertion` | 9 | 0 | A test that passes against a deliberately broken implementation. |
| `fail-open-validation` | 5 | 0 | A check that accepts what it exists to reject — an empty string as proof, an untrusted producer, an unresolved relative path, a fallback that makes a broken path look correct. |
| `pipe-masked-exit` | 4 | 0 | A pipeline or wrapper made a failing command report success. |
| `uncaught-fault-injection` | 3 | 0 | A deliberate sabotage of a production line that **no existing guard detected**. Distinct from `vacuous-assertion`: there the test existed and proved nothing; here nothing reached the line at all. |
| `unimplemented-claim` | 4 | 0 | A comment, doc, export, or rendered state asserting a capability or path that does not exist. |
| `unit-green-integration-red` | 3 | 3 | A real defect the unit suite could not see, exposed only by a real browser or a live path. |
| `fix-round-regression` | 3 | 1 | A defect introduced by the fix round itself, caught only because something re-ran over the delta. |
| `host-specific-assertion` | 2 | 2 | An assertion true only on the author's machine or worktree, silently passing there. |
| `misattributed-evidence` | 2 | 0 | A result attributed to a run that did not produce it — a red read from a sibling worktree's test file, a neighbouring check's `OK:` line matched by a loose grep. The mirror of `vacuous-assertion`: there a green meant nothing, here a red does. |
| `silent-source-corruption` | 2 | 1 | Source bytes that break tooling invisibly — a comment terminator inside a comment, literal NUL bytes hiding a file from search. |
| `ungated-completion` | 2 | 1 | Work reaching a "done" state without its gates being walked — once refused, once forced past. |
| `eager-import-cost` | 1 | 1 | A lazily-consumed value computed at module scope, inflating a shared bundle. |
| `stale-evidence-as-fresh` | 1 | 0 | Evidence cited for a change it predates. |
| `unexecuted-evidence` | 1 | 0 | A test that existed, asserted the right thing, and was never run — the acceptance criterion failed on the delivered commit. |
| `unsatisfiable-gate` | 1 | 0 | A gate as authored could never be satisfied. The mirror of fail-open, and just as invisible. |

## What belongs in a record

One record per **distinct catch**, not per PR — a PR with three findings gets
three rows, because the classes and the detectors differ and folding them
together destroys exactly the signal this file exists for.

Include it when a real defect was found before it shipped. Leave it out when:

- **Nothing was actually caught.** A guard *demonstrated* on a planted defect is
  a proof that the guard works, not a catch. `s1c-dogfood-log.md:655` records
  `rename:inventory` being proven by planting `STATION_LEAK` and removing it —
  genuinely valuable, deliberately **not** in this file, because counting
  planted proofs as catches inflates the machine number and the ratio is the
  point.
- **You cannot ground a field.** Mark it: set `confidence: "low"`, list the
  field in `unverified`, and say what you could not determine in `notes`. Low
  rows are excluded from the ratio. One row currently sits there
  (`station-23fdef82-sse-absence-check-timing`): the defect and fix are read
  from the diff, but the commit never says how the vacuity was discovered, so
  claiming a detector would be invention.
- **It is expected churn, not a defect.** Specs that encode a layout a redesign
  deliberately changed are blast radius, not a catch.

Every row must cite something a reader can open: `repo@sha`, `path:line`, an
issue or PR number, or a retained evidence bundle. `fix_ref: null` is honest
and expected for a catch that is still open — one row is unfixed today
(`station-1548-comment-asserts-unbuilt-ui-path`), and its being visible here is
the whole idea.

## Where it is consumed

[`.veritas/proof-families/repo-guardrails.families.json`](../../../.veritas/proof-families/repo-guardrails.families.json)
carries a `recentCatchEvidence` field per guardrail family, and a policy that a
family cannot become `required` without it
([`proof-family-promotion-workflow.md`](../veritas/proof-family-promotion-workflow.md)).
Four of eight families read `"unknown"` and every entry was stale since
2026-06-11. This file is the input that field was designed for.

Note what `"unknown"` actually meant: *nobody looked*. A family whose evidence
is `"unknown"` cannot be promoted, but neither can it be demoted, because the
demotion criterion is "catch evidence remains unknown" and nobody could say
whether it had remained anything. Consulting a dated record converts `unknown`
into **`none` over a stated window**, which is a finding a decision can rest on.

## Adding a record

Append a line. Keep the file sorted by `date` then `id`. Then:

```sh
npx vitest run scripts/__tests__/catch-log.test.ts
```

That validates JSON Lines shape, required fields, the class enum, id
uniqueness, sort order, and that this README's class table matches the data.
It does not, and will not, check that you wrote one.
