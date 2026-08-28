import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  COMMIT_TYPES,
  FROZEN_IMMUTABLE_HISTORY_RECORDS,
  matchingExemption,
  matchingFrozenImmutableHistoryRecord,
  parsePrepushLines,
  pushedCommits,
  subjectFromMessage,
  teachingMessage,
  validateMessage,
  validatePullRequestTitle,
  validateSubject,
} from '../commit-message-gate.mjs';

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const gatePath = resolve(scriptsDir, '../commit-message-gate.mjs');
const hookPath = resolve(scriptsDir, '../../.githooks/commit-msg');

function runGate(args: string[], input?: string, env?: Record<string, string>) {
  return spawnSync(process.execPath, [gatePath, ...args], {
    encoding: 'utf8',
    windowsHide: true,
    ...(input === undefined ? {} : { input }),
    ...(env === undefined ? {} : { env: { ...process.env, ...env } }),
  });
}

function runHook(message: string) {
  const tmp = mkdtempSync(join(tmpdir(), 'station-commit-msg-'));
  try {
    const file = join(tmp, 'message');
    writeFileSync(file, message);
    return spawnSync('bash', [hookPath, file], {
      encoding: 'utf8',
      windowsHide: true,
    });
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

describe('accepted vocabulary (table-driven over the exported constant)', () => {
  it('accepts every exported type unscoped', () => {
    for (const type of COMMIT_TYPES) {
      const verdict = validateSubject(`${type}: describe the outcome`);
      expect(verdict.ok, `${type}: describe the outcome`).toBe(true);
      expect(verdict.exemption).toBeUndefined();
    }
  });

  it('accepts every exported type scoped', () => {
    for (const type of COMMIT_TYPES) {
      const subject = `${type}(dock): describe the outcome`;
      expect(validateSubject(subject).ok, subject).toBe(true);
    }
  });

  it('accepts every exported type with the breaking-change marker', () => {
    for (const type of COMMIT_TYPES) {
      const subject = `${type}(plugins)!: retire the api-request bridge`;
      expect(validateSubject(subject).ok, subject).toBe(true);
    }
  });

  it('names every type a real repo subject has used', () => {
    // Measured from `git log --format=%s origin/main -1500` (2026-08-28);
    // if a legitimate type is missing from COMMIT_TYPES the corpus check
    // below is what will surface it.
    for (const type of [
      'feat',
      'fix',
      'test',
      'chore',
      'docs',
      'refactor',
      'style',
      'perf',
      'build',
      'ci',
    ]) {
      expect(COMMIT_TYPES).toContain(type);
    }
  });
});

describe('scope forms in real repo history', () => {
  it('accepts hyphenated and dotted-free lowercase scopes', () => {
    for (const subject of [
      'fix(basis-pane): preserve fallback owner sequence',
      'build(deps-dev): bump the CLI toolchain',
      'feat(workspace-panes): add the skeleton rhythm',
    ]) {
      expect(validateSubject(subject).ok, subject).toBe(true);
    }
  });

  it('accepts comma-separated scope lists', () => {
    const subject = 'fix(ui,test): canonical "Add model connection" copy';
    expect(validateSubject(subject).ok, subject).toBe(true);
  });

  it('rejects uppercase scopes (none exist in history)', () => {
    expect(validateSubject('fix(UI): align the breakpoint').ok).toBe(false);
  });
});

describe('exemptions name themselves', () => {
  it('exempts git and GitHub merge commits', () => {
    for (const subject of [
      'Merge pull request #4570 from kontourai/fix/delegate-supervision-binding',
      "Merge remote-tracking branch 'origin/main' into feat/tabs-primitive",
      "Merge branch 'fix/4401-runtime-final' into feat/4401-single-root",
    ]) {
      const verdict = validateSubject(subject);
      expect(verdict.ok, subject).toBe(true);
      expect(verdict.exemption).toBe('merge commit (git/GitHub default)');
    }
  });

  it("exempts this repo's hand-written lowercase merge subjects", () => {
    const subject =
      'merge origin/main (union spec fixtures; entry JS ceiling to merged-tree measured 305957)';
    const verdict = validateSubject(subject);
    expect(verdict.ok, subject).toBe(true);
    expect(verdict.exemption).toBe(
      "merge commit (this repo's hand-written style)",
    );
  });

  it("exempts the repo's real lowercase merge population (measured 25/25 in the last 3000)", () => {
    // Measured 2026-08-28: every lowercase-merge subject in the last 3000
    // commits is a genuine merge (parent count >= 2) — bare `merge main`,
    // suffixed variants, and `merge:` forms — and `git merge -m "merge main"`
    // runs commit-msg, so refusing one strands a merge mid-flight with
    // MERGE_HEAD set.
    for (const subject of [
      'merge main',
      'merge main (#3153)',
      'merge main and retain measured bundle ceiling (+51 B gzip)',
      'merge origin/main (union spec fixtures; entry JS ceiling to merged-tree measured 305957)',
      'merge origin/main into feat/2652-unpaired-first-run',
      "merge: bring #3215's corrections in, keeping both sides of each conflict",
      'merge: origin main into Basis adapter',
      'merge: origin/main into fix/followups-ui-batch',
    ]) {
      const verdict = validateSubject(subject);
      expect(verdict.ok, subject).toBe(true);
      expect(verdict.exemption, subject).toBe(
        "merge commit (this repo's hand-written style)",
      );
    }
  });

  it('keeps the lowercase merge exemption anchored and word-bounded', () => {
    // Plural "merges" is not a merge subject, and the word "merge" must be
    // the subject's first word — not merely present in it.
    expect(matchingExemption('merges: fold panes into one')).toBeNull();
    expect(validateSubject('merges: fold panes into one').ok).toBe(false);
  });

  it('does NOT exempt "Merge" appearing mid-subject (the anchor is the start)', () => {
    // A conforming subject that merely CONTAINS "Merge ..." must stay a
    // grammar pass, not an exemption: loosening /^Merge \S/ to /Merge \S/
    // exempts exactly this shape, and nothing else notices.
    const subject = 'feat: Merge maps into the pane';
    const verdict = validateSubject(subject);
    expect(verdict.ok).toBe(true);
    expect(verdict.exemption).toBeUndefined();
    expect(matchingExemption(subject)).toBeNull();
    expect(matchingExemption('fix: merge main into the dock')).toBeNull();
  });

  it('exempts git revert subjects, including nested reverts', () => {
    for (const subject of [
      'Revert "fix(sdk): retain terminal protected read error"',
      'Revert "Revert "fix(test): project-live-work fixtures stop casting""',
    ]) {
      const verdict = validateSubject(subject);
      expect(verdict.ok, subject).toBe(true);
      expect(verdict.exemption).toBe('git revert');
    }
  });

  it('exempts autosquash markers', () => {
    for (const subject of [
      'fixup! fix(dock): stop the badge resetting',
      'squash! fix(dock): stop the badge resetting',
    ]) {
      const verdict = validateSubject(subject);
      expect(verdict.ok, subject).toBe(true);
      expect(verdict.exemption).toBe('autosquash marker');
    }
  });

  it('accepts the changesets release subject through the normal grammar', () => {
    const verdict = validateSubject('chore: version packages');
    expect(verdict.ok).toBe(true);
    expect(verdict.exemption).toBeUndefined();
    expect(matchingExemption('chore: version packages')).toBeNull();
  });
});

describe('rejections teach rather than just refuse', () => {
  it('rejects a subject with no type', () => {
    const verdict = validateSubject('stop the badge resetting');
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toContain('no recognizable type');
  });

  it('rejects unknown types seen in pre-gate residue', () => {
    for (const subject of [
      'wip: five-port fixtures',
      'checkpoint: merged-tree gates green',
      'docs+test: regenerate baseline post-determinism-fix; drop volatile marker',
      'fix/test: one chat-receipt fixture with a guard',
    ]) {
      const verdict = validateSubject(subject);
      expect(verdict.ok, subject).toBe(false);
      expect(verdict.reason).toContain('not an accepted type');
    }
  });

  it('rejects an empty or whitespace-only subject', () => {
    for (const subject of ['', '   ', '\t']) {
      const verdict = validateSubject(subject);
      expect(verdict.ok, JSON.stringify(subject)).toBe(false);
      expect(verdict.reason).toContain('empty');
    }
  });

  it('rejects whitespace tricks around an otherwise-valid subject', () => {
    for (const subject of [
      '  fix(dock): indented subject',
      'fix(dock): trailing space ',
    ]) {
      const verdict = validateSubject(subject);
      expect(verdict.ok, JSON.stringify(subject)).toBe(false);
      expect(verdict.reason).toContain('whitespace');
    }
    // A tab where the separator space belongs is a colon-spacing defect and
    // is taught as one.
    const tab = validateSubject('fix(dock):\ttab-prefixed subject');
    expect(tab.ok).toBe(false);
    expect(tab.reason).toContain('colon spacing');
  });

  it('rejects colon-spacing defects with a pointer at the real problem', () => {
    const noSpace = validateSubject('fix(dock):no space after colon');
    expect(noSpace.ok).toBe(false);
    expect(noSpace.reason).toContain('colon spacing');

    const emptyDescription = validateSubject('fix(dock): ');
    expect(emptyDescription.ok).toBe(false);

    const missingSubject = validateSubject('fix:');
    expect(missingSubject.ok).toBe(false);
  });

  it('rejects scope-shape defects with a pointer at the real problem', () => {
    const verdict = validateSubject('fix(Dock): uppercase scope');
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toContain('scope');
  });
});

describe('message extraction', () => {
  it('takes the first non-comment, non-blank line as the subject', () => {
    expect(
      subjectFromMessage(
        [
          '# Please enter the commit message...',
          '',
          'fix(dock): the real subject',
          '',
          'Body text.',
        ].join('\n'),
      ),
    ).toBe('fix(dock): the real subject');
  });

  it('a message with only comments has no subject', () => {
    expect(subjectFromMessage('# comment\n# another\n')).toBeNull();
    expect(validateMessage('# only comments').ok).toBe(false);
  });
});

describe('pre-push range parsing is push-only', () => {
  it('parses ref lines and skips deletions', () => {
    const lines = [
      'refs/heads/feat/x 4a1b2c3 refs/heads/feat/x 0000000000000000000000000000000000000000',
      'refs/heads/gone 0000000000000000000000000000000000000000 refs/heads/gone d4e5f6a',
      '',
    ].join('\n');
    expect(parsePrepushLines(lines)).toEqual([
      {
        localSha: '4a1b2c3',
        remoteSha: '0000000000000000000000000000000000000000',
      },
    ]);
  });

  it('enumerates only remote..local for a tracked ref', () => {
    const seen: string[][] = [];
    const commits = pushedCommits(
      { localSha: 'local1', remoteSha: 'remote1', baseSha: 'base1' },
      (args) => {
        seen.push(args);
        return 'aaa0000000000000000000000000000000000000\0fix(dock): subject one\nbbb0000000000000000000000000000000000000\0bad subject two';
      },
    );
    expect(seen[0]).toEqual(['log', '--format=%H%x00%s', 'remote1..local1']);
    expect(commits).toEqual([
      {
        sha: 'aaa0000000000000000000000000000000000000',
        subject: 'fix(dock): subject one',
      },
      {
        sha: 'bbb0000000000000000000000000000000000000',
        subject: 'bad subject two',
      },
    ]);
  });

  it('for a brand-new ref, enumerates commits not on the base — never history', () => {
    const seen: string[][] = [];
    pushedCommits(
      { localSha: 'local1', remoteSha: null, baseSha: 'base1' },
      (args) => {
        seen.push(args);
        return '';
      },
    );
    expect(seen[0]).toEqual([
      'log',
      '--format=%H%x00%s',
      'local1',
      '--not',
      'base1',
    ]);
  });

  it('without a base ref a new ref enumerates nothing (fail-open only for the unpushable)', () => {
    expect(
      pushedCommits(
        { localSha: 'local1', remoteSha: null, baseSha: null },
        () => '',
      ),
    ).toEqual([]);
  });
});

describe('.githooks/pre-push wiring (the emission seam)', () => {
  // The hook emits ref lines that parsePrepushLines destructures; the two
  // halves live in different languages and once drifted (the hook emitted
  // two fields, the parser read four, and every push validated the wrong
  // range while printing the pass message). This executes the hook's OWN
  // collection loop and feeds its actual output through the parser, so the
  // contract is tested, not re-stated.
  const hook = readFileSync('.githooks/pre-push', 'utf8');

  function extractCollectionLoop() {
    const start = hook.indexOf('has_updates=0');
    const end = hook.indexOf('done', start);
    // If the hook is restructured so this extraction breaks, fail loudly
    // rather than silently asserting nothing.
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    return hook.slice(start, end + 'done'.length);
  }

  it("emits git's four-field ref lines into the parser's slots", () => {
    const script = [
      'set -euo pipefail',
      extractCollectionLoop(),
      `printf "%s\\n" "\${push_ref_lines[@]}"`,
    ].join('\n');
    const localSha = 'a'.repeat(40);
    const remoteSha = 'b'.repeat(40);
    const zeroSha = '0'.repeat(40);
    const stdin = [
      `refs/heads/feat/new ${localSha} refs/heads/feat/new ${zeroSha}`,
      `refs/heads/feat/tracked ${localSha} refs/heads/feat/tracked ${remoteSha}`,
      `refs/heads/gone ${zeroSha} refs/heads/gone ${remoteSha}`,
      '',
    ].join('\n');
    const result = spawnSync('bash', ['-c', script], {
      input: stdin,
      encoding: 'utf8',
      windowsHide: true,
    });
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    // A brand-new ref keeps its zero remote OID (base-ref fallback), a
    // tracked update keeps its real remote tip (range), and the deletion
    // is skipped. A two-field emission lands the SHAs in the wrong slots
    // and fails here.
    expect(parsePrepushLines(result.stdout)).toEqual([
      { localSha, remoteSha: zeroSha },
      { localSha, remoteSha },
    ]);
  });
});

describe('the CLI proves its refusal path by real exit status', () => {
  it('exits 1 and teaches the grammar for a bad --subject', () => {
    const result = runGate(['--subject', 'bad subject']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('type(scope)?: subject');
    expect(result.stderr).toContain('bad subject');
    for (const type of COMMIT_TYPES) {
      expect(result.stderr).toContain(type);
    }
  });

  it('exits 0 for a good --subject', () => {
    const result = runGate([
      '--subject',
      'fix(dock): stop the badge resetting',
    ]);
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
  });

  it('names the merge/revert/fixup exemptions in the teaching message', () => {
    const text = teachingMessage({ subject: 'x', reason: 'why' });
    expect(text).toContain('Merge ...');
    expect(text).toContain('merge ...');
    expect(text).toContain('Revert "..."');
    expect(text).toContain('fixup! / squash!');
  });

  it('prints SKIPPED — never a pass — when a new-ref push cannot resolve the base', () => {
    const result = runGate(
      ['--prepush-stdin'],
      `refs/heads/feat/x ${'a'.repeat(40)} refs/heads/feat/x ${'0'.repeat(40)}\n`,
      { STATION_BASE_REF: 'refs/heads/does-not-exist' },
    );
    // The skip posture stands (a detached checkout is not blocked), but the
    // output must not claim subjects were checked when nothing was.
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(
      'SKIPPED: could not resolve refs/heads/does-not-exist; commit subjects were NOT checked',
    );
    expect(result.stdout).not.toContain('conforms');
  });
});

describe('.githooks/commit-msg wiring (a wrapper that never refused is unproven)', () => {
  it('refuses a bad message file with exit 1 and the teaching text', () => {
    const result = runHook('bad subject\n\n# comment\n');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('type(scope)?: subject');
  });

  it('accepts a good message file', () => {
    const result = runHook(
      'fix(dock): stop the badge resetting\n\nLonger body.\n',
    );
    expect(result.status).toBe(0);
  });

  it('accepts git comment noise around a good subject', () => {
    const result = runHook(
      ['# On branch feat/x', '', 'fix(dock): the subject', ''].join('\n'),
    );
    expect(result.status).toBe(0);
  });
});

describe('pull-request title mode', () => {
  it('derives the exact conventional subject and accepts a valid title', () => {
    const title = 'fix(cli): retain bounded reconcile lock ownership';
    expect(validatePullRequestTitle(title, '641')).toEqual(
      validateSubject(`${title} (#641)`),
    );
    expect(runGate(['--pull-request-title', title, '641']).status).toBe(0);
  });

  it.each(['0', '-1', '1.5', 'abc', ''])(
    'rejects invalid pull-request number %j',
    (number) => {
      expect(validatePullRequestTitle('fix: valid title', number).ok).toBe(
        false,
      );
      expect(
        runGate(['--pull-request-title', 'fix: valid title', number]).status,
      ).toBe(1);
    },
  );

  it('does not admit frozen records or future uppercase titles', () => {
    const frozen = FROZEN_IMMUTABLE_HISTORY_RECORDS.find((record) =>
      record.subject.endsWith('(#635)'),
    );
    expect(frozen).toBeTruthy();
    const title = 'Reconcile stale desktop sidecar before runtime preparation';
    expect(validatePullRequestTitle(title, '635')).toMatchObject({
      ok: false,
      subject: frozen?.subject,
    });
    expect(runGate(['--pull-request-title', title, '635']).status).toBe(1);
    expect(
      validatePullRequestTitle('Fix: future uppercase title', '642').ok,
    ).toBe(false);
  });
});

describe('corpus: the vocabulary constant must fit the repo it governs', () => {
  it('matches only the named immutable history records', () => {
    for (const record of FROZEN_IMMUTABLE_HISTORY_RECORDS) {
      expect(matchingFrozenImmutableHistoryRecord(record)).toBe(record);

      for (const changed of [
        { ...record, sha: `${record.sha.slice(0, -1)}0` },
        {
          ...record,
          parents: `${record.parents} 0000000000000000000000000000000000000000`,
        },
        { ...record, subject: `${record.subject} changed` },
      ]) {
        expect(matchingFrozenImmutableHistoryRecord(changed)).toBeNull();
      }

      expect(validateSubject(record.subject).ok).toBe(false);
    }

    expect(
      validateSubject('Fix: future uppercase subject remains rejected').ok,
    ).toBe(false);
  });

  /**
   * Known pre-gate residue (out of the last 1500 subjects, ~1.2%): `wip:`,
   * `checkpoint:`, `docs+test:`, `fix/test:`, lowercase `merge:`/`revert:`
   * types, and a handful of pre-gate free-form subjects. None of it is in
   * the last 100, so the threshold has full headroom; if this check ever
   * reds below 95%, the vocabulary constant is wrong — fix the constant,
   * not the corpus.
   */
  it('passes >= 95% of the last up-to-100 non-merge subjects on origin/main', () => {
    // %P first: the parentless ROOT commit (the 2026-08-28 history reset's
    // ceremonial founding commit, "Found Station: …") is structural history,
    // not push traffic — there is exactly one, it can never recur, and the
    // gate governs pushes going forward. Everything with a parent counts.
    const subjects = execFileSync(
      'git',
      ['log', '--format=%P%x00%s', '--no-merges', 'origin/main', '-100'],
      { encoding: 'utf8', windowsHide: true },
    )
      .split('\n')
      .filter(Boolean)
      .map((line) => line.split('\0'))
      .filter(([parents]) => parents !== '')
      .map(([, subject]) => subject);

    // Post history-reset (2026-08-28) the repo restarted from a single root
    // commit, so the corpus is however much history exists, capped at 100.
    // The non-empty floor keeps the check from ever passing over nothing;
    // the >= 95% ratio below is unchanged and applies to whatever exists.
    // Once 100+ commits accumulate this is exactly the original assertion.
    expect(subjects.length).toBeGreaterThan(0);
    expect(subjects.length).toBeLessThanOrEqual(100);

    const failures = subjects
      .map((subject) => ({ subject, verdict: validateSubject(subject) }))
      .filter(({ verdict }) => !verdict.ok);

    const rate = ((subjects.length - failures.length) / subjects.length) * 100;
    console.log(
      `commit-message-gate corpus: ${subjects.length - failures.length}/${subjects.length} (${rate.toFixed(1)}%) of the last 100 non-merge origin/main subjects conform`,
    );
    for (const { subject } of failures) {
      console.log(`  known pre-gate residue: ${subject}`);
    }

    expect(
      rate,
      `non-conforming subjects: ${failures.map((f) => f.subject).join(' | ')}`,
    ).toBeGreaterThanOrEqual(95);
  });

  it('covers every merge subject among the last 3000 origin/main commits as exempt-or-conform', () => {
    // The test above excludes merges entirely (--no-merges), which was a
    // blindspot: the exemptions govern exactly the population it skipped.
    // This asserts over merge commits by parent count (>= 2), the same
    // truth git uses, and requires 100% — a genuine merge subject the
    // exemptions refuse is a push this gate would strand mid-merge.
    const rows = execFileSync(
      'git',
      ['log', 'origin/main', '-3000', '--format=%H%x00%P%x00%s'],
      { encoding: 'utf8', maxBuffer: 1 << 24, windowsHide: true },
    )
      .split('\n')
      .filter(Boolean)
      .map((line) => line.split('\0'));
    const merges = rows.filter(([, parents]) => parents.includes(' '));
    // Post history-reset the merge population rebuilds from zero (the
    // single-root history starts with none). Assert over every merge that
    // exists rather than a fixed floor — and make the zero-merge state
    // loud in the log rather than silently vacuous, so a reader of the
    // output can tell "no merges yet" from "853 checked". (Pre-reset this
    // asserted > 800 against the archive's 853; restore a floor once the
    // new history has a real merge population to pin.)
    if (merges.length === 0) {
      console.log(
        'commit-message-gate corpus: 0 merge commits exist on origin/main yet (post-reset single-root history) — nothing to check',
      );
      return;
    }

    const immutableCounts = new Map(
      FROZEN_IMMUTABLE_HISTORY_RECORDS.map((record) => [record.sha, 0]),
    );
    const verdicts = merges.map(([sha, parents, subject]) => {
      const immutable = matchingFrozenImmutableHistoryRecord({
        sha,
        parents,
        subject,
      });
      if (immutable) {
        immutableCounts.set(
          immutable.sha,
          (immutableCounts.get(immutable.sha) ?? 0) + 1,
        );
      }
      return { subject, verdict: validateSubject(subject), immutable };
    });
    const failures = verdicts.filter(({ verdict, immutable }) =>
      immutable ? false : !verdict.ok,
    );

    console.log(
      `commit-message-gate corpus: ${merges.length - failures.length}/${merges.length} merge subjects are exempt, conform, or exact immutable records`,
    );
    expect([...immutableCounts.entries()]).toEqual(
      FROZEN_IMMUTABLE_HISTORY_RECORDS.map((record) => [record.sha, 1]),
    );
    expect(failures.map((f) => f.subject)).toEqual([]);
  });
});
