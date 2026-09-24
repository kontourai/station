/** @vitest-environment jsdom */

/**
 * #2049: what a click on a chat link does, through the real anchor.
 *
 * Every assertion is about a CLICK, not about a classifier: the classifier
 * has its own test, and the defects this one exists to catch — a modified
 * click swallowed, a link opened against the wrong project, a plain anchor
 * outside a conversation growing a handler — all live in the branch order of
 * the handler rather than in what the href means.
 */

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const openPullRequestInRegion = vi.fn(() => ({ ok: true }) as never);
const openFilePreviewInRegion = vi.fn(() => ({ ok: true }) as never);
const openNativeExternalLink = vi.fn(async (_url: string) => true);
let tauri = false;
let model: object | null = { regions: {}, openSurfaceInRegion: vi.fn() };

vi.mock('../../../contexts/useOpenInRegion', () => ({
  openPullRequestInRegion: (...args: unknown[]) =>
    openPullRequestInRegion(...(args as [])),
  openFilePreviewInRegion: (...args: unknown[]) =>
    openFilePreviewInRegion(...(args as [])),
}));
vi.mock('../../../contexts/RegionModelContext', () => ({
  useRegionModelOptional: () => model,
}));
let repositoryContext: unknown;
vi.mock('@kontourai/station-sdk', () => ({
  usePullRequestContextQuery: () => ({ data: repositoryContext }),
}));
vi.mock('../../../platform/openExternalLink', () => ({
  hostOwnsExternalLinks: () => tauri,
  openNativeExternalLink: (url: string) => openNativeExternalLink(url),
}));

import { ChatMarkdownAnchor } from '../ChatMarkdownAnchor';
import {
  MarkdownLinkContext,
  type MarkdownLinkContextValue,
} from '../MarkdownLinkContext';

const openPathInMain = vi.fn();

const CONVERSATION: MarkdownLinkContextValue = {
  projectSlug: 'alpha',
  projectId: 'alpha-id',
  dockProjectSlug: 'alpha',
  bottomOnly: false,
  openPathInMain,
};

function mount(
  href: string,
  value: MarkdownLinkContextValue | null = CONVERSATION,
  text = 'link',
): HTMLAnchorElement {
  const anchor: ReactNode = (
    <ChatMarkdownAnchor href={href}>{text}</ChatMarkdownAnchor>
  );
  render(
    value ? (
      <MarkdownLinkContext.Provider value={value}>
        {anchor}
      </MarkdownLinkContext.Provider>
    ) : (
      anchor
    ),
  );
  return screen.getByRole('link') as HTMLAnchorElement;
}

/** Click, reporting whether the anchor's own navigation survived. */
function click(anchor: HTMLAnchorElement, init: MouseEventInit = {}): boolean {
  return fireEvent.click(anchor, { button: 0, ...init });
}

