/**
 * @vitest-environment jsdom
 */

/**
 * #2062 — the Boards section, driven through the REAL `ProjectSidebar`.
 *
 * Every case here mounts the actual panel and reaches the section the way a
 * person does: find the control by its accessible name, click it, type into
 * it. Nothing calls `ProjectSidebarBoards` directly and nothing calls a
 * helper in place of the gesture — a test that rendered the section alone
 * would pass even if `ProjectSidebar` never mounted it, which is precisely
 * the wiring this slice adds.
 *
 * The seam that IS stubbed is the SDK, mirroring `ProjectSidebar.test.tsx`'s
 * own harness (this file follows its mock shape). The Boards hooks are backed
 * by a small in-memory list so a create, a rename and a delete are observable
 * as list changes rather than only as calls — and the mutation payloads are
 * recorded, because the payload is what the server acts on.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import type { ReactElement } from 'react';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { requestNewBoard } from '../components/project-sidebar/new-board-events';

const showSurfaceStub = vi.hoisted(() => vi.fn());
vi.mock('../contexts/useShowSurface', () => ({
  useShowSurface: () => showSurfaceStub,
}));
vi.mock('../contexts/RegionModelContext', () => ({
  useRegionModelOptional: () => null,
}));
vi.mock('../build-info', () => ({
  buildInfo: { version: '0.1.2', commit: 'test' },
}));

const {
  boards,
  projects,
  navigate,
  calls,
  pathname,
  sdk,
  reactApi,
  viewport,
  createOutcome,
} = vi.hoisted(() => ({
  /**
   * Whether the panel believes it is on a phone. Configurable, because
   * hardcoding `false` is exactly why #2062 review F1 — the palette's
   * rename focusing into the closed drawer — was invisible here.
   */
  viewport: { isMobile: false },
  /** Whether the next create is refused; see the create mock below. */
  createOutcome: { rejects: false },
  boards: [] as Array<{ slug: string; name: string; icon?: string }>,
  projects: [] as Array<{ id: string; slug: string; name: string }>,
  navigate: vi.fn(),
  pathname: { value: '/' },
  calls: {
    create: [] as unknown[],
    update: [] as unknown[],
    remove: [] as unknown[],
    promote: [] as unknown[],
  },
  /** Assigned by the SDK mock factory; lets the test reset re-publish. */
  sdk: { notify: () => {}, version: 0 },
  /** React, reachable from inside the hoisted mock factory. */
  reactApi: { current: undefined as typeof import('react') | undefined },
}));

vi.mock('../contexts/ProjectsContext', () => ({
  useProjects: () => ({ projects, isLoading: false }),
}));
vi.mock('../contexts/AgentsContext', () => ({ useAgents: () => [] }));
vi.mock('../contexts/ActiveChatsContext', () => ({
  useAllActiveChats: () => ({}),
}));
vi.mock('../contexts/open-chats-store', () => ({
  useOpenChats: () => [],
  openChatsStore: {
    focus: vi.fn(),
    openCollection: vi.fn(),
    registerNavigation: () => vi.fn(),
  },
}));
vi.mock('../contexts/NavigationContext', () => {
  const navigation = () => ({
    selectedProject: null,
    selectedProjectLayout: null,
    navigate,
    setProject: vi.fn(),
    setLayout: vi.fn(),
    pathname: pathname.value,
  });
  return {
    useNavigation: (selector?: (state: any) => unknown) =>
      selector ? selector(navigation()) : navigation(),
    useNavigationActions: navigation,
  };
});
vi.mock('../hooks/useBranding', () => ({
  useBranding: () => ({ appName: 'Station' }),
}));
vi.mock('../platform/PlatformProfileContext', () => ({
  usePlatformProfile: () => ({ isTauri: false }),
}));
vi.mock('../contexts/ApiBaseContext', () => ({
  useApiBase: () => ({ apiBase: 'http://test.local' }),
  useHostRequestAuthorityScope: () => undefined,
}));
vi.mock('../hooks/useIsMobile', () => ({
  useIsMobile: () => viewport.isMobile,
}));

/**
 * The Boards half of this mock is a STORE, not four spies. A rename that
 * reported a call but left the list unchanged would pass a call-count
 * assertion and still be a rename the user never sees, so the list the panel
 * reads is the same list the mutations write.
 */
vi.mock('@kontourai/station-sdk', () => {
  const listeners = new Set<() => void>();
  const subscribe = (listener: () => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  };
  // The published snapshot is a VERSION NUMBER, not the array: a fresh array
  // every read makes `useSyncExternalStore` loop forever.
  const notify = () => {
    sdk.version += 1;
    for (const listener of listeners) listener();
  };
  sdk.notify = notify;
  return {
    useOrchestrationSessionsQuery: () => ({ data: [] }),
    useProjectLayoutsQuery: () => ({ data: [] }),
    useReorderProjectsMutation: () => ({ mutate: vi.fn() }),
    useFeaturePreviewsQuery: () => ({ data: [] }),
    useBoardAvailabilityQuery: () => ({ data: undefined }),
    useAttentionQuery: () => ({ data: { pendingCount: 0 } }),
    usePersonalLayoutsQuery: () => {
      // Subscribed, so a mutation below re-renders the real panel — which is
      // what makes "the row is gone afterwards" an observation rather than a
      // restatement of the spy.
      reactApi.current?.useSyncExternalStore(
        subscribe,
        () => sdk.version,
        () => sdk.version,
      );
      return { data: [...boards] };
    },
    useCreatePersonalLayoutMutation: (options?: {
      onSuccess?: (created: { slug: string }) => void;
      onError?: (error: Error) => void;
    }) => ({
      isPending: false,
      mutate: (input: { slug: string; name: string }) => {
        calls.create.push(input);
        // A create the server refuses. `useCreatePersonalLayoutMutation`
        // routes it to `options.onError` and never calls `onSuccess`, which
        // is the path #2062 review F2 found unhandled.
        if (createOutcome.rejects) {
          options?.onError?.(new Error('Board storage is unavailable'));
          return;
        }
        // PRODUCTION ORDER, and the order is the whole point (#2062 review
        // MED-3). `useCreatePersonalLayoutMutation` calls
        // `queryClient.invalidateQueries` and then the caller's `onSuccess`;
        // the invalidation only SCHEDULES a refetch, so when `onSuccess` runs
        // the new Board is not in the list yet, and the row arrives in a LATER
        // COMMIT. Both halves matter, and the second is the one that is easy
        // to get wrong: simply calling `onSuccess` first while still pushing
        // synchronously leaves React committing the mode change and the new
        // row TOGETHER, which an effect keyed on `[mode]` handles fine and
        // production does not. Deferring the list update to a microtask is
        // what reproduces the separate commit — verified by injection: with
        // this deferral, reverting the component to the effect-based focus
        // reds the assertion below, and without it, it does not.
        options?.onSuccess?.({ slug: input.slug });
        queueMicrotask(() => {
          boards.push({ slug: input.slug, name: input.name });
          notify();
        });
      },
    }),
    useUpdatePersonalLayoutMutation: () => ({
      mutate: (input: { layoutSlug: string; update: { name?: string } }) => {
        calls.update.push(input);
        const board = boards.find((row) => row.slug === input.layoutSlug);
        if (board && input.update.name) board.name = input.update.name;
        notify();
      },
    }),
    useDeletePersonalLayoutMutation: () => ({
      mutate: (slug: string) => {
        calls.remove.push(slug);
        const index = boards.findIndex((row) => row.slug === slug);
        if (index >= 0) boards.splice(index, 1);
        notify();
      },
    }),
    usePromotePersonalLayoutMutation: () => ({
      mutate: (input: { layoutSlug: string; projectSlug: string }) => {
        calls.promote.push(input);
        // Promote is a MOVE: the record leaves the personal list. A mock that
        // left it there would let a panel that treats promote as a copy pass.
        const index = boards.findIndex((row) => row.slug === input.layoutSlug);
        if (index >= 0) boards.splice(index, 1);
        notify();
      },
    }),
  };
});

