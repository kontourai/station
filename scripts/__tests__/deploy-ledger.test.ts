import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  appendEntry,
  assertValidEntry,
  DEPLOY_LEDGER_CHANNELS,
  DEPLOY_LEDGER_JSON_PATH,
  DEPLOY_LEDGER_MD_PATH,
  entryIdentityKey,
  main,
  previousShipSha,
  renderLedgerMarkdown,
  sameShaBatchLeader,
  sameShaCompanionChangelog,
  validateEntry,
} from '../deploy-ledger.mjs';

const A_SHA = 'a'.repeat(40);
const B_SHA = 'b'.repeat(40);
const C_SHA = 'c'.repeat(40);
const REPO_ROOT = resolve(import.meta.dirname, '../..');

// Past dates: validateEntry rejects future timestamps beyond clock skew
// (review LOW-1), so fixtures must be unambiguously in the past.
function entry(overrides = {}) {
  return {
    timestampUtc: '2026-08-20T09:00:00Z',
    channel: 'nightly-android',
    version: '0.1.2-nightly.2431',
    sha: A_SHA,
    workflowRunUrl: 'https://github.com/kontourai/station/actions/runs/1',
    artifacts: [
      'play-internal-aab:io.kontourai.station.nightly@versionCode 243100',
    ],
    gateResult: 'nightly test-gate success (station#4539)',
    notes: null,
    changelog: {
      previousSha: null,
      groups: { feat: [], fix: [], ci: [], docs: [], other: [] },
      note: 'First recorded entry for this channel; no previous ship SHA exists in the ledger, so no changelog slice was derived.',
      commitCount: 0,
    },
    ...overrides,
  };
}

describe('deploy ledger entry validation', () => {
  it('accepts a complete entry and nulls for unverifiable fields', () => {
    expect(validateEntry(entry())).toEqual({ ok: true, errors: [] });
    expect(validateEntry(entry({ workflowRunUrl: null, notes: null }))).toEqual(
      { ok: true, errors: [] },
    );
  });

  it('rejects malformed shas — the field the whole ledger pivots on', () => {
    for (const bad of [
      'short',
      `${'A'.repeat(40)}`,
      'g'.repeat(40),
      '123',
      '',
      null,
      42,
    ]) {
      const { ok, errors } = validateEntry(entry({ sha: bad }));
      expect(ok).toBe(false);
      expect(errors.join('\n')).toMatch(/sha must be 40 lowercase hex/);
    }
  });

  it('rejects unknown channels, empty versions, and bad timestamps', () => {
    expect(validateEntry(entry({ channel: 'beta-web' })).ok).toBe(false);
    expect(validateEntry(entry({ channel: null })).ok).toBe(false);
    expect(validateEntry(entry({ version: '' })).ok).toBe(false);
    expect(validateEntry(entry({ version: ' ' })).ok).toBe(false);
    for (const bad of [
      '2026-08-20T09:00:00', // no Z — wall clock, not UTC
      '2026-08-20 09:00:00Z',
      'not-a-dateZ',
      '',
    ]) {
      expect(validateEntry(entry({ timestampUtc: bad })).ok).toBe(false);
    }
  });

  it('rejects future timestamps beyond clock skew (LOW-1)', () => {
    const future = new Date(Date.now() + 60 * 60_000)
      .toISOString()
      .replace(/\.\d{3}Z$/, 'Z');
    const { ok, errors } = validateEntry(entry({ timestampUtc: future }));
    expect(ok).toBe(false);
    expect(errors.join('\n')).toMatch(/in the future/);
    // Within skew (a workflow clock a moment behind) is accepted.
    const slight = new Date(Date.now() + 60_000)
      .toISOString()
      .replace(/\.\d{3}Z$/, 'Z');
    expect(validateEntry(entry({ timestampUtc: slight })).ok).toBe(true);
  });

  it('rejects parse-artifact versions with a teaching message (HIGH-1)', () => {
    // The exact artifact the review produced by text-splitting the
    // changesets action's JSON-array output.
    const artifact = 'kontourai/station-cli","version":"0.4.1"}]';
    const { ok, errors } = validateEntry(entry({ version: artifact }));
    expect(ok).toBe(false);
    expect(errors.join('\n')).toMatch(/parse artifact/);
    expect(errors.join('\n')).toMatch(/parse-published-packages/);
    for (const bad of ['1.0.0"', "1.0.0'}", '0.4.1"]', '1.0.0,2.0.0', 'a\tb']) {
      expect(validateEntry(entry({ version: bad })).ok).toBe(false);
    }
    // Real channel-version shapes are accepted.
    for (const good of [
      '0.4.1',
      '1.2.3-beta.1',
      '0.1.2-nightly.2430',
      '1.0.0-alpha+build.5',
    ]) {
      expect(validateEntry(entry({ version: good })).ok).toBe(true);
    }
  });

  it('rejects empty artifact lists and non-https run urls', () => {
    expect(validateEntry(entry({ artifacts: [] })).ok).toBe(false);
    expect(validateEntry(entry({ artifacts: [''] })).ok).toBe(false);
    expect(validateEntry(entry({ artifacts: 'one string' })).ok).toBe(false);
    for (const bad of ['http://insecure', 'github.com/x', '']) {
      expect(validateEntry(entry({ workflowRunUrl: bad })).ok).toBe(false);
    }
  });

  it('requires a gate verdict sentence and well-formed notes', () => {
    expect(validateEntry(entry({ gateResult: '' })).ok).toBe(false);
    expect(validateEntry(entry({ gateResult: null })).ok).toBe(false);
    expect(validateEntry(entry({ notes: [''] })).ok).toBe(false);
    expect(validateEntry(entry({ notes: ['ok', ''] })).ok).toBe(false);
    expect(validateEntry(entry({ notes: ['honest caveat'] })).ok).toBe(true);
  });

  it('throws with every offending field listed', () => {
    expect(() =>
      assertValidEntry(entry({ sha: 'x', channel: 'nope' })),
    ).toThrow(/channel must be one of[\s\S]*sha must be 40 lowercase hex/);
  });
});

