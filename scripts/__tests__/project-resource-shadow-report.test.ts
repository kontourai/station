/**
 * station#1686 — the shadow record's reader, including its refusal path.
 *
 * "A guardrail whose rejection path has never executed is unproven"
 * (`docs/strategy/multi-agent-delivery-protocol.md` §6), and this reader's
 * whole purpose is to refuse: it exists because an unread counter let an
 * absence render as clearance. So the exit status is asserted by RUNNING THE
 * SCRIPT as a child process, not by inspecting a returned number — a script
 * that sets `process.exitCode` and never exits non-zero would pass the
 * in-process form.
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import {
  readShadowRecord,
  recordShadowComparison,
  SHADOW_RECORD_VERSION,
  SLICE_3C_POPULATIONS,
  shadowRecordPath,
} from '../../src-server/services/projects/project-resource-shadow-record.js';
import {
  buildReport,
  parseArgs,
  renderReport,
  type ShadowReport,
} from '../project-resource-shadow-report.js';

/** Narrow to the `observed` variant, failing loudly rather than optional-chaining. */
function observed(
  report: ShadowReport,
): Extract<ShadowReport, { state: 'observed' }> {
  if (report.state !== 'observed') {
    throw new Error(`expected an observed report, got ${report.state}`);
  }
  return report;
}

/** Narrow to the `recovered` variant (round 4, MEDIUM 1). */
function recovered(
  report: ShadowReport,
): Extract<ShadowReport, { state: 'recovered' }> {
  if (report.state !== 'recovered') {
    throw new Error(`expected a recovered report, got ${report.state}`);
  }
  return report;
}

const REPORTER = resolve(
  import.meta.dirname,
  '..',
  'project-resource-shadow-report.ts',
);

const tmpRoots: string[] = [];
let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'station-1686-report-'));
  tmpRoots.push(home);
});

