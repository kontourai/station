#!/usr/bin/env node
/**
 * Deploy ledger appender (archive#4572).
 *
 * Appends one entry to docs/reference/deploy-ledger.json (array, newest
 * first) and regenerates docs/reference/deploy-ledger.md from the JSON, so
 * the rendered view is always a pure function of the ledger — regenerating
 * twice writes identical bytes.
 *
 * The ledger answers the owner's question — "on this date, this version was
 * deployed, so how out of date am I?" — and its honesty rules are strict:
 *
 * - The entry's SHA is PASSED IN from the workflow's own decided ship SHA
 *   (`steps.decide.outputs.head_sha` in nightly.yml, `needs.*.outputs.sha` in
 *   the release flows). This script never runs `git rev-parse` to "find" a
 *   SHA: a gate or ledger on a different SHA than the one that shipped is a
 *   lie, and that mistake is exactly what archive#4572 closes.
 * - Every field is validated (timestamp not in the future beyond clock skew,
 *   channel from the closed list, version over a strict charset, sha 40
 *   lowercase hex, https run URL, non-empty artifacts and gate sentence);
 *   anything malformed fails loud (exit 1), because a workflow that cannot
 *   record its ship must be red, not green-with-a-gap.
 * - Fields the caller cannot verify may be null (the historical seed uses
 *   this), but never invented.
 *
 * The changelog slice embedded in each entry is derived by
 * scripts/deploy-changelog.mjs between the previous same-channel ship SHA and
 * the new SHA. Only the FIRST entry of a same-sha batch carries that slice;
 * same-sha companions (a multi-package npm publish writes several entries at
 * one SHA) get an omission note referencing the batch leader, because there
 * are no commits between them. This script never commits or pushes: the
 * bounded-retry commit-back lives in scripts/lib/deploy-ledger-commit.mjs
 * (checked-in text, pinned by tests), called by the workflows visibly.
 */

import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CHANGELOG_GROUP_ORDER,
  deriveChangelogSlice,
} from './deploy-changelog.mjs';

export const DEPLOY_LEDGER_CHANNELS = Object.freeze([
  'nightly-android',
  'nightly-npm',
  'nightly-desktop',
  'stable-desktop',
  'stable-npm',
]);

export const DEPLOY_LEDGER_JSON_PATH = 'docs/reference/deploy-ledger.json';
export const DEPLOY_LEDGER_MD_PATH = 'docs/reference/deploy-ledger.md';

const SHA_PATTERN = /^[0-9a-f]{40}$/;
const TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;
const HTTPS_URL_PATTERN = /^https:\/\/\S+$/;

/**
 * Versions the ledger accepts: alphanumeric plus `.`, `+`, `~`, `-` — the
 * charset of every real channel version (semver, npm prerelease tags, the
 * nightly `0.1.2-nightly.2430` scheme). It excludes exactly the characters
 * a parse artifact carries: quotes, braces, brackets, commas, colons,
 * whitespace. A version that fails this pattern is not a version a user
 * could see in `station --version`, npm, or the Play console.
 */
export const DEPLOY_LEDGER_VERSION_PATTERN = /^[0-9A-Za-z][0-9A-Za-z.+~-]*$/;

/** Workflow clocks can lag the recorder's; five minutes of skew is
 * generous for a `date -u` taken in the same second as the publish. */
const FUTURE_TIMESTAMP_SKEW_MS = 5 * 60_000;

