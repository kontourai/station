/**
 * The precedence contract, tested at the layer that owns it.
 *
 * The route suite exercises this through fixtures, which reaches four of the
 * eight condition combinations and left the other four unpinned — and one of
 * those unpinned cells is where an inverted ordering survived a review round
 * (an unsafe name co-occurring with a containment failure was published as the
 * containment refusal, advising an install that the resolver refuses on the
 * name before it ever looks at a root).
 *
 * A fixture can only reach a combination the filesystem can produce; this table
 * enumerates directly. `unsafe-name` aside, three conditions co-occur freely,
 * and all eight of their subsets appear below — so the ordering among them is
 * pinned rather than sampled. The `unsafe-name` rows then cover it against each
 * of the other three and against all of them at once. An earlier version of
 * this sentence claimed eight combinations while listing eight ROWS, which is
 * not the same count: four cells were unpinned under a docblock promising
 * completeness (review round 8).
 */
import { describe, expect, test } from 'vitest';
import type { SkillPackageDirectoryCondition } from '../../../domain/skill-paths.js';
import {
  SKILL_REFUSAL_STATEMENT,
  worstSkillPackageCondition,
} from '../skill-service.js';

/**
 * `name-mismatch` is implied by `unsafe-name` in practice — a name that cannot
 * be a directory name cannot equal any basename — so the table varies the three
 * conditions that can occur in any combination and asserts what is SPOKEN
 * ABOUT, not merely that something was refused.
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
