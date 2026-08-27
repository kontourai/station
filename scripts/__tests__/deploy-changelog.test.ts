import { describe, expect, it } from 'vitest';
import {
  CHANGELOG_GROUP_ORDER,
  classifyCommitGroup,
  deriveChangelogSlice,
  groupChangelogSlice,
  LEDGER_COMMIT_SUBJECT_PATTERN,
  parseGitLogOutput,
  parseMergePullRequest,
  parseTrailingPullRequest,
} from '../deploy-changelog.mjs';

const A_SHA = 'a'.repeat(40);
const B_SHA = 'b'.repeat(40);
const C_SHA = 'c'.repeat(40);
const D_SHA = 'd'.repeat(40);
const E_SHA = 'e'.repeat(40);

describe('commit classification', () => {
  it('prefers the merge commit pull-request number over everything else', () => {
    expect(
      parseMergePullRequest('Merge pull request #4572 from kontourai/feat/x'),
    ).toBe(4572);
    expect(parseMergePullRequest('Merge pull request #12 from a/b/c')).toBe(12);
    expect(parseMergePullRequest('fix(ci): something')).toBeNull();
    expect(parseMergePullRequest('Merge branch main into feat/x')).toBeNull();
  });

  it('reads squash-style trailing pull-request numbers', () => {
    expect(parseTrailingPullRequest('feat(x): thing (#4572)')).toBe(4572);
    expect(parseTrailingPullRequest('feat(x): thing (#12)')).toBe(12);
    expect(
      parseTrailingPullRequest('feat(x): (#4572) in the middle stays'),
    ).toBeNull();
    expect(parseTrailingPullRequest('feat(x): no number')).toBeNull();
  });

  it('maps conventional types onto the five published groups', () => {
    expect(classifyCommitGroup('feat(x): a')).toBe('feat');
    expect(classifyCommitGroup('fix(y): b')).toBe('fix');
    expect(classifyCommitGroup('ci: c')).toBe('ci');
    expect(classifyCommitGroup('docs(z): d')).toBe('docs');
    for (const other of [
      'chore: e',
      'test(x): f',
      'refactor: g',
      'perf(h): i',
      'no prefix at all',
    ]) {
      expect(classifyCommitGroup(other)).toBe('other');
    }
    // Breaking-change and multi-token scopes stay conventional.
    expect(classifyCommitGroup('feat(ui,test): combined scope')).toBe('feat');
    expect(classifyCommitGroup('fix(ci)!: breaking')).toBe('fix');
  });

  it('excludes only the ledger’s own bookkeeping subjects', () => {
    expect(
      LEDGER_COMMIT_SUBJECT_PATTERN.test(
        'docs(ledger): record nightly ships from run 1',
      ),
    ).toBe(true);
    expect(
      LEDGER_COMMIT_SUBJECT_PATTERN.test('docs(reference): fix a typo'),
    ).toBe(false);
    expect(
      LEDGER_COMMIT_SUBJECT_PATTERN.test('docs: unrelated docs work'),
    ).toBe(false);
  });
});

describe('git log output parsing', () => {
  it('parses sha, parents, and subject records', () => {
    const raw = [
      `${A_SHA}\0${B_SHA} ${C_SHA}\0Merge pull request #7 from org/branch`,
      `${C_SHA}\0${B_SHA}\0fix(ci): real change`,
      `${B_SHA}\0${A_SHA}\0docs(ledger): bookkeeping`,
      `${A_SHA}\0\0root commit`,
    ].join('\n');
    expect(parseGitLogOutput(raw)).toEqual([
      {
        sha: A_SHA,
        parents: [B_SHA, C_SHA],
        subject: 'Merge pull request #7 from org/branch',
      },
      { sha: C_SHA, parents: [B_SHA], subject: 'fix(ci): real change' },
      { sha: B_SHA, parents: [A_SHA], subject: 'docs(ledger): bookkeeping' },
      { sha: A_SHA, parents: [], subject: 'root commit' },
    ]);
  });

  it('rejects malformed shas instead of guessing', () => {
    expect(() => parseGitLogOutput(`nothex\0\0subject`)).toThrow(/bad sha/);
    expect(() => parseGitLogOutput(`${'A'.repeat(40)}\0\0uppercase`)).toThrow(
      /bad sha/,
    );
    expect(parseGitLogOutput('')).toEqual([]);
  });
});

