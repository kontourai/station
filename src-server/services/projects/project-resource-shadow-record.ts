/**
 * station#1686 — the shadow counter's LOCAL, DURABLE READ PATH.
 *
 * `station.project_resource.shadow_comparisons` was written to be slice 3c's
 * population-coverage evidence, and it has never been readable from a real
 * Station. `src-server/telemetry.ts` starts the OTel SDK **only** when
 * `OTEL_EXPORTER_OTLP_ENDPOINT` is set; unset — which it is on every install
 * that is not running `monitoring/docker-compose.yml` — `metrics.getMeter`
 * returns a no-op meter and every `.add()` is discarded. Nothing is buffered,
 * so nothing is recoverable after the fact, and there is no `/metrics`
 * endpoint, in-process reader, or debug route to ask.
 *
 * That is not merely "the gate has no data yet". It is the
 * emptiness-as-clearance trap living inside the gate that was written to
 * avoid it: an empty divergence record and an unfired `conflated-unbound`
 * tripwire are exactly what an instrument that discards its writes produces,
 * and they are indistinguishable from agreement unless something records
 * that the observer ran at all.
 *
 * WHY A FILE AND NOT AN IN-PROCESS METRIC READER.
 *
 * Registering a real `MeterProvider` so `metrics.getMeter('station')` stops
 * being a no-op would make every instrument in `telemetry/metrics.ts`
 * readable — and would also make every one of them accumulate cumulative
 * state in memory for the life of the process, including instruments whose
 * attribute cardinality nothing in this repo bounds. It also answers only
 * for the CURRENT process: slice 3c's four populations cannot be produced on
 * demand (legs 2–4 need a project's directory to actually go missing, or
 * `git` to be unavailable), so the evidence has to ACCUMULATE across boots.
 * A process-scoped reader cannot do that. So this module records the same
 * dimensions the counter records, durably, under the Station home — the
 * counter is not replaced, it is made readable.
 *
 * WHAT THE RECORD MUST NEVER CONFLATE (the whole point of the issue).
 *
 * "The observer ran and saw agreement" and "the observer never ran" must not
 * render as the same zero. This shape makes them structurally distinct
 * rather than distinct by convention:
 *
 *  - An outcome that has never been observed is **ABSENT** from `entries`.
 *    There are no zero rows, ever, so nothing can be read as "counted zero
 *    times" when it was never counted at all.
 *  - `observations` is the total over every comparison this home has ever
 *    recorded. `conflated-unbound` absent with `observations: 0` (or with no
 *    record file at all) says NOTHING about the tripwire. Absent with
 *    `observations: 4127` says the tripwire did not fire across 4127 real
 *    comparisons. Same absence, different fact, and the reader must state
 *    which — see `scripts/project-resource-shadow-report.ts`.
 *  - {@link readShadowRecord} is three-valued: `never-observed`, `unreadable`
 *    and `observed`. A corrupt or future-versioned file fails closed as
 *    `unreadable` and is never folded into "no divergences found".
 *
 * DISCLOSED GAP — CROSS-PROCESS WRITES. {@link recordShadowComparison} is a
 * read-modify-write. Within one process it is safe (the write is synchronous,
 * and Node runs it to completion), and the file itself can never tear
 * (`JsonFileStore`'s `durableAtomicWrite` writes a sibling temp and renames).
 * Two Station instances sharing ONE home can still lose an increment to a
 * lost update. The record therefore UNDERCOUNTS and never overcounts, which
 * is the safe direction for a population-coverage claim (missing evidence
 * reads as missing) and the unsafe direction for the tripwire — so the
 * tripwire keeps its second, independent reader: divergent outcomes are also
 * written to the process log as a warn line by `observeCwdShadow`, which no
 * other process can lose.
 *
 * WHAT THE WRITE COSTS, AND WHY IT IS `tear-safe` (review round 1, MEDIUM 7).
 *
 * This write happens once per session start, synchronously, on the event
 * loop. As first written it used `JsonFileStore`'s default `crash-safe`
 * durability: four fsyncs — the temp file, the retained `.previous`, and the
 * containing directory after each of the two renames — measured at ~3.6ms
 * each on this repo's reference host, ~15.4ms per write in total. That is
 * 4.5x the ~3.4ms `git` spawn that `project-resource-shadow.ts` decision 1
 * already treats as too expensive to leave on the session-start stack, and it
 * blocked the loop for every concurrent request while it ran.
 *
 * `tear-safe` keeps the same-directory temp file, the atomic rename and the
 * retained `.previous`, and drops only the fsyncs, taking the write to
 * ~0.4ms.
 *
 * BE PRECISE ABOUT WHAT DROPPING THE FSYNCS ACTUALLY RISKS (round 2,
 * MEDIUM 2). An earlier draft of this note claimed the tolerable failure was
 * "losing the last few observations… the same undercount direction" as a
 * cross-process lost update. That was WRONG, and comfortably so.
 *
 * `rename()` is atomic for concurrent readers with or without fsync, so no
 * other process ever sees a half-written file. What fsync bought was
 * DATA-BEFORE-METADATA ordering across a power loss: without it, a filesystem
 * that commits the rename's metadata before the temp file's data blocks
 * leaves a primary that EXISTS AND IS GARBAGE. That is not an undercount —
 * it is the total loss of every accumulated observation, and because
 * {@link recordShadowComparison} correctly refuses to write over a record it
 * cannot read, it would also mean the home never records another one.
 *
 * So `tear-safe` is only an honest name if a corrupt primary is RECOVERABLE,
 * and that is what {@link readShadowRecord} now derives rather than asserts:
 * a primary that is present but unusable falls back to the retained
 * `.previous`, exactly as a missing one already did. The residual risk is
 * losing the observations written since the last `.previous` rotation, which
 * IS the disclosed undercount direction — and the reader says so, because a
 * recovered read carries `recoveredFrom`.
 *
 * Keeping one fsync on the temp file (~3.5ms of the 15.4ms) was the
 * alternative. It was not taken because it closes only the POWER-LOSS cause
 * of a corrupt primary, while a disk error, an external truncation or a
 * hand-edit reach the same state — so the recovery path is required either
 * way, and once it exists the fsync buys a strict subset of what it covers.
 *
 * The write stays SYNCHRONOUS deliberately. Making it async would move the
 * cost off the loop too, but an observation would then no longer be on disk
 * when the observing tick ends, so a process that exits immediately after a
 * session start would lose it. ~0.4ms is not worth buying that window.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { JsonFileStore } from '../infra/json-store.js';

/** File name under the Station home. */
export const SHADOW_RECORD_FILENAME = 'project-resource-shadow.json';