import * as React from 'react';
import { ProjectSidebar } from '../components/project-sidebar/ProjectSidebar';
import { nextBoardSlug } from '../components/project-sidebar/ProjectSidebarBoards';
import { KeyboardShortcutsProvider } from '../contexts/KeyboardShortcutsContext';
import { deviceSettingsStore } from '../lib/device-settings-store';

reactApi.current = React;

/**
 * Mounts the real panel and WAITS for the Boards chunk.
 *
 * The section is behind a `LazyBoundary` (it costs ~1.2 kB of entry JS for a
 * surface most viewers do not have yet), so a synchronous `render` observes
 * the panel before the section exists. Awaiting here means every assertion
 * below is about the mounted section — and a boundary that never resolved
 * would fail these tests rather than reading as "hidden when empty".
 */
async function renderSidebar(ui: ReactElement) {
  const result = render(
    <KeyboardShortcutsProvider>{ui}</KeyboardShortcutsProvider>,
  );
  // The panel's own rows are synchronous; this is the lazy boundary settling.
  await act(async () => {
    await Promise.resolve();
  });
  return result;
}

beforeEach(() => {
  viewport.isMobile = false;
  createOutcome.rejects = false;
  boards.length = 0;
  projects.length = 0;
  pathname.value = '/';
  navigate.mockClear();
  for (const key of Object.keys(calls)) {
    (calls as Record<string, unknown[]>)[key].length = 0;
  }
  window.localStorage.clear();
  // The rail's collapsed state lives in a MODULE SINGLETON, so clearing
  // storage does not clear it: the #2083 collapse case drives the real
  // `Collapse sidebar` control, and a failure between collapsing and
  // re-expanding would otherwise leave every later test rendering a rail with
  // no Boards chrome in it — nine unrelated reds pointing at the wrong file.
  // Observed while fault-injecting that case, not hypothesised.
  deviceSettingsStore.reset('projectSidebarCollapsed');
  sdk.notify();
});

/** The section's own header, found by the heading text the user reads. */
function boardsHeader() {
  return screen.queryByText('Boards');
}

function boardMenu(name: string) {
  fireEvent.click(screen.getByRole('button', { name: `${name} actions` }));
}

