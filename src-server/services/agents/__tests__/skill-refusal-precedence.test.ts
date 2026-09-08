/**
 * The precedence contract, tested at the layer that owns it.
 *
 * TEN of the sixteen combinations are reached by no fixture anywhere — so for
 * those ten, this table is the only thing exercising the ordering at all. That
 * was measured by recording every condition set the picker is handed during a
 * run, across the related set and the statically-reachable suites outside it.
 *
 * Fixture reach is concentrated in one file: `skills.routes.writable.test.ts`
 * reaches six combinations — the empty set (writable), each condition alone,
 * and one pair (`unsafe-name` with `name-mismatch`). `skills.routes.test.ts`,
 * the other route suite, reaches one. No fixture anywhere reaches a
 * combination outside those six.
 *
 * Deliberately no third figure here. Four attempts at a per-suite breakdown
 * produced four different wrong numbers, the last by excluding this file from
 * the measurement and then leaving it in the denominator. A plain count also
 * misleads: most suites in the related set cannot import the picker at all, so
 * "N suites contribute two combinations" reads as a broad survey that came
 * back thin, when almost none of it was ever able to reach the code. The claim
 * above needs no such count and does not go stale when a test file is added.
 *
 * "Reached by no fixture" is a fact about THIS CORPUS, not about the
 * filesystem. The measurement cannot tell "no filesystem state produces this
 * combination" from "nobody has written a fixture for it", and the sentence
 * below about what a fixture can produce must not be read as the former. Two
 * rounds on this branch shipped a wrong reachability claim about exactly this
 * space, both times by asserting an impossibility that was only an absence.
 *
 * One of the ten is where an inverted ordering survived a review round: an
 * unsafe name co-occurring with a containment failure, published as the
 * containment refusal, advising an install that the resolver refuses on the
 * name before it ever looks at a root. No fixture reaches that cell.
 *
 * A fixture can only reach a combination the filesystem can produce; this table
 * enumerates directly. All SIXTEEN subsets of the four conditions appear below
 * — the full power set, relying on no claim about which conditions can
 * co-occur, because two attempts to state such a claim were both wrong.
 *
 * What these rows are and are not: they complete the enumeration the docblock
 * claims, and they are not additional test POWER. A review enumerated all 24
 * permutations of the precedence list and all 65 ordered subsets and found no
 * mutation caught by a new row that an older row does not already catch. The
 * value is that the sentence above is now true, which is the property round 8
 * and round 9 were both about.
 */
import { describe, expect, test } from 'vitest';
import type { SkillPackageDirectoryCondition } from '../../../domain/skill-paths.js';
import {
  SKILL_REFUSAL_STATEMENT,
  worstSkillPackageCondition,
} from '../skill-service.js';

/**
 * The table asserts what is SPOKEN ABOUT, not merely that something was
 * refused.
 *
 * It relies on NO implication between conditions. An earlier version claimed
 * `unsafe-name` implies `name-mismatch` — "a name that cannot be a directory
 * name cannot equal any basename" — and that is false: `isSafeSkillName` also
 * refuses `__proto__`, `constructor`, `prototype`, whitespace-only and
 * over-long names, every one of which is a legal directory basename. So the two
 * come apart, and the four cells that premise excused were unpinned beneath a
 * docblock promising completeness (review round 9).
 */