/**
 * Bumped when the on-disk shape changes. A reader that meets a version it
 * does not know reports `unreadable` naming the version — never an empty
 * record, which would read as clearance.
 */
export const SHADOW_RECORD_VERSION = 2;

/**
 * The counter's own attribute tuple. Deliberately the SAME dimensions
 * `projectResourceShadowComparisons.add()` is given, minus nothing: a record
 * that summarised the counter differently would be a second, divergent
 * derivation of the fact the gate reads, which is the class of defect the
 * shadow itself exists to stop taking on faith.
 *
 * Typed as plain strings rather than the outcome/state unions so this module
 * stays a leaf that `scripts/` and the resolver-side types can both depend on
 * without importing the comparison; the producer supplies the union values.
 *
 * Declared as a TYPE ALIAS rather than an interface on purpose: TypeScript
 * gives an object type alias an implicit index signature, so the very same
 * value can be handed to OTel's `Attributes` parameter without a cast or a
 * second, hand-copied literal. One object, both readers — which is the
 * property `emitComparison` relies on.
 */
export type ShadowRecordDimensions = {
  /** Which seam produced the comparison (`start_session_cwd` today). */
  seam: string;
  /** `CwdShadowOutcome`. */
  outcome: string;
  /** `BaselineCwdOutcome['kind']`. */
  baseline: string;
  provider: string;
  /** `ResourceResolutionResult['state']`; absent when the resolver threw. */
  shadow?: string;
};

export interface ShadowRecordEntry extends ShadowRecordDimensions {
  count: number;
  firstObservedAt: string;
  lastObservedAt: string;
}