export function validateEntry(entry) {
  const errors = [];
  if (
    typeof entry.timestampUtc !== 'string' ||
    !TIMESTAMP_PATTERN.test(entry.timestampUtc) ||
    Number.isNaN(Date.parse(entry.timestampUtc))
  ) {
    errors.push(
      `timestampUtc must be an ISO 8601 UTC string: ${String(entry.timestampUtc)}`,
    );
  } else if (
    Date.parse(entry.timestampUtc) >
    Date.now() + FUTURE_TIMESTAMP_SKEW_MS
  ) {
    errors.push(
      `timestampUtc is in the future (${entry.timestampUtc}); a recording step cannot have run after the moment it records. Pass the workflow's own \`date -u\` timestamp rather than a projected one.`,
    );
  }
  if (
    typeof entry.channel !== 'string' ||
    !DEPLOY_LEDGER_CHANNELS.includes(entry.channel)
  ) {
    errors.push(
      `channel must be one of ${DEPLOY_LEDGER_CHANNELS.join(', ')}: ${String(entry.channel)}`,
    );
  }
  if (typeof entry.version !== 'string' || entry.version.trim() === '') {
    errors.push(`version must be a non-empty string: ${String(entry.version)}`);
  } else if (!DEPLOY_LEDGER_VERSION_PATTERN.test(entry.version)) {
    errors.push(
      `version contains characters no real version has (allowed: alphanumeric . + ~ -): ${JSON.stringify(entry.version)}. A value carrying quotes, braces, or brackets is a parse artifact — publish-packages.yml's published-packages output is a JSON array and must be parsed with scripts/lib/parse-published-packages.mjs, never text-split.`,
    );
  }
  if (typeof entry.sha !== 'string' || !SHA_PATTERN.test(entry.sha)) {
    errors.push(
      `sha must be 40 lowercase hex characters: ${String(entry.sha)}`,
    );
  }
  if (
    entry.workflowRunUrl !== null &&
    (typeof entry.workflowRunUrl !== 'string' ||
      !HTTPS_URL_PATTERN.test(entry.workflowRunUrl))
  ) {
    errors.push(
      `workflowRunUrl must be an https URL or null: ${String(entry.workflowRunUrl)}`,
    );
  }
  if (
    !Array.isArray(entry.artifacts) ||
    entry.artifacts.length === 0 ||
    entry.artifacts.some(
      (artifact) => typeof artifact !== 'string' || artifact.trim() === '',
    )
  ) {
    errors.push('artifacts must be a non-empty array of non-empty strings');
  }
  if (typeof entry.gateResult !== 'string' || entry.gateResult.trim() === '') {
    errors.push(
      `gateResult must be a non-empty string: ${String(entry.gateResult)}`,
    );
  }
  if (
    entry.notes !== null &&
    entry.notes !== undefined &&
    (!Array.isArray(entry.notes) ||
      entry.notes.some(
        (note) => typeof note !== 'string' || note.trim() === '',
      ))
  ) {
    errors.push('notes must be null or an array of non-empty strings');
  }
  return { ok: errors.length === 0, errors };
}

export function assertValidEntry(entry) {
  const { ok, errors } = validateEntry(entry);
  if (!ok) {
    throw new Error(
      `invalid deploy ledger entry:\n  - ${errors.join('\n  - ')}`,
    );
  }
}

/** Duplicate identity: the same channel shipping the same version from the
 * same SHA is a re-record, not a second ship — REGARDLESS of the artifact
 * list. Artifact lists are conditional (nightly's workflow-artifact entry
 * depends on a step outcome), so keying on them let a re-run with fewer
 * artifacts double-record the same ship. */
export function entryIdentityKey(entry) {
  return [entry.channel, entry.sha, entry.version].join('|');
}

export function appendEntry(entries, entry) {
  assertValidEntry(entry);
  const duplicate = entries.find(
    (existing) => entryIdentityKey(existing) === entryIdentityKey(entry),
  );
  if (duplicate) {
    throw new Error(
      `deploy ledger already records this ship: ${duplicate.channel} ${duplicate.version} at ${duplicate.sha}`,
    );
  }
  return [entry, ...entries];
}

/**
 * The previous recorded ship of this channel with a DIFFERENT SHA. Same-sha
 * entries (a multi-package npm publish writes several) are not "previous
 * ships" — there are no commits between them.
 */
