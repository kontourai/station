#!/usr/bin/env tsx
/**
 * station#1686 — read the project-resource shadow's observation record.
 *
 * `station.project_resource.shadow_comparisons` is a no-op unless an OTLP
 * collector is attached, so this reads the durable per-home record written
 * alongside it (`src-server/services/projects/project-resource-shadow-record.ts`).
 *
 * THE ONE RULE THIS OUTPUT EXISTS TO HOLD: an outcome that was never
 * observed and an outcome that was observed zero times must never render the
 * same. There is no such thing as a zero row here — an unobserved population
 * prints `NOT OBSERVED` and an unfired tripwire prints the number of
 * comparisons it did not fire across. With no record at all, every line says
 * so explicitly and `--gate` refuses.
 *
 *   npx tsx scripts/project-resource-shadow-report.ts [--home <dir>] [--json] [--gate]
 *
 * `--gate` exits non-zero unless the record shows slice 3c's four populations
 * exercised, the fail-open tripwire absent, and no divergent outcome recorded.
 * It also refuses a RECOVERED record — one salvaged from `.previous` after a
 * corrupt primary — because the tripwire and divergence questions are absence
 * claims and the recovery discarded an unbounded window of observations.
 * Population coverage survives recovery (it is a floor); those two do not.
 */

import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  NON_DIVERGENT_RECORD_OUTCOMES,
  type ProjectResourceShadowRecord,
  readShadowRecord,
  SHADOW_TRIPWIRE_OUTCOME,
  type ShadowRecordEntry,
  SLICE_3C_POPULATIONS,
} from '../src-server/services/projects/project-resource-shadow-record.js';

interface Options {
  homeDir: string;
  json: boolean;
  gate: boolean;
}

export function parseArgs(argv: readonly string[]): Options {
  let homeDir: string | undefined;
  let json = false;
  let gate = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--home') {
      // REFUSED rather than defaulted (review round 1, LOW 9). `--home` as
      // the final argument, or immediately before another flag, used to
      // consume `undefined` and fall through to the DEFAULT home — so the
      // reporter answered about `~/.station` while the caller believed it had
      // named a home, and `--gate` returned a verdict about the wrong record.
      // A gate that answers about something other than what it was asked is
      // the silent-wrong-answer shape, not a usability nit.
      const value = argv[i + 1];
      if (value === undefined || value === '' || value.startsWith('--')) {
        throw new Error('--home requires a directory argument');
      }
      homeDir = value;
      i += 1;
    } else if (arg.startsWith('--home=')) {
      homeDir = arg.slice('--home='.length);
      if (homeDir === '') {
        throw new Error('--home requires a directory argument');
      }
    } else if (arg === '--json') {
      json = true;
    } else if (arg === '--gate') {
      gate = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (homeDir === undefined) {
    homeDir = process.env.STATION_HOME?.trim() || join(homedir(), '.station');
  }
  return { homeDir, json, gate };
}

/**
 * What a PASSING gate does not prove (station#1775, review round 1,
 * MEDIUM 6).
 *
 * The record accumulates across every Station build that has ever run in this
 * home and carries no provenance, so coverage is a statement about the HOME's
 * history, not about the resolver currently on disk. Slice 3c is a one-way
 * flip of a fail-closed seam every engine family reaches, and it intends to
 * cite this gate — so the limit of the claim travels WITH the verdict, in the
 * human rendering and as data in `--json`, rather than living only in an
 * issue nobody re-reads at flip time. A gate cited as authority must name
 * where its authority stops.
 */
export const GATE_LIMIT_NO_PROVENANCE =
  'This record accumulates across every Station version that has ever run in this home and carries no provenance. A pass says these populations were observed AT SOME POINT — not that they were exercised by the resolver currently on disk (station#1775).';

/**
 * The seam-scope limit, DERIVED from the record rather than asserted (round 2,
 * LOW 6).
 *
 * This used to be a hardcoded sentence naming `start_session_cwd`, which is a
 * claim about which seams call `observeCwdShadow` that no code checked — add
 * a second seam and the gate would have printed a confidently false scope.
 * The record carries a `seam` dimension on every entry, so the enumeration
 * now comes from the observations themselves and cannot drift from them.
 *
 * The sub-step caveat stays prose: it is a property of what `observeCwdShadow`
 * compares WITHIN a seam (`project-resource-shadow.ts` decision 1, SCOPE), and
 * nothing in the record can derive it. It is folded into station#1775 with the
 * rest of the provenance question rather than left as a claim pretending to be
 * derived.
 */