export interface ProjectResourceShadowRecord {
  version: number;
  /**
   * Total comparisons recorded into this file, over every process that has
   * ever used this home. The denominator that turns an ABSENT outcome from
   * "unknown" into "did not happen in N observations".
   */
  observations: number;
  firstObservedAt: string;
  lastObservedAt: string;
  /**
   * One row per observed dimension tuple. Never contains a zero-count row —
   * an invariant `isRecordEntry` DERIVES on every read (a row outside
   * `count >= 1` makes the whole record `unreadable`), rather than one this
   * comment asserts and the gate then trusts.
   */
  entries: ShadowRecordEntry[];
}

export type ShadowRecordRead =
  /** No file. The observer has never recorded a comparison in this home. */
  | { state: 'never-observed'; path: string }
  /**
   * A file exists and could not be trusted — unparseable, wrong shape, or a
   * version this reader does not know — AND `.previous` could not stand in
   * for it. Deliberately NOT folded into `never-observed`: "I could not look"
   * is not "there was nothing to see".
   */
  | { state: 'unreadable'; path: string; reason: string }
  | {
      state: 'observed';
      path: string;
      record: ProjectResourceShadowRecord;
      /**
       * Set when the primary was unusable and this record came from the
       * retained `.previous` instead. A recovered record is a DIFFERENT fact
       * from an intact one — the observations written since the last rotation
       * are gone — so it is carried as data rather than being flattened into
       * an ordinary `observed`, and the reporter says so.
       */
      recoveredFrom?: string;
    };

export function shadowRecordPath(homeDir: string): string {
  return join(homeDir, SHADOW_RECORD_FILENAME);
}

/**
 * WRITE-ONLY as of round 2: {@link readShadowRecord} reads the files directly,
 * because `JsonFileStore.read()` consults `.previous` only when the primary is
 * MISSING. Two of the arguments below are therefore currently INERT and kept
 * deliberately rather than trimmed — `emptyRecord()` (the read default) and
 * `onCorruption: 'throw'` (a read-path policy). Both describe what this store
 * would do if anything here ever called `.read()` again, and dropping them
 * would leave the next such caller silently inheriting `'default-value'`, which
 * turns a corrupt record into an empty one — the exact conflation this module
 * exists to prevent. `durableAtomicWrite` and `atomicWriteDurability` are the
 * two that are live.
 */
function store(homeDir: string): JsonFileStore<ProjectResourceShadowRecord> {
  return new JsonFileStore<ProjectResourceShadowRecord>(
    shadowRecordPath(homeDir),
    emptyRecord(),
    {
      onCorruption: 'throw',
      durableAtomicWrite: true,
      // See the WHAT THE WRITE COSTS note above: a torn record would destroy
      // every accumulated observation, so the temp-file + atomic rename and
      // the retained `.previous` are kept; power-loss durability is not worth
      // ~14.6ms of blocked event loop per session start on an observation
      // record whose disclosed failure direction is already undercounting.
      atomicWriteDurability: 'tear-safe',
    },
  );
}

function emptyRecord(): ProjectResourceShadowRecord {
  return {
    version: SHADOW_RECORD_VERSION,
    observations: 0,
    firstObservedAt: '',
    lastObservedAt: '',
    entries: [],
  };
}

/**
 * Stable identity for a dimension tuple, NUL-separated so no combination of
 * values can collide by concatenation.
 *
 * The separator is written as the ESCAPE `\u0000`, never as a literal NUL
 * byte in the source. A literal one makes git treat this whole file as
 * binary, so `git diff` reports `Bin 12580 -> 12597 bytes` and every review of
 * a change to it sees nothing at all. Found here by a fault injection whose
 * diff was invisible (protocol section 2).
 */
function entryKey(dimensions: ShadowRecordDimensions): string {
  return [
    dimensions.seam,
    dimensions.outcome,
    dimensions.baseline,
    dimensions.provider,
    dimensions.shadow ?? '',
  ].join('\u0000');
}