export function previousShipSha(entries, channel, sha) {
  const previous = entries.find(
    (existing) => existing.channel === channel && existing.sha !== sha,
  );
  return previous ? previous.sha : null;
}

/**
 * The first recorded entry of this channel at exactly this SHA — the batch
 * leader of a same-sha batch (a multi-package publish writes one entry per
 * package, all at the build SHA). Only the leader carries the changelog
 * slice; companions reference it instead of repeating the same N-commit
 * slice once per package.
 */
export function sameShaBatchLeader(entries, channel, sha) {
  const leader = entries.find(
    (existing) => existing.channel === channel && existing.sha === sha,
  );
  return leader ?? null;
}

/** The changelog object a same-sha companion entry carries: no slice, a note
 * naming the leader, and no commit count (there are no commits between
 * same-sha ships). */
export function sameShaCompanionChangelog(leader, sha) {
  return {
    previousSha: null,
    groups: Object.fromEntries(CHANGELOG_GROUP_ORDER.map((g) => [g, []])),
    note: `Changelog slice omitted: this ship is a same-sha companion of ${leader.channel} ${leader.version} (recorded at ${sha.slice(0, 7)}) — no commits exist between same-sha ships, so the slice would repeat that entry's.`,
    commitCount: 0,
  };
}

function tableCell(value) {
  return String(value ?? '')
    .replaceAll('|', '\\|')
    .replaceAll('\n', ' ');
}

function shortSha(sha) {
  return sha.slice(0, 7);
}

const GROUP_TITLES = Object.freeze({
  feat: 'Features',
  fix: 'Fixes',
  ci: 'CI / workflow',
  docs: 'Docs',
  other: 'Other',
});

function renderChangelogSection(entry, githubRepo) {
  const changelog = entry.changelog;
  if (!changelog) return '';
  const lines = ['', '### Changelog', ''];
  if (changelog.note) {
    lines.push(`> ${changelog.note}`, '');
  }
  if (changelog.previousSha) {
    const fullSha = githubRepo
      ? ` ([full sha](https://github.com/${githubRepo}/commit/${changelog.previousSha}))`
      : '';
    lines.push(
      `Commits since \`${shortSha(changelog.previousSha)}\`${fullSha}:`,
      '',
    );
  }
  let any = false;
  for (const [group, groupLines] of Object.entries(changelog.groups ?? {})) {
    if (!Array.isArray(groupLines) || groupLines.length === 0) continue;
    any = true;
    lines.push(`**${GROUP_TITLES[group] ?? group}**`, '');
    for (const line of groupLines) lines.push(`- ${line}`);
    lines.push('');
  }
  if (!any && !changelog.note) {
    lines.push('_No user-visible changes recorded for this slice._', '');
  }
  return lines.join('\n');
}

/**
 * The rendered view is derived ONLY from the entries (plus the repo slug for
 * links), so regeneration is idempotent by construction.
 */
