import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  STATION_DOCS_CONTENT_DIGEST,
  STATION_DOCS_TOPICS,
} from '../../src-server/tools/station-docs-content.js';
import {
  learningHref,
  renderLearningDocument,
} from '../build-learning-guide.mjs';
import { INDEXED_DIRECTORIES } from '../docs-index.mjs';
import {
  compileStationDocs,
  readStationDocsInputs,
  stationDocsDigest,
} from '../generate-station-docs.mjs';
import {
  documentSections,
  extractModules,
  validateCatalog,
} from '../lib/documentation-model.mjs';

// docs/README.md indexed roughly half the docs tree when this was written —
// 17 ADRs and eight whole directories were unreachable from the map that calls
// itself the map. Directory-level reachability is enforced here (the README
// stays curated prose); file-level completeness for the two drift-prone
// directories is enforced by the generated docs-index blocks.

function tracked(args: string[]): string[] {
  return execFileSync('git', ['ls-files', '--', ...args], {
    encoding: 'utf8',
    windowsHide: true,
  })
    .split('\n')
    .filter(Boolean);
}

describe('docs index reachability', () => {
  const index = readFileSync('docs/README.md', 'utf8');

  it('mentions every top-level docs/ directory', () => {
    const directories = new Set(
      tracked(['docs'])
        .map((path) => path.split('/'))
        .filter((parts) => parts.length > 2)
        .map((parts) => parts[1]),
    );
    expect(directories.size).toBeGreaterThan(10);
    for (const directory of directories) {
      expect(index, `docs/README.md never mentions docs/${directory}/`).toMatch(
        new RegExp(`\\(${directory}/`),
      );
    }
  });

  it('links every root-level docs/*.md', () => {
    const roots = tracked(['docs/*.md'])
      .filter((path) => path.split('/').length === 2)
      .map((path) => path.slice('docs/'.length))
      .filter((name) => name !== 'README.md');
    expect(roots.length).toBeGreaterThan(3);
    for (const name of roots) {
      expect(index, `docs/README.md never links docs/${name}`).toContain(
        `(${name})`,
      );
    }
  });

  it('the generated per-directory indexes match their tracked files', () => {
    // Regenerate-and-diff, as a real child process so the npm entry point and
    // its non-zero drift exit are proven, not just the pure functions.
    const result = execFileSync('node', ['scripts/docs-index.mjs', '--check'], {
      encoding: 'utf8',
      windowsHide: true,
    });
    expect(result).toBe('');
  });

  it('both indexed READMEs still carry their marker blocks', () => {
    for (const directory of INDEXED_DIRECTORIES) {
      const body = readFileSync(`${directory}/README.md`, 'utf8');
      expect(
        body,
        `${directory}/README.md lost its docs-index block`,
      ).toContain('docs-index:start');
    }
  });
});