describe('deploy ledger append semantics', () => {
  it('prepends newest-first', () => {
    const older = entry({ version: '0.1.2-nightly.2430', sha: B_SHA });
    const newer = entry({});
    const ledger = appendEntry(appendEntry([], older), newer);
    expect(ledger.map((e) => e.version)).toEqual([
      '0.1.2-nightly.2431',
      '0.1.2-nightly.2430',
    ]);
  });

  it('refuses to re-record an identical ship', () => {
    const ledger = appendEntry([], entry());
    expect(() => appendEntry(ledger, entry())).toThrow(/already records/);
    // MED-5: identity is channel|sha|version ONLY. A re-run with fewer
    // artifacts (the nightly's workflow-artifact line is conditional on a
    // step outcome) is the same ship and must refuse, not double-record.
    expect(() =>
      appendEntry(ledger, entry({ artifacts: ['npm:other@1.0.0'] })),
    ).toThrow(/already records/);
    // A different version at the same sha is a different record (the
    // multi-package publish shape).
    expect(() =>
      appendEntry(ledger, entry({ version: '0.1.2-nightly.2432' })),
    ).not.toThrow();
  });

  it('keys identity on channel, sha, and version — never artifacts', () => {
    expect(entryIdentityKey(entry())).toBe(entryIdentityKey(entry()));
    expect(entryIdentityKey(entry({ sha: B_SHA }))).not.toBe(
      entryIdentityKey(entry()),
    );
    expect(entryIdentityKey(entry({ artifacts: ['different'] }))).toBe(
      entryIdentityKey(entry()),
    );
  });
});

describe('deploy ledger rendered source link', () => {
  it('keeps the stable JSON label while linking to its sibling file', () => {
    const markdown = renderLedgerMarkdown({
      entries: [entry()],
      githubRepo: 'kontourai/station',
    });
    expect(markdown).toContain(
      `[\`${DEPLOY_LEDGER_JSON_PATH}\`](deploy-ledger.json)`,
    );
  });

  it('keeps the checked-in Markdown byte-identical to the JSON projection', () => {
    const entries = JSON.parse(
      readFileSync(resolve(REPO_ROOT, DEPLOY_LEDGER_JSON_PATH), 'utf8'),
    );
    expect(
      renderLedgerMarkdown({ entries, githubRepo: 'kontourai/station' }),
    ).toBe(readFileSync(resolve(REPO_ROOT, DEPLOY_LEDGER_MD_PATH), 'utf8'));
  });
});

