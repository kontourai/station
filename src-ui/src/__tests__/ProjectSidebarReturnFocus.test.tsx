/**
 * @vitest-environment jsdom
 */

/**
 * station#1245 — the mobile drawer's return focus.
 *
 * `ProjectSidebar` hand-rolled `if (trigger?.isConnected) trigger.focus()`
 * inside its own `requestAnimationFrame`, so it kept both station#1126 gaps:
 * `isConnected` answers "is it in the document", not "can it take focus", and
 * a trigger the drawer's own navigation removed got nothing at all. It now
 * goes through `@kontourai/station-shared/return-focus`.
 *
 * COVERAGE HONESTY. jsdom, and deliberately scoped to the wiring: that the
 * drawer captures a chain from the toggle that opened it and hands it to the
 * shared module with the nav as the closing surface. The module's own halves
 * are proven in two places because neither suite can cover both —
 * `packages/shared/src/__tests__/return-focus.test.ts` (jsdom: the structural
 * veto) and `tests/dialog-return-focus.spec.ts` (Chromium: whether the focus
 * actually landed, which jsdom reports as successful on a hidden node).
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render } from '@testing-library/react';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('../contexts/ProjectsContext', () => ({
  useProjects: () => ({ projects: [], isLoading: false }),
}));
vi.mock('../contexts/AgentsContext', () => ({
  useAgents: () => [],
}));
vi.mock('../contexts/ActiveChatsContext', () => ({
  useAllActiveChats: () => [],
}));
vi.mock('../contexts/NavigationContext', () => ({
  useNavigation: () => ({
    selectedProject: null,
    selectedProjectLayout: null,
    navigate: vi.fn(),
    pathname: '/',
  }),
}));
vi.mock('../hooks/useBranding', () => ({
  useBranding: () => ({ appName: 'Station' }),
}));
vi.mock('../hooks/useIsMobile', () => ({
  useIsMobile: () => true,
}));

import { ProjectSidebar } from '../components/project-sidebar/ProjectSidebar';

function renderProjectSidebar() {
  return render(
    <QueryClientProvider
      client={
        new QueryClient({
          defaultOptions: { queries: { retry: false } },
        })
      }
    >
      <ProjectSidebar />
    </QueryClientProvider>,
  );
}

/**
 * The drawer schedules both its open-focus and its restore on a frame. A
 * single-slot stub is enough because only one of them is ever pending at a
 * time, and it makes the restore an explicit step rather than a race.
 */
function stubFrame() {
  const frame: { callback: FrameRequestCallback | null } = { callback: null };
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    frame.callback = cb;
    return 1;
  });
  vi.stubGlobal('cancelAnimationFrame', () => {});
  return frame;
}

function toggleDrawer(trigger: HTMLElement) {
  act(() => {
    window.dispatchEvent(
      new CustomEvent('toggle-sidebar', { detail: { trigger } }),
    );
  });
}

let frame: ReturnType<typeof stubFrame>;

beforeEach(() => {
  frame = stubFrame();
});

afterEach(() => {
  vi.unstubAllGlobals();
  // Deliberately not `document.body.innerHTML = ''`: Testing Library's own
  // cleanup removes its container from <body> afterwards and throws if this
  // hook already emptied it. Each test removes the nodes it appended.
});

describe('ProjectSidebar mobile drawer return focus (station#1245)', () => {
  test('restores focus to the hamburger that opened it', () => {
    const header = document.createElement('header');
    const trigger = document.createElement('button');
    header.append(trigger);
    document.body.append(header);
    trigger.focus();

    renderProjectSidebar();
    toggleDrawer(trigger);
    act(() => {
      frame.callback?.(0);
    });
    expect(document.activeElement).not.toBe(trigger);

    toggleDrawer(trigger);
    act(() => {
      frame.callback?.(0);
    });

    expect(document.activeElement).toBe(trigger);
    expect(trigger.hasAttribute('tabindex')).toBe(false);
  });

  /**
   * The drawer's own reason to exist is navigation, and every item in it
   * navigates — so the header the hamburger lives in is routinely replaced by
   * the destination's own. Pre-fix `isConnected` was false and nothing at all
   * happened: focus sat on `<body>`.
   */
  test('falls back to a surviving ancestor when navigation replaced the hamburger', () => {
    const header = document.createElement('header');
    const bar = document.createElement('div');
    const trigger = document.createElement('button');
    bar.append(trigger);
    header.append(bar);
    document.body.append(header);
    trigger.focus();

    renderProjectSidebar();
    toggleDrawer(trigger);
    act(() => {
      frame.callback?.(0);
    });

    // Destination view swapped the toolbar the hamburger was in.
    bar.remove();

    toggleDrawer(trigger);
    act(() => {
      frame.callback?.(0);
    });

    expect(document.activeElement).toBe(header);
    expect(document.activeElement).not.toBe(document.body);
    expect(header.getAttribute('tabindex')).toBe('-1');
  });

  /** Gap 1: whatever the destination focused for itself keeps focus. */
  test('leaves focus alone when the destination already claimed it', () => {
    const header = document.createElement('header');
    const bar = document.createElement('div');
    const trigger = document.createElement('button');
    const destination = document.createElement('input');
    bar.append(trigger);
    header.append(bar);
    document.body.append(header, destination);
    trigger.focus();

    renderProjectSidebar();
    toggleDrawer(trigger);
    act(() => {
      frame.callback?.(0);
    });

    toggleDrawer(trigger);
    bar.remove();
    destination.focus();
    act(() => {
      frame.callback?.(0);
    });

    expect(document.activeElement).toBe(destination);
    expect(header.hasAttribute('tabindex')).toBe(false);
  });
});