describe('learning atlas', () => {
  it('keeps example headings inside code fences out of the navigation tree', () => {
    const source =
      '## Boundary\n\n```markdown\n## Example only\n```\n\n~~~md\n## Another example\n~~~\n\n## Recovery\n\nRefuse stale work.';
    expect(
      documentSections(source).map(
        (section: { title: string }) => section.title,
      ),
    ).toEqual(['Boundary', 'Recovery']);
    expect(documentSections(source)[0].body).toContain('## Example only');
  });
  it('ships the exact canonical prose and tree through the credential-free MCP', async () => {
    const compiled = await readStationDocsInputs();
    expect(STATION_DOCS_TOPICS).toEqual(compiled);
    expect(STATION_DOCS_CONTENT_DIGEST).toBe(stationDocsDigest(compiled));
    const changed = structuredClone(compiled);
    changed[0].body += '\nChanged behavior.';
    expect(stationDocsDigest(changed)).not.toBe(STATION_DOCS_CONTENT_DIGEST);
  });

  it('rejects missing or uncatalogued shipped prose instead of silently omitting it', () => {
    const catalog = {
      version: 1,
      source: 'docs/reference/station-docs.md',
      topics: [
        {
          id: 'start',
          title: 'Start',
          section: 'Start',
          summary: 'Starting',
          tags: ['start'],
        },
      ],
    };
    const atlas = {
      version: 1,
      groups: [
        {
          id: 'execution',
          title: 'Execution',
          summary: 'Run work',
          docs: ['docs/architecture/module-map.md'],
          modules: ['StartBoundary'],
          questions: ['Who owns start?'],
        },
      ],
    };
    const modules = '## StartBoundary\n\nAccepts or refuses a start.';
    expect(() =>
      compileStationDocs('# Manual', catalog, modules, atlas),
    ).toThrow('Missing shipped-documentation section');
    expect(() =>
      compileStationDocs(
        '## Start\n\nRun work.\n\n## Uncatalogued\n\nLost prose.',
        catalog,
        modules,
        atlas,
      ),
    ).toThrow('Uncatalogued shipped sections');
    const topics = compileStationDocs(
      '## Start\n\nRun work.',
      catalog,
      modules,
      atlas,
    );
    expect(topics[0].body).toBe('Run work.');
    expect(
      topics.find(
        (topic: { id: string }) => topic.id === 'architecture-startboundary',
      )?.body,
    ).toContain('Accepts or refuses a start.');
  });
  it('assigns every actual module exactly once and keeps its reading documents tracked', () => {
    const catalog = JSON.parse(readFileSync('docs/learn/atlas.json', 'utf8'));
    const modules = extractModules(
      readFileSync('docs/architecture/module-map.md', 'utf8'),
    );
    const files = new Set(tracked(['*.md', '*.mdx', '*.markdown']));
    expect(() => validateCatalog(catalog, modules, files)).not.toThrow();
    expect(() =>
      validateCatalog(
        catalog,
        [...modules, { title: 'New unassigned boundary' }],
        files,
      ),
    ).toThrow('missing from learning tree');
    expect(() => validateCatalog(catalog, modules, new Set())).toThrow(
      'Untracked learning document',
    );
    const duplicate = structuredClone(catalog);
    duplicate.groups[1].modules.push(duplicate.groups[0].modules[0]);
    expect(() => validateCatalog(duplicate, modules, files)).toThrow(
      'Multiply assigned module',
    );
    const unknown = structuredClone(catalog);
    unknown.groups[0].modules.push('Removed boundary');
    expect(() => validateCatalog(unknown, modules, files)).toThrow(
      'Unknown module',
    );
  });

  it('keeps Markdown links in the reader while source links use the recorded revision', () => {
    const files = new Set(['docs/guide.md', 'README.md', 'docs/café notes.md']);
    expect(
      learningHref('../README.md#setup', 'docs/guide.md', files, 'abc'),
    ).toBe('#doc=README.md&section=setup');
    expect(learningHref('#same-page', 'docs/guide.md', files, 'abc')).toBe(
      '#doc=docs%2Fguide.md&section=same-page',
    );
    expect(
      learningHref('caf%C3%A9%20notes.md', 'docs/guide.md', files, 'abc'),
    ).toBe('#doc=docs%2Fcaf%C3%A9%20notes.md');
    expect(
      learningHref('../src-server/index.ts', 'docs/guide.md', files, 'abc'),
    ).toBe('https://github.com/kontourai/station/blob/abc/src-server/index.ts');
    expect(learningHref('../../outside', 'docs/guide.md', files, 'abc')).toBe(
      '',
    );
    expect(
      learningHref('javascript:alert(1)', 'docs/guide.md', files, 'abc'),
    ).toBe('');
    expect(
      learningHref('https://example.com/guide', 'docs/guide.md', files, 'abc'),
    ).toBe('https://example.com/guide');
  });

  it('renders useful Markdown, duplicate heading anchors, and inert raw HTML', () => {
    const rendered = renderLearningDocument(
      '# Guide\n\n## Recovery\n\n## Recovery\n\n| State | Meaning |\n| --- | --- |\n| Pending | Not complete |\n\n<script>alert(1)</script>\n\n[Unsafe](javascript:alert)\n\n```mermaid\ngraph LR\nA-->B\n```',
      'docs/guide.md',
      new Set(['docs/guide.md']),
      'abc',
    );
    expect(
      rendered.headings.map((heading: { id: string }) => heading.id),
    ).toEqual(['guide', 'recovery', 'recovery-1']);
    expect(rendered.html).toContain('<table>');
    expect(rendered.html).not.toContain('<script>');
    expect(rendered.html).not.toContain('href="javascript:');
    expect(rendered.html).toContain('Diagram source');
    expect(rendered.html).toContain('A--&gt;B');
  });
});