/**
 * Validate ONE entry. Split out and applied to every element because
 * `Array.isArray(entries)` alone says nothing about what is in the array
 * (review round 1, MEDIUM 4): a structurally-broken entry — a null, a string,
 * a row with `count: "3"` — then flowed straight into the reporter, which
 * summed `entry.count` and rendered `entry.outcome`, and crashed or printed
 * `NaN` instead of answering `unreadable`. A reader whose whole contract is
 * to refuse must refuse on this too.
 */
function isRecordEntry(value: unknown): value is ShadowRecordEntry {
  if (typeof value !== 'object' || value === null) return false;
  const entry = value as Partial<ShadowRecordEntry>;
  return (
    typeof entry.seam === 'string' &&
    typeof entry.outcome === 'string' &&
    typeof entry.baseline === 'string' &&
    typeof entry.provider === 'string' &&
    (entry.shadow === undefined || typeof entry.shadow === 'string') &&
    // The DOMAIN, not just the type (round 2, MEDIUM 1). `entries` is
    // documented as never containing a zero-count row, and the gate keyed the
    // tripwire question off a SUM — so an entry at `count: 0` (or a negative
    // one) escaped both the tripwire check and the divergence loop and the
    // gate returned PASS with a live `conflated-unbound` row on the record.
    // This is the module's own founding defect — a fail-open tripwire read as
    // silent — so the invariant is now derived here instead of asserted in a
    // docblock.
    //
    // `Number.isInteger` also subsumes the `Number.isFinite` clause it
    // replaces, and unlike it is REACHABLE: `JSON.parse` cannot produce NaN
    // or Infinity, but it produces `1.5` happily.
    typeof entry.count === 'number' &&
    Number.isInteger(entry.count) &&
    entry.count > 0 &&
    typeof entry.firstObservedAt === 'string' &&
    typeof entry.lastObservedAt === 'string'
  );
}

function isRecordShape(value: unknown): value is ProjectResourceShadowRecord {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<ProjectResourceShadowRecord>;
  return (
    typeof candidate.version === 'number' &&
    // Same reachability point as `isRecordEntry`'s count: a `Number.isFinite`
    // clause here could never execute its rejection, because `JSON.parse` has
    // no way to produce NaN or Infinity. `Number.isInteger` plus a floor is
    // both a real constraint and one a file can actually violate.
    typeof candidate.observations === 'number' &&
    Number.isInteger(candidate.observations) &&
    candidate.observations >= 0 &&
    typeof candidate.firstObservedAt === 'string' &&
    typeof candidate.lastObservedAt === 'string' &&
    Array.isArray(candidate.entries) &&
    candidate.entries.every(isRecordEntry)
  );
}

type RecordFileRead =
  | { kind: 'ok'; record: ProjectResourceShadowRecord }
  | { kind: 'missing'; reason: string }
  | { kind: 'unusable'; reason: string }
  | { kind: 'wrong-version'; reason: string };

/** Read and validate ONE file, without deciding what to do about it. */
function readRecordFile(filePath: string): RecordFileRead {
  if (!existsSync(filePath)) {
    return { kind: 'missing', reason: `no file at ${filePath}` };
  }
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(filePath, 'utf-8'));
  } catch (error) {
    return {
      kind: 'unusable',
      reason: error instanceof Error ? error.message : String(error),
    };
  }
  // VERSION BEFORE SHAPE, and the order is the whole point (round 3, MEDIUM).
  //
  // Shape-first was airtight in one direction only. `wrong-version` was
  // reachable only after `isRecordShape` passed IN FULL, so it could classify
  // a future record as future ONLY when that record was also valid under v1 —
  // i.e. only for a purely ADDITIVE change. But {@link SHADOW_RECORD_VERSION}
  // is documented as being bumped "when the on-disk shape changes", so the
  // common case is precisely the one shape-first got wrong: a v2 whose shape
  // is not v1-valid fell through to `unusable`, recovered from a stale
  // `.previous`, and the older Station then overwrote the newer one's
  // history — the exact outcome this exception exists to prevent.
  //
  // Asking about `version` alone first needs no knowledge of v2's shape,
  // which is the only thing this reader can honestly claim to know.
  if (typeof value === 'object' && value !== null) {
    const declared = (value as { version?: unknown }).version;
    // A POSITIVE INTEGER, not merely a number (round 4, LOW 2). Hoisting the
    // version check re-stranded corrupt shapes that round 2's recovery had
    // handled — a `1.5` or `0` version is not a record any writer of this
    // format could have produced, so treating it as "a future version I must
    // not overwrite" refuses a file that is simply damaged. Constraining the
    // branch to versions this format could actually emit sends those back to
    // `unusable`, where `.previous` recovers them. `{"version": 2}` still
    // strands, correctly: it is indistinguishable from a real v2 without
    // knowing v2's shape, which this reader cannot claim to know.
    if (
      typeof declared === 'number' &&
      Number.isInteger(declared) &&
      declared > 0 &&
      declared !== SHADOW_RECORD_VERSION
    ) {
      return {
        kind: 'wrong-version',
        reason: `unsupported record version ${declared} (this reader knows ${SHADOW_RECORD_VERSION})`,
      };
    }
  }
  if (!isRecordShape(value)) {
    return { kind: 'unusable', reason: 'not a shadow record' };
  }
  return { kind: 'ok', record: value };
}

