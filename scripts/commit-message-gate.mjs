/**
 * Conventional-commit subject gate (owner decision 2026-08-28).
 *
 * The deploy ledger (station#4572, forthcoming at time of writing) will
 * generate its changelog from commit subjects, so a free-form subject
 * stops being a style nit and becomes a broken release artifact. This gate
 * keeps the subject grammar a derivation, not a label: one exported
 * vocabulary constant, one pure validator, and two enforcement entry
 * points that ride the repo's existing hook mechanism
 * (`.githooks/` armed by `scripts/install-git-hooks.mjs`, so
 * `npm run dependencies:ci` / `npm run hooks:install` arm both):
 *
 *   .githooks/commit-msg  — refuses a bad subject at `git commit` time
 *   .githooks/pre-push    — refuses a push whose NEW commits carry bad subjects
 *
 * Enforcement is FORWARD-ONLY. The push-range path validates exactly the
 * commits being pushed (`remote_sha..local_sha`, or `local_sha --not
 * origin/main` for a brand-new ref); the commit-msg path validates one
 * message being written right now. Neither ever walks history. The repo's
 * measured residue (last 1500 commits, 2026-08-28, non-merge = parent
 * count < 2): 1132/1147 non-merge subjects already conform or are exempt;
 * the 15 that do not are pre-gate commits this gate deliberately never
 * re-judges.
 *
 * What this gate covers, stated plainly: locally-authored commits on
 * hook-armed machines. It does NOT govern GitHub squash-merge titles
 * (GitHub writes those itself, after the push) and it is bypassed by
 * `--no-verify` by design — a refusal people cannot route around teaches
 * routing around every hook. A CI-side mirror of this grammar is a
 * possible follow-up; it is deliberately not built here.
 *
 * The grammar accepts everything the repo legitimately writes today and
 * nothing more, measured from `git log --format=%s origin/main`:
 *   - types: the ten below (feat dominates, then fix/test/chore/docs);
 *     `wip:`/`checkpoint:`/`docs+test:` appeared 3/1/5 times and are
 *     residue, not vocabulary — they fail.
 *   - scope is optional, lowercase, hyphens allowed (`basis-pane`,
 *     `deps-dev`), and may be a comma list (`fix(ui,test):`) because the
 *     history contains real commits in that shape.
 *   - `!` before the colon (breaking change) is accepted; one real use
 *     exists (`feat(plugins)!: retire the api-request bridge`).
 *   - NO max-length rule: measured over those non-merge subjects,
 *     p50=66, p99=154, max=190. The conventional 50/72 guidance would
 *     fail roughly half the repo's good history, and any cap above 190
 *     has never caught anything.
 *
 * Exemptions are merge/revert/autosquash subjects, which no author
 * formats as conventional commits:
 *   Merge ...            — `git merge` / GitHub PR merges
 *   merge ...            — hand-written lowercase merge subjects in this
 *                          repo's style (`merge main`, `merge origin/main`,
 *                          `merge: ...`): all 25 in the last 3000 commits
 *                          are genuine merges (parent count >= 2), and
 *                          `git merge -m` runs commit-msg — refusing one
 *                          strands a merge mid-flight under MERGE_HEAD
 *   Revert "..."         — `git revert`
 *   fixup! / squash!     — `git commit --fixup/--squash` autosquash markers
 * Changesets release commits need no exemption: `chore: version packages`
 * already conforms.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

/**
 * The only accepted subject types, derived from the repo's real history.
 * Exported so tests iterate it — a type accepted by the gate but missing
 * here (or vice versa) is a bug in exactly one place.
 */
export const COMMIT_TYPES = Object.freeze([
  'build',
  'chore',
  'ci',
  'docs',
  'feat',
  'fix',
  'perf',
  'refactor',
  'style',
  'test',
]);

const TYPE_ALTERNATION = COMMIT_TYPES.join('|');
const SCOPE_ATOM = '[a-z0-9][a-z0-9_/-]*';
const SUBJECT_PATTERN = new RegExp(
  `^(${TYPE_ALTERNATION})(\\(${SCOPE_ATOM}(,${SCOPE_ATOM})*\\))?(!)?: \\S.*$`,
);