describe('changelog grouping', () => {
  it('groups lines and links the delivering pull request', () => {
    const { groups } = groupChangelogSlice({
      githubRepo: 'kontourai/station',
      commits: [
        { sha: A_SHA, subject: 'feat(ci): publish the CLI (#4566)', pr: 4566 },
        { sha: B_SHA, subject: 'fix(dock): badge (#4546)', pr: null },
        { sha: C_SHA, subject: 'docs: guide (#1)', pr: 1 },
        { sha: D_SHA, subject: 'no prefix, no pr' },
      ],
    });
    expect(groups.feat).toEqual([
      '[#4566](https://github.com/kontourai/station/pull/4566) feat(ci): publish the CLI',
    ]);
    expect(groups.fix).toEqual([
      '[#4546](https://github.com/kontourai/station/pull/4546) fix(dock): badge',
    ]);
    expect(groups.docs).toEqual([
      '[#1](https://github.com/kontourai/station/pull/1) docs: guide',
    ]);
    expect(groups.other).toEqual(['no prefix, no pr']);
    expect(groups.ci).toEqual([]);
  });

  it('moves a trailing pull-request number into the link without duplicating it', () => {
    const { groups } = groupChangelogSlice({
      githubRepo: 'kontourai/station',
      commits: [
        { sha: A_SHA, subject: 'feat(x): squash merged (#4570)', pr: null },
      ],
    });
    expect(groups.feat).toEqual([
      '[#4570](https://github.com/kontourai/station/pull/4570) feat(x): squash merged',
    ]);
  });

  it('rejects malformed repository slugs before emitting links', () => {
    expect(() =>
      groupChangelogSlice({ githubRepo: 'not-a-slug', commits: [] }),
    ).toThrow(/owner\/name/);
  });

  it('publishes the group vocabulary as a stable contract', () => {
    expect(CHANGELOG_GROUP_ORDER).toEqual([
      'feat',
      'fix',
      'ci',
      'docs',
      'other',
    ]);
  });
});

describe('changelog slice derivation', () => {
  function fixtureExec(responses: Record<string, string>) {
    const calls: string[][] = [];
    const execGit = (args: string[]): string => {
      calls.push(args);
      const key = args.join(' ');
      const response = responses[key];
      if (response === undefined)
        throw new Error(`unexpected git call: ${key}`);
      return response;
    };
    return { execGit, calls };
  }

  it('omits the slice for a channel’s first entry, without running git', () => {
    const { execGit, calls } = fixtureExec({});
    const slice = deriveChangelogSlice({
      repoRoot: '.',
      previousSha: null,
      sha: A_SHA,
      githubRepo: 'kontourai/station',
      execGit,
    });
    expect(calls).toEqual([]);
    expect(slice.previousSha).toBeNull();
    expect(slice.commitCount).toBe(0);
    for (const group of CHANGELOG_GROUP_ORDER)
      expect(slice.groups[group]).toEqual([]);
    expect(slice.note).toMatch(/First recorded entry/);
  });

  it('attributes merge-commit pull requests and excludes ledger bookkeeping', () => {
    const merge = `${E_SHA}\0${A_SHA} ${D_SHA}\0Merge pull request #4570 from org/branch`;
    const inner = `${D_SHA}\0${A_SHA}\0fix(delegate): real change`;
    const ledger = `${C_SHA}\0${A_SHA}\0docs(ledger): record nightly ships from run 1`;
    const { execGit } = fixtureExec({
      [`log --format=%H%x00%P%x00%s ${A_SHA}..${B_SHA}`]: [
        merge,
        inner,
        ledger,
      ].join('\n'),
      [`rev-list ${E_SHA}^1..${E_SHA}`]: `${D_SHA}\n`,
    });
    const slice = deriveChangelogSlice({
      repoRoot: '.',
      previousSha: A_SHA,
      sha: B_SHA,
      githubRepo: 'kontourai/station',
      execGit,
    });
    expect(slice.previousSha).toBe(A_SHA);
    expect(slice.note).toBeNull();
    expect(slice.commitCount).toBe(1);
    expect(slice.groups.fix).toEqual([
      '[#4570](https://github.com/kontourai/station/pull/4570) fix(delegate): real change',
    ]);
  });

  it('keeps unattributed commits visible and unlinked rather than dropping them', () => {
    const { execGit } = fixtureExec({
      [`log --format=%H%x00%P%x00%s ${A_SHA}..${B_SHA}`]: `${C_SHA}\0${A_SHA}\0chore: direct push\n`,
    });
    const slice = deriveChangelogSlice({
      repoRoot: '.',
      previousSha: A_SHA,
      sha: B_SHA,
      githubRepo: 'kontourai/station',
      execGit,
    });
    expect(slice.groups.other).toEqual(['chore: direct push']);
  });

  it('rejects malformed shas before any git call', () => {
    expect(() =>
      deriveChangelogSlice({
        repoRoot: '.',
        previousSha: null,
        sha: 'short',
        githubRepo: 'kontourai/station',
        execGit: () => {
          throw new Error('must not run');
        },
      }),
    ).toThrow(/40 lowercase hex/);
    expect(() =>
      deriveChangelogSlice({
        repoRoot: '.',
        previousSha: 'nope',
        sha: A_SHA,
        githubRepo: 'kontourai/station',
        execGit: () => {
          throw new Error('must not run');
        },
      }),
    ).toThrow(/previousSha/);
  });
});
