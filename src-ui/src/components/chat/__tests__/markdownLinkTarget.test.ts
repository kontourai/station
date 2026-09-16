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
      './x.ts',
    ])
      expect(classifyMarkdownLink(escaping), escaping).toBeNull();
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