export function renderLedgerMarkdown({ entries, githubRepo }) {
  if (!Array.isArray(entries)) {
    throw new Error('ledger entries must be an array');
  }
  const repoSlug = typeof githubRepo === 'string' ? githubRepo : '';
  const rawLedgerUrl = repoSlug
    ? `https://raw.githubusercontent.com/${repoSlug}/main/${DEPLOY_LEDGER_JSON_PATH}`
    : null;
  const lines = [
    '# Deploy ledger',
    '',
    'Every ship this repository makes, recorded by the workflow that shipped it — the answer to "on this date, this version was deployed; how out of date am I?" (archive#4572).',
    '',
    '## Machine-readable source of truth',
    '',
    `- JSON (stable location, newest first): [\`${DEPLOY_LEDGER_JSON_PATH}\`](deploy-ledger.json) on \`main\`. This public repository makes the current ledger readable at [the raw JSON URL](${rawLedgerUrl}).`,
    '- This markdown view is generated from that JSON by `scripts/deploy-ledger.mjs`; it is a projection, never edited by hand.',
    '',
    '### JSON schema (one array element per ship)',
    '',
    '- `timestampUtc` — ISO 8601 UTC. When the recording workflow step ran (immediately after the publish it records); never in the future.',
    `- \`channel\` — one of \`${DEPLOY_LEDGER_CHANNELS.join('`, `')}\`.`,
    '- `version` — the channel-specific version identity users see (`station --version`, Play console, npm); alphanumeric plus `. + ~ -` only.',
    '- `sha` — the exact commit shipped, 40 lowercase hex, taken from the workflow\u2019s own decided ship SHA (never re-derived). A ship is identified by `channel` + `sha` + `version`; a re-record of the same identity is refused regardless of artifact list.',
    '- `workflowRunUrl` — the GitHub Actions run that recorded the ship, or null when unverifiable (historical seed entries).',
    '- `artifacts` — what shipped, one descriptor each (store track, npm package, retained bundle, release asset).',
    '- `gateResult` — the gate verdict that preceded the ship, as a sentence.',
    '- `notes` — null or honest caveats (fields that could not be verified for a seeded historical entry, for example).',
    '- `changelog` — `{ previousSha, groups, note, commitCount }`; `groups` maps `feat`/`fix`/`ci`/`docs`/`other` to markdown lines linking the delivering pull request. `docs(ledger):` bookkeeping commits are excluded from every slice. `note` carries the first-entry case and the same-sha-companion case (only the first entry of a same-sha batch carries the slice).',
    '',
    '### Site consumption',
    '',
    'This file decides nothing about how `station.kontourai.io` will read the ledger (archive#4572 site follow-up). What is true today: the in-repo path and schema above are the source of truth, every publish appends exactly one entry per shipped surface and commits it back to `main`, and the public raw JSON URL above is available to consumers without authentication. The site PR decides whether it reads that URL directly or copies the JSON, along with caching, refresh, and presentation. Because `main` moves, consumers should retain each entry’s `sha` and `workflowRunUrl` as evidence rather than treating a later fetch as an immutable release receipt.',
    '',
    '## Ledger',
    '',
    '| Date (UTC) | Channel | Version | Ship SHA | Gate | Run |',
    '| --- | --- | --- | --- | --- | --- |',
  ];
  for (const entry of entries) {
    const run = entry.workflowRunUrl ? `[run](${entry.workflowRunUrl})` : '—';
    lines.push(
      `| ${tableCell(entry.timestampUtc)} | ${tableCell(entry.channel)} | ${tableCell(entry.version)} | \`${shortSha(entry.sha)}\` | ${tableCell(entry.gateResult)} | ${run} |`,
    );
  }
  for (const entry of entries) {
    lines.push(
      '',
      `## ${tableCell(entry.timestampUtc)} · ${tableCell(entry.channel)} · ${tableCell(entry.version)}`,
      '',
      `- Ship SHA: \`${entry.sha}\``,
      ...entry.artifacts.map((artifact) => `- Artifact: ${artifact}`),
    );
    if (entry.notes && entry.notes.length > 0) {
      lines.push(...entry.notes.map((note) => `- Note: ${note}`));
    }
    lines.push(renderChangelogSection(entry, repoSlug).trimEnd());
  }
  return `${lines.join('\n')}\n`;
}

function usage() {
  return [
    'usage: node scripts/deploy-ledger.mjs \\',
    '         --channel <nightly-android|nightly-npm|nightly-desktop|stable-desktop|stable-npm> \\',
    '         --version <version> --sha <40-hex> --gate-result <sentence> \\',
    '         --github-repo owner/name [--timestamp <ISO-UTC>] [--workflow-run-url <https-url>]',
    '         [--artifact <descriptor>]... [--note <caveat>]... \\',
    '         [--repo-root <path>] [--ledger-json <path>] [--ledger-md <path>]',
    '',
    '--timestamp defaults to the current UTC moment (the workflow passes its own).',
    'Fails loud on any invalid field or duplicate ship; never commits or pushes.',
  ].join('\n');
}

