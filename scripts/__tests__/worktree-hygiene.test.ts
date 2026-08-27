import { describe, expect, test } from 'vitest';
import {
  BUILD_OUTPUT_PRUNE_PATTERNS,
  classifyWorktree,
  countStatusEntries,
  findNestedWorktrees,
  freshnessFindArgs,
  HYGIENE_POLICY,
  isCurrentWorktree,
  isHarnessManaged,
  mapWithConcurrency,
  parseArgs,
  parseWorktreeList,
  summarize,
  UsageError,
} from '../worktree-hygiene.mjs';

/** A worktree that is finished by every measure: the FINISHED baseline. */
function finished(overrides: Record<string, unknown> = {}) {
  return {
    path: '/w/lane-1',
    branch: 'fix/1-done',
    isPrimary: false,
    isCurrent: false,
    commitsNotInBase: 0,
    baseError: null,
    modifiedTrackedFiles: 0,
    untrackedFiles: 0,
    statusError: null,
    touchedWithinWindow: false,
    freshnessError: null,
    ...overrides,
  };
}

describe('worktree hygiene decision', () => {
  test('a fully merged, clean, cold worktree is finished', () => {
    const result = classifyWorktree(finished());
    expect(result.finished).toBe(true);
    expect(result.keepReasons).toEqual([]);
  });

  // The tool cannot remove anything, so it must not report a field named for
  // an action it does not have. `removable` was that name.
  test('no disposition field claims a removal capability', () => {
    expect(classifyWorktree(finished())).not.toHaveProperty('removable');
  });

  // Each of these is a distinct way a worktree can still be someone's live
  // work. They are asserted one at a time so a regression names which
  // protection was lost, rather than only that "something" changed.
  test.each([
    ['the primary checkout', { isPrimary: true }, 'primary checkout'],
    ['the current worktree', { isCurrent: true }, 'current worktree'],
    ['a detached HEAD', { branch: null }, 'detached HEAD'],
    [
      'commits the base lacks',
      { commitsNotInBase: 3 },
      '3 commit(s) not in the base',
    ],
    [
      'modified tracked files',
      { modifiedTrackedFiles: 2 },
      '2 modified tracked file(s)',
    ],
    [
      'untracked files',
      { untrackedFiles: 1 },
      '1 untracked file(s) — not committed anywhere',
    ],
    [
      'recent activity',
      { touchedWithinWindow: true },
      'modified recently — a session may be live',
    ],
  ])('keeps %s', (_label, overrides, expectedReason) => {
    const result = classifyWorktree(finished(overrides));
    expect(result.finished).toBe(false);
    expect(result.keepReasons).toContain(expectedReason);
  });

  // `git worktree remove` never deletes the branch, so committed work always
  // survives. Modified-tracked and untracked-not-ignored files are the entire
  // loss surface — and untracked is the half that exists in exactly one place
  // on earth. The first version of this tool reported them and removed
  // anyway, with `--force` to silence git's own refusal.
  test('an untracked file is the one thing removal can destroy, so it keeps', () => {
    const result = classifyWorktree(finished({ untrackedFiles: 1 }));
    expect(result.finished).toBe(false);
    expect(result.keepReasons).toEqual([
      '1 untracked file(s) — not committed anywhere',
    ]);
  });

  // Every fact this tool cannot derive is a reason to keep. A `null` must
  // never read as a benign zero.
  test.each([
    [
      'the base comparison failed',
      { commitsNotInBase: null, baseError: 'bad revision' },
      'cannot compare against the base: bad revision',
    ],
    [
      'the working tree could not be read',
      {
        statusError: 'not a git repository',
        modifiedTrackedFiles: null,
        untrackedFiles: null,
      },
      'working tree unreadable: not a git repository',
    ],
    [
      'freshness could not be derived',
      { freshnessError: 'find: no such file' },
      'freshness undecidable: find: no such file',
    ],
  ])('keeps a worktree when %s', (_label, overrides, expectedReason) => {
    const result = classifyWorktree(finished(overrides));
    expect(result.finished).toBe(false);
    expect(result.keepReasons).toContain(expectedReason);
  });

  test('every keep reason is reported, not just the first', () => {
    const result = classifyWorktree(
      finished({
        commitsNotInBase: 2,
        modifiedTrackedFiles: 1,
        isCurrent: true,
      }),
    );
    expect(result.keepReasons).toHaveLength(3);
  });

  test('the freshness window is long enough to cover a between-commits pause', () => {
    // Pinned deliberately: shortening this is how the tool starts deleting
    // worktrees out from under a session that is mid-task but between commits.
    expect(HYGIENE_POLICY.freshnessWindowHours).toBeGreaterThanOrEqual(6);
  });
});