describe('the Boards section is hidden until there is a Board', () => {
  test('no Boards and no shared Boards renders no section at all', async () => {
    await renderSidebar(<ProjectSidebar />);
    expect(boardsHeader()).toBeNull();
    // Not merely a hidden heading: the section contributes no control either,
    // so the panel is byte-for-byte the panel that shipped before #2062.
    expect(screen.queryByRole('button', { name: 'New Board' })).toBeNull();
    // The rest of the panel is intact — this is an absent section, not a
    // crashed one.
    expect(screen.getByText('Projects')).toBeDefined();

    // The absence above is a DECISION, not an unresolved lazy chunk. Both
    // look identical from outside, so this proves the difference: publishing
    // a Board with no further awaiting makes the header appear, which is only
    // possible if the section was already mounted and chose to render null.
    boards.push({ slug: 'daily', name: 'Daily brief' });
    act(() => {
      sdk.notify();
    });
    expect(boardsHeader()).not.toBeNull();
  });

  test('one Board brings the section back, above Projects', async () => {
    boards.push({ slug: 'daily', name: 'Daily brief' });
    await renderSidebar(<ProjectSidebar />);
    const header = boardsHeader();
    expect(header).not.toBeNull();
    expect(screen.getByRole('button', { name: 'Daily brief' })).toBeDefined();
    // D3 puts Boards between Activity and Projects. Compared by document
    // order rather than by asserting a DOM parent, so a restyle that keeps
    // the order keeps this true.
    const projectsHeader = screen.getByText('Projects');
    expect(
      header!.compareDocumentPosition(projectsHeader) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    const activityRow = screen.getByRole('button', { name: 'Activity' });
    expect(
      activityRow.compareDocumentPosition(header!) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });
});

describe('creating a Board from the panel', () => {
  /**
   * DISCLOSED GAP, pinned rather than papered over. #2062 asks for two things
   * that meet here: the section is hidden when the viewer has no Boards, and
   * the section's `+` is what creates one. Together they mean the panel
   * offers no way to create the FIRST Board — the `+` only exists once a
   * Board does.
   *
   * This is the acceptance criterion implemented as written, and the cost
   * named. The fix is a product decision the epic owns (a palette entry, or
   * an empty-state row that contradicts "hidden"), not something to invent
   * here — and a test asserting the absence is how the next reader finds out
   * instead of rediscovering it.
   */
  test('with no Boards the panel offers no way to create the first one', async () => {
    await renderSidebar(<ProjectSidebar />);
    expect(screen.queryByRole('button', { name: 'New Board' })).toBeNull();
  });

  /**
   * #2062 review MED-6. The panel half of the command-palette entry: the REAL
   * `ProjectSidebar` answering the REAL trigger the palette's `run` calls.
   *
   * Split across two files on purpose, and this is the honest reason: the
   * palette's harness and this one mock `@kontourai/station-sdk` differently,
   * and module mocks are per-file, so mounting the palette here would give it
   * a stub missing most of what it reaches — the exact failure BLOCKING-1 was.
   * `CommandPalette.test.tsx` drives the real palette and asserts its "New
   * Board" row dispatches; this drives the real panel and asserts what the
   * dispatch does. Both import `requestNewBoard` itself rather than writing
   * the event name down, so the two halves cannot drift apart without one of
   * them going red.
   */
  test('the command palette trigger creates the first Board and opens it', async () => {
    // The viewer has NONE — the whole point of the entry. The section renders
    // nothing at all here, so there is no `+` to click.
    await renderSidebar(<ProjectSidebar />);
    expect(screen.queryByRole('button', { name: 'New Board' })).toBeNull();

    // Two steps, not one `await act(async ...)`, and the split is what gives
    // the focus assertion below its power. The palette's row click is a
    // DISCRETE event, so React flushes the `onSuccess` state update on its
    // own — with the new row not yet in the list. Wrapping both in one async
    // act lets React defer that commit until after the refetch microtask has
    // landed, which silently merges the two commits production keeps apart
    // and makes an effect-based focus look like it works.
    act(() => {
      requestNewBoard();
    });
    await act(async () => {});

    expect(calls.create).toEqual([
      { slug: 'untitled-board', name: 'Untitled Board' },
    ]);
    // Opened, because the caller was not looking at the panel.
    expect(navigate).toHaveBeenCalledWith('/boards/untitled-board');
    // ...and named, not merely created: the caret is in the new row.
    const input = screen.getByRole('textbox', {
      name: 'Rename Untitled Board',
    });
    expect(document.activeElement).toBe(input);
  });

  /**
   * #2062 review F1. The panel lives inside the mobile drawer, which carries
   * `aria-hidden={isMobile && !mobileOpen}`, and the drawer is normally closed
   * when the palette is used — so entering rename mode here would focus an
   * input the user cannot see, inside a subtree screen readers are told does
   * not exist.
   *
   * This whole harness hardcoded `useIsMobile: () => false` until now, which
   * is the only reason that shipped. The viewport is a fixture from here on.
   */
  test('on a phone the palette creates and opens without focusing a hidden input', async () => {
    viewport.isMobile = true;
    await renderSidebar(<ProjectSidebar />);

    act(() => {
      requestNewBoard();
    });
    await act(async () => {});

    // The gesture still does its job: the Board exists and the user is taken
    // to it.
    expect(calls.create).toEqual([
      { slug: 'untitled-board', name: 'Untitled Board' },
    ]);
    expect(navigate).toHaveBeenCalledWith('/boards/untitled-board');

    // What it must NOT do is put the caret somewhere invisible.
    //
    // This case is specifically the DRAWER-CLOSED one, which is the state the
    // panel is in when the palette is used: `useProjectSidebarState` starts
    // `mobileOpen` at false and nothing persists it. The assertion below says
    // so outright rather than pretending to be general — an earlier comment
    // here claimed the property form "keeps holding if the panel is ever
    // open", which the unconditional aria-hidden check on the next line
    // plainly contradicts (#2062 review L2).
    const nav = document.querySelector('nav');
    const active = document.activeElement as HTMLElement | null;
    expect(nav?.getAttribute('aria-hidden')).toBe('true');
    expect(
      Boolean(nav && active && nav.contains(active)),
      'focus is inside the hidden drawer',
    ).toBe(false);
    // `hidden: true` is load-bearing: Testing Library's default excludes
    // everything inside an `aria-hidden` subtree, which is exactly where this
    // input would mount — so the default query could never fail and the whole
    // test rested on the focus check above (#2062 review L1). With hidden
    // elements included, this independently asserts that rename mode was not
    // entered at all.
    expect(
      screen.queryByRole('textbox', {
        name: 'Rename Untitled Board',
        hidden: true,
      }),
    ).toBeNull();
  });

  /**
   * #2062 review L3 — the drawer-OPEN mobile case, which is reachable:
   * `ProjectSidebarFooter.tsx` dispatches `open-command-palette` from inside
   * the drawer without closing it, so a phone user can run New Board with the
   * panel still covering the screen.
   *
   * The first pass at F1 dropped `onAfterNavigate` along with rename mode,
   * which left that user on a Board hidden behind the panel that made it.
   * Restored, and pinned here — an injection removing the call again passed
   * every other case in this file.
   *
   * The drawer is opened through the real mechanism (`toggle-sidebar`, the
   * event `useProjectSidebarState` listens on), not by reaching into state.
   */
  test('on a phone with the drawer open, the palette closes it and hands focus back out', async () => {
    viewport.isMobile = true;
    // The drawer's focus restore runs in a frame callback, so it has to be
    // drivable. Mirrors `ProjectSidebarReturnFocus.test.tsx`.
    const frame: { callback: FrameRequestCallback | null } = { callback: null };
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      frame.callback = cb;
      return 1;
    });
    vi.stubGlobal('cancelAnimationFrame', () => {});

    // The trigger that opened the drawer, OUTSIDE it — which is what the real
    // dispatchers send and where focus has to end up.
    const opener = document.createElement('button');
    opener.setAttribute('aria-label', 'Open navigation');
    document.body.append(opener);

    await renderSidebar(<ProjectSidebar />);

    await act(async () => {
      // `detail.trigger` is load-bearing and a bare `new Event` was the
      // earlier mistake (#2062 review F3): without it `mobileTriggerRef`
      // falls back to `document.body`, `captureReturnFocus` returns an empty
      // chain, and NOTHING restores focus — so the test's own drawer-open
      // state stranded focus inside the hidden drawer while asserting
      // nothing about it. Sent faithfully here, as the sibling suite does.
      window.dispatchEvent(
        new CustomEvent('toggle-sidebar', { detail: { trigger: opener } }),
      );
    });
    // Precondition, asserted rather than assumed: the panel really is open,
    // so the close below is an observation and not a restatement of the
    // default.
    expect(
      document.querySelector('nav')?.getAttribute('aria-hidden'),
    ).toBeNull();

    act(() => {
      requestNewBoard();
    });
    await act(async () => {});

    expect(navigate).toHaveBeenCalledWith('/boards/untitled-board');
    expect(document.querySelector('nav')?.getAttribute('aria-hidden')).toBe(
      'true',
    );

    // ...and focus is handed back OUT of the drawer that just closed, which
    // is what actually makes closing it safe. Note what is NOT true here:
    // `document.activeElement` at the close is `document.body`, not the
    // palette button — the palette closes before running the command, defers
    // its focus restore a frame, and mounts outside this `nav`. The assertion
    // with direct power is the `toBe(opener)` below; the containment check
    // above it passes trivially on a pristine tree.
    await act(async () => {
      frame.callback?.(0);
    });
    const active = document.activeElement as HTMLElement | null;
    const nav = document.querySelector('nav');
    expect(
      Boolean(nav && active && nav.contains(active)),
      'focus was left inside the closed drawer',
    ).toBe(false);
    expect(active).toBe(opener);

    vi.unstubAllGlobals();
    opener.remove();
  });

  test('on a desktop the same gesture does enter rename', async () => {
    // The discriminating half of the case above: without it, a change that
    // skipped rename mode everywhere would satisfy F1 and quietly remove the
    // naming step the gesture exists for.
    await renderSidebar(<ProjectSidebar />);
    act(() => {
      requestNewBoard();
    });
    await act(async () => {});
    expect(
      screen.getByRole('textbox', { name: 'Rename Untitled Board' }),
    ).toBeDefined();
  });

  /**
   * #2062 review F2. `openOnCreate` is set before the mutation and cleared
   * when it succeeds; a create the server refuses never reaches `onSuccess`,
   * so the flag stayed true and the NEXT create — an ordinary `+` — behaved
   * like a palette one and navigated the user away from where they were.
   */
  test('a refused palette create does not make the next + navigate', async () => {
    boards.push({ slug: 'daily', name: 'Daily brief' });
    createOutcome.rejects = true;
    await renderSidebar(<ProjectSidebar />);

    act(() => {
      requestNewBoard();
    });
    await act(async () => {});
    // Nothing was created and nothing was opened.
    expect(navigate).not.toHaveBeenCalled();

    // Now an ordinary `+`, which succeeds.
    createOutcome.rejects = false;
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'New Board' }));
    });

    expect(calls.create).toHaveLength(2);
    // The `+` never navigates. Before the fix this fired once, carrying the
    // user to a Board they had not asked to open.
    expect(navigate).not.toHaveBeenCalled();
  });

  test('a palette-created Board takes the next free slug like the + does', async () => {
    boards.push({ slug: 'untitled-board', name: 'Untitled Board' });
    await renderSidebar(<ProjectSidebar />);

    act(() => {
      requestNewBoard();
    });
    await act(async () => {});

    // The derivation is the gesture's, not the caller's — this is what makes
    // the palette entry the same create rather than a second one.
    expect(calls.create).toEqual([
      { slug: 'untitled-board-2', name: 'Untitled Board' },
    ]);
  });

  test('+ does not navigate away from the list the new row joins', async () => {
    boards.push({ slug: 'daily', name: 'Daily brief' });
    await renderSidebar(<ProjectSidebar />);

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'New Board' }));
    });

    expect(calls.create).toHaveLength(1);
    // The two origins differ ONLY here, so the difference is pinned on both
    // sides: the palette case above asserts the navigate, this asserts its
    // absence. Without this, `openOnCreate` could be stuck true and only the
    // happy path would notice.
    expect(navigate).not.toHaveBeenCalled();
  });

  test('+ on an existing section creates the next free slug and enters rename', async () => {
    boards.push({ slug: 'untitled-board', name: 'Untitled Board' });
    await renderSidebar(<ProjectSidebar />);

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'New Board' }));
    });

    // The slug is derived, not typed: `untitled-board` is taken, so the
    // create must not repeat it (the server answers 409 for a repeat).
    expect(calls.create).toEqual([
      { slug: 'untitled-board-2', name: 'Untitled Board' },
    ]);
    // ...and the panel puts the caret in the new Board's name, because a
    // placeholder name is only half the gesture.
    const input = screen.getAllByRole('textbox', {
      name: 'Rename Untitled Board',
    })[0];
    expect(document.activeElement).toBe(input);
  });

  test('the slug derivation skips every taken name in order', async () => {
    expect(nextBoardSlug([])).toBe('untitled-board');
    expect(nextBoardSlug(['untitled-board'])).toBe('untitled-board-2');
    expect(nextBoardSlug(['untitled-board', 'untitled-board-2'])).toBe(
      'untitled-board-3',
    );
    // A gap is reused rather than skipped: nothing depends on the number
    // being monotonic, and the shortest free name is the friendliest URL.
    expect(nextBoardSlug(['untitled-board', 'untitled-board-3'])).toBe(
      'untitled-board-2',
    );
    // The create control answers to "New Board". No derived slug may collide
    // with a Board a user could plausibly have named that, which is why the
    // placeholder is "Untitled" — pinned here so a future rename of the
    // placeholder has to look at this.
    expect(nextBoardSlug([]).startsWith('new-board')).toBe(false);
  });
});

