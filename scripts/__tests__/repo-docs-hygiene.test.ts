import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { evaluate, findingsFor, trackedDocs } from '../repo-docs-hygiene.mjs';

const read = (fixtures: Record<string, string>) => (file: string) =>
  fixtures[file] ?? '';

describe('repo docs hygiene', () => {
  it('flags a real machine name, path, and mailbox in a non-grandfathered doc', () => {
    const byFile = findingsFor(
      ['docs/new.md'],
      read({
        'docs/new.md':
          'Deploy on brian-media under /Users/brian/dev and mail me at someone.private@gmail.com',
      }),
    );
    const { failures } = evaluate({ byFile, grandfathered: [] });
    expect(failures.join('\n')).toContain('private-hostname: brian-media');
    expect(failures.join('\n')).toContain('absolute-developer-path');
    expect(failures.join('\n')).toContain('personal-mailbox');
  });

  it('treats loopback and placeholder tailnet values as documentation, not disclosure', () => {
    const byFile = findingsFor(
      ['docs/new.md'],
      read({
        'docs/new.md':
          'Serve on localhost via http://127.0.0.1:3141 and pair at example.ts.net',
      }),
    );
    expect(byFile.size).toBe(0);
  });

  // The deploy ledger writes git SHAs; ~1 in 128 start with fc/fd, and the
  // ULA branch once matched any colon-free hex run with that prefix. A ULA is
  // derived from the literal's shape (fc00::/7 first group, then a colon).
  const SHA = 'fd2c04e8632d40e6e9c53dd13a558a1764375800';
  const privateIpControls: [value: string, flagged: boolean][] = [
    ['fd12:3456:789a::1', true],
    ['fc00::1', true],
    ['fd00:1234:5678:9abc:def0:1234:5678:9abc', true],
    ['10.1.2.3', true],
    ['172.16.0.1', true],
    ['fe80::1', false],
    ['192.168.1.1', false],
    [SHA, false],
    [SHA.slice(0, 7), false],
    ['fc9a1b2c3d4e5f60718293a4b5c6d7e8f9a0b1c2', false],
    ['fc7', false],
    ['fdisk', false],
    ['RFD:', false],
    ['fd:', false],
    ['fcA1b2C3d4E5f6G7h8==', false],
  ];
  it.each(privateIpControls)(
    'private-ip control %s -> flagged=%s',
    (value, flagged) => {
      for (const wrap of [(v: string) => v, (v: string) => `\`${v}\``]) {
        const findings = findingsFor(
          ['docs/new.md'],
          read({ 'docs/new.md': `Ship SHA / address: ${wrap(value)} done.` }),
        );
        const lines: string[] = findings.get('docs/new.md') ?? [];
        const privateIp = lines.filter((line) => line.includes('private-ip'));
        expect(privateIp, `wrapped as ${wrap(value)}`).toHaveLength(
          flagged ? 1 : 0,
        );
        if (flagged) expect(privateIp[0]).toContain(value);
      }
    },
  );

  it('a doc carrying a fc/fd git SHA has no private-ip finding; one carrying a ULA has exactly one', () => {
    const ledger = [
      '| 2026-09-08T17:23:06Z | nightly-desktop | 0.1.11-nightly.2442.5 | `fd2c04e` | complete |',
      '',
      `- Ship SHA: \`${SHA}\``,
      `- Source: https://github.com/kontourai/station/commit/${SHA}`,
    ].join('\n');
    expect(
      findingsFor(['docs/ledger.md'], read({ 'docs/ledger.md': ledger })).size,
    ).toBe(0);
    const ula = findingsFor(
      ['docs/net.md'],
      read({ 'docs/net.md': 'Bind the node at `fd12:3456::1` and `fd2c04e`.' }),
    );
    expect(ula.get('docs/net.md')).toEqual([
      'docs/net.md:1 private-ip: `fd12:3456::1',
    ]);
  });

  it('distinguishes a filename suffix from a complete private hostname', () => {
    expect(
      findingsFor(
        ['docs/new.md'],
        read({
          'docs/new.md':
            'Use `.claude/settings.local.json` and settings.internal.json.',
        }),
      ).size,
    ).toBe(0);
    for (const host of [
      'settings.local',
      'build.internal',
      'node.corp',
      'node.lan',
      'node.home.arpa',
    ]) {
      const findings = findingsFor(
        ['docs/new.md'],
        read({
          'docs/new.md': `Connect to https://${host}:443/path or ${host}.`,
        }),
      );
      expect(
        evaluate({ byFile: findings, grandfathered: [] }).failures.join('\n'),
      ).toContain(`private-hostname: ${host}`);
    }
  });

  it('reads a hex SHA starting fc/fd as a SHA, and a ULA literal as an address', () => {
    // The generated deploy ledger records every ship SHA; one starting `fd`
    // read as a ULA and failed the sweep (#1810). An address needs IPv6
    // syntax — a first group of at most four hex digits, then a colon.
    for (const [label, text] of [
      ['full ship SHA', 'Ship SHA: `fd2c04e8632d40e6e9c53dd13a558a1764375800`'],
      ['short ship SHA', 'Ship SHA: `fd2c04e` in the ledger table'],
      ['short SHA starting fc', 'Reverted `fc1a2b3c4d5e` last night'],
      [
        'SHA in a URL path',
        'See https://example.com/commit/fdbeef1234567890abcdef1234567890abcdef12/log',
      ],
      [
        'short SHA starting fe8 leading a commit subject',
        'fe8abc1: fix the thing (the link-local branch, same shape)',
      ],
    ] as const) {
      const byFile = findingsFor(
        ['docs/new.md'],
        read({ 'docs/new.md': text }),
      );
      expect(
        [...byFile.values()].flat(),
        `${label} must not read as a private address`,
      ).toEqual([]);
    }
    // Positive control: the same branch still catches a real ULA literal, so
    // the negatives above are a narrowed rule and not a disabled one.
    const ula = findingsFor(
      ['docs/new.md'],
      read({
        'docs/new.md': 'The peer answers on fd12:3456::1 over the mesh.',
      }),
    );
    expect(
      evaluate({ byFile: ula, grandfathered: [] }).failures.join('\n'),
    ).toContain('private-ip: fd12:3456::1');
    const linkLocal = findingsFor(
      ['docs/new.md'],
      // `fe80:` itself is benign for the repo sweep (the guard in
      // repo-docs-hygiene.mjs), so the control sits elsewhere in fe80::/10.
      read({ 'docs/new.md': 'The bridge listens on fe9a:1234::1 for peers.' }),
    );
    expect(
      evaluate({ byFile: linkLocal, grandfathered: [] }).failures.join('\n'),
    ).toContain('private-ip: fe9a:1234::1');
  });

  it('a grandfathered file holds exactly its pinned findings without failing', () => {
    const byFile = findingsFor(
      ['docs/old.md'],
      read({ 'docs/old.md': 'lives on brian-media' }),
    );
    const { failures, stale } = evaluate({
      byFile,
      grandfathered: [{ file: 'docs/old.md', findings: 1 }],
    });
    expect(failures).toEqual([]);
    expect(stale).toEqual([]);
  });

  it('a NEW finding in an allowlisted file fails — the pin is a count, not a blanket', () => {
    const byFile = findingsFor(
      ['docs/old.md'],
      read({
        'docs/old.md': 'lives on brian-media, now also on desktop-win',
      }),
    );
    const { failures } = evaluate({
      byFile,
      grandfathered: [{ file: 'docs/old.md', findings: 1 }],
    });
    expect(failures.join('\n')).toContain('allowlist pins 1');
    expect(failures.join('\n')).toContain('desktop-win');
  });

  it('an entry whose file is clean, or whose count dropped, is stale — the list only shrinks', () => {
    const gone = evaluate({
      byFile: findingsFor(
        ['docs/cleaned.md'],
        read({ 'docs/cleaned.md': 'nothing private here' }),
      ),
      grandfathered: [{ file: 'docs/cleaned.md', findings: 2 }],
    });
    expect(gone.stale.join('\n')).toContain('docs/cleaned.md');
    const shrunk = evaluate({
      byFile: findingsFor(
        ['docs/old.md'],
        read({ 'docs/old.md': 'lives on brian-media' }),
      ),
      grandfathered: [{ file: 'docs/old.md', findings: 2 }],
    });
    expect(shrunk.stale.join('\n')).toContain('shrink the entry');
  });

  it('the checked-in grandfather list matches the tree exactly (both directions), via the real entry point', () => {
    const out = execFileSync('node', ['scripts/repo-docs-hygiene.mjs'], {
      encoding: 'utf8',
      windowsHide: true,
    });
    expect(out).toContain('Repo docs hygiene passed');
    // The catch log is a .jsonl record and MUST be in sweep scope — it is
    // published, and it once carried a machine name the md-only sweep missed.
    expect(trackedDocs()).toContain('docs/strategy/catches/catches.jsonl');
    const grandfathered = JSON.parse(
      readFileSync('scripts/docs-hygiene-grandfather.json', 'utf8'),
    ) as { file: string; findings: number }[];
    expect(grandfathered.length).toBeGreaterThan(0);
    const files = grandfathered.map((entry) => entry.file);
    expect([...files].sort()).toEqual(files);
  });

  it('no public-projection document is ever allowlisted', async () => {
    // The public gate scans the manifest's documents and the repo gate scans
    // docs/**: a file in both blind spots would be unswept. Pin the invariant
    // that the sets never overlap.
    const { loadPublicDocs } = await import('../build-github-pages.mjs');
    const documents = (await loadPublicDocs()) as { source: string }[];
    const grandfathered = JSON.parse(
      readFileSync('scripts/docs-hygiene-grandfather.json', 'utf8'),
    ) as { file: string }[];
    const files = new Set(grandfathered.map((entry) => entry.file));
    for (const { source } of documents) {
      expect(files.has(`docs/${source}`)).toBe(false);
    }
  });
});
