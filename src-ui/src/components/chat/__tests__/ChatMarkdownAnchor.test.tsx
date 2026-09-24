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
const contextQueries: unknown[] = [];
vi.mock('@kontourai/station-sdk', () => ({
  usePullRequestContextQuery: (context: unknown) => {
    contextQueries.push(context);
    return { data: repositoryContext };
  },
}));
vi.mock('../../../platform/openExternalLink', () => ({
  hostOwnsExternalLinks: () => tauri,
  openNativeExternalLink: (url: string) => openNativeExternalLink(url),
}));

import { toastStore } from '../../../contexts/ToastContext';
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

  test('a host that has not earned a forge mark keeps its own URL as the text', () => {
    // A compact `o/r#1` would hide that this leaves for another host.
    const url = 'https://attacker.example/kontourai/station/pull/1';
    expect(mount(url, CONVERSATION, url).textContent).toBe(url);
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

describe('a web link Station lets through', () => {
  test('opens in a new tab, never replacing the running Station tab', () => {
    // Web, no region model: the pull request has no dock to go to, so the
    // anchor's default runs — and must not navigate Station away.
    model = null;
    for (const href of [
      'https://github.com/o/r/pull/1',
      'https://example.test/docs',
      'https://github.com/o/r/blob/main/a.ts',
    ]) {
      const anchor = mount(href);
      expect(anchor.getAttribute('target'), href).toBe('_blank');
      expect(anchor.getAttribute('rel'), href).toBe('noopener noreferrer');
      cleanup();
    }
    // A path never leaves Station, and outside a conversation nothing changes.
    expect(mount('src/app.ts').hasAttribute('target')).toBe(false);
    cleanup();
    expect(
      mount('https://example.test/docs', null).hasAttribute('target'),
    ).toBe(false);
  });
});

describe('a forge file link (github.com/.../blob/...)', () => {
  const url = 'https://github.com/kontourai/station/blob/main/src/app.ts#L4';

  test('opens the local preview when the checkout IS that repository, on that ref', () => {
    repositoryContext = {
      available: true,
      provider: 'github',
      host: 'github.com',
      repository: { owner: 'KontourAI', name: 'Station' },
      branch: 'main',
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
        branch: 'main',
      },
      // The same repository on another branch: the link shows different code.
      {
        available: true,
        provider: 'github',
        host: 'github.com',
        repository: { owner: 'kontourai', name: 'station' },
        branch: 'feature',
      },
    ]) {
      repositoryContext = context;
      expect(click(mount(url))).toBe(false);
      cleanup();
    }
    expect(openFilePreviewInRegion).not.toHaveBeenCalled();
    expect(openNativeExternalLink).toHaveBeenCalledTimes(4);
  });

  const station = (branch?: string) => ({
    available: true,
    provider: 'github',
    host: 'github.com',
    repository: { owner: 'kontourai', name: 'station' },
    ...(branch ? { branch } : {}),
  });

  test('a branch with a `/` in it is split at the checkout’s branch, not at its first segment', () => {
    repositoryContext = station('feature/x');
    const anchor = mount(
      'https://github.com/kontourai/station/blob/feature/x/src/app.ts#L2',
    );
    expect(click(anchor)).toBe(false);
    expect(openFilePreviewInRegion).toHaveBeenCalledWith(model, {
      projectId: 'alpha-id',
      projectSlug: 'alpha',
      path: 'src/app.ts',
      lineRange: { start: 2, end: 2 },
    });
    // The tooltip does not imply the local copy is the forge's revision.
    expect(anchor.getAttribute('title')).toMatch(
      /working copy of src\/app\.ts/,
    );
  });

  test('a slash branch the checkout is not on, or an unknown branch, opens on the forge', () => {
    tauri = true;
    for (const context of [
      station('feature/y'),
      station('feature/xy'),
      station(undefined),
    ]) {
      repositoryContext = context;
      const anchor = mount(
        'https://github.com/kontourai/station/blob/feature/x/src/app.ts',
      );
      expect(click(anchor)).toBe(false);
      expect(anchor.getAttribute('title')).toBe(
        'https://github.com/kontourai/station/blob/feature/x/src/app.ts',
      );
      cleanup();
    }
    expect(openFilePreviewInRegion).not.toHaveBeenCalled();
    expect(openNativeExternalLink).toHaveBeenCalledTimes(3);
  });

  test('a session whose directory cannot be read opens the forge, not a refused local path', () => {
    toastStore.clear();
    tauri = true;
    repositoryContext = station('main');
    const anchor = mount(url, {
      ...CONVERSATION,
      projectRoots: ['/work/repo'],
      sessionDirectory: '/elsewhere/lane',
      threadId: null,
    });
    expect(click(anchor)).toBe(false);
    expect(openNativeExternalLink).toHaveBeenCalledWith(url);
    expect(openFilePreviewInRegion).not.toHaveBeenCalled();
    expect(toastStore.getSnapshot()).toHaveLength(0);
  });

  test('in a worktree session the ref is compared with the WORKTREE branch', () => {
    contextQueries.length = 0;
    mount(url, {
      ...CONVERSATION,
      projectRoots: ['/work/repo'],
      sessionDirectory: '/wt/lane',
      threadId: 'thread-7',
    });
    expect(contextQueries).toContainEqual({
      project: 'alpha',
      thread: 'thread-7',
    });
  });
});