/**
 * #2062 review M1 — the row menu's trigger must be VISIBLE on touch.
 *
 * Modelled on `ProjectSidebarReorder.test.tsx`'s coarse-pointer assertion,
 * including its limits: jsdom evaluates no media query and computes no
 * layout, so this pins the stylesheet's own text, and every assertion is
 * scoped to the rule it is about — an unscoped `css.toContain('opacity: 1')`
 * is satisfied by any rule in the file and discriminates nothing.
 *
 * It matters because of what the rest of this file establishes: the section
 * is hidden when the viewer owns no Boards, so the `+` is unreachable; the
 * palette is their only entry point; and it deliberately does not open rename
 * on touch. The row menu is therefore the ONLY way to rename a Board on a
 * phone, and a trigger revealed by `:hover` is not a trigger there —
 * `:focus-within` cannot rescue it either, because tapping the row navigates
 * and closes the drawer.
 */
describe('the Boards row menu on touch (#2062)', () => {
  const boardsCss = () =>
    readFileSync(
      join(
        dirname(fileURLToPath(import.meta.url)),
        '../components/project-sidebar/ProjectSidebarBoards.css',
      ),
      'utf8',
    );

  /**
   * #2062 review F1 — the trigger must not sit on top of the menu it opens.
   *
   * It is `position: absolute` and centred with `top: 50%`, so what it
   * centres on is whichever ancestor is positioned. When that was the whole
   * row, opening a menu grew the row from 44px to ~138px and slid the trigger
   * down onto the menu's first item: a tap on Rename hit the trigger and
   * closed the menu (measured in Chromium at 33x27px of overlap).
   *
   * jsdom computes no layout, so this asserts the CONTAINMENT that makes the
   * geometry impossible rather than the pixels: the trigger shares a
   * positioned box with the row's own line, and the menu is outside that box.
   * Both halves are needed — the trigger being inside the wrapper proves
   * nothing if the menu is in there with it.
   */
  test('the open menu is outside the box the trigger is positioned against', async () => {
    boards.push({ slug: 'daily', name: 'Daily brief' });
    await renderSidebar(<ProjectSidebar />);
    boardMenu('Daily brief');

    const trigger = screen.getByRole('button', {
      name: 'Daily brief actions',
    });
    const menu = screen.getByRole('menu');
    const main = document.querySelector('.sidebar__board-row-main');
    expect(main).not.toBeNull();

    // The positioned ancestor the trigger resolves against.
    expect(main?.contains(trigger)).toBe(true);
    // ...and the menu is NOT in it, so opening one cannot move the trigger.
    expect(main?.contains(menu)).toBe(false);
    // Both are still in the same row, which is what keeps the menu attached
    // to the Board it belongs to.
    const row = document.querySelector('.sidebar__board-row');
    expect(row?.contains(menu)).toBe(true);
    expect(row?.contains(trigger)).toBe(true);

    // The row grows for all three menu modes, not just this one, so all three
    // have to sit outside the positioned box or the overlap returns for
    // whichever was left in. Asserting only the first would leave the other
    // two free to regress.
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete' }));
    const confirmMenu = screen.getByRole('menu');
    expect(confirmMenu.textContent).toContain('Delete Daily brief?');
    expect(main?.contains(confirmMenu)).toBe(false);
    expect(row?.contains(confirmMenu)).toBe(true);

    fireEvent.click(screen.getByRole('menuitem', { name: 'Cancel' }));
    boardMenu('Daily brief');
    fireEvent.click(screen.getByRole('menuitem', { name: 'Move to project…' }));
    const pickMenu = screen.getByRole('menu');
    expect(main?.contains(pickMenu)).toBe(false);
    expect(row?.contains(pickMenu)).toBe(true);

    // The wrapper is the positioned box, not merely a div: without this the
    // trigger would resolve against the row again and the overlap returns.
    const boardsCssText = readFileSync(
      join(
        dirname(fileURLToPath(import.meta.url)),
        '../components/project-sidebar/ProjectSidebarBoards.css',
      ),
      'utf8',
    );
    const mainRule = boardsCssText.slice(
      boardsCssText.indexOf('\n.sidebar__board-row-main {'),
    );
    expect(mainRule.slice(0, mainRule.indexOf('\n}'))).toContain(
      'position: relative',
    );
  });

  test('the row-menu trigger is always visible at the 44px floor on coarse pointers', () => {
    const css = boardsCss();
    /** The declarations of the first rule whose selector line matches. */
    const ruleBody = (selector: string): string => {
      const start = css.indexOf(`\n${selector} {`);
      expect(start).toBeGreaterThan(-1);
      const from = start + selector.length + 4;
      return css.slice(from, css.indexOf('\n}', from));
    };

    // The base rule is hover-revealed, which is correct for a pointer and is
    // the whole problem on touch. Pinned so the coarse block below is not
    // asserting against a default that quietly changed.
    expect(ruleBody('.sidebar__board-menu-trigger')).toContain('opacity: 0');

    const coarseStart = css.indexOf('@media (pointer: coarse)');
    expect(coarseStart).toBeGreaterThan(-1);
    const coarse = css.slice(coarseStart);
    const coarseBlock = coarse.slice(0, coarse.indexOf('}\n}'));

    // Scoped to the RULE inside the block, not to the block (#2062 review
    // F4). Block-scoped `toContain` was satisfied by any rule in there: a
    // probe that gutted the trigger's own declarations and added a sibling
    // rule carrying them passed all five assertions, which is the same
    // discriminates-nothing failure the base-rule helper above exists to
    // avoid.
    const coarseRuleBody = (selector: string): string => {
      const start = coarseBlock.indexOf(`\n  ${selector} {`);
      expect(start).toBeGreaterThan(-1);
      const from = start + selector.length + 6;
      return coarseBlock.slice(from, coarseBlock.indexOf('\n  }', from));
    };
    const trigger = coarseRuleBody('.sidebar__board-menu-trigger');
    expect(trigger).toContain('opacity: 1');
    expect(trigger).toContain('min-height: 44px');
    expect(trigger).toContain('min-width: 44px');
    // The base rule's 0 must not survive into THIS rule. Asserted here rather
    // than across the whole block, where it would go red the first time some
    // unrelated selector legitimately wanted `opacity: 0` on touch.
    expect(trigger).not.toContain('opacity: 0');
  });
});