describe('current-worktree containment', () => {
  // The original check was `entry.path === process.cwd()`, which held only
  // from the worktree ROOT. Run from any subdirectory it read false, and git
  // then removed the worktree out from under the running process — a linked
  // worktree, unlike the primary checkout, has no refusal of its own.
  test('a subdirectory of a worktree is inside that worktree', () => {
    expect(isCurrentWorktree('/w/lane-1', '/w/lane-1/src/deep/here')).toBe(
      true,
    );
  });

  test('the worktree root itself is inside it', () => {
    expect(isCurrentWorktree('/w/lane-1', '/w/lane-1')).toBe(true);
  });

  test('a sibling sharing a name prefix is not inside it', () => {
    expect(isCurrentWorktree('/w/lane-1', '/w/lane-10/src')).toBe(false);
  });

  test('an unrelated path is not inside it', () => {
    expect(isCurrentWorktree('/w/lane-1', '/w/lane-2')).toBe(false);
  });
});

describe('worktree list parsing', () => {
  test('parses the NUL-terminated porcelain form', () => {
    const output =
      'worktree /repo\0HEAD abc\0branch refs/heads/main\0\0' +
      'worktree /w/lane-a\0HEAD def\0branch refs/heads/fix/a\0\0' +
      'worktree /w/detached\0HEAD 123\0detached\0\0';
    expect(parseWorktreeList(output)).toEqual([
      { path: '/repo', branch: 'main', isPrimary: true },
      { path: '/w/lane-a', branch: 'fix/a', isPrimary: false },
      { path: '/w/detached', branch: null, isPrimary: false },
    ]);
  });

  test('a path containing a newline stays one worktree', () => {
    // Not reachable with today's lane names, and precisely why the newline
    // form was left in place long enough to become a latent parser bug.
    const output = 'worktree /w/od\nd\0HEAD abc\0branch refs/heads/x\0\0';
    expect(parseWorktreeList(output)).toEqual([
      { path: '/w/od\nd', branch: 'x', isPrimary: true },
    ]);
  });
});

describe('status counting', () => {
  test('separates untracked from modified tracked records', () => {
    const output = ' M src/a.ts\0?? new-source.ts\0A  src/b.ts\0?? scratch/\0';
    expect(countStatusEntries(output)).toEqual({
      modifiedTrackedFiles: 2,
      untrackedFiles: 2,
    });
  });

  test('a clean worktree counts nothing', () => {
    expect(countStatusEntries('')).toEqual({
      modifiedTrackedFiles: 0,
      untrackedFiles: 0,
    });
  });
});

