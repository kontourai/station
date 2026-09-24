/** @vitest-environment jsdom */

/**
 * Paths a model writes in prose become links only when they name a file that
 * exists in the conversation's checkout — through the real markdown pipeline
 * (GFM, the mention plugin, the anchor), with the server's existence answer
 * as the one mocked seam.
 */

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const existing = new Set<string>();
const existenceAsks: [string | null, string | null][] = [];
const openFilePreviewInRegion = vi.fn(() => ({ ok: true }) as never);

vi.mock('../useWorkspaceFileExists', () => ({
  useWorkspaceFileExists: (projectSlug: string | null, path: string | null) => {
    existenceAsks.push([projectSlug, path]);
    return path !== null && existing.has(path);
  },
}));
vi.mock('../../../contexts/useOpenInRegion', () => ({
  openPullRequestInRegion: vi.fn(),
  openFilePreviewInRegion: (...args: unknown[]) =>
    openFilePreviewInRegion(...(args as [])),
}));
vi.mock('../../../contexts/RegionModelContext', () => ({
  useRegionModelOptional: () => ({ regions: {} }),
}));
vi.mock('../../../platform/openExternalLink', () => ({
  hostOwnsExternalLinks: () => false,
  openNativeExternalLink: vi.fn(),
}));

import { MarkdownLinkContext } from '../MarkdownLinkContext';
import { MarkdownRenderer } from '../MarkdownRenderer';
import {
  findPathMentions,
  PATH_MENTION_MAX_PER_PARSE,
} from '../remarkPathMentions';

const CONVERSATION = {
  projectSlug: 'alpha',
  projectId: 'alpha-id',
  dockProjectSlug: 'alpha',
  bottomOnly: false,
  openPathInMain: vi.fn(),
  projectRoots: ['/work/repo'],
};

function renderInConversation(markdown: string, inConversation = true) {
  const tree = <MarkdownRenderer>{markdown}</MarkdownRenderer>;
  return render(
    inConversation ? (
      <MarkdownLinkContext.Provider value={CONVERSATION}>
        {tree}
      </MarkdownLinkContext.Provider>
    ) : (
      tree
    ),
  );
}

const tokens = (text: string) =>
  findPathMentions(text).map(({ start, end }) => text.slice(start, end));

beforeEach(() => {
  existing.clear();
  existenceAsks.length = 0;
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('finding path mentions in text', () => {
  test('the shapes a model writes', () => {
    expect(
      tokens(
        'See src/app.ts:42, ./lib/x.rb and README.md. Also /work/repo/a/b.tsx:3-9 and .github/workflows/ci.yml:12:4.',
      ),
    ).toEqual([
      'src/app.ts:42',
      './lib/x.rb',
      'README.md',
      '/work/repo/a/b.tsx:3-9',
      '.github/workflows/ci.yml:12:4',
    ]);
  });

  test('what is not a path', () => {
    for (const text of [
      'version 1.2.3',
      'github.com/foo/bar',
      'end of sentence.Next one',
      'https://example.test/a/b.ts',
      'a/b/c',
      'user@host.Com',
    ])
      expect(tokens(text), text).toEqual([]);
  });

  test('stays linear on a long run of dotted text', () => {
    const hostile = `${'a.'.repeat(50_000)}/`;
    const started = performance.now();
    tokens(hostile);
    expect(performance.now() - started).toBeLessThan(1_000);
  });
});

describe('path mentions in a rendered chat message', () => {
  test('a path to an existing file is a chip; a missing one stays text', () => {
    existing.add('src/app.ts');
    renderInConversation('Edit src/app.ts:42 and src/gone.ts:3 now.');

    const link = screen.getByRole('link', { name: /app\.ts:42/ });
    expect(link.getAttribute('href')).toBe('src/app.ts:42');
    expect(link.className).toContain('chat-link-chip--file');
    expect(link.getAttribute('title')).toBe('src/app.ts:42');
    // The marker never reaches the DOM.
    expect(link.hasAttribute('data-path-mention')).toBe(false);
    expect(screen.queryByRole('link', { name: /gone/ })).toBeNull();
    expect(screen.getByText(/src\/gone\.ts:3/)).toBeTruthy();
    // Each mention asked about its own path, in the conversation's project.
    expect(existenceAsks).toContainEqual(['alpha', 'src/app.ts']);
    expect(existenceAsks).toContainEqual(['alpha', 'src/gone.ts']);
  });

  test('inline code that is exactly one path is a candidate; other code is not', () => {
    existing.add('src/app.ts');
    existing.add('package.json');
    renderInConversation('Run `npm run build`, then open `src/app.ts`.');
    expect(screen.getByRole('link', { name: /app\.ts/ })).toBeTruthy();
    expect(screen.getByText('npm run build').closest('a')).toBeNull();
  });

  test('an absolute path inside the checkout opens relative to it', () => {
    existing.add('src/app.ts');
    renderInConversation('Changed /work/repo/src/app.ts:7.');
    fireEvent.click(screen.getByRole('link', { name: /app\.ts:7/ }));
    expect(openFilePreviewInRegion).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        path: 'src/app.ts',
        lineRange: { start: 7, end: 7 },
        projectSlug: 'alpha',
      }),
    );
  });

  test('text inside links and fenced code is never scanned', () => {
    existing.add('src/app.ts');
    renderInConversation(
      '[see src/app.ts](https://example.test/x)\n\n```\nsrc/app.ts\n```',
    );
    expect(screen.getAllByRole('link')).toHaveLength(1);
    expect(existenceAsks).toEqual([]);
  });

  test('outside a conversation a mention stays text and asks nothing', () => {
    existing.add('src/app.ts');
    renderInConversation('Edit src/app.ts now.', false);
    expect(screen.queryByRole('link')).toBeNull();
    expect(existenceAsks).toEqual([]);
  });

  test('one parse links at most the capped number of mentions', () => {
    const names = Array.from(
      { length: PATH_MENTION_MAX_PER_PARSE + 5 },
      (_, index) => `f${index}.ts`,
    );
    for (const name of names) existing.add(name);
    renderInConversation(names.join(' '));
    expect(screen.getAllByRole('link')).toHaveLength(
      PATH_MENTION_MAX_PER_PARSE,
    );
  });
});