/**
 * #2083 — the row menu now behaves like the role it declares.
 *
 * Before this, `role="menu"` was a bare attribute: nothing moved focus into
 * the menu, arrows did nothing, Escape did nothing, a press elsewhere left it
 * open, and collapsing the rail hid it with `mode` still set. The a11y ratchet
 * reported zero violations throughout, because none of that is a violation of
 * anything it checks.
 *
 * The behaviour comes from `useMenuFocus`, the same hook the header, dock and
 * turn menus use, so these cases are about THIS menu being wired to it — which
 * is exactly what the hook's own tests cannot say. They drive the real
 * `ProjectSidebar` and reach the menu the way a person does.
 *
 * FOCUS THE TRIGGER BEFORE OPENING. `fireEvent.click` does not move focus, and
 * the primitive's focus return is captured from `document.activeElement` at the
 * moment the menu opens — so a test that only clicked would be asking the
 * restore to return focus to `<body>`, which the shared module deliberately
 * refuses. A real pointer or keyboard user focuses the trigger; these do too.
 */
describe('the Boards row menu behaves like the role it declares (#2083)', () => {
  /** Focuses the row's `⋯` the way a pointer does, then opens it. */
  function openBoardMenu(name: string): HTMLElement {
    const trigger = screen.getByRole('button', { name: `${name} actions` });
    act(() => {
      trigger.focus();
      fireEvent.click(trigger);
    });
    return trigger;
  }

  test('opening the menu moves focus into it', async () => {
    boards.push({ slug: 'daily', name: 'Daily brief' });
    await renderSidebar(<ProjectSidebar />);

    const trigger = openBoardMenu('Daily brief');
    // Focus is INSIDE the menu, on its first command — not left behind on the
    // trigger, which is where it sat before and which made the open menu
    // something Tab walked past rather than into.
    expect(document.activeElement).not.toBe(trigger);
    expect(document.activeElement).toBe(
      screen.getByRole('menuitem', { name: 'Rename' }),
    );
    expect(screen.getByRole('menu').contains(document.activeElement)).toBe(
      true,
    );
  });

  test('ArrowDown and ArrowUp move focus between the items, and wrap', async () => {
    boards.push({ slug: 'daily', name: 'Daily brief' });
    await renderSidebar(<ProjectSidebar />);
    openBoardMenu('Daily brief');

    const rename = screen.getByRole('menuitem', { name: 'Rename' });
    const move = screen.getByRole('menuitem', { name: 'Move to project…' });
    const remove = screen.getByRole('menuitem', { name: 'Delete' });
    expect(document.activeElement).toBe(rename);

    const arrow = (key: 'ArrowDown' | 'ArrowUp') => {
      act(() => {
        fireEvent.keyDown(document.activeElement ?? document.body, { key });
      });
    };

    arrow('ArrowDown');
    expect(document.activeElement).toBe(move);
    arrow('ArrowDown');
    expect(document.activeElement).toBe(remove);
    // A menu wraps; the last row's Down is not a dead key.
    arrow('ArrowDown');
    expect(document.activeElement).toBe(rename);
    arrow('ArrowUp');
    expect(document.activeElement).toBe(remove);
  });

  test('Escape closes the menu and returns focus to the trigger', async () => {
    boards.push({ slug: 'daily', name: 'Daily brief' });
    await renderSidebar(<ProjectSidebar />);
    const trigger = openBoardMenu('Daily brief');

    act(() => {
      fireEvent.keyDown(document.activeElement ?? document.body, {
        key: 'Escape',
      });
    });

    expect(screen.queryByRole('menu')).toBeNull();
    // Closing must not strand focus on `<body>`: the trigger is where the user
    // was, and it is the control that reopens the menu.
    expect(document.activeElement).toBe(trigger);
    // Dismissing is not choosing. Escape must not rename, delete or move.
    expect(calls.update).toEqual([]);
    expect(calls.remove).toEqual([]);
    expect(calls.promote).toEqual([]);
  });

  test('a pointer press outside the menu dismisses it', async () => {
    boards.push({ slug: 'daily', name: 'Daily brief' });
    await renderSidebar(<ProjectSidebar />);
    openBoardMenu('Daily brief');
    expect(screen.queryByRole('menu')).not.toBeNull();

    // A real element elsewhere in the panel, not `document.body`: pressing
    // ordinary page furniture is the case focus-based dismissal cannot see,
    // because furniture does not take focus.
    act(() => {
      fireEvent.pointerDown(screen.getByText('Projects'));
    });
    expect(screen.queryByRole('menu')).toBeNull();

    // ...and a press INSIDE the menu is not a dismissal, or choosing a command
    // would close the menu before the click that chose it landed.
    openBoardMenu('Daily brief');
    act(() => {
      fireEvent.pointerDown(screen.getByRole('menuitem', { name: 'Rename' }));
    });
    expect(screen.queryByRole('menu')).not.toBeNull();
  });

  test('the trigger still closes the menu it opened', async () => {
    boards.push({ slug: 'daily', name: 'Daily brief' });
    await renderSidebar(<ProjectSidebar />);
    const trigger = openBoardMenu('Daily brief');
    expect(screen.queryByRole('menu')).not.toBeNull();

    // The full gesture, pointerdown included — in TWO `act` blocks, which is
    // the whole test. A browser delivers `pointerdown` and `click` as separate
    // tasks with a render between them, so the click handler reads the state
    // the pointer press left behind. Batched into one `act` React never
    // re-renders, the click closure still holds the stale `open === true`, and
    // the menu closes for a reason that has nothing to do with the guard:
    // measured, not assumed — with both events in one block, deleting
    // `ref={open ? openTriggerRef : undefined}` left this suite 30/30 green.
    act(() => {
      fireEvent.pointerDown(trigger);
    });
    act(() => {
      fireEvent.click(trigger);
    });
    // Without the trigger's exemption the press closes the menu and the click
    // that follows reopens it, so the toggle appears to do nothing.
    expect(screen.queryByRole('menu')).toBeNull();
  });

  /**
   * THE TRANSITION CASES, and the reason the component calls `useMenuFocus`
   * three times rather than once (`ProjectSidebarBoards.tsx`).
   *
   * The hook keys its effects on an open flag. A single call keyed on "some
   * menu is open" stays true across menu → confirm and menu → picker, so it
   * would not re-run: focus would never enter the surface that just mounted and
   * the roving-key listener would stay bound to the container React has already
   * removed. That argument was written in a comment and asserted by nothing,
   * which meant the exact refactor it warns against would have landed green.
   * These two cases are what make it a claim about the product.
   *
   * They matter beyond the refactor. The Delete confirm is reached on a phone
   * from the only surface that offers rename and delete at all, and before
   * these its focus entry, arrows, focusout and Escape were all untested.
   */
  test('the delete confirm takes focus and its own arrow keys', async () => {
    boards.push({ slug: 'daily', name: 'Daily brief' });
    await renderSidebar(<ProjectSidebar />);
    openBoardMenu('Daily brief');

    act(() => {
      fireEvent.click(screen.getByRole('menuitem', { name: 'Delete' }));
    });

    // A DIFFERENT surface, so focus has to move again. The confirm's own first
    // command — not the row the user just left, which React has removed.
    const confirmDelete = screen.getByRole('menuitem', { name: 'Delete' });
    const cancel = screen.getByRole('menuitem', { name: 'Cancel' });
    expect(document.activeElement).toBe(confirmDelete);

    const arrow = (key: 'ArrowDown' | 'ArrowUp') => {
      act(() => {
        fireEvent.keyDown(document.activeElement ?? document.body, { key });
      });
    };
    arrow('ArrowDown');
    expect(document.activeElement).toBe(cancel);
    arrow('ArrowDown');
    expect(document.activeElement).toBe(confirmDelete);
    arrow('ArrowUp');
    expect(document.activeElement).toBe(cancel);

    // Escape dismisses the confirm without deleting — the irreversible command
    // is a press, never a dismissal.
    act(() => {
      fireEvent.keyDown(document.activeElement ?? document.body, {
        key: 'Escape',
      });
    });
    expect(screen.queryByRole('menu')).toBeNull();
    expect(calls.remove).toEqual([]);
    // Not stranded on `<body>`. The trigger that opened THIS surface was a
    // menu row the transition removed, so the shared return-focus module falls
    // back to the nearest surviving ancestor; what is asserted is the contract
    // that matters — focus is still somewhere inside the Board's own row.
    const row = document.querySelector('.sidebar__board-row');
    expect(row?.contains(document.activeElement)).toBe(true);
  });

  test('the project picker takes focus of its own', async () => {
    boards.push({ slug: 'daily', name: 'Daily brief' });
    projects.push(
      { id: '1', slug: 'demo', name: 'Demo' },
      { id: '2', slug: 'other', name: 'Other' },
    );
    await renderSidebar(<ProjectSidebar />);
    openBoardMenu('Daily brief');

    act(() => {
      fireEvent.click(
        screen.getByRole('menuitem', { name: 'Move to project…' }),
      );
    });

    expect(document.activeElement).toBe(
      screen.getByRole('menuitem', { name: 'Demo' }),
    );
    act(() => {
      fireEvent.keyDown(document.activeElement ?? document.body, {
        key: 'ArrowDown',
      });
    });
    expect(document.activeElement).toBe(
      screen.getByRole('menuitem', { name: 'Other' }),
    );

    // Dismissing the picker moves no Board. Promote is the one command here
    // that silently takes a record out of the personal list.
    act(() => {
      fireEvent.keyDown(document.activeElement ?? document.body, {
        key: 'Escape',
      });
    });
    expect(screen.queryByRole('menu')).toBeNull();
    expect(calls.promote).toEqual([]);
    expect(screen.getByRole('button', { name: 'Daily brief' })).toBeDefined();
  });

  test('collapsing the rail closes the menu rather than stranding it', async () => {
    boards.push({ slug: 'daily', name: 'Daily brief' });
    await renderSidebar(<ProjectSidebar />);
    openBoardMenu('Daily brief');
    expect(screen.queryByRole('menu')).not.toBeNull();

    act(() => {
      fireEvent.click(screen.getByRole('button', { name: 'Collapse sidebar' }));
    });
    // The menu is GONE, not merely hidden by `.sidebar--collapsed`. jsdom
    // applies no stylesheet, so a menu still in the tree is still found here —
    // which is precisely the stranded state: the collapsed rail renders no
    // trigger, so nothing on screen could dismiss it.
    expect(screen.queryByRole('menu')).toBeNull();

    act(() => {
      fireEvent.click(screen.getByRole('button', { name: 'Expand sidebar' }));
    });
    // Re-expanding must not reopen a menu nobody asked for — the second half
    // of the same defect, and the half a CSS-only fix would leave behind.
    expect(screen.queryByRole('menu')).toBeNull();
    expect(
      screen.getByRole('button', { name: 'Daily brief actions' }),
    ).toBeDefined();
  });

  test('the menu rows are the shared menu primitive, which carries the 44px touch floor', async () => {
    boards.push({ slug: 'daily', name: 'Daily brief' });
    projects.push({ id: '1', slug: 'demo', name: 'Demo' });
    await renderSidebar(<ProjectSidebar />);

    // MEASURED HALF: the rows this component actually renders wear the shared
    // class. This is a DOM observation of the real panel, and it is the half
    // that used to be false — the rows carried no class at all and took their
    // `padding: 6px 8px` at `--text-sm` from a descendant selector in
    // `ProjectSidebarBoards.css`, about 26px against a 44px requirement.
    const rowClasses = () =>
      screen
        .getAllByRole('menuitem')
        .map((row) => [...row.classList].includes('menu-row'));

    openBoardMenu('Daily brief');
    expect(rowClasses()).toEqual([true, true, true]);
    // All three surfaces, because all three are menus the finger reaches.
    act(() => {
      fireEvent.click(screen.getByRole('menuitem', { name: 'Delete' }));
    });
    expect(rowClasses()).toEqual([true, true]);
    act(() => {
      fireEvent.click(screen.getByRole('menuitem', { name: 'Cancel' }));
    });
    openBoardMenu('Daily brief');
    act(() => {
      fireEvent.click(
        screen.getByRole('menuitem', { name: 'Move to project…' }),
      );
    });
    expect(rowClasses()).toEqual([true]);

    // TEXT-PINNED HALF, and it is text-pinned rather than measured: jsdom
    // computes no layout, and `menu-primitive.cascade.test.tsx` measures this
    // family's FINE-pointer 32px floor in a real Chromium, not the coarse
    // branch. What is asserted here is that the coarse rule exists and says
    // 44px — scoped to the rule, not to the block, following the trigger's own
    // coarse assertion above.
    const chatCss = readFileSync(
      join(
        dirname(fileURLToPath(import.meta.url)),
        '../components/chat/chat.css',
      ),
      'utf8',
    );
    const coarseStart = chatCss.indexOf(
      '@media (max-width: 768px), (pointer: coarse) {\n  .menu-row.menu-row {',
    );
    expect(coarseStart).toBeGreaterThan(-1);
    const coarseRule = chatCss.slice(
      chatCss.indexOf('{', chatCss.indexOf('.menu-row.menu-row', coarseStart)),
    );
    expect(coarseRule.slice(0, coarseRule.indexOf('}'))).toContain(
      'min-height: 44px',
    );

    // ...and nothing page-local overrides it back down. The descendant rule
    // that sized these rows is gone, and a new one would win on specificity
    // over a single-class base rule in another sheet.
    const boardsCssText = readFileSync(
      join(
        dirname(fileURLToPath(import.meta.url)),
        '../components/project-sidebar/ProjectSidebarBoards.css',
      ),
      'utf8',
    );
    // The retired descendant rule — the one that sized these rows at about
    // 26px — is gone and stays gone.
    expect(boardsCssText).not.toContain('.sidebar__board-menu button');
    // ...and nothing page-local takes the row's HEIGHT back. Scoped to height
    // rather than to the selector's existence, because this menu legitimately
    // owns one row declaration: the `padding-block` its wrapping picker labels
    // need, which the family's single-line members do not. A blanket "no
    // page-local row rule" assertion would have forbidden that too, and the
    // defect it exists to catch is a floor override, not a rule.
    const rowRuleStart = boardsCssText.indexOf(
      '\n.sidebar__board-menu .menu-row {',
    );
    if (rowRuleStart > -1) {
      const rowRule = boardsCssText.slice(rowRuleStart);
      expect(rowRule.slice(0, rowRule.indexOf('\n}'))).not.toContain('height');
    }

    // The one declaration this menu keeps, pinned because dropping it is
    // invisible in a diff and near-invisible on screen: `.menu-surface` fills
    // with `--bg-secondary`, which is the same `--k-panel` the rail itself
    // uses, so without this the menu reads as an outline drawn on the panel
    // rather than a surface raised off it.
    const menuRule = boardsCssText.slice(
      boardsCssText.indexOf('\n.sidebar__board-menu {'),
    );
    expect(menuRule.slice(0, menuRule.indexOf('\n}'))).toContain(
      'background: var(--bg-tertiary)',
    );
  });
});