/** Merge/revert/autosquash subjects no author formats; each names its own exemption. */
export const SUBJECT_EXEMPTIONS = Object.freeze([
  { name: 'merge commit (git/GitHub default)', pattern: /^Merge \S/ },
  {
    name: "merge commit (this repo's hand-written style)",
    // Anchored word-boundary: `merge main`, `merge origin/main …`,
    // `merge: …` are all real merge subjects here (all 25 lowercase-merge
    // subjects in the last 3000 commits have parent count >= 2), while
    // `merges: …` or a mid-subject "merge" word is NOT exempt.
    pattern: /^merge\b/,
  },
  { name: 'git revert', pattern: /^Revert "/ },
  { name: 'autosquash marker', pattern: /^(fixup|squash)! / },
]);

/**
 * Frozen history records accepted only by the corpus check. These are not
 * subject exemptions: an exact immutable record may document an already
 * published merge, but it must never admit a future commit with the same
 * non-conforming subject.
 */
export const FROZEN_IMMUTABLE_HISTORY_RECORDS = Object.freeze([
  Object.freeze({
    sha: '61e40b2efd0b744ebd4866117a66bffdc321b73e',
    parents:
      '52687b3cfe4a1b603db2bbf160298db54f6781c9 2c979c096b54a64963467a0faf8e65eaf3a44dc3',
    subject: 'Fix real legacy service manifest quarantine (#621)',
    reason:
      'published immutable service-manifest quarantine merge predating the subject gate',
  }),
  Object.freeze({
    sha: 'c7c9a598bfcd454ab1da692c139c36b96909efe5',
    parents:
      'ae2194f22c0e999bd7048f60453ae185d8e3e26c 52951fc015518742bbda8b83e65ba1bbdd985931',
    subject:
      'Reconcile stale desktop sidecar before runtime preparation (#635)',
    reason:
      'published immutable desktop-sidecar merge predating pull-request title enforcement',
  }),
]);

/** Exact immutable-history match; no subject-only or partial-record exception. */
export function matchingFrozenImmutableHistoryRecord({
  sha,
  parents,
  subject,
}) {
  return (
    FROZEN_IMMUTABLE_HISTORY_RECORDS.find(
      (record) =>
        record.sha === sha &&
        record.parents === parents &&
        record.subject === subject,
    ) ?? null
  );
}

/** Which exemption (if any) covers this subject. `null` when none does. */
export function matchingExemption(subject) {
  const line = String(subject ?? '');
  return (
    SUBJECT_EXEMPTIONS.find((exemption) => exemption.pattern.test(line)) ?? null
  );
}

/**
 * The subject line of a raw commit message: the first line that is neither
 * blank nor a `#` comment (git leaves status comments in the commit-msg
 * file). `null` when the message has no subject at all.
 */
export function subjectFromMessage(message) {
  for (const line of String(message ?? '').split(/\r?\n/)) {
    if (!line.trim() || line.startsWith('#')) continue;
    return line;
  }
  return null;
}

/**
 * Pure verdict for one subject line.
 *
 * @returns {{ok: boolean, subject: string, exemption?: string, reason?: string}}
 *   `ok` true with `exemption` named when exempt; `ok` false with a
 *   `reason` that states what was seen and what the grammar expects.
 */
export function validateSubject(subject) {
  const line = String(subject ?? '');

  if (!line.trim()) {
    return {
      ok: false,
      subject: line,
      reason: 'the subject is empty (or nothing but whitespace)',
    };
  }
  if (line !== line.trim()) {
    return {
      ok: false,
      subject: line,
      reason:
        'the subject has leading or trailing whitespace; strip it so `git log --oneline` and generated changelogs stay aligned',
    };
  }

  const exemption = matchingExemption(line);
  if (exemption) {
    return { ok: true, subject: line, exemption: exemption.name };
  }

  const match = SUBJECT_PATTERN.exec(line);
  if (!match) {
    // Name the type the author actually wrote, when there is one, so the
    // refusal teaches rather than just says no.
    const typeLike = /^([A-Za-z][A-Za-z/+]*)(\(|:|!)/.exec(line);
    let detail;
    if (!typeLike) {
      detail = 'no recognizable type';
    } else if (!COMMIT_TYPES.includes(typeLike[1].toLowerCase())) {
      detail = `"${typeLike[1]}" is not an accepted type`;
    } else if (typeLike[2] === '(') {
      detail = `"${typeLike[1]}" is accepted, so the scope or colon spacing is the problem (scope must be lowercase, comma-separated, followed by ": ")`;
    } else {
      detail = `"${typeLike[1]}" is accepted, so the colon spacing is the problem (one space after the colon, non-empty subject)`;
    }
    return {
      ok: false,
      subject: line,
      reason: `found ${detail}; expected type(scope)?: subject`,
    };
  }
  return { ok: true, subject: line };
}

/**
 * PR titles become the conventional subject `${title} (#${number})`.
 * This deliberately delegates to validateSubject: title enforcement has no
 * history exceptions and cannot widen the ordinary grammar.
 */
export function validatePullRequestTitle(title, number) {
  const rawNumber = String(number ?? '');
  const subject = `${String(title ?? '')} (#${rawNumber})`;
  if (!/^[1-9]\d*$/.test(rawNumber)) {
    return {
      ok: false,
      subject,
      reason: 'the pull-request number must be a positive integer',
    };
  }
  return validateSubject(subject);
}

/** Pure verdict for a full commit message (subject line extraction included). */
export function validateMessage(message) {
  const subject = subjectFromMessage(message);
  if (subject === null) {
    return {
      ok: false,
      subject: '',
      reason: 'the message has no subject line',
    };
  }
  return validateSubject(subject);
}

/** The refusal text: states the grammar, the vocabulary, and the exemptions. */
export function teachingMessage({ subject, reason }) {
  return [
    '',
    'FAIL: commit subject does not match the required format',
    '',
    `  ${subject}`,
    '',
    `Why it failed: ${reason}.`,
    '',
    'Accepted grammar:  type(scope)?: subject',
    `Accepted types:   ${COMMIT_TYPES.join(', ')}`,
    '  - scope is optional, lowercase (hyphens ok), and may be a comma list:',
    '      fix(ui,test): stop the badge resetting',
    '  - `!` before the colon marks a breaking change:',
    '      feat(plugins)!: retire the api-request bridge',
    'Examples from this repo:',
    '  fix(dock): stop the project badge resetting to No project',
    '  feat(cli): add station-dev, a cwd-resolving global dev shim',
    '  docs: correct the STATION_E2E_SCREENS equivalence claim',
    '',
    'Exempt (no format required):',
    '  Merge ...          git/GitHub merge commits',
    '  merge ...          lowercase merge subjects (this repo style)',
    '  Revert "..."       git revert',
    '  fixup! / squash!   autosquash markers',
    'Changesets releases already conform: "chore: version packages".',
    '',
    'Why this exists: commit subjects will feed the deploy-ledger changelog',
    '(station#4572, forthcoming), so a free-form subject would break a',
    'release artifact. The gate is forward-only: it validates commits being',
    'written or pushed now, never history.',
    '',
  ].join('\n');
}

/**
 * Parse pre-push stdin lines (`<local_ref> <local_sha> <remote_ref> <remote_sha>`),
 * skipping ref deletions (zero local OID), into one {localSha, remoteSha} pair
 * per updated ref.
 */
export function parsePrepushLines(lines) {
  return String(lines ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [_localRef, localSha, _remoteRef, remoteSha] = line.split(/\s+/);
      return { localSha, remoteSha };
    })
    .filter(({ localSha }) => localSha && !/^0+$/.test(localSha));
}

/**
 * The commits a push would introduce, as {sha, subject} pairs, in push order.
 * For a tracked ref: `remoteSha..localSha`. For a new ref (zero remote OID):
 * everything reachable from localSha but not from the base ref — the same
 * containment contract `check-merge-base-fresh.mjs` already enforces, so a
 * branch that does not contain the base never reaches this code.
 */
export function pushedCommits({ localSha, remoteSha, baseSha }, run = git) {
  const range =
    remoteSha && !/^0+$/.test(remoteSha)
      ? `${remoteSha}..${localSha}`
      : baseSha
        ? [localSha, '--not', baseSha]
        : null;
  if (!range) return [];
  const out = run(['log', '--format=%H%x00%s', ...rangeArgs(range)]);
  return out
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [sha, subject] = line.split('\0');
      return { sha, subject };
    });
}