afterEach(() => {
  while (tmpRoots.length > 0) {
    const dir = tmpRoots.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function seedEveryPopulation(): void {
  for (const population of SLICE_3C_POPULATIONS) {
    recordShadowComparison(home, {
      seam: 'start_session_cwd',
      provider: 'claude',
      outcome: population.outcome,
      baseline: population.baseline,
      shadow: population.shadow,
    });
  }
}

/**
 * Run the reporter as a REAL child process, so an exit status is proven
 * rather than inferred from a returned number.
 *
 * Each call spawns `npx tsx` and costs seconds. This file is listed in
 * `PROCESS_HEAVY_VITEST_FILES`, and that group runs one worker under a
 * five-minute execution deadline shared with `verification-stress.test.ts`,
 * whose assertions are themselves timing-sensitive. So keep the number of
 * these deliberately small: use `buildReport`/`renderReport` in-process for
 * anything that is not specifically a claim about the real exit status or the
 * real stdout, and fold assertions into an existing spawn when the command
 * and fixture are identical.
 */
function runReporter(args: readonly string[]): {
  status: number;
  stdout: string;
} {
  try {
    const stdout = execFileSync(
      'npx',
      ['tsx', REPORTER, '--home', home, ...args],
      { cwd: resolve(import.meta.dirname, '..', '..'), encoding: 'utf-8' },
    );
    return { status: 0, stdout };
  } catch (error) {
    const failure = error as { status?: number; stdout?: string };
    return { status: failure.status ?? -1, stdout: failure.stdout ?? '' };
  }
}

describe('the report never renders "never observed" as a zero', () => {
  test('an empty home reports every slice 3c question as UNANSWERED, not as clean', () => {
    const rendered = renderReport(buildReport(home));
    expect(rendered).toContain('STATUS: NOT OBSERVED');
    expect(rendered).toContain('This is NOT clearance');
    // The tripwire line must not be readable as "did not fire".
    expect(rendered).toContain(
      'conflated-unbound tripwire   NOT OBSERVED (cannot be read as "did not fire")',
    );
    expect(rendered).toContain(
      'divergences                  NOT OBSERVED (cannot be read as "none")',
    );
    // And nowhere does a bare zero stand in for the missing observation.
    expect(rendered).not.toMatch(/conflated-unbound[^\n]*\b0\b/);
  });

  test('an OBSERVED record renders the tripwire silence against its own denominator', () => {
    seedEveryPopulation();
    const rendered = renderReport(buildReport(home));
    expect(rendered).toContain('STATUS: OBSERVED — 4 comparison(s) recorded');
    expect(rendered).toContain(
      'conflated-unbound did not fire across 4 recorded comparison(s).',
    );
    expect(rendered).toContain('none across 4 recorded comparison(s).');
  });

  test('an unreadable record is its own status, not "nothing was observed"', () => {
    writeFileSync(shadowRecordPath(home), 'not json at all');
    const rendered = renderReport(buildReport(home));
    expect(rendered).toContain('STATUS: UNREADABLE');
    expect(rendered).not.toContain('NOT OBSERVED');
  });
});

describe('population coverage', () => {
  test('a partially-covered record names the missing legs individually', () => {
    recordShadowComparison(home, {
      seam: 'start_session_cwd',
      provider: 'claude',
      outcome: 'agree',
      baseline: 'directory',
      shadow: 'bound',
    });
    const report = observed(buildReport(home));
    const covered = report.populations.filter((p) => p.covered);
    expect(covered.map((p) => p.id)).toEqual(['directory-bound']);
    expect(report.gatePass).toBe(false);
    expect(report.gateReasons).toContain(
      'population "directory-less" was never observed',
    );
    // The `stale` leg specifically — the one `agree-drifted` must not stand
    // in for (station#1594).
    expect(report.gateReasons).toContain(
      'population "manifested-git-unverified" was never observed',
    );
  });

  test('an `agree-drifted` sample does NOT satisfy the `stale` leg', () => {
    seedEveryPopulation();
    // Replace nothing; just add drift and confirm the leg's coverage came
    // from `stale` and not from the drifted sample.
    recordShadowComparison(home, {
      seam: 'start_session_cwd',
      provider: 'claude',
      outcome: 'agree-drifted',
      baseline: 'directory',
      shadow: 'drifted',
    });
    const staleOnly = observed(buildReport(home)).populations.find(
      (p) => p.id === 'manifested-git-unverified',
    );
    expect(staleOnly).toEqual(
      expect.objectContaining({ covered: true, count: 1 }),
    );
  });
});

describe('the gate refuses', () => {
  test('a fired tripwire fails the gate even with every population covered', () => {
    seedEveryPopulation();
    recordShadowComparison(home, {
      seam: 'start_session_cwd',
      provider: 'claude',
      outcome: 'conflated-unbound',
      baseline: 'missing-directory',
      shadow: 'unbound',
    });
    const report = buildReport(home);
    expect(report.gatePass).toBe(false);
    expect(report.gateReasons?.[0]).toContain(
      'fail-open tripwire "conflated-unbound" fired 1 time(s)',
    );
  });

  test('a recorded divergence fails the gate', () => {
    seedEveryPopulation();
    recordShadowComparison(home, {
      seam: 'start_session_cwd',
      provider: 'claude',
      outcome: 'path-mismatch',
      baseline: 'directory',
      shadow: 'bound',
    });
    const report = buildReport(home);
    expect(report.gatePass).toBe(false);
    expect(report.gateReasons).toContain(
      'divergent outcome "path-mismatch" recorded 1 time(s)',
    );
  });
});

describe('the real exit status', () => {
  test('--gate exits 1 on a home that has never observed anything, and SAYS so', () => {
    const { status, stdout } = runReporter(['--gate']);
    expect(status).toBe(1);
    expect(stdout).toContain('STATUS: NOT OBSERVED');
    // Round 1, LOW 9b, folded in here rather than spawning a second identical
    // child process: a gate that prints no verdict is indistinguishable, to a
    // human reading the output, from a gate that passed. The exit status is
    // not what someone scrolling a terminal reads.
    //
    // Merged deliberately — this file is in PROCESS_HEAVY_VITEST_FILES, whose
    // group runs one worker under a five-minute deadline, and it had grown
    // to six `npx tsx` spawns. Two of them ran the IDENTICAL command on the
    // IDENTICAL fixture. See the note on `runReporter`.
    expect(stdout).toContain('GATE: fail');
  }, 60_000);

  test('--gate exits 0 once every population is observed and nothing diverged', () => {
    seedEveryPopulation();
    const { status, stdout } = runReporter(['--gate']);
    expect(status).toBe(0);
    expect(stdout).toContain('GATE: pass');
  }, 60_000);
});

describe('a gate always prints a verdict (review round 1, LOW 9)', () => {
  // A gate that prints no GATE: line is indistinguishable, to a human reading
  // the output, from a gate that passed — and these are the two states the
  // gate most needs to refuse on. Both used to return before the verdict
  // block.
  test('a never-observed home prints GATE: fail and the reason', () => {
    const rendered = renderReport(buildReport(home));
    expect(rendered).toContain('GATE: fail');
    expect(rendered).toContain(
      '- no comparison has ever been recorded in this home',
    );
    expect(rendered).not.toContain('GATE: pass');
  });

  test('an unreadable record prints GATE: fail and the reason', () => {
    writeFileSync(shadowRecordPath(home), 'not json at all');
    const rendered = renderReport(buildReport(home));
    expect(rendered).toContain('GATE: fail');
    expect(rendered).toContain('- the record could not be read:');
  });

  // The real-child-process proof for this case lives in 'the real exit
  // status' above, folded into the never-observed run so the group does not
  // pay for two identical spawns.
});

describe('--home refuses a missing value (review round 1, LOW 9)', () => {
  // Falling through to the DEFAULT home means answering about a different
  // record than the caller named — on a gate, a silent wrong answer.
  test.each([
    ['as the final argument', ['--home']],
    ['immediately before another flag', ['--home', '--gate']],
    ['given empty via =', ['--home=']],
  ])('%s throws instead of defaulting', (_label, argv) => {
    expect(() => parseArgs(argv)).toThrow(/--home requires a directory/);
  });

  test('a well-formed --home is still honoured, in both spellings', () => {
    expect(parseArgs(['--home', home]).homeDir).toBe(home);
    expect(parseArgs([`--home=${home}`]).homeDir).toBe(home);
  });
});

describe('a readable record holding zero comparisons (review round 1, MEDIUM 5)', () => {
  // Reachable only by hand-authoring or truncation — the writer always
  // increments before it writes — but the renderer used to answer the
  // tripwire and divergence questions against a denominator of nothing:
  // "did not fire across 0 recorded comparison(s)", which is precisely the
  // emptiness-as-clearance sentence this module exists to prevent.
  function seedEmptyRecord(): void {
    writeFileSync(
      shadowRecordPath(home),
      JSON.stringify({
        version: SHADOW_RECORD_VERSION,
        observations: 0,
        firstObservedAt: '',
        lastObservedAt: '',
        entries: [],
      }),
    );
  }

  test('it never claims the tripwire "did not fire" or that divergences are "none"', () => {
    seedEmptyRecord();
    const rendered = renderReport(buildReport(home));
    expect(rendered).not.toContain('did not fire across');
    expect(rendered).not.toContain('none across');
    expect(rendered).toContain('STATUS: RECORD PRESENT, ZERO COMPARISONS');
    expect(rendered).toContain(
      'conflated-unbound NOT OBSERVED — the record holds zero comparisons',
    );
    expect(rendered).toContain(
      'NOT OBSERVED — the record holds zero comparisons, so this cannot be read as "none".',
    );
  });

  test('and the gate refuses it', () => {
    seedEmptyRecord();
    const report = buildReport(home);
    expect(report.gatePass).toBe(false);
    expect(report.gateReasons).toContain(
      'the record exists but holds zero comparisons',
    );
    expect(renderReport(report)).toContain('GATE: fail');
  });
});

describe('a non-positive tripwire entry cannot pass the gate (round 2, MEDIUM 1)', () => {
  const entry = (outcome: string, count: number) => ({
    seam: 'start_session_cwd',
    provider: 'claude',
    outcome,
    baseline: 'missing-directory',
    shadow: 'unbound',
    count,
    firstObservedAt: '2026-08-01T00:00:00.000Z',
    lastObservedAt: '2026-08-01T00:00:00.000Z',
  });

  // TWO independent guards, tested independently, because this is the
  // module's own founding defect — a fail-open tripwire read as silent — on
  // the gate slice 3c's one-way flip intends to cite.

  test.each([0, -3])(
    'guard 1, the record: a tripwire entry at count %i is `unreadable`',
    (count) => {
      writeFileSync(
        shadowRecordPath(home),
        JSON.stringify({
          version: SHADOW_RECORD_VERSION,
          observations: 4,
          firstObservedAt: '2026-08-01T00:00:00.000Z',
          lastObservedAt: '2026-08-01T00:00:00.000Z',
          entries: [entry('conflated-unbound', count)],
        }),
      );
      const report = buildReport(home);
      expect(report.state).toBe('unreadable');
      expect(report.gatePass).toBe(false);
    },
  );

  test.each([0, -3])(
    'guard 2, the gate: a tripwire entry at count %i fails even if it reaches buildReport',
    (count) => {
      // Injected past the record validator on purpose: the gate must not
      // depend on the reader having caught it. Keying the tripwire question
      // off a SUM let this row escape both the tripwire check and the
      // divergence loop, and the gate returned PASS.
      seedEveryPopulation();
      const read = readShadowRecord(home);
      if (read.state !== 'observed') throw new Error('unreachable');
      read.record.entries.push(entry('conflated-unbound', count));

      const report = buildReport(home, read);
      expect(report.gatePass).toBe(false);
      expect(report.gateReasons).toContain(
        `the fail-open tripwire "conflated-unbound" fired ${count} time(s)`,
      );
      const rendered = renderReport(report);
      expect(rendered).toContain('GATE: fail');
      // And the three sections agree with each other, which they did not.
      expect(rendered).not.toContain('did not fire across');
      expect(rendered).toContain('FIRED');
    },
  );
});

describe('a recovered record is not rendered as an intact one (round 2, MEDIUM 2)', () => {
  test('the report says what was recovered and that counts are a floor', () => {
    seedEveryPopulation();
    writeFileSync(shadowRecordPath(home), '{"version":1,"observ');
    const report = buildReport(home);
    expect(report.state).toBe('recovered');
    const rendered = renderReport(report);
    expect(rendered).toContain('RECOVERED — the primary record was unusable');
    expect(rendered).toContain('is LOST');
    // Round 3 replaced "Counts below are a floor" — which named only the SAFE
    // direction — with a per-question breakdown, because the tripwire and
    // divergence answers are not conservative under truncation, they are
    // unsound. The banner must now say both.
    expect(rendered).toContain('A FLOOR, and therefore still sound');
    expect(rendered).toContain('nothing bounds how');
  });
});

describe('a recovered record cannot pass the gate (round 3, HIGH)', () => {
  // The exact probe from the round-2 delta review, pinned as a regression:
  // one home, changing NOTHING but the primary, went from a failing gate to
  // `GATE: pass` with an empty reason list — because the recovery discarded
  // the `conflated-unbound` row the primary held and `.previous` did not.
  function seedTripwireInPrimaryOnly(): void {
    seedEveryPopulation(); // rotates into `.previous` on the next write
    recordShadowComparison(home, {
      seam: 'start_session_cwd',
      provider: 'claude',
      outcome: 'conflated-unbound',
      baseline: 'missing-directory',
      shadow: 'unbound',
    });
  }

  test('the intact record FAILS, and corrupting the primary does not rescue it', () => {
    seedTripwireInPrimaryOnly();

    const intact = buildReport(home);
    expect(intact.gatePass).toBe(false);
    expect(intact.gateReasons).toContain(
      'the fail-open tripwire "conflated-unbound" fired 1 time(s)',
    );

    // The corruption this module's recovery path exists to survive.
    writeFileSync(shadowRecordPath(home), '{"version":1,"observ');

    const salvaged = buildReport(home);
    // Round 4: recovery is its own STATE, so a consumer cannot read it as an
    // ordinary observed report by forgetting to check a field.
    expect(salvaged.state).toBe('recovered');
    expect(recovered(salvaged).recoveredFrom).toBeDefined();
    // The tripwire row is genuinely gone from the salvaged copy…
    expect(recovered(salvaged).tripwire.fired).toBe(false);
    // …and the gate must STILL refuse, because absence over a truncated
    // window is not absence. This flipped to `true` before round 3.
    expect(salvaged.gatePass).toBe(false);
    expect(salvaged.gateReasons.join(' ')).toContain('RECOVERED');
  });

  /**
   * Seed so that `.previous` ITSELF covers all four populations.
   *
   * A plain `seedEveryPopulation()` rotates `.previous` to the state after
   * the THIRD write, so a recovered record is missing a population and the
   * gate fails for that reason instead of for the recovery — which made two
   * of these tests pass under an injection that removed the recovery guard
   * entirely. One extra write makes the recovery the ONLY thing left to fail
   * on, which is what gives the assertion its power.
   */
  function seedAllPopulationsIntoPrevious(): void {
    seedEveryPopulation();
    recordShadowComparison(home, {
      seam: 'start_session_cwd',
      provider: 'claude',
      outcome: 'agree',
      baseline: 'directory',
      shadow: 'bound',
    });
  }

  test('a passing report is an intact one, and a salvaged one cannot pass', () => {
    // The `--json` consumer's protection. Round 4 moved this from a runtime
    // convention to the type: a passing report is `state: 'observed'`, which
    // has no `recoveredFrom` at all — so the assertion below is now that the
    // FIELD IS ABSENT FROM THE TYPE, which the typecheck project proves, and
    // this test pins the state discrimination it rests on.
    seedAllPopulationsIntoPrevious();
    const clean = buildReport(home);
    expect(clean.gatePass).toBe(true);
    expect(clean.state).toBe('observed');
    expect(observed(clean)).not.toHaveProperty('recoveredFrom');

    writeFileSync(shadowRecordPath(home), 'garbage');
    const salvaged = buildReport(home);
    expect(recovered(salvaged).recoveredFrom).toBeDefined();
    // Every population is still covered in the salvaged copy, so recovery is
    // the only remaining reason this can fail.
    expect(recovered(salvaged).populations.every((p) => p.covered)).toBe(true);
    expect(recovered(salvaged).tripwire.fired).toBe(false);
    expect(salvaged.gateReasons).toHaveLength(1);
    expect(salvaged.gatePass).toBe(false);
  });

  test('a passing recovered report is a TYPE error, not just a runtime one', () => {
    // Round 4, MEDIUM 1. Round 3's comment claimed this hazard was already
    // unrepresentable, but `gatePass` sat on the shared base and
    // `recoveredFrom` was optional, so the object below compiled clean under
    // --strict and only a runtime push kept it honest. `state: 'recovered'`
    // now fixes `gatePass: false`, so the compiler carries the claim.
    //
    // If the union is ever flattened back, this @ts-expect-error becomes
    // "unused" and the build fails — which is the point.
    const salvagedPass = {
      state: 'recovered' as const,
      recoveredFrom: '/tmp/x.json.previous',
      // @ts-expect-error a recovered report can never report a passing gate
      gatePass: true as const,
    } satisfies Partial<Extract<ShadowReport, { state: 'recovered' }>>;
    expect(salvagedPass.recoveredFrom).toContain('.previous');
  });

  test('the real --gate run on a recovered record exits non-zero', () => {
    seedAllPopulationsIntoPrevious();
    writeFileSync(shadowRecordPath(home), 'garbage');
    const { status, stdout } = runReporter(['--gate']);
    expect(status).toBe(1);
    expect(stdout).toContain('RECOVERED');
    expect(stdout).toContain('GATE: fail');
    // Not "a population was never observed" — the recovery itself.
    expect(stdout).not.toContain('was never observed');
  }, 60_000);

  test('the absence answers render as NOT ANSWERABLE, not as "did not fire" / "none"', () => {
    seedAllPopulationsIntoPrevious();
    writeFileSync(shadowRecordPath(home), 'garbage');
    const rendered = renderReport(buildReport(home));
    // The self-contradiction the review found: the RECOVERED banner named
    // only the safe direction while these two lines asserted the unsafe one.
    expect(rendered).not.toContain('did not fire across');
    expect(rendered).not.toContain('none across');
    expect(rendered).toContain('conflated-unbound NOT ANSWERABLE');
    expect(rendered).toContain('"none" cannot be concluded');
    // And the banner names both directions explicitly.
    expect(rendered).toContain('A FLOOR, and therefore still sound');
    expect(rendered).toContain('UNSOUND');
  });
});

describe('the headline label always names the report state (round 5, LOW 1)', () => {
  /**
   * The state→headline contract, as a `Record` over the union.
   *
   * This is a mapping table, which is normally a second source of truth — but
   * here the compiler owns its completeness: `Record<ShadowReport['state'],
   * …>` cannot omit a member, and this file is now inside
   * `tsconfig.tests.json` (round 4). So adding a fifth state fails to COMPILE
   * until its headline is declared, and the loop below then proves the
   * renderer actually emits it. That is what makes this a class-closing pin
   * rather than one more instance assertion: neither half works alone, and
   * the expensive half is free.
   */
  const HEADLINE: Record<ShadowReport['state'], string> = {
    'never-observed': 'STATUS: NOT OBSERVED',
    unreadable: 'STATUS: UNREADABLE',
    observed: 'STATUS: OBSERVED',
    recovered: 'STATUS: RECOVERED',
  };

  function reportInState(state: ShadowReport['state']): ShadowReport {
    if (state === 'never-observed') return buildReport(home);
    if (state === 'unreadable') {
      writeFileSync(shadowRecordPath(home), 'not json');
      writeFileSync(`${shadowRecordPath(home)}.previous`, 'not json either');
      return buildReport(home);
    }
    seedEveryPopulation();
    if (state === 'recovered') {
      writeFileSync(shadowRecordPath(home), 'garbage');
    }
    return buildReport(home);
  }

  test.each(Object.keys(HEADLINE) as Array<ShadowReport['state']>)(
    'a %s report headlines as its own state',
    (state) => {
      const report = reportInState(state);
      // The fixture really is in the state it claims — otherwise this asserts
      // the right string about the wrong report.
      expect(report.state).toBe(state);

      const headline = renderReport(report)
        .split('\n')
        .find((line) => line.startsWith('STATUS:'));
      expect(headline).toBeDefined();
      expect(headline).toContain(HEADLINE[state]);

      // …and names no OTHER state. 'STATUS: OBSERVED' is a substring of
      // nothing here, but 'NOT OBSERVED' contains 'OBSERVED', so compare on
      // the full `STATUS: ` prefix rather than the bare word.
      for (const [other, label] of Object.entries(HEADLINE)) {
        if (other === state) continue;
        expect(headline).not.toContain(label);
      }
    },
  );
});

describe('the seam limit is derived from the record (round 2, LOW 6)', () => {
  test('one seam is named as one seam', () => {
    seedEveryPopulation();
    const report = buildReport(home);
    expect(report.gateLimits[1]).toContain('one seam — start_session_cwd —');
  });

  test('a second seam changes the derived limit, so it cannot go stale', () => {
    // The proof that it is derived and not asserted: a hardcoded sentence
    // would keep naming one seam here and print a confidently false scope.
    seedEveryPopulation();
    recordShadowComparison(home, {
      seam: 'resolve_agent_cwd',
      provider: 'claude',
      outcome: 'agree',
      baseline: 'directory',
      shadow: 'bound',
    });
    const report = buildReport(home);
    expect(report.gateLimits[1]).toContain(
      '2 seams — resolve_agent_cwd, start_session_cwd —',
    );
    expect(renderReport(report)).toContain('resolve_agent_cwd');
  });
});

describe('a passing gate names the limit of its own claim (station#1775)', () => {
  // MEDIUM 6. The record accumulates across arbitrary code versions with no
  // provenance, and slice 3c is a one-way flip that intends to cite this
  // gate. The caveat has to travel with the verdict, not live in an issue.
  test('the human rendering states what the pass does not prove', () => {
    seedEveryPopulation();
    const rendered = renderReport(buildReport(home));
    expect(rendered).toContain('GATE: pass');
    expect(rendered).toContain('WHAT THIS PASS DOES NOT PROVE');
    expect(rendered).toContain('station#1775');
    expect(rendered).toContain(
      'not that they were exercised by the resolver currently on disk',
    );
    // Every declared limit is rendered — an assertion on one line cannot
    // notice a second being dropped from the list.
    const report = buildReport(home);
    for (const limit of report.gateLimits) {
      expect(rendered).toContain(limit);
    }
    expect(report.gateLimits.length).toBe(2);
  });

  test('a refusal does not claim authority, so it carries no limits block', () => {
    const rendered = renderReport(buildReport(home));
    expect(rendered).toContain('GATE: fail');
    expect(rendered).not.toContain('WHAT THIS PASS DOES NOT PROVE');
  });

  test('--json carries the limits as data for machine consumers', () => {
    seedEveryPopulation();
    const { status, stdout } = runReporter(['--gate', '--json']);
    expect(status).toBe(0);
    const parsed = JSON.parse(stdout) as {
      gatePass: boolean;
      gateLimits: string[];
    };
    expect(parsed.gatePass).toBe(true);
    expect(parsed.gateLimits).toEqual([...buildReport(home).gateLimits]);
  }, 60_000);
});