describe('renaming a Board from the panel', () => {
  test('the row menu opens an input, and Enter renames the Board', async () => {
    boards.push({ slug: 'daily', name: 'Daily brief' });
    await renderSidebar(<ProjectSidebar />);

    boardMenu('Daily brief');
    act(() => {
      fireEvent.click(screen.getByRole('menuitem', { name: 'Rename' }));
    });
    const input = screen.getByRole('textbox', { name: 'Rename Daily brief' });
    fireEvent.change(input, { target: { value: 'Morning' } });
    act(() => {
      fireEvent.keyDown(input, { key: 'Enter' });
    });

    expect(calls.update).toEqual([
      { layoutSlug: 'daily', update: { name: 'Morning' } },
    ]);
    // The renamed row is what the panel shows afterwards — the write reached
    // the list the panel reads, not just the spy.
    expect(screen.getByRole('button', { name: 'Morning' })).toBeDefined();
  });

  test('Escape discards the edit and writes nothing', async () => {
    boards.push({ slug: 'daily', name: 'Daily brief' });
    await renderSidebar(<ProjectSidebar />);

    boardMenu('Daily brief');
    act(() => {
      fireEvent.click(screen.getByRole('menuitem', { name: 'Rename' }));
    });
    const input = screen.getByRole('textbox', { name: 'Rename Daily brief' });
    fireEvent.change(input, { target: { value: 'Discarded' } });
    act(() => {
      fireEvent.keyDown(input, { key: 'Escape' });
    });

    expect(calls.update).toEqual([]);
    // Escape's discard IS the unmount: the input is gone, which is what makes
    // the blur-commit unreachable afterwards. Asserted as the observable —
    // firing a blur at the detached node would prove nothing, because the
    // browser does not deliver one either.
    expect(
      screen.queryByRole('textbox', { name: 'Rename Daily brief' }),
    ).toBeNull();
    expect(screen.getByRole('button', { name: 'Daily brief' })).toBeDefined();
  });

  test('clicking away commits the typed name', async () => {
    boards.push({ slug: 'daily', name: 'Daily brief' });
    await renderSidebar(<ProjectSidebar />);
    boardMenu('Daily brief');
    act(() => {
      fireEvent.click(screen.getByRole('menuitem', { name: 'Rename' }));
    });
    const input = screen.getByRole('textbox', { name: 'Rename Daily brief' });
    fireEvent.change(input, { target: { value: 'Morning' } });
    act(() => {
      fireEvent.blur(input);
    });
    expect(calls.update).toEqual([
      { layoutSlug: 'daily', update: { name: 'Morning' } },
    ]);
  });

  test('a rename to the same name writes nothing', async () => {
    boards.push({ slug: 'daily', name: 'Daily brief' });
    await renderSidebar(<ProjectSidebar />);
    boardMenu('Daily brief');
    act(() => {
      fireEvent.click(screen.getByRole('menuitem', { name: 'Rename' }));
    });
    act(() => {
      fireEvent.keyDown(
        screen.getByRole('textbox', { name: 'Rename Daily brief' }),
        { key: 'Enter' },
      );
    });
    expect(calls.update).toEqual([]);
  });
});