function rangeArgs(range) {
  return Array.isArray(range) ? range : [range];
}

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8', windowsHide: true });
}

function resolveBaseRef() {
  const ref = process.env.STATION_BASE_REF ?? 'origin/main';
  try {
    return {
      ref,
      sha: git(['rev-parse', '--verify', `${ref}^{commit}`]).trim(),
    };
  } catch {
    return { ref, sha: null };
  }
}

function failWithVerdicts(verdicts) {
  for (const { sha, verdict } of verdicts) {
    console.error(
      teachingMessage({
        subject: `${sha ? `${sha} ` : ''}${verdict.subject}`,
        reason: verdict.reason,
      }),
    );
  }
  const subjects = verdicts
    .map(({ verdict }) => `"${verdict.subject}"`)
    .join(', ');
  console.error(
    `FAIL: ${verdicts.length} commit subject(s) above do not match the required format (${subjects}).`,
  );
  console.error('Fix with `git rebase -i` and reword, then push again.');
  process.exitCode = 1;
}

function runFileMode(path) {
  const message = readFileSync(path, 'utf8');
  const verdict = validateMessage(message);
  if (!verdict.ok) {
    console.error(teachingMessage(verdict));
    process.exitCode = 1;
  }
}

function runSubjectMode(subject) {
  const verdict = validateSubject(subject);
  if (!verdict.ok) {
    console.error(teachingMessage(verdict));
    process.exitCode = 1;
  }
}

