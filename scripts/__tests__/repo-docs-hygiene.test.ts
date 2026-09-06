import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { evaluate, findingsFor, trackedDocs } from '../repo-docs-hygiene.mjs';

const read = (fixtures: Record<string, string>) => (file: string) =>
  fixtures[file] ?? '';

describe('repo docs hygiene', () => {
  it('does not mistake a settings filename for a private DNS suffix while retaining real local hosts', () => {
    expect(
      findingsFor(
        ['docs/settings.md'],
        read({
          'docs/settings.md':
            'Use `.claude/settings.local.json` and `config.internal.json`.',
        }),
      ).size,
    ).toBe(0);
    for (const host of [
      'printer.local',
      'printer.local.',
      'https://service.internal:8443/',
      'host.home.arpa',
    ]) {
      const { failures } = evaluate({
        byFile: findingsFor(['docs/host.md'], read({ 'docs/host.md': host })),
        grandfathered: [],
      });
      expect(failures.join('\n')).toContain('private-hostname');
    }
  });

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