describe('deleting a Board from the panel', () => {
  test('the row menu confirms first, then removes the Board', async () => {
    boards.push({ slug: 'daily', name: 'Daily brief' });
    await renderSidebar(<ProjectSidebar />);

    boardMenu('Daily brief');
    act(() => {
      fireEvent.click(screen.getByRole('menuitem', { name: 'Delete' }));
    });
    // Nothing is deleted by opening the confirm — the irreversible step is
    // the second click, not the first.
    expect(calls.remove).toEqual([]);
    expect(screen.getByText('Delete Daily brief?')).toBeDefined();

    act(() => {
      fireEvent.click(screen.getByRole('menuitem', { name: 'Delete' }));
    });
    expect(calls.remove).toEqual(['daily']);
    // Last Board gone, so the whole section goes with it.
    expect(boardsHeader()).toBeNull();
  });

  test('Cancel in the confirm deletes nothing', async () => {
    boards.push({ slug: 'daily', name: 'Daily brief' });
    await renderSidebar(<ProjectSidebar />);
    boardMenu('Daily brief');
    act(() => {
      fireEvent.click(screen.getByRole('menuitem', { name: 'Delete' }));
    });
    act(() => {
      fireEvent.click(screen.getByRole('menuitem', { name: 'Cancel' }));
    });
    expect(calls.remove).toEqual([]);
    expect(screen.getByRole('button', { name: 'Daily brief' })).toBeDefined();
  });
});