describe('same-sha batch companions (MED-3)', () => {
  it('finds the batch leader and omits the slice on companions', () => {
    const leader = entry({
      channel: 'stable-npm',
      version: '0.4.1',
      sha: C_SHA,
    });
    expect(sameShaBatchLeader([leader], 'stable-npm', C_SHA)).toBe(leader);
    expect(sameShaBatchLeader([leader], 'stable-npm', A_SHA)).toBeNull();
    expect(sameShaBatchLeader([leader], 'nightly-npm', C_SHA)).toBeNull();
    const companion = sameShaCompanionChangelog(leader, C_SHA);
    expect(companion.previousSha).toBeNull();
    expect(companion.commitCount).toBe(0);
    expect(companion.note).toMatch(/same-sha companion of stable-npm 0\.4\.1/);
    expect(companion.note).toMatch(/ccccccc/);
    for (const group of Object.values(companion.groups)) {
      expect(group).toEqual([]);
    }
  });

  it('gives the second package of a two-package publish the omission note', () => {
    const directory = mkdtempSync(join(tmpdir(), 'station-deploy-ledger-'));
    const scratch = {
      json: join(directory, 'deploy-ledger.json'),
      md: join(directory, 'deploy-ledger.md'),
    };
    const base = [
      '--channel',
      'stable-npm',
      '--sha',
      C_SHA,
      '--timestamp',
      '2026-08-20T09:00:00Z',
      '--workflow-run-url',
      'https://github.com/kontourai/station/actions/runs/2',
      '--gate-result',
      'npm trusted-publisher OIDC preflight success',
      '--github-repo',
      'kontourai/station',
      '--ledger-json',
      scratch.json,
      '--ledger-md',
      scratch.md,
    ];
    // Package 1: first stable-npm entry at this sha — carries the
    // first-entry changelog note (previous ship lookup finds none).
    expect(
      main([
        ...base,
        '--version',
        '0.4.1',
        '--artifact',
        'npm:@kontourai/station-cli@0.4.1 (dist-tag latest)',
      ]),
    ).toBe(0);
    // Package 2: same sha, same channel, different version — companion.
    expect(
      main([
        ...base,
        '--version',
        '0.2.1',
        '--artifact',
        'npm:@kontourai/station-shared@0.2.1 (dist-tag latest)',
      ]),
    ).toBe(0);
    const ledger = JSON.parse(readFileSync(scratch.json, 'utf8')) as Array<{
      version: string;
      changelog: { note: string | null };
    }>;
    expect(ledger.map((e) => e.version)).toEqual(['0.2.1', '0.4.1']);
    expect(ledger[1].changelog.note).toMatch(/First recorded entry/);
    expect(ledger[0].changelog.note).toMatch(
      /same-sha companion of stable-npm 0\.4\.1/,
    );
    // The rendered markdown carries the companion note visibly.
    const md = readFileSync(scratch.md, 'utf8');
    expect(md).toMatch(/Changelog slice omitted.*0\.4\.1/);
  });
});

describe('previous ship lookup', () => {
  it('finds the previous same-channel ship with a different sha', () => {
    const ledger = [
      entry({ channel: 'nightly-npm', sha: A_SHA }),
      entry({ channel: 'nightly-android', sha: A_SHA }),
      entry({ channel: 'nightly-android', sha: B_SHA }),
    ];
    expect(previousShipSha(ledger, 'nightly-android', C_SHA)).toBe(A_SHA);
    // Same-sha entries (multi-package publish) are skipped, not "previous".
    expect(previousShipSha(ledger, 'nightly-npm', A_SHA)).toBeNull();
    expect(previousShipSha(ledger, 'stable-desktop', A_SHA)).toBeNull();
  });
});

