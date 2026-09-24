import { describe, expect, test } from 'vitest';
import { classifyMarkdownLink } from '../markdownLinkTarget';

/**
 * #2049: what a chat link is, decided before anything is opened. The three
 * things this must get right are the three ways it could open the wrong
 * thing: a URL that only LOOKS like a pull request, a relative path that
 * escapes the checkout, and a scheme that is not a link at all.
 */
describe('classifying a link in a chat message (#2049)', () => {
  test('a pull request is identified by host and path, not by substring', () => {
    expect(
      classifyMarkdownLink('https://github.com/kontourai/Station/pull/2049'),
    ).toEqual({
      kind: 'pull-request',
      key: {
        host: 'github.com',
        owner: 'kontourai',
        repository: 'Station',
        ref: '2049',
      },
      url: 'https://github.com/kontourai/Station/pull/2049',
    });
    // GitLab's own shape, with the `/-/` segment its URLs carry.
    expect(
      classifyMarkdownLink('https://gitlab.com/g/p/-/merge_requests/7'),
    ).toMatchObject({
      kind: 'pull-request',
      key: { host: 'gitlab.com', owner: 'g', repository: 'p', ref: '7' },
    });
    // The query and the fragment are not part of a review's identity, and a
    // sub-path (`/files`, `/commits`) still names the same pull request.
    expect(
      classifyMarkdownLink(
        'https://github.com/o/r/pull/12/files?diff=split#r1',
      ),
    ).toMatchObject({ kind: 'pull-request', key: { ref: '12' } });
    // A host that merely CARRIES the shape in its query is external: the
    // pathname is what decides, so an attacker-controlled host cannot borrow
    // a review pane bound to the reader's own Project.
    expect(
      classifyMarkdownLink(
        'https://evil.test/x?u=https://github.com/o/r/pull/1',
      ),
    ).toMatchObject({ kind: 'external' });
    expect(classifyMarkdownLink('https://github.com/o/r/pull/x')).toMatchObject(
      { kind: 'external' },
    );
    expect(classifyMarkdownLink('https://github.com/o/r')).toMatchObject({
      kind: 'external',
    });
  });

  test('a repo-relative path is a path, and an escaping one is nothing', () => {
    expect(classifyMarkdownLink('src/app.ts')).toEqual({
      kind: 'path',
      path: 'src/app.ts',
    });
    expect(classifyMarkdownLink('src/app.ts#L10-L20')).toEqual({
      kind: 'path',
      path: 'src/app.ts',
      lineRange: { start: 10, end: 20 },
    });
    expect(classifyMarkdownLink('src/app.ts#L10')).toEqual({
      kind: 'path',
      path: 'src/app.ts',
      lineRange: { start: 10, end: 10 },
    });
    // An anchor the contract cannot carry leaves the PATH intact rather than
    // discarding the whole link: the file is still the thing being named.
    expect(classifyMarkdownLink('src/app.ts#readme')).toEqual({
      kind: 'path',
      path: 'src/app.ts',
    });
    expect(classifyMarkdownLink('src/app.ts#L20-L10')).toEqual({
      kind: 'path',
      path: 'src/app.ts',
    });
    for (const escaping of [
      '../secrets.env',
      '/etc/passwd',
      '//github.com/o/r',
      'a\\b.ts',
      './../x.ts',
    ])
      expect(classifyMarkdownLink(escaping), escaping).toBeNull();
  });

  test('a leading ./ names the same file, not a traversal', () => {
    expect(classifyMarkdownLink('./src/app.ts')).toEqual({
      kind: 'path',
      path: 'src/app.ts',
    });
  });

  test('a :line suffix is a position, in every form a model writes it', () => {
    expect(classifyMarkdownLink('src/app.ts:42')).toEqual({
      kind: 'path',
      path: 'src/app.ts',
      lineRange: { start: 42, end: 42 },
    });
    // Column numbers are dropped: a preview addresses lines.
    expect(classifyMarkdownLink('src/app.ts:42:7')).toEqual({
      kind: 'path',
      path: 'src/app.ts',
      lineRange: { start: 42, end: 42 },
    });
    expect(classifyMarkdownLink('src/app.ts:10-20')).toEqual({
      kind: 'path',
      path: 'src/app.ts',
      lineRange: { start: 10, end: 20 },
    });
    // An impossible range keeps the file and drops the position.
    expect(classifyMarkdownLink('src/app.ts:20-10')).toEqual({
      kind: 'path',
      path: 'src/app.ts',
    });
  });

  test('an absolute path is a file only inside one of the conversation roots', () => {
    const roots = ['/work/repo', '/work/worktrees/lane/'];
    expect(classifyMarkdownLink('/work/repo/src/app.ts:3', { roots })).toEqual({
      kind: 'path',
      path: 'src/app.ts',
      lineRange: { start: 3, end: 3 },
    });
    expect(
      classifyMarkdownLink('/work/worktrees/lane/README.md', { roots }),
    ).toEqual({ kind: 'path', path: 'README.md' });
    for (const outside of [
      // A sibling whose name merely starts with the root's.
      '/work/repository/src/app.ts',
      '/etc/passwd',
      // Inside by prefix, out by traversal: the validator still refuses it.
      '/work/repo/../secret.env',
      // `file:` is not a link scheme here, inside a root or not.
      'file:///work/repo/src/app.ts',
    ])
      expect(classifyMarkdownLink(outside, { roots }), outside).toBeNull();
    // No roots, no absolute file links at all.
    expect(classifyMarkdownLink('/work/repo/src/app.ts')).toBeNull();
  });

  test('a forge file view is a repo file, identified by its repository', () => {
    expect(
      classifyMarkdownLink(
        'https://github.com/kontourai/station/blob/main/src/app.ts#L4-L9',
      ),
    ).toEqual({
      kind: 'repo-file',
      host: 'github.com',
      owner: 'kontourai',
      repository: 'station',
      ref: 'main',
      path: 'src/app.ts',
      refPath: 'main/src/app.ts',
      lineRange: { start: 4, end: 9 },
      url: 'https://github.com/kontourai/station/blob/main/src/app.ts#L4-L9',
    });
    expect(
      classifyMarkdownLink('https://gitlab.com/g/p/-/blob/abc123/lib/x.rb'),
    ).toMatchObject({ kind: 'repo-file', repository: 'p', path: 'lib/x.rb' });
    // A slash branch cannot be told from a directory by the URL alone: the
    // undivided tail is kept for a reader that knows the branch.
    expect(
      classifyMarkdownLink(
        'https://github.com/o/r/blob/feature/x/src/a.ts',
      ),
    ).toMatchObject({
      ref: 'feature',
      path: 'x/src/a.ts',
      refPath: 'feature/x/src/a.ts',
    });
    // A path the preview could not address is an ordinary external link.
    expect(
      classifyMarkdownLink('https://github.com/o/r/blob/main/a%2F..%2Fb.ts'),
    ).toMatchObject({ kind: 'external' });
  });

  test('an href no placement applies to is left to the anchor', () => {
    for (const href of [
      undefined,
      '',
      '#section',
      'mailto:someone@example.test',
      // The point of classifying `external` positively rather than as
      // "everything else": a scheme Station will not hand to a browser.
      'javascript:alert(1)',
      'data:text/html,<b>',
      'file:///etc/passwd',
    ])
      expect(classifyMarkdownLink(href), String(href)).toBeNull();
  });
});