function runPullRequestTitleMode(title, number) {
  const verdict = validatePullRequestTitle(title, number);
  if (!verdict.ok) {
    console.error(teachingMessage(verdict));
    process.exitCode = 1;
  }
}

function runPrepushMode(stdin) {
  const { ref: baseRef, sha: baseSha } = resolveBaseRef();
  const pairs = parsePrepushLines(stdin);
  // Fail-open stays (a detached CI checkout must not be blocked), but a
  // skip must never wear the pass message: a brand-new ref with an
  // unresolvable base checks NOTHING, and the output must say so.
  const needsBase = pairs.some(
    ({ remoteSha }) => !remoteSha || /^0+$/.test(remoteSha),
  );
  if (!baseSha && needsBase) {
    console.log(
      `SKIPPED: could not resolve ${baseRef}; commit subjects were NOT checked`,
    );
    return;
  }
  const failures = [];
  for (const { localSha, remoteSha } of pairs) {
    for (const { sha, subject } of pushedCommits({
      localSha,
      remoteSha,
      baseSha,
    })) {
      const verdict = validateSubject(subject);
      if (!verdict.ok) {
        failures.push({ sha: sha.slice(0, 10), verdict });
      }
    }
  }
  if (failures.length > 0) {
    failWithVerdicts(failures);
    return;
  }
  console.log(
    'Commit subjects: every subject in the push range conforms (or is exempt).',
  );
}

function usage() {
  console.error(
    'usage: commit-message-gate.mjs --file <commit-msg-file> | --subject <subject> | --pull-request-title <title> <positive-number> | --prepush-stdin < prepush-ref-lines',
  );
  process.exitCode = 2;
}

function main() {
  const [mode, value, extra] = process.argv.slice(2);
  switch (mode) {
    case '--file':
      if (!value) return usage();
      return runFileMode(value);
    case '--subject':
      if (value === undefined) return usage();
      return runSubjectMode(value);
    case '--pull-request-title':
      if (value === undefined || extra === undefined) return usage();
      return runPullRequestTitleMode(value, extra);
    case '--prepush-stdin':
      return runPrepushMode(readFileSync(0, 'utf8'));
    default:
      return usage();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