describe('markdown regeneration', () => {
  it('renders identical bytes on repeated regeneration', () => {
    const entries = [
      entry(),
      entry({ sha: B_SHA, version: '0.1.2-nightly.2430' }),
    ];
    const first = renderLedgerMarkdown({
      entries,
      githubRepo: 'kontourai/station',
    });
    const second = renderLedgerMarkdown({
      entries: JSON.parse(JSON.stringify(entries)),
      githubRepo: 'kontourai/station',
    });
    expect(first).toBe(second);
  });

  it('documents the public raw JSON source and schema (MED-8)', () => {
    const markdown = renderLedgerMarkdown({
      entries: [entry()],
      githubRepo: 'kontourai/station',
    });
    expect(markdown).toContain(DEPLOY_LEDGER_JSON_PATH);
    expect(markdown).toContain(
      'https://raw.githubusercontent.com/kontourai/station/main/docs/reference/deploy-ledger.json',
    );
    expect(markdown).toMatch(/public repository/);
    expect(markdown).toMatch(/without authentication/);
    // The site controls its transport and presentation, while the ledger
    // remains the source-generated input.
    expect(markdown).toContain('archive#4572');
    expect(markdown).not.toContain('station#4572');
    expect(markdown).toMatch(/site PR decides/);
    expect(markdown).toMatch(/reads that URL directly or copies the JSON/);
    for (const channel of DEPLOY_LEDGER_CHANNELS) {
      expect(markdown).toContain(`\`${channel}\``);
    }
    for (const field of [
      'timestampUtc',
      'workflowRunUrl',
      'artifacts',
      'gateResult',
      'changelog',
    ]) {
      expect(markdown).toContain(`\`${field}\``);
    }
  });

  it('renders the table newest-first and escapes pipes in cells', () => {
    const entries = [
      entry({ gateResult: 'a | b' }),
      entry({ sha: B_SHA, version: '0.1.2-nightly.2430' }),
    ];
    const markdown = renderLedgerMarkdown({
      entries,
      githubRepo: 'kontourai/station',
    });
    const table = markdown
      .split('\n')
      .filter((line) => line.startsWith('| 2026-'));
    expect(table).toHaveLength(2);
    expect(table[0]).toContain('0.1.2-nightly.2431');
    expect(table[0]).toContain('a \\| b');
    expect(table[1]).toContain('0.1.2-nightly.2430');
  });

  it('renders changelog groups under their entry', () => {
    const withSlice = entry({
      changelog: {
        previousSha: B_SHA,
        groups: {
          feat: [
            '[#4566](https://github.com/kontourai/station/pull/4566) feat(ci): x',
          ],
          fix: [],
          ci: [],
          docs: [],
          other: [],
        },
        note: null,
        commitCount: 1,
      },
    });
    const markdown = renderLedgerMarkdown({
      entries: [withSlice],
      githubRepo: 'kontourai/station',
    });
    expect(markdown).toContain('**Features**');
    expect(markdown).toContain(
      '- [#4566](https://github.com/kontourai/station/pull/4566) feat(ci): x',
    );
    expect(markdown).toContain('Commits since `bbbbbbb`');
  });
});

describe('per-package identity (multi-package npm publishes)', () => {
  const base = {
    timestampUtc: '2026-08-28T16:00:00Z',
    channel: 'stable-npm',
    version: '0.7.0',
    sha: 'b4fe42e5cc089fc95f8f513d549d78b82f198d96',
    workflowRunUrl: null,
    artifacts: ['npm:probe'],
    gateResult: 'probe',
    notes: null,
    changelog: null,
  };

  it('two packages sharing version and sha from one publish both record', () => {
    let entries: unknown[] = [];
    entries = appendEntry(
      entries as never,
      {
        ...base,
        package: '@kontourai/station-contracts',
      } as never,
    );
    entries = appendEntry(
      entries as never,
      {
        ...base,
        package: '@kontourai/station-sdk',
      } as never,
    );
    expect(entries).toHaveLength(2);
  });

  it('the same package at the same version and sha is refused as a re-record', () => {
    const entries = appendEntry(
      [] as never,
      {
        ...base,
        package: '@kontourai/station-sdk',
      } as never,
    );
    expect(() =>
      appendEntry(
        entries as never,
        {
          ...base,
          package: '@kontourai/station-sdk',
        } as never,
      ),
    ).toThrow(/already records this ship/);
  });

  it('a malformed package name is refused with a teaching message', () => {
    const verdict = validateEntry({
      ...base,
      package: 'Not A Package!!',
    } as never);
    expect(verdict.ok).toBe(false);
    expect(verdict.errors.join(' ')).toMatch(
      /package must be an npm package name/,
    );
  });
});