describe('promoting a Board from the panel', () => {
  test('the row menu offers the projects and moves the Board into one', async () => {
    boards.push({ slug: 'daily', name: 'Daily brief' });
    projects.push(
      { id: '1', slug: 'demo', name: 'Demo' },
      { id: '2', slug: 'other', name: 'Other' },
    );
    await renderSidebar(<ProjectSidebar />);

    boardMenu('Daily brief');
    act(() => {
      fireEvent.click(
        screen.getByRole('menuitem', { name: 'Move to project…' }),
      );
    });
    const menu = screen.getByRole('menu');
    expect(
      within(menu)
        .getAllByRole('menuitem')
        .map((item) => item.textContent),
    ).toEqual(['Demo', 'Other']);

    act(() => {
      fireEvent.click(within(menu).getByRole('menuitem', { name: 'Other' }));
    });

    expect(calls.promote).toEqual([
      { layoutSlug: 'daily', projectSlug: 'other' },
    ]);
    // A MOVE: the Board is no longer a Board, so the section that listed it
    // is gone. A panel that treated promote as a copy would still show it.
    expect(screen.queryByRole('button', { name: 'Daily brief' })).toBeNull();
    expect(boardsHeader()).toBeNull();
  });

  test('with no projects the picker names the remedy instead of offering nothing', async () => {
    boards.push({ slug: 'daily', name: 'Daily brief' });
    await renderSidebar(<ProjectSidebar />);
    boardMenu('Daily brief');
    act(() => {
      fireEvent.click(
        screen.getByRole('menuitem', { name: 'Move to project…' }),
      );
    });
    expect(
      screen.getByText('Create a project to move this Board into one.'),
    ).toBeDefined();
    expect(calls.promote).toEqual([]);
  });
});

describe('opening a Board', () => {
  test('the row navigates to the Board route and marks itself current there', async () => {
    boards.push({ slug: 'daily', name: 'Daily brief' });
    const first = await renderSidebar(<ProjectSidebar />);
    act(() => {
      fireEvent.click(screen.getByRole('button', { name: 'Daily brief' }));
    });
    expect(navigate).toHaveBeenCalledWith('/boards/daily');
    first.unmount();

    // On that route the row is the current page — exactly one row may claim
    // it, and a Board row is a routed place rather than a placed surface.
    pathname.value = '/boards/daily';
    await renderSidebar(<ProjectSidebar />);
    expect(
      screen
        .getByRole('button', { name: 'Daily brief' })
        .getAttribute('aria-current'),
    ).toBe('page');
  });
});