function parseArgs(argv) {
  const flags = new Map();
  const repeated = new Map();
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (!flag.startsWith('--') || value === undefined) {
      throw new Error(`malformed argument pair: ${flag} ${String(value)}`);
    }
    if (flag === '--artifact' || flag === '--note') {
      if (!repeated.has(flag)) repeated.set(flag, []);
      repeated.get(flag).push(value);
      i += 1;
      continue;
    }
    flags.set(flag, value);
    i += 1;
  }
  return { flags, repeated };
}

export function main(argv) {
  let parsed;
  try {
    parsed = parseArgs(argv);
  } catch (error) {
    console.error(String(error.message));
    console.error(usage());
    return 1;
  }
  const { flags, repeated } = parsed;
  const required = [
    '--channel',
    '--version',
    '--sha',
    '--gate-result',
    '--github-repo',
  ];
  const missing = required.filter((flag) => flags.get(flag) === undefined);
  if (missing.length > 0) {
    console.error(`missing required argument(s): ${missing.join(', ')}`);
    console.error(usage());
    return 1;
  }
  const repoRoot = resolve(
    dirname(fileURLToPath(import.meta.url)),
    flags.get('--repo-root') ?? '..',
  );
  const ledgerJsonPath = resolve(
    repoRoot,
    flags.get('--ledger-json') ?? DEPLOY_LEDGER_JSON_PATH,
  );
  const ledgerMdPath = resolve(
    repoRoot,
    flags.get('--ledger-md') ?? DEPLOY_LEDGER_MD_PATH,
  );
  const githubRepo = flags.get('--github-repo');
  let entries;
  try {
    entries = JSON.parse(readFileSync(ledgerJsonPath, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') entries = [];
    else {
      console.error(`deploy ledger JSON is unreadable: ${error.message}`);
      return 1;
    }
  }
  if (!Array.isArray(entries)) {
    console.error('deploy ledger JSON must be an array (newest first)');
    return 1;
  }
  for (const existing of entries) assertValidEntry(existing);

  const sha = flags.get('--sha');
  const channel = flags.get('--channel');
  const leader = sameShaBatchLeader(entries, channel, sha);
  const previousSha = previousShipSha(entries, channel, sha);
  const timestampUtc =
    flags.get('--timestamp') ??
    new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  const entry = {
    timestampUtc,
    channel,
    version: flags.get('--version'),
    sha,
    workflowRunUrl: flags.get('--workflow-run-url') ?? null,
    artifacts: repeated.get('--artifact') ?? [],
    gateResult: flags.get('--gate-result'),
    notes: repeated.get('--note')?.length ? repeated.get('--note') : null,
    changelog: null,
  };
  try {
    assertValidEntry(entry);
    entry.changelog = leader
      ? sameShaCompanionChangelog(leader, sha)
      : deriveChangelogSlice({
          repoRoot,
          previousSha,
          sha,
          githubRepo,
        });
    entries = appendEntry(entries, entry);
  } catch (error) {
    console.error(`::error::${error.message}`);
    return 1;
  }
  writeFileSync(ledgerJsonPath, `${JSON.stringify(entries, null, 2)}\n`);
  writeFileSync(ledgerMdPath, renderLedgerMarkdown({ entries, githubRepo }));
  const row = `${entry.timestampUtc} | ${entry.channel} | ${entry.version} | ${shortSha(entry.sha)} | ${entry.changelog.commitCount ?? 0} commits in slice`;
  process.stdout.write(`${row}\n`);
  return 0;
}

// realpathSync both sides: an unresolved argv[1] under a symlinked workspace
// makes this compare false, the script imports as a module, and it exits 0
// having recorded nothing — the exact silent-unrecorded-ship gap this
// feature exists to close.
if (
  process.argv[1] &&
  realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  process.exit(main(process.argv.slice(2)));
}