describe('an explicit path link follows the session’s file scope', () => {
  test('in a worktree session with a thread it opens the session’s copy', () => {
    const anchor = mount('src/app.ts', {
      ...CONVERSATION,
      projectRoots: ['/work/repo'],
      sessionDirectory: '/wt/lane',
      threadId: 'thread-7',
    });
    expect(click(anchor)).toBe(false);
    expect(openFilePreviewInRegion).toHaveBeenCalledWith(model, {
      projectId: 'alpha-id',
      projectSlug: 'alpha',
      path: 'src/app.ts',
      thread: 'thread-7',
    });
  });

  test('when the session directory cannot be read it refuses visibly, never opening the checkout copy', () => {
    toastStore.clear();
    const outside = {
      ...CONVERSATION,
      projectRoots: ['/work/repo'],
      sessionDirectory: '/elsewhere/lane',
      threadId: null,
    };
    for (const value of [outside, { ...outside, dockProjectSlug: 'beta' }]) {
      const anchor = mount('src/app.ts#L4', value);
      expect(click(anchor)).toBe(false);
      cleanup();
    }
    expect(openFilePreviewInRegion).not.toHaveBeenCalled();
    expect(openPathInMain).not.toHaveBeenCalled();
    const notices = toastStore.getSnapshot();
    expect(notices).toHaveLength(1);
    expect(notices[0]?.message).toMatch(/session's own directory/);
    toastStore.clear();
  });
});

describe('a link whose text names another host than it goes to', () => {
  test('shows the real host beside the text and the full href as its tooltip', () => {
    for (const [href, text, host] of [
      ['https://evil.test/x', 'github.com/kontourai/station', 'evil.test'],
      ['https://evil.test/x', 'https://github.com/o/r', 'evil.test'],
      ['https://evil.test:8443/', 'www.github.com', 'evil.test:8443'],
      [
        'https://github.com.evil.test/o/r',
        'github.com',
        'github.com.evil.test',
      ],
      // A recognised forge URL on another host is still a mismatch.
      [
        'https://gitlab.com/o/r/-/issues/1',
        'github.com/o/r/issues/1',
        'gitlab.com',
      ],
      // A port is part of the host a reader is promised.
      ['https://github.com:8443/o/r', 'github.com/o/r', 'github.com:8443'],
      ['https://github.com/x', 'github.com:8443/x', 'github.com'],
      // localhost, IP literals, with or without scheme and port.
      ['https://evil.test/', 'localhost:3000', 'evil.test'],
      ['https://evil.test/', 'localhost', 'evil.test'],
      ['https://evil.test/', '127.0.0.1', 'evil.test'],
      ['https://evil.test/', 'http://10.0.0.1:8080/x', 'evil.test'],
      ['http://10.0.0.2/', '10.0.0.1', '10.0.0.2'],
      // A Unicode look-alike is compared in the punycode form it resolves to.
      ['https://xn--gthub-zsa.com/', 'github.com/o', 'xn--gthub-zsa.com'],
      ['https://github.com/', 'gíthub.com/o', 'github.com'],
      ['https://evil.test/', 'example.xn--p1ai/x', 'evil.test'],
      // The reader sees `github.com`; the parser would call it userinfo.
      ['https://evil.test/', 'https://github.com@evil.test/', 'evil.test'],
      // A scheme-less host with a port is a claim.
      ['https://evil.test/', 'github.com:443/x', 'evil.test'],
      // Bare text is a claim for an ordinary external site.
      ['https://evil.test/', 'docs.example', 'evil.test'],
    ] as const) {
      const anchor = mount(href, CONVERSATION, text);
      expect(anchor.textContent, href).toBe(`${text} (${host})`);
      expect(anchor.getAttribute('title'), href).toBe(new URL(href).href);
      cleanup();
    }
  });

  test('prose, file names and matching hosts are unchanged', () => {
    for (const [href, text] of [
      ['https://example.test/docs', 'the docs'],
      ['https://github.com/o/r/blob/main/README.md', 'README.md'],
      ['https://github.com/o/r', 'github.com/o/r'],
      ['https://www.github.com/o/r', 'github.com/o/r'],
      ['https://github.com/o/r/pull/1', 'src/app.ts'],
      // A default port is not a difference.
      ['https://github.com/x', 'github.com:443/x'],
      ['https://github.com/x', 'https://github.com:443/x'],
      // Bare file names, on an external site or a forge target.
      ['https://example.test/a', 'logo.png'],
      ['https://example.test/a', 'index.php'],
      ['https://example.test/a', 'Info.plist'],
      ['https://example.test/a', 'App.vue'],
      ['https://example.test/a', 'ASP.NET'],
      ['https://example.test/a', 'docs.rs'],
      ['https://github.com/o/r/blob/main/go.mod', 'go.mod'],
      // Bare text on a forge file or pull request is never a host claim —
      // a ref or file name that happens to look like a domain.
      ['https://github.com/o/r/blob/main/config.io', 'config.io'],
      ['https://github.com/o/r/pull/1', 'release.app'],
      // Without a scheme, `@` makes an address, not a host.
      ['https://example.test/a', 'someone@github.com'],
    ] as const) {
      const anchor = mount(href, CONVERSATION, text);
      expect(anchor.textContent, `${text} -> ${href}`).toBe(text);
      expect(anchor.querySelector('.chat-link-host')).toBeNull();
      cleanup();
    }
  });
});