beforeEach(() => {
  repositoryContext = undefined;
  tauri = false;
  model = { regions: {}, openSurfaceInRegion: vi.fn() };
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('a link in a chat message (#2049)', () => {
  test('a pull request opens as a dock pane bound to the conversation’s project', () => {
    const anchor = mount('https://github.com/kontourai/station/pull/2049');
    expect(click(anchor)).toBe(false);
    expect(openPullRequestInRegion).toHaveBeenCalledWith(
      model,
      {
        host: 'github.com',
        owner: 'kontourai',
        repository: 'station',
        ref: '2049',
      },
      'alpha-id',
    );
    expect(openNativeExternalLink).not.toHaveBeenCalled();
  });

  test('a repo-relative path opens a preview for the conversation’s project', () => {
    const anchor = mount('src/app.ts#L4-L9');
    expect(click(anchor)).toBe(false);
    expect(openFilePreviewInRegion).toHaveBeenCalledWith(model, {
      projectId: 'alpha-id',
      projectSlug: 'alpha',
      path: 'src/app.ts',
      lineRange: { start: 4, end: 9 },
    });
    expect(openPathInMain).not.toHaveBeenCalled();
  });

  test('a model refusal falls back to the route a preview had before', () => {
    openFilePreviewInRegion.mockReturnValueOnce({
      ok: false,
      reason: 'region-unavailable',
    } as never);
    click(mount('src/app.ts'));
    expect(openPathInMain).toHaveBeenCalledWith('src/app.ts', undefined);
  });

  test('the conversation’s project, not the dock’s, decides — and a mismatch does not rebind', () => {
    // The dock is showing another Project. A preview minted for THIS
    // conversation would be refused by the region, and one minted for the
    // dock would name a file in a checkout the conversation never mentioned.
    const anchor = mount('src/app.ts', {
      ...CONVERSATION,
      dockProjectSlug: 'beta',
    });
    expect(click(anchor)).toBe(false);
    expect(openFilePreviewInRegion).not.toHaveBeenCalled();
    expect(openPathInMain).toHaveBeenCalledWith('src/app.ts', undefined);
  });

  test('a bottom-only device keeps the main route, and sends a review to the host', () => {
    const bottomOnly = { ...CONVERSATION, bottomOnly: true };
    click(mount('src/app.ts', bottomOnly));
    expect(openFilePreviewInRegion).not.toHaveBeenCalled();
    expect(openPathInMain).toHaveBeenCalledWith('src/app.ts', undefined);
    cleanup();
    tauri = true;
    click(mount('https://github.com/o/r/pull/3', bottomOnly));
    expect(openPullRequestInRegion).not.toHaveBeenCalled();
    expect(openNativeExternalLink).toHaveBeenCalledWith(
      'https://github.com/o/r/pull/3',
    );
  });

  test('an external link goes to the host that owns external navigation, and only there', () => {
    // Web: an anchor already means "leave", so the default is the behaviour
    // and nothing is prevented.
    expect(click(mount('https://example.test/docs'))).toBe(true);
    expect(openNativeExternalLink).not.toHaveBeenCalled();
    cleanup();
    // Tauri: the default would replace the running application with the page.
    tauri = true;
    expect(click(mount('https://example.test/docs'))).toBe(false);
    expect(openNativeExternalLink).toHaveBeenCalledWith(
      'https://example.test/docs',
    );
  });

  test('a modified or non-primary click is the browser’s, untouched', () => {
    for (const modifier of [
      { metaKey: true },
      { ctrlKey: true },
      { shiftKey: true },
      { altKey: true },
      { button: 1 },
    ]) {
      const anchor = mount('https://github.com/o/r/pull/1');
      expect(click(anchor, modifier), JSON.stringify(modifier)).toBe(true);
      cleanup();
    }
    expect(openPullRequestInRegion).not.toHaveBeenCalled();
    // An event another handler already prevented is not re-decided here.
    const anchor = mount('https://github.com/o/r/pull/1');
    anchor.addEventListener('click', (event) => event.preventDefault(), {
      capture: true,
    });
    click(anchor);
    expect(openPullRequestInRegion).not.toHaveBeenCalled();
  });

  test('outside a conversation every anchor stays a plain anchor', () => {
    // No provider: a document view, a shared answer, a system event. There is
    // no project to resolve a path against, and guessing one would preview
    // some other checkout's file.
    tauri = true;
    for (const href of [
      'src/app.ts',
      'https://github.com/o/r/pull/1',
      'https://example.test/docs',
    ]) {
      const anchor = mount(href, null);
      expect(click(anchor), href).toBe(true);
      cleanup();
    }
    expect(openPullRequestInRegion).not.toHaveBeenCalled();
    expect(openFilePreviewInRegion).not.toHaveBeenCalled();
    expect(openNativeExternalLink).not.toHaveBeenCalled();
  });

  /**
   * Review H3. The branch with nowhere to send a path — no dock that may hold
   * it, no `openPathInMain` — used to `return` without preventing the
   * default, so the anchor navigated. On Tauri that replaces the running
   * application; on the web it is a same-origin route-miss that drops the
   * conversation pointer. Dropping the `preventDefault()` reds both hosts
   * here, and re-adding a `if (!link.openPathInMain) return;` guard above it
   * reds them the same way.
   */
  test('a path with nowhere to go is refused, not followed, on either host', () => {
    const nowhere = {
      ...CONVERSATION,
      dockProjectSlug: 'beta',
      openPathInMain: null,
    };
    for (const host of [false, true]) {
      tauri = host;
      const anchor = mount('src/app.ts#L4', nowhere);
      expect(click(anchor), `tauri=${host}`).toBe(false);
      cleanup();
    }
    expect(openFilePreviewInRegion).not.toHaveBeenCalled();
    expect(openPathInMain).not.toHaveBeenCalled();
    expect(openNativeExternalLink).not.toHaveBeenCalled();
  });

  test('with no region model a path takes the main route and a review the host', () => {
    model = null;
    tauri = true;
    click(mount('src/app.ts'));
    expect(openPathInMain).toHaveBeenCalledWith('src/app.ts', undefined);
    cleanup();
    click(mount('https://github.com/o/r/pull/1'));
    expect(openNativeExternalLink).toHaveBeenCalledWith(
      'https://github.com/o/r/pull/1',
    );
  });
});

describe('how a recognised link looks', () => {
  test('a raw pull-request URL reads as its forge and owner/repo#number', () => {
    const url = 'https://github.com/kontourai/station/pull/2049';
    const anchor = mount(url, CONVERSATION, url);
    expect(anchor.textContent).toBe('kontourai/station#2049');
    expect(anchor.className).toContain('chat-link-chip--pull-request');
    expect(anchor.getAttribute('title')).toBe(url);
    expect(anchor.querySelector('svg')).not.toBeNull();
  });

  test('text an author chose is kept, with the mark beside it', () => {
    const anchor = mount(
      'https://github.com/kontourai/station/pull/2049',
      CONVERSATION,
      'the fix',
    );
    expect(anchor.textContent).toBe('the fix');
    expect(anchor.className).toContain('chat-link-chip');
  });

  test('issues and commits read the way the forge writes them', () => {
    for (const [url, label] of [
      ['https://github.com/o/r/issues/12', 'o/r#12'],
      ['https://github.com/o/r/commit/abcdef1234567', 'o/r@abcdef1'],
      ['https://gitlab.com/g/p/-/issues/3', 'g/p#3'],
      ['https://github.com/o/r', 'o/r'],
    ]) {
      expect(mount(url, CONVERSATION, url).textContent, url).toBe(label);
      cleanup();
    }
  });

  test('a raw path reads as its file name and position', () => {
    const anchor = mount(
      'src/deep/app.ts:12',
      CONVERSATION,
      'src/deep/app.ts:12',
    );
    expect(anchor.textContent).toBe('app.ts:12');
    expect(anchor.getAttribute('title')).toBe('src/deep/app.ts:12');
  });

  test('an ordinary site stays a plain anchor, and nothing is a chip outside a conversation', () => {
    const site = mount('https://example.test/docs');
    expect(site.className).toBe('');
    cleanup();
    const pr = 'https://github.com/o/r/pull/1';
    expect(mount(pr, null, pr).className).toBe('');
  });
});

describe('a forge file link (github.com/.../blob/...)', () => {
  const url = 'https://github.com/kontourai/station/blob/main/src/app.ts#L4';

  test('opens the local preview when the checkout IS that repository', () => {
    repositoryContext = {
      available: true,
      provider: 'github',
      host: 'github.com',
      repository: { owner: 'KontourAI', name: 'Station' },
    };
    expect(click(mount(url))).toBe(false);
    expect(openFilePreviewInRegion).toHaveBeenCalledWith(model, {
      projectId: 'alpha-id',
      projectSlug: 'alpha',
      path: 'src/app.ts',
      lineRange: { start: 4, end: 4 },
    });
  });

  test('opens on the forge when the checkout is another repository or unknown', () => {
    tauri = true;
    for (const context of [
      undefined,
      { available: false, reason: 'no remote' },
      {
        available: true,
        provider: 'github',
        host: 'github.com',
        repository: { owner: 'kontourai', name: 'other' },
      },
    ]) {
      repositoryContext = context;
      expect(click(mount(url))).toBe(false);
      cleanup();
    }
    expect(openFilePreviewInRegion).not.toHaveBeenCalled();
    expect(openNativeExternalLink).toHaveBeenCalledTimes(3);
  });
});