const CASES: Array<{
  held: SkillPackageDirectoryCondition[];
  spokenAbout: SkillPackageDirectoryCondition | undefined;
  why: string;
}> = [
  { held: [], spokenAbout: undefined, why: 'it is the package' },
  {
    held: ['name-mismatch'],
    spokenAbout: 'name-mismatch',
    why: 'somewhere writable and readable, just named differently',
  },
  {
    held: ['outside-writable-root'],
    spokenAbout: 'outside-writable-root',
    why: 'where it sits is the whole problem',
  },
  {
    held: ['outside-writable-root', 'name-mismatch'],
    spokenAbout: 'outside-writable-root',
    why: 'renaming the directory changes nothing in a root Station never writes',
  },
  {
    held: ['unreadable'],
    spokenAbout: 'unreadable',
    why: 'no claim about which root holds it is safe to make',
  },
  {
    held: ['unreadable', 'outside-writable-root'],
    spokenAbout: 'unreadable',
    why: 'every unreadable case also raises outside-root; ranking it first is what makes the spurious claim unreachable',
  },
  {
    held: ['unsafe-name', 'name-mismatch'],
    spokenAbout: 'unsafe-name',
    why: 'renaming the skill is always possible and always necessary first',
  },
  {
    held: [
      'unsafe-name',
      'name-mismatch',
      'unreadable',
      'outside-writable-root',
    ],
    spokenAbout: 'unsafe-name',
    why: 'the resolver refuses on the name before it looks at a root, so any install advice is guaranteed to fail',
  },
  {
    held: ['unreadable', 'name-mismatch'],
    spokenAbout: 'unreadable',
    why: 'a directory name cannot be compared against a location that could not be read',
  },
  {
    held: ['unreadable', 'name-mismatch', 'outside-writable-root'],
    spokenAbout: 'unreadable',
    why: 'nothing below it can be claimed while where the write would land is unknown',
  },
  {
    held: ['unsafe-name', 'name-mismatch', 'unreadable'],
    spokenAbout: 'unsafe-name',
    why: 'the name blocks resolution, so the unreadable location was never reached',
  },
  {
    held: ['unsafe-name', 'name-mismatch', 'outside-writable-root'],
    spokenAbout: 'unsafe-name',
    why: 'renaming is still the first thing to fix when the root is also wrong',
  },
  // `unsafe-name` WITHOUT `name-mismatch`. Reachable, contrary to what this
  // file used to assume: `__proto__` is refused as a skill name and is a
  // perfectly ordinary directory basename, so the two conditions come apart.
  {
    held: ['unsafe-name'],
    spokenAbout: 'unsafe-name',
    why: 'a name a directory can carry but Station will not resolve',
  },
  {
    held: ['unsafe-name', 'unreadable'],
    spokenAbout: 'unsafe-name',
    why: 'the name is answerable without reading anything',
  },
  {
    held: ['unsafe-name', 'outside-writable-root'],
    spokenAbout: 'unsafe-name',
    why: 'an install cannot help a name the resolver refuses',
  },
  {
    held: ['unsafe-name', 'unreadable', 'outside-writable-root'],
    spokenAbout: 'unsafe-name',
    why: 'nothing below the name is worth reporting while the name cannot resolve',
  },
];

describe('which condition a refusal speaks about', () => {
  test.each(CASES)('$why', ({ held, spokenAbout }) => {
    expect(worstSkillPackageCondition(held)).toBe(spokenAbout);
  });

  test('order of the reported conditions does not change the answer', () => {
    for (const { held, spokenAbout } of CASES) {
      expect(worstSkillPackageCondition([...held].reverse())).toBe(spokenAbout);
    }
  });

  // The compile-time guard for this lives in the service; this is the runtime
  // half, so deleting that guard does not silently reopen the hole. An unranked
  // condition makes the picker return `undefined` for a non-empty set, which the
  // caller reads as WRITABLE — the one failure here that fails toward a grant.
  test('every condition with a statement is also ranked', () => {
    for (const condition of Object.keys(
      SKILL_REFUSAL_STATEMENT,
    ) as SkillPackageDirectoryCondition[]) {
      expect(worstSkillPackageCondition([condition])).toBe(condition);
    }
  });

  test('every condition has a statement, and no two share a reason code', () => {
    const reasons = Object.values(SKILL_REFUSAL_STATEMENT).map((s) => s.reason);
    expect(new Set(reasons).size).toBe(reasons.length);
    // No statement carries a path or an interpolation: where the package sits is
    // `packageDirectory`'s job, and prose carrying author-controlled text is
    // what this branch exists to remove. Apostrophes are prose ("this skill's
    // name") and are not the thing being excluded.
    for (const statement of Object.values(SKILL_REFUSAL_STATEMENT)) {
      expect(statement.detail).not.toMatch(/\$\{|[/\\]/);
    }
  });
});