export function seamCoverageLimit(seams: readonly string[]): string {
  const named = seams.length > 0 ? seams.join(', ') : 'no seam at all';
  return `Coverage is observed at ${seams.length === 1 ? 'one seam' : `${seams.length} seams`} — ${named} — and only for the project-resolution sub-step within it. Caller-supplied-cwd precedence, the $HOME/ACP terminus, and the final existence check on the effective cwd are unshadowed and unproven here (station#1775).`;
}

type PopulationStatus =
  | { id: string; description: string; covered: true; count: number }
  | { id: string; description: string; covered: false };

interface ShadowReportBase {
  path: string;
  gateReasons: string[];
  /**
   * What a pass does not prove; carried as data so `--json` consumers see it
   * too. Partly derived from the record (see {@link seamCoverageLimit}), so
   * it is built per report rather than being a module constant.
   */
  gateLimits: readonly string[];
}

/** The parts of a report that only exist once a record has been read. */
interface ShadowReportRecordFields {
  observations: number;
  firstObservedAt: string;
  lastObservedAt: string;
  populations: PopulationStatus[];
  /** Absent-with-observations is a fact; absent-with-none is not. */
  tripwire:
    | { outcome: string; fired: false }
    | { outcome: string; fired: true; count: number };
  divergences: ShadowRecordEntry[];
  killSwitch: { count: number };
}

/**
 * A DISCRIMINATED UNION, not one interface with optional fields (review
 * round 1, MEDIUM 5).
 *
 * As one flat interface, `observations?: number` was representable as absent
 * on an `observed` report, and the renderer duly wrote `report.observations
 * ?? 0` — which prints "did not fire across 0 recorded comparison(s)", the
 * exact conflation of "observed nothing" with "never observed" that this
 * whole module exists to prevent, in the one sentence a reader would take as
 * the tripwire's all-clear. That is "a default that decides"
 * (`docs/guides/code-quality.md`): the fallback participates in a claim about
 * evidence.
 *
 * The fix is to make it unrepresentable rather than to guard it, so the
 * renderer cannot reach a count that is not there and no future edit can
 * reintroduce the fallback without a type error.
 */
export type ShadowReport =
  | (ShadowReportBase & { state: 'never-observed'; gatePass: false })
  | (ShadowReportBase & {
      state: 'unreadable';
      reason: string;
      gatePass: false;
    })
  | (ShadowReportBase &
      ShadowReportRecordFields & { state: 'observed'; gatePass: boolean })
  /**
   * RECOVERY IS ITS OWN STATE, not an optional field on `observed` (round 4,
   * MEDIUM 1).
   *
   * Round 3 forced a recovered record to fail the gate and this file then
   * CLAIMED the hazard was "unrepresentable rather than guarded". It was not:
   * `gatePass` lived on the shared base and `recoveredFrom` was an optional
   * field, so nothing related them and `{state: 'observed', recoveredFrom:
   * '…', gatePass: true, gateReasons: []}` compiled clean under `--strict`.
   * The runtime invariant held, but the durability claim was a label nothing
   * computed — this repo's own most-repeated defect, committed in a comment
   * about avoiding it.
   *
   * Now the compiler carries it. `gatePass` is declared per state, `false` on
   * every state that cannot pass, so a passing recovered report is a type
   * error rather than a convention. `recoveredFrom` is required here and
   * absent everywhere else, so a consumer cannot read a recovered record as
   * an intact one by forgetting to check a field — the same move that made
   * `never-observed` and `unreadable` honest instead of folding them into an
   * empty `observed`.
   */
  | (ShadowReportBase &
      ShadowReportRecordFields & {
        state: 'recovered';
        recoveredFrom: string;
        gatePass: false;
      });

function matchCount(
  record: ProjectResourceShadowRecord,
  predicate: (entry: ShadowRecordEntry) => boolean,
): number {
  return record.entries
    .filter(predicate)
    .reduce((total, entry) => total + entry.count, 0);
}