/**
 * Read the record for `homeDir`, three-valued (see {@link ShadowRecordRead}).
 * Never throws: a reader that throws on a corrupt file is a reader whose
 * caller will wrap it in a `catch` and print "no divergences".
 *
 * RECOVERS FROM `.previous` WHEN THE PRIMARY IS PRESENT BUT UNUSABLE (round
 * 2, MEDIUM 2). This does NOT delegate to `JsonFileStore.read()` any more,
 * because that consults `.previous` only when the primary is MISSING — a
 * present-but-garbage primary throws straight past the retained copy. Dropping
 * the fsyncs is exactly what makes that state reachable (see the durability
 * note at the top of this file), and {@link recordShadowComparison}'s correct
 * refusal to overwrite an unreadable record then turns it from
 * lossy-but-self-healing into PERMANENTLY STUCK: a good record sits inert in
 * `.previous` while the home silently records nothing, every boot, forever.
 *
 * One deliberate exception: a primary at a version this reader does not know
 * is INTACT, not corrupt. It must keep failing closed rather than falling
 * back, because recovering a stale `.previous` here would let an older
 * Station read it and then write over a newer Station's history — the very
 * thing the version check exists to prevent.
 */
export function readShadowRecord(homeDir: string): ShadowRecordRead {
  const path = shadowRecordPath(homeDir);
  const previousPath = `${path}.previous`;
  if (!existsSync(path) && !existsSync(previousPath)) {
    return { state: 'never-observed', path };
  }

  const primary = readRecordFile(path);
  if (primary.kind === 'ok') {
    return { state: 'observed', path, record: primary.record };
  }
  if (primary.kind === 'wrong-version') {
    return { state: 'unreadable', path, reason: primary.reason };
  }

  const recovered = readRecordFile(previousPath);
  if (recovered.kind === 'ok') {
    return {
      state: 'observed',
      path,
      record: recovered.record,
      recoveredFrom: previousPath,
    };
  }
  if (primary.kind === 'missing') {
    return { state: 'unreadable', path, reason: recovered.reason };
  }
  // Name the PRIMARY's failure — that is the file an operator has to deal
  // with. Mention the fallback only when there WAS one that failed too;
  // saying "`.previous` could not stand in" about a file that never existed
  // is noise, and noise in a refusal reason is how refusals get waved away.
  return {
    state: 'unreadable',
    path,
    reason:
      recovered.kind === 'missing'
        ? primary.reason
        : `${primary.reason} (and ${previousPath} could not stand in: ${recovered.reason})`,
  };
}

