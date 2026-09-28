/** @vitest-environment jsdom */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';
import { ChatPaneFileDropBoundary } from '../components/chat-dock/ChatPaneFileDropBoundary';
import { KeyboardShortcutsProvider } from '../contexts/KeyboardShortcutsContext';
import { NavigationProvider } from '../contexts/NavigationContext';
import { RegionPaneHost } from '../workspace-panes/RegionPaneHost';

// archive#4525: `DockShell` (via `useDockShellChrome`) now reads
// `useProjects` for its project-binding deletion cleanup — mocked here the
// same way this file already avoids pulling in a real query client for
// anything unrelated to what it actually asserts (activity-region wiring).
vi.mock('../contexts/ProjectsContext', () => ({
  useProjects: () => ({
    projects: [],
    isLoading: false,
    isConfirmedLoaded: true,
  }),
  // #2047: the region host resolves the dock's project through this read;
  // no project here, so the panes that need one derive none.
  useProject: () => ({ project: undefined, isLoading: false }),
}));

const source = readFileSync(
  join(__dirname, '..', 'components', 'chat-dock', 'ChatDock.tsx'),
  'utf8',
);

describe('ChatDock activity region', () => {
  test('keeps the named dock root, every passive reset modality, and shortcut focus wiring together', () => {
    const onActivity = vi.fn();
    const onFocusWithinChange = vi.fn();
    // The ambient host publishes the slot's placement and size
    // (archive#3929), so it reads navigation. Mounting the REAL provider
    // rather than mocking it keeps this a test of the host rather than of a
    // stand-in. Device settings need no provider — they come from a store.
    const { container } = render(
      // `DockShell` (archive#4460) registers `dock.toggle`/`dock.maximize`
      // through the real `useKeyboardShortcut`, which needs this provider —
      // the ambient host previously had no keyboard-shortcut dependency of
      // its own.
      <KeyboardShortcutsProvider>
        <NavigationProvider>
          <RegionPaneHost
            renderChatPane={() => (
              <ChatPaneFileDropBoundary
                enabled
                onActivity={onActivity}
                onFocusWithinChange={onFocusWithinChange}
                reportError={vi.fn()}
                resetKey="dock|open"
                selectFiles={async () => {}}
              >
                <button type="button">Composer child</button>
              </ChatPaneFileDropBoundary>
            )}
          />
        </NavigationProvider>
      </KeyboardShortcutsProvider>,
    );

    const pane = screen.getByRole('region', { name: 'Chat dock' });
    const child = screen.getByRole('button', { name: 'Composer child' });

    // The real ambient host stays chromeless, so `DockShell` (archive#4460)
    // not this boundary — is the shell's direct child, and the CSS child
    // combinators keep THAT as their target (it carries the `.chat-dock`
    // class). The boundary is a descendant of it.
    const shellRoot = container.firstElementChild;
    expect(shellRoot?.className).toContain('chat-dock');
    expect(shellRoot?.contains(pane)).toBe(true);

    fireEvent.mouseEnter(pane);
    expect(onActivity).toHaveBeenCalledTimes(1);
    onActivity.mockClear();

    fireEvent.pointerDown(pane);
    expect(onActivity).toHaveBeenCalledTimes(1);
    onActivity.mockClear();

    fireEvent.wheel(pane);
    expect(onActivity).toHaveBeenCalledTimes(1);
    onActivity.mockClear();

    fireEvent.focus(child);
    expect(onActivity).toHaveBeenCalledTimes(1);
    expect(onFocusWithinChange).toHaveBeenLastCalledWith(true);

    const outside = document.createElement('button');
    document.body.append(outside);
    fireEvent.blur(child, { relatedTarget: outside });
    expect(onFocusWithinChange).toHaveBeenLastCalledWith(false);
    outside.remove();
  });
});

/**
 * Extracts the brace-balanced body of the FIRST `{` found at or after
 * `anchor` in `source` — tolerant of exact indentation/formatting (a biome
 * reformat cannot redden this the way a multi-line, whitespace-sensitive
 * regex can). Used only for the one property below
 * that a pure function genuinely cannot carry (archive#4525:
 * "does this callback avoid calling X" is a fact about ChatWorkspacePane's
 * own wiring, not a computation `chat-dock-utils.ts` could isolate).
 */
function extractBalancedBody(source: string, anchor: string): string {
  const anchorIndex = source.indexOf(anchor);
  expect(
    anchorIndex,
    `expected to find "${anchor}" in ChatDock.tsx`,
  ).toBeGreaterThanOrEqual(0);
  const braceStart = source.indexOf('{', anchorIndex);
  expect(
    braceStart,
    `expected an opening brace after "${anchor}"`,
  ).toBeGreaterThanOrEqual(0);
  let depth = 0;
  for (let i = braceStart; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    else if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(braceStart, i + 1);
    }
  }
  throw new Error(`unbalanced braces reading the body after "${anchor}"`);
}

/**
 * archive#4525: the one project-binding property still pinned in source. The
 * rest of the binding wiring (badge, mobile header, session facts, switcher,
 * New Chat defaults) is mounted in `ChatWorkspacePaneComposerDraft.test.tsx`;
 * the fork path is not, because a fork starts from a transcript action that
 * harness stands in for.
 */
describe('ChatDock project-binding wiring (station#4525)', () => {
  // archive#4525: a fork is none of the three things the
  // DeviceSettings docblock names as legitimate binding-change triggers
  // (an explicit picker pick, an explicit new-chat project choice, or
  // deletion) — it must never sync the ambient binding to the fork
  // source's project. No pure function can carry this: it is a fact about
  // which of two DIFFERENT callback props (`onSelectNewChat` vs.
  // `onForkAgentSelect`, dispatched by `ChatDockModalStack`'s own
  // `handleNewChatSelect`) gets wired to the sync call.
  test('a fork confirmation never syncs the project binding (station#4525 review LOW-1)', () => {
    const forkBody = extractBalancedBody(source, 'onForkAgentSelect: async (');
    expect(forkBody).not.toMatch(/setActiveProjectSlug/);

    const nonForkBody = extractBalancedBody(source, 'onSelectNewChat: (');
    expect(
      nonForkBody,
      'the non-fork new-chat path must route the explicit project choice through the scoped opener',
    ).toMatch(/openChatForAgentInScopedPane/);
    const scopedOpenBody = extractBalancedBody(
      source,
      'const openChatForAgentInScopedPane = useCallback(',
    );
    expect(
      scopedOpenBody,
      'the shared non-fork opener must still sync an explicit project choice',
    ).toMatch(/setActiveProjectSlug/);
  });
});