export function buildReport(
  homeDir: string,
  read = readShadowRecord(homeDir),
): ShadowReport {
  if (read.state !== 'observed') {
    const reasons = [
      read.state === 'unreadable'
        ? `the record could not be read: ${read.reason}`
        : 'no comparison has ever been recorded in this home',
    ];
    return read.state === 'unreadable'
      ? {
          path: read.path,
          state: 'unreadable',
          reason: read.reason,
          gatePass: false,
          gateReasons: reasons,
          gateLimits: [GATE_LIMIT_NO_PROVENANCE],
        }
      : {
          path: read.path,
          state: 'never-observed',
          gatePass: false,
          gateReasons: reasons,
          gateLimits: [GATE_LIMIT_NO_PROVENANCE],
        };
  }

  const record = read.record;
  const populations: PopulationStatus[] = SLICE_3C_POPULATIONS.map(
    (population) => {
      const count = matchCount(
        record,
        (entry) =>
          entry.outcome === population.outcome &&
          entry.baseline === population.baseline &&
          entry.shadow === population.shadow,
      );
      return count > 0
        ? {
            id: population.id,
            description: population.description,
            covered: true,
            count,
          }
        : {
            id: population.id,
            description: population.description,
            covered: false,
          };
    },
  );

  // PRESENCE, not a sum (round 2, MEDIUM 1). Keying the fail-open tripwire
  // off `matchCount(...) > 0` meant a `conflated-unbound` entry at `count: 0`
  // (or negative) escaped this check AND the divergence loop below, which
  // `continue`s past the tripwire outcome to avoid double-reporting — so the
  // gate returned PASS with a live tripwire row on the record, printing three
  // mutually contradicting sections and handing `--json` `gatePass: true`.
  // The record's `count >= 1` invariant is now derived by `isRecordEntry`
  // too; these are two independent guards on the same fail-open, which is the
  // right number for the tripwire the whole module was built around.
  const tripwireFired = record.entries.some(
    (entry) => entry.outcome === SHADOW_TRIPWIRE_OUTCOME,
  );
  const tripwireCount = matchCount(
    record,
    (entry) => entry.outcome === SHADOW_TRIPWIRE_OUTCOME,
  );
  const divergences = record.entries.filter(
    (entry) => !NON_DIVERGENT_RECORD_OUTCOMES.includes(entry.outcome),
  );
  const killSwitchCount = matchCount(
    record,
    (entry) => entry.outcome === 'disabled',
  );

  const gateReasons: string[] = [];
  if (read.recoveredFrom) {
    // ROUND 3, HIGH. Recovering a corrupt primary from `.previous` is right;
    // letting the result PASS is the module's founding defect — emptiness
    // read as clearance — walking back in through the door built to close it.
    //
    // The direction analysis is what makes this non-negotiable, because the
    // two questions the gate asks behave OPPOSITELY under a truncated window:
    //
    //  - Population coverage is a PRESENCE claim on a floor. Covered on the
    //    salvaged record implies covered in truth, so a pass there is sound.
    //  - The tripwire and the divergence list are ABSENCE claims. Recovery
    //    discarded an unbounded window of observations, and absence over a
    //    truncated window is not absence. A `conflated-unbound` row that was
    //    in the primary and not in `.previous` is now simply gone.
    //
    // Observed live: one home, changing nothing but the primary, went from
    // `gatePass: false` (tripwire fired 1 time) to `gatePass: true` with an
    // empty reason list purely by corrupting the primary.
    //
    // The REASON is recorded here so the refusal explains itself; the refusal
    // ITSELF is carried by the type (`state: 'recovered'` fixes
    // `gatePass: false`), not by this push. Round 3 claimed the opposite —
    // that pushing here made the hazard unrepresentable — which was untrue
    // while `gatePass` sat on the shared base and `recoveredFrom` was
    // optional; see the `ShadowReport` docblock.
    gateReasons.push(
      `the record was RECOVERED from ${read.recoveredFrom}, so the tripwire and divergence answers are absence claims over a truncated window and cannot be trusted`,
    );
  }
  if (record.observations === 0) {
    gateReasons.push('the record exists but holds zero comparisons');
  }
  for (const population of populations) {
    if (!population.covered) {
      gateReasons.push(`population "${population.id}" was never observed`);
    }
  }
  if (tripwireFired) {
    gateReasons.push(
      `the fail-open tripwire "${SHADOW_TRIPWIRE_OUTCOME}" fired ${tripwireCount} time(s)`,
    );
  }
  for (const entry of divergences) {
    if (entry.outcome === SHADOW_TRIPWIRE_OUTCOME) continue;
    gateReasons.push(
      `divergent outcome "${entry.outcome}" recorded ${entry.count} time(s)`,
    );
  }

  const recordFields = {
    observations: record.observations,
    firstObservedAt: record.firstObservedAt,
    lastObservedAt: record.lastObservedAt,
    populations,
    tripwire: tripwireFired
      ? {
          outcome: SHADOW_TRIPWIRE_OUTCOME,
          fired: true,
          count: tripwireCount,
        }
      : { outcome: SHADOW_TRIPWIRE_OUTCOME, fired: false },
    divergences,
    killSwitch: { count: killSwitchCount },
  } satisfies ShadowReportRecordFields;

  const shared = {
    path: read.path,
    gateReasons,
    gateLimits: [
      GATE_LIMIT_NO_PROVENANCE,
      seamCoverageLimit([...new Set(record.entries.map((e) => e.seam))].sort()),
    ],
  };

  // The gate cannot pass a recovered record, and now the TYPE says so rather
  // than this function remembering to push a reason.
  return read.recoveredFrom
    ? {
        ...shared,
        ...recordFields,
        state: 'recovered',
        recoveredFrom: read.recoveredFrom,
        gatePass: false,
      }
    : {
        ...shared,
        ...recordFields,
        state: 'observed',
        gatePass: gateReasons.length === 0,
      };
}