/**
 * Record one comparison against `homeDir`.
 *
 * THROWS on an unwritable or corrupt record rather than swallowing: the
 * caller (`observeCwdShadow`) owns the policy, and a record that silently
 * stops being written is precisely the failure this module exists to make
 * impossible to mistake for agreement.
 *
 * THE WRITER READS THROUGH {@link readShadowRecord}, deliberately, so that
 * writer and reader can never disagree about what the current record is
 * (review round 1, MEDIUM 3). Reading the file directly is what the first
 * version did, and it was wrong in two ways that both silently DESTROYED
 * accumulated evidence — the one property this record exists to provide:
 *
 *  - It gated on `existsSync(primary)` alone, while the reader also recovers
 *    from `<path>.previous`. On a boot where the primary was lost but the
 *    `.previous` was not, the reader answered `observed` with the recovered
 *    history while the writer saw "no file", started from an empty record,
 *    and reset `observations` to 1. Cross-boot accumulation is the entire
 *    reason this record exists rather than the OTel counter.
 *  - It fell back to an empty record on a shape it did not recognise
 *    (`isRecordShape(current) ? current : emptyRecord()`), so a file the
 *    reader would refuse as `unreadable` was instead overwritten.
 *
 * Going through the reader makes both cases structural: `never-observed`
 * starts an empty record, `observed` accumulates onto exactly what the
 * reporter would have read, and `unreadable` — which subsumes the old
 * explicit version check — refuses rather than overwrites.
 */
export function recordShadowComparison(
  homeDir: string,
  dimensions: ShadowRecordDimensions,
  now: string = new Date().toISOString(),
): void {
  const file = store(homeDir);
  const read = readShadowRecord(homeDir);
  if (read.state === 'unreadable') {
    throw new Error(
      `Refusing to write over an unreadable shadow record at ${read.path}: ${read.reason}`,
    );
  }
  const record = read.state === 'observed' ? read.record : emptyRecord();

  const key = entryKey(dimensions);
  const existing = record.entries.find((entry) => entryKey(entry) === key);
  if (existing) {
    existing.count += 1;
    existing.lastObservedAt = now;
  } else {
    record.entries.push({
      ...dimensions,
      count: 1,
      firstObservedAt: now,
      lastObservedAt: now,
    });
  }
  record.observations += 1;
  record.firstObservedAt = record.firstObservedAt || now;
  record.lastObservedAt = now;
  file.write(record);
}

/**
 * The populations station#1501 slice 3c's gate asks to have been exercised,
 * declared as DATA so the reader and the issue cannot drift apart in prose.
 *
 * Each is a dimension predicate over the record, not a count threshold: the
 * gate's question is "was this population observed at all", and a threshold
 * would let one blind spot hide behind another (protocol §6, "prefer an
 * exact set to a floor").
 */
export interface ShadowPopulation {
  id: string;
  /** What real-world shape produces it, for the reader's own output. */
  description: string;
  outcome: string;
  baseline: string;
  shadow: string;
}

export const SLICE_3C_POPULATIONS: readonly ShadowPopulation[] = [
  {
    id: 'directory-bound',
    description:
      'an ordinary project whose declared working directory exists and the resolver verified',
    outcome: 'agree',
    baseline: 'directory',
    shadow: 'bound',
  },
  {
    id: 'directory-less',
    description:
      'station#1023: a project that declares no directory and terminates at $HOME',
    outcome: 'agree',
    baseline: 'no-directory',
    shadow: 'unbound',
  },
  {
    id: 'declared-and-gone',
    description:
      'station#791: a project that declares a working directory that is not there',
    outcome: 'agree',
    baseline: 'missing-directory',
    shadow: 'missing',
  },
  {
    id: 'manifested-git-unverified',
    description:
      'station#1594: a manifested git resource the resolver could not identity-check (`git` unavailable)',
    outcome: 'agree-unverified',
    baseline: 'directory',
    shadow: 'stale',
  },
];

/**
 * The FAIL-OPEN tripwire outcome. Absent-with-observations means it did not
 * fire; absent-with-no-observations means nothing looked. The reader must
 * never print the two the same way.
 */
export const SHADOW_TRIPWIRE_OUTCOME = 'conflated-unbound';

/**
 * Outcomes that are not a disagreement. Mirrors
 * `project-resource-shadow.ts`'s `NON_DIVERGENT_OUTCOMES` and is pinned
 * against it by test — two copies of this set that can drift is exactly the
 * shape that makes a divergence record read empty.
 */
export const NON_DIVERGENT_RECORD_OUTCOMES: readonly string[] = [
  'agree',
  'agree-unverified',
  'agree-drifted',
  'both-failed-closed',
  'disabled',
];
