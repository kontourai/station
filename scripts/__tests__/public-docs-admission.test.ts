import {
  lstat,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  loadPublicDocs,
  renderDocsIndexSections,
  renderInline,
  renderMarkdown,
} from '../build-github-pages.mjs';
import {
  marketingHygieneFindings,
  publicDocsHygieneFindings,
} from '../public-docs-hygiene.mjs';

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'station-public-docs-'));
  const manifestPath = path.join(root, 'pages', 'public-docs.json');
  await mkdir(path.join(root, 'pages'), { recursive: true });
  await mkdir(path.join(root, 'user'), { recursive: true });
  await writeFile(path.join(root, 'user', 'start.md'), '# Start\n');
  return { manifestPath, root };
}

async function writeManifest(manifestPath: string, document: unknown) {
  await writeFile(
    manifestPath,
    JSON.stringify({ schemaVersion: 1, documents: [document] }),
  );
}

describe('public documentation admission', () => {
  it('rejects untracked, odd, symlinked, and ancestor-escaping sources', async () => {
    const { manifestPath, root } = await fixture();
    const options = {
      isTracked: () => true,
      lstatPath: lstat,
      realpathPath: realpath,
      manifestPath,
      root,
    };
    try {
      await writeManifest(manifestPath, {
        section: 'Start',
        source: 'user/odd_name.md',
      });
      await expect(loadPublicDocs(options)).rejects.toThrow(
        'Invalid public docs source',
      );

      await writeManifest(manifestPath, {
        section: 'Start',
        source: 'user/start.md',
      });
      await expect(
        loadPublicDocs({ ...options, isTracked: () => false }),
      ).rejects.toThrow('not git-tracked');

      const outside = await mkdtemp(path.join(tmpdir(), 'station-outside-'));
      await writeFile(path.join(outside, 'outside.md'), '# Outside\n');
      await symlink(
        path.join(outside, 'outside.md'),
        path.join(root, 'user', 'link.md'),
      );
      await writeManifest(manifestPath, {
        section: 'Start',
        source: 'user/link.md',
      });
      await expect(loadPublicDocs(options)).rejects.toThrow('regular file');

      await mkdir(path.join(outside, 'nested'), { recursive: true });
      await writeFile(path.join(outside, 'nested', 'start.md'), '# Outside\n');
      await rm(path.join(root, 'user'), { recursive: true, force: true });
      await symlink(path.join(outside, 'nested'), path.join(root, 'user'));
      await writeManifest(manifestPath, {
        section: 'Start',
        source: 'user/start.md',
      });
      await expect(loadPublicDocs(options)).rejects.toThrow(
        'escapes docs root',
      );
      await rm(outside, { recursive: true, force: true });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('escapes public Markdown content before writing text or attributes', () => {
    const html = renderInline(
      '[<script>alert(1)</script>](" onmouseover="alert(1))',
    );
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('onmouseover="alert(1)');
    expect(renderInline('[unsafe](javascript:alert(1))')).toContain('href="#"');
    const index = renderDocsIndexSections([
      {
        description: '<script>alert(1)</script>',
        relativePath: 'user/start.md" onmouseover="alert(1)',
        section: '<script>section</script>',
        title: '<img src=x>',
      },
    ]);
    expect(index).toContain('&lt;Script&gt;Section&lt;/Script&gt;');
    expect(index).toContain('&lt;img src=x&gt;');
    expect(index).not.toContain('<script>');
    expect(index).not.toContain('onmouseover="alert(1)');
  });

  it('rejects the hostile path, private-host, private-IP, and provenance matrix', () => {
    const documents = [{ source: 'user/start.md' }, { source: 'guides/ok.md' }];
    const contents = new Map([
      [
        'docs/user/start.md',
        [
          '/Users/example',
          '/private/tmp/example',
          '/home/example',
          'C:/Users/example',
          'C:\\Users\\example',
          '\\\\server\\share\\example',
          '10.1.2.3',
          '100.64.0.0',
          '100.127.255.255',
          '172.16.2.3',
          '192.168.2.3',
          '169.254.2.3',
          '127.0.0.1',
          '::1',
          'fd00::1',
          'fe80::1',
          'febf::ffff',
          'host.internal',
          'host.corp',
          'host.local',
          'https://host.lan/guide',
          'http://host.home.arpa/status',
        ].join(' '),
      ],
      ['docs/guides/ok.md', 'This guide was adapted from a private source.'],
    ]);
    const findings = publicDocsHygieneFindings(
      documents,
      (file) => contents.get(file) ?? '',
    );
    expect(findings).toEqual(
      expect.arrayContaining([
        expect.stringContaining('absolute-developer-path'),
        expect.stringContaining('private-hostname'),
        expect.stringContaining('private-ip'),
        expect.stringContaining('source-provenance'),
      ]),
    );
    expect(
      publicDocsHygieneFindings(
        [{ source: 'guides/ok.md' }],
        () => 'Competitive research can inspire a better public explanation.',
      ),
    ).toEqual([]);
    expect(
      publicDocsHygieneFindings(
        [{ source: 'guides/ok.md' }],
        () =>
          'The values 100.64 and 100.127 are ordinary numeric prose; 100.63.255.255, 100.128.0.0, fe7f::1, fec0::1, and 203.0.113.7 are public controls.',
      ),
    ).toEqual([]);
  });

  it('keeps external product names out of marketing without blocking technical docs', () => {
    expect(
      marketingHygieneFindings(
        ['README.md'],
        () => 'Station works with Claude Code, Codex, and other engines.',
      ),
    ).toEqual([
      'README.md:1 marketing-external-brand: Claude Code',
      'README.md:1 marketing-external-brand: Codex',
    ]);
    expect(
      publicDocsHygieneFindings(
        [{ source: 'guides/connections.md' }],
        () => 'Configure a supported Codex engine connection.',
      ),
    ).toEqual([]);
  });
});

describe('public documentation markdown rendering', () => {
  it('keeps a source-wrapped paragraph and list item as one block each', () => {
    const html = renderMarkdown(
      [
        'Station uses a small set of concepts. Transport names stay out of',
        'the way unless setup requires them.',
        '',
        "- A **Station agent** is executed by Station's engine. Station owns its",
        '  prompt, skills, tools, commands, and Model choice.',
        '- An **External agent** is executed by another supported engine.',
        '',
        'Trailing prose.',
      ].join('\n'),
    );
    expect(html).toContain(
      '<p>Station uses a small set of concepts. Transport names stay out of the way unless setup requires them.</p>',
    );
    expect(html).toContain(
      "<li>A <strong>Station agent</strong> is executed by Station's engine. Station owns its prompt, skills, tools, commands, and Model choice.\n</li>",
    );
    expect(html.match(/<li>/g)).toHaveLength(2);
    expect(html.match(/<p>/g)).toHaveLength(2);
    expect(html).not.toContain('<p>the way unless setup requires them.</p>');
    expect(html).not.toContain('<p>prompt, skills');
  });

  it('closes an open list item at a heading, fence, table, or blockquote', () => {
    const html = renderMarkdown(
      [
        '- item one',
        '## Next',
        '- item two',
        '```',
        'code',
        '```',
        '- item three',
        '| a |',
        '| --- |',
        '| b |',
        '- item four',
        '> quoted',
      ].join('\n'),
    );
    expect(html.match(/<li>/g)).toHaveLength(4);
    expect(html.match(/<ul>/g)).toHaveLength(4);
    expect(html.match(/<\/ul>/g)).toHaveLength(4);
    expect(html).toContain('<h2>Next</h2>');
    expect(html).toContain('<blockquote>quoted</blockquote>');
  });

  it('nests indented list items inside their parent item', () => {
    const html = renderMarkdown(
      [
        '- parent',
        '  - child one',
        '    continues the child',
        '  - child two',
        '- sibling',
      ].join('\n'),
    );
    expect(html).toBe(
      [
        '<ul>',
        '<li>parent',
        '<ul>',
        '<li>child one continues the child',
        '</li>',
        '<li>child two',
        '</li>',
        '</ul>',
        '</li>',
        '<li>sibling',
        '</li>',
        '</ul>',
      ].join('\n'),
    );
  });

  it('renders an indented fence after a list item as code and keeps later prose out of the list', () => {
    const html = renderMarkdown(
      ['- item', '  ```js', '  const x = 1;', '  ```', 'After'].join('\n'),
    );
    expect(html).toBe(
      [
        '<ul>',
        '<li>item',
        '</li>',
        '</ul>',
        '<pre><code>',
        '  const x = 1;',
        '</code></pre>',
        '<p>After</p>',
      ].join('\n'),
    );
  });

  it('renders numbered steps as an ordered list and switches list kinds at a boundary', () => {
    const html = renderMarkdown(
      [
        '1. Open **Connections**.',
        '2. Choose a service',
        '   until it reports Ready.',
        '- a bullet after the steps',
      ].join('\n'),
    );
    expect(html).toBe(
      [
        '<ol>',
        '<li>Open <strong>Connections</strong>.',
        '</li>',
        '<li>Choose a service until it reports Ready.',
        '</li>',
        '</ol>',
        '<ul>',
        '<li>a bullet after the steps',
        '</li>',
        '</ul>',
      ].join('\n'),
    );
  });

  it('closes every open list level at the end of the document', () => {
    const html = renderMarkdown(['- outer', '  - inner'].join('\n'));
    expect(html).toBe(
      [
        '<ul>',
        '<li>outer',
        '<ul>',
        '<li>inner',
        '</li>',
        '</ul>',
        '</li>',
        '</ul>',
      ].join('\n'),
    );
  });
});