/**
 * The GATE verdict block, rendered for EVERY state (review round 1, LOW 9).
 *
 * `never-observed` and `unreadable` used to return early, so
 * `--gate` printed no `GATE:` line at all on the two states it most needs to
 * refuse on — and a gate that prints no verdict is indistinguishable, to
 * anyone reading the output, from a gate that passed. It still exited 1, but
 * the exit status is the thing a human scrolling a terminal does not see.
 */
function gateVerdictLines(report: ShadowReport): string[] {
  const lines = [
    '',
    report.gatePass
      ? 'GATE: pass — every population observed, tripwire silent, no divergence recorded.'
      : 'GATE: fail',
  ];
  for (const reason of report.gateReasons) {
    lines.push(`  - ${reason}`);
  }
  if (report.gatePass) {
    // Only on a pass: a refusal claims no authority, so the limits of the
    // authority are noise there. On a pass this gate WILL be cited for
    // station#1501 slice 3c's one-way flip.
    lines.push('', 'WHAT THIS PASS DOES NOT PROVE');
    for (const limit of report.gateLimits) {
      lines.push(`  - ${limit}`);
    }
  }
  return lines;
}

export function renderReport(report: ShadowReport): string {
  const lines: string[] = [
    'Project resource shadow — station#1501 slice 3c observation record',
    `Record: ${report.path}`,
    '',
  ];

  if (report.state === 'never-observed') {
    lines.push(
      'STATUS: NOT OBSERVED — no shadow comparison has ever been recorded in this home.',
      '',
      'This is NOT clearance. Every slice 3c question below is unanswered, not answered',
      'negatively: an empty divergence record and an unfired fail-open tripwire are exactly',
      'what an observer that never ran produces (station#1686).',
      '',
      `  populations exercised        NOT OBSERVED (0 of ${SLICE_3C_POPULATIONS.length} answerable)`,
      `  ${SHADOW_TRIPWIRE_OUTCOME} tripwire   NOT OBSERVED (cannot be read as "did not fire")`,
      '  divergences                  NOT OBSERVED (cannot be read as "none")',
      ...gateVerdictLines(report),
    );
    return `${lines.join('\n')}\n`;
  }

  if (report.state === 'unreadable') {
    lines.push(
      `STATUS: UNREADABLE — ${report.reason}`,
      '',
      'A record that cannot be read says nothing about population coverage, the fail-open',
      'tripwire, or divergences. It is deliberately not folded into "nothing was observed".',
      ...gateVerdictLines(report),
    );
    return `${lines.join('\n')}\n`;
  }

  const observations = report.observations;
  // A readable, correctly-versioned record carrying zero comparisons is not
  // something this module's writer can produce — it always increments before
  // it writes — so it means a hand-authored or externally-truncated file. It
  // is still READABLE, so calling it `unreadable` would overstate; what it
  // must never do is answer the tripwire and divergence questions, because
  // "none across 0 comparisons" is the emptiness-as-clearance sentence with a
  // denominator of nothing (review round 1, MEDIUM 5; independently found
  // from the other direction by the verifier).
  const empty = observations === 0;
  lines.push(
    // The headline names the STATE, not just the count (round 5, LOW 1). The
    // state rename left this branch behind, so a recovered report announced
    // `STATUS: OBSERVED` while its own `state` field — and `--json` — said
    // `recovered`. Not false (those comparisons were recorded, and the banner
    // two lines down qualifies it), but a report whose top line disagrees with
    // its own state is the vocabulary defect this module exists to police.
    report.state === 'recovered'
      ? `STATUS: RECOVERED — ${observations} comparison(s) recovered from a salvaged copy`
      : empty
        ? 'STATUS: RECORD PRESENT, ZERO COMPARISONS — the file is readable and holds no observation.'
        : `STATUS: OBSERVED — ${observations} comparison(s) recorded`,
    `First ${report.firstObservedAt} · last ${report.lastObservedAt}`,
  );
  if (report.state === 'recovered') {
    // A recovered record is not an intact one, and rendering it as an
    // ordinary OBSERVED would be a label the reader would trust.
    lines.push(
      '',
      `RECOVERED — the primary record was unusable; this was read from ${report.recoveredFrom}.`,
      'Every comparison written since that copy was rotated is LOST, and nothing bounds how',
      'many that was. The two kinds of answer below are affected in OPPOSITE directions:',
      '',
      '  populations exercised   A FLOOR, and therefore still sound. Coverage shown here was',
      '                          really observed; the record can only understate it.',
      `  ${SHADOW_TRIPWIRE_OUTCOME} tripwire  UNSOUND. "Did not fire" is an absence claim, and absence`,
      '                          over a truncated window is not absence. A row that was in the',
      '                          lost primary and not in this copy is simply gone.',
      '  divergences             UNSOUND, for the same reason. "None" cannot be concluded.',
      '',
      'This is why --gate refuses a recovered record outright rather than reporting on it.',
    );
  }
  lines.push('', 'Slice 3c populations');
  for (const population of report.populations) {
    lines.push(
      population.covered
        ? `  [observed ${String(population.count).padStart(6)}] ${population.id} — ${population.description}`
        : `  [NOT OBSERVED     ] ${population.id} — ${population.description}`,
    );
  }

  lines.push('', 'Fail-open tripwire');
  const tripwire = report.tripwire;
  if (tripwire.fired) {
    lines.push(
      `  ${tripwire.outcome} FIRED ${tripwire.count} time(s) — slice 3c must not flip.`,
    );
  } else if (empty) {
    lines.push(
      `  ${SHADOW_TRIPWIRE_OUTCOME} NOT OBSERVED — the record holds zero comparisons, so its`,
      '  absence cannot be read as "did not fire".',
    );
  } else if (report.state === 'recovered') {
    // Absence over a truncated window is not absence (round 3, HIGH). The
    // denominator is a floor, so "did not fire across N" would assert
    // something this record cannot support.
    lines.push(
      `  ${SHADOW_TRIPWIRE_OUTCOME} NOT ANSWERABLE — no row survives in this recovered copy,`,
      `  but it covers only ${observations} of an unknown number of comparisons, so that is`,
      '  not evidence the tripwire did not fire.',
    );
  } else {
    lines.push(
      `  ${SHADOW_TRIPWIRE_OUTCOME} did not fire across ${observations} recorded comparison(s).`,
    );
  }

  lines.push('', 'Divergences');
  const divergences = report.divergences;
  if (divergences.length === 0 && empty) {
    lines.push(
      '  NOT OBSERVED — the record holds zero comparisons, so this cannot be read as "none".',
    );
  } else if (divergences.length === 0 && report.state === 'recovered') {
    lines.push(
      `  NOT ANSWERABLE — none survive in this recovered copy, but it covers only ${observations}`,
      '  of an unknown number of comparisons, so "none" cannot be concluded.',
    );
  } else if (divergences.length === 0) {
    lines.push(`  none across ${observations} recorded comparison(s).`);
  } else {
    for (const entry of divergences) {
      lines.push(
        `  ${entry.outcome} ×${entry.count} (baseline=${entry.baseline}, shadow=${entry.shadow ?? 'threw'}, provider=${entry.provider})`,
      );
    }
  }

  const killSwitch = report.killSwitch.count;
  if (killSwitch > 0) {
    lines.push(
      '',
      'Kill switch',
      `  ${killSwitch} comparison(s) were recorded with STATION_PROJECT_RESOURCE_SHADOW=off, so`,
      '  nothing was compared for them. They are counted here so a quiet record caused by the',
      '  kill switch can never be read as a quiet record caused by agreement.',
    );
  }

  lines.push(...gateVerdictLines(report));
  return `${lines.join('\n')}\n`;
}

export function main(argv: readonly string[]): number {
  const options = parseArgs(argv);
  const report = buildReport(options.homeDir);
  process.stdout.write(
    options.json
      ? `${JSON.stringify(report, null, 2)}\n`
      : renderReport(report),
  );
  return options.gate && !report.gatePass ? 1 : 0;
}

if (process.argv[1]?.endsWith('project-resource-shadow-report.ts')) {
  process.exit(main(process.argv.slice(2)));
}