describe('freshness find arguments', () => {
  // Measured on this repo: 3762 of 4884 tracked paths sit at depth >= 4, so a
  // `-maxdepth 3` walk could not see `src-ui/src/components/X.tsx` at all.
  test('imposes no depth limit', () => {
    expect(freshnessFindArgs('/w/lane-1', 6)).not.toContain('-maxdepth');
  });

  // `-not -path '*/node_modules/*'` still DESCENDED into node_modules and
  // discarded the results afterwards; pruning is what made an unlimited-depth
  // walk cheaper than the old bounded one.
  test('prunes rather than filtering after descent', () => {
    const args = freshnessFindArgs('/w/lane-1', 6);
    expect(args).toContain('-prune');
    expect(args).not.toContain('-not');
    expect(args).toContain('node_modules');
  });

  // A linked worktree's index lives under the PRIMARY checkout, so committing
  // inside a worktree touches nothing under its own path. Directory mtimes
  // are part of the little evidence there is.
  test('does not restrict to regular files', () => {
    expect(freshnessFindArgs('/w/lane-1', 6)).not.toContain('-type');
  });

  test('carries the window it was given', () => {
    expect(freshnessFindArgs('/w/lane-1', 6)).toContain('-6 hours');
  });

  // MED-2. `-name 'dist*'` is a BASENAME glob applied at every depth, so it
  // pruned `packages/contracts/src/distribution.ts` and three other real
  // tracked paths in this repo — and, because `find` evaluates the START path
  // too, pruned the entire tree of any worktree directory named `dist*`.
  // `worktree-hygiene-git.test.ts` proves both against real repositories;
  // this pins the argv shape that makes them possible.
  test('every -name argument is a literal, never a glob', () => {
    // The defect was the `*`. `-name` matches a BASENAME at every depth, so
    // any glob there reaches paths nobody enumerated — `dist*` reached four
    // tracked files and every worktree directory starting with `dist`. The
    // two names that remain (`node_modules`, `.git`) are literal and can only
    // ever match themselves.
    //
    // Asserting the ABSENCE of today's patterns from the argv would not catch
    // this: `dist*` is neither `dist` nor `dist-*`, so such a check passes on
    // the exact code this test exists to reject (proven by injection).
    const args = freshnessFindArgs('/w/lane-1', 6);
    const named = args.filter((_arg, index) => args[index - 1] === '-name');
    expect(named).toEqual(['node_modules', '.git']);
    for (const name of named) {
      expect(name, `-name ${name} is a glob`).not.toMatch(/[*?[\]]/);
    }
  });

  test('prunes build output by a path anchored at the worktree root', () => {
    const args = freshnessFindArgs('/w/lane-1', 6);
    for (const pattern of BUILD_OUTPUT_PRUNE_PATTERNS) {
      const index = args.indexOf(`/w/lane-1/${pattern}`);
      expect(index, `${pattern} is not pruned by path`).toBeGreaterThan(-1);
      expect(args[index - 1]).toBe('-path');
    }
  });

  // Deleting an entry from the pattern list must not read as "still pruning
  // by path" — the loops above iterate the list, so they cannot see a removal
  // (protocol §2, the scope-assertion corollary). This pins the list itself.
  test('the pruned build-output patterns are pinned', () => {
    expect([...BUILD_OUTPUT_PRUNE_PATTERNS]).toEqual(['dist', 'dist-*']);
  });

  // `node_modules` and `.git` stay basename globs on purpose: both nest at
  // arbitrary depth and neither is ever a tracked file name.
  test('node_modules and .git are still pruned at any depth', () => {
    const args = freshnessFindArgs('/w/lane-1', 6);
    for (const name of ['node_modules', '.git']) {
      const index = args.indexOf(name);
      expect(index, `${name} is not pruned`).toBeGreaterThan(-1);
      expect(args[index - 1]).toBe('-name');
    }
  });

  test('a trailing separator cannot desynchronise the root from the patterns', () => {
    // `find` composes child paths from the start argument verbatim, so a
    // doubled `//` would make every `-path` pattern match nothing.
    const args = freshnessFindArgs('/w/lane-1/', 6);
    expect(args[0]).toBe('/w/lane-1');
    expect(args).toContain('/w/lane-1/dist');
    expect(args).not.toContain('/w/lane-1//dist');
  });
});

describe('bounded inspection concurrency', () => {
  // The protocol doc tells agents this tool is safe to run *during* a git
  // storm because it inspects at most 8 worktrees at once. Nothing measured
  // that: deleting the bound left the whole suite green (LOW-7). This asserts
  // the peak actually reached, so the claim is derived rather than written
  // down.
  test('never exceeds its limit, and reaches it', async () => {
    let inFlight = 0;
    let peak = 0;
    const items = Array.from({ length: 50 }, (_, index) => index);
    const results = await mapWithConcurrency(items, 8, async (item: number) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 1));
      inFlight -= 1;
      return item * 2;
    });
    // `toBe`, not `toBeLessThanOrEqual`: a bound of 1 also satisfies "at most
    // 8", and an unbounded implementation would peak at 50.
    expect(peak).toBe(8);
    expect(results).toEqual(items.map((item) => item * 2));
  });

  test('fewer items than the limit does not stall', async () => {
    expect(
      await mapWithConcurrency([1, 2], 8, async (item: number) => item),
    ).toEqual([1, 2]);
  });

  test('the policy the report runs with is the bounded one', () => {
    expect(HYGIENE_POLICY.concurrency).toBe(8);
  });
});