describe('the CLI boundary', () => {
  function scratchLedger() {
    const directory = mkdtempSync(join(tmpdir(), 'station-deploy-ledger-'));
    return {
      directory,
      json: join(directory, 'deploy-ledger.json'),
      md: join(directory, 'deploy-ledger.md'),
    };
  }

  function argvFor(
    scratch: { json: string; md: string },
    overrides: string[] = [],
  ) {
    return [
      '--channel',
      'stable-npm',
      '--version',
      '0.6.1',
      '--sha',
      C_SHA,
      '--timestamp',
      '2026-08-20T09:05:00Z',
      '--workflow-run-url',
      'https://github.com/kontourai/station/actions/runs/2',
      '--gate-result',
      'npm trusted-publisher OIDC preflight success',
      '--github-repo',
      'kontourai/station',
      '--artifact',
      'npm:@kontourai/station-cli@0.6.1 (dist-tag latest)',
      '--ledger-json',
      scratch.json,
      '--ledger-md',
      scratch.md,
      ...overrides,
    ];
  }

  it('writes JSON and markdown and exits zero; rerender is idempotent', () => {
    const scratch = scratchLedger();
    expect(main(argvFor(scratch))).toBe(0);
    const json = readFileSync(scratch.json, 'utf8');
    const md = readFileSync(scratch.md, 'utf8');
    expect(JSON.parse(json)).toHaveLength(1);
    expect(md).toContain('0.6.1');
    expect(md).toContain('stable-npm');
    expect(readdirSync(scratch.directory).sort()).toEqual([
      'deploy-ledger.json',
      'deploy-ledger.md',
    ]);
    // The markdown must be a pure projection: rendering the JSON we just
    // wrote reproduces the file byte for byte.
    expect(
      renderLedgerMarkdown({
        entries: JSON.parse(json),
        githubRepo: 'kontourai/station',
      }),
    ).toBe(md);
  });

  it('appends to an existing ledger newest-first', () => {
    const scratch = scratchLedger();
    // Same sha, different package version — the multi-package publish
    // shape; the previous-ship lookup skips same-sha entries, so this stays
    // hermetic (no git range derivation for a same-sha append).
    writeFileSync(
      scratch.json,
      JSON.stringify([
        entry({
          channel: 'stable-npm',
          sha: C_SHA,
          version: '0.2.1',
          artifacts: ['npm:@kontourai/station-shared@0.2.1 (dist-tag latest)'],
        }),
      ]),
    );
    expect(main(argvFor(scratch))).toBe(0);
    const ledger = JSON.parse(readFileSync(scratch.json, 'utf8')) as Array<{
      version: string;
    }>;
    expect(ledger.map((e) => e.version)).toEqual(['0.6.1', '0.2.1']);
  });

  it('fails loud on an invalid ship and writes nothing', () => {
    const scratch = scratchLedger();
    expect(main(argvFor(scratch, ['--sha', 'not-a-sha']))).toBe(1);
    expect(readdirSync(scratch.directory)).toEqual([]);
  });

  it('fails loud on a duplicate ship', () => {
    const scratch = scratchLedger();
    expect(main(argvFor(scratch))).toBe(0);
    expect(main(argvFor(scratch))).toBe(1);
  });

  it('fails loud on missing required arguments', () => {
    expect(main(['--channel', 'nightly-android'])).toBe(1);
    expect(main([])).toBe(1);
  });
});