describe('argument parsing', () => {
  test('defaults to a report against origin/main', () => {
    expect(parseArgs([])).toMatchObject({
      json: false,
      comparisonRef: 'origin/main',
    });
  });

  // The removal path is gone, and so are its flags. `--remove=false` used to
  // turn removal ON (the value was never read), which is the shape of defect
  // that ends an argument about whether a destructive flag is worth keeping.
  test.each([['--remove'], ['--remove=false'], ['--dry-run'], ['--force']])(
    'rejects the retired destructive flag %j',
    (flag) => {
      expect(() => parseArgs([flag])).toThrow(UsageError);
      expect(() => parseArgs([flag])).toThrow('unrecognized argument');
    },
  );

  // The dangerous direction is real: `--base=<narrower ref>` silently
  // degrading to origin/main makes strictly MORE worktrees look finished.
  test.each([[['--base', 'upstream/next']], [['--base=upstream/next']]])(
    'honors %j',
    (argv) => {
      expect(parseArgs(argv).comparisonRef).toBe('upstream/next');
    },
  );

  test.each([
    [['--base'], '--base requires a value'],
    [['--base', '--json'], '--base requires a value, got the flag "--json"'],
    [['--base='], '--base requires a non-empty value'],
    [['--repo'], '--repo requires a value'],
    [['--oops'], 'unrecognized argument "--oops"'],
    [['-x'], 'unrecognized argument "-x"'],
    [['--concurrency', 'lots'], '--concurrency requires a positive integer'],
    [['--concurrency', '0'], '--concurrency requires a positive integer'],
  ])('rejects %j', (argv, expected) => {
    expect(() => parseArgs(argv)).toThrow(UsageError);
    expect(() => parseArgs(argv)).toThrow(expected);
  });

  test('accepts the reporting combination', () => {
    expect(parseArgs(['--json', '--verbose', '--concurrency=4'])).toMatchObject(
      {
        json: true,
        verbose: true,
        concurrency: 4,
      },
    );
  });
});

describe('nesting', () => {
  test('finds worktrees nested inside another worktree', () => {
    const nested = findNestedWorktrees([
      '/repo',
      '/repo/station-worktrees/lane-a',
      '/repo/station-worktrees/lane-b',
      '/siblings/lane-c',
    ]);
    expect(nested).toEqual([
      {
        path: '/repo/station-worktrees/lane-a',
        insideOf: '/repo',
        harnessManaged: false,
      },
      {
        path: '/repo/station-worktrees/lane-b',
        insideOf: '/repo',
        harnessManaged: false,
      },
    ]);
  });

  test('names the immediate container, not the outermost one', () => {
    // "inside /repo" does not tell the reader which directory to move it out
    // of when the containment is two deep.
    const nested = findNestedWorktrees([
      '/repo',
      '/repo/inner',
      '/repo/inner/lane-a',
    ]);
    expect(nested).toEqual([
      { path: '/repo/inner', insideOf: '/repo', harnessManaged: false },
      {
        path: '/repo/inner/lane-a',
        insideOf: '/repo/inner',
        harnessManaged: false,
      },
    ]);
  });

  test('a lexicographic sibling between a container and its contents', () => {
    // The real shape on this host, and a live regression: `-` sorts before
    // `/`, so `station-worktrees/lane` lands BETWEEN `station` and
    // `station/.claude/worktrees/agent`. A single sorted pass that keeps a
    // stack of ancestors reported 0 nested worktrees where 27 exist.
    const nested = findNestedWorktrees([
      '/k/station',
      '/k/station-worktrees/lane-a',
      '/k/station/.claude/worktrees/agent-x',
    ]);
    expect(nested).toEqual([
      {
        path: '/k/station/.claude/worktrees/agent-x',
        insideOf: '/k/station',
        harnessManaged: true,
      },
    ]);
  });

  test('a sibling directory sharing a name prefix is not nested', () => {
    // `/repo-worktrees` starts with `/repo` as a STRING but is not inside it.
    // The separator is what makes containment real.
    expect(findNestedWorktrees(['/repo', '/repo-worktrees/lane-a'])).toEqual(
      [],
    );
  });

  test('harness-created worktrees are nested but marked as not ours to move', () => {
    // The Claude Code harness puts one worktree per background agent under
    // `.claude/worktrees/`. On a live host these outnumbered the movable ones
    // 10 to 16, so counting them as convention violations would make the
    // report mostly noise about something nobody in this repo can change.
    const nested = findNestedWorktrees([
      '/repo',
      '/repo/.claude/worktrees/agent-abc',
      '/repo/station-worktrees/lane-a',
    ]);
    expect(nested).toHaveLength(2);
    expect(isHarnessManaged('/repo/.claude/worktrees/agent-abc')).toBe(true);
    expect(isHarnessManaged('/repo/station-worktrees/lane-a')).toBe(false);
  });

  test('summarize separates movable nesting from harness-managed nesting', () => {
    const classifications = [
      classifyWorktree(finished()),
      classifyWorktree(finished({ path: '/w/lane-2', commitsNotInBase: 1 })),
    ];
    const summary = summarize(classifications, [
      { path: '/repo/w/a', insideOf: '/repo', harnessManaged: false },
      {
        path: '/repo/.claude/worktrees/agent-x',
        insideOf: '/repo',
        harnessManaged: true,
      },
    ]);
    expect(summary).toEqual({
      total: 2,
      finished: 1,
      nested: 2,
      nestedActionable: 1,
    });
  });
});
