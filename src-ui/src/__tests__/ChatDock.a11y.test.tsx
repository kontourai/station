/** @vitest-environment jsdom */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';
import { ChatPaneFileDropBoundary } from '../components/chat-dock/ChatPaneFileDropBoundary';
import { KeyboardShortcutsProvider } from '../contexts/KeyboardShortcutsContext';
import { NavigationProvider } from '../contexts/NavigationContext';
import { AmbientChatDockPaneHost } from '../workspace-panes/AmbientChatDockPaneHost';

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
}));

const source = readFileSync(
  join(__dirname, '..', 'components', 'chat-dock', 'ChatDock.tsx'),
  'utf8',
);

describe('ChatDock activity region', () => {
  test('keeps the named dock root, every passive reset modality, and shortcut focus wiring together', () => {
    const onActivity = vi.fn();
    const onFocusWithinChange = vi.fn();
// The ambient host publishes the slot's placement and size for whichever
// occupant holds it (archive#3929), so it reads navigation. Mounting the
// REAL provider rather than mocking it keeps this a test of the host
// rather than of a stand-in. Device settings need no provider — they come
// from a store.
    const { container } = render(
// `DockShell` (archive#4460) registers `dock.toggle`/`dock.maximize`
// through the real `useKeyboardShortcut`, which needs this provider —
// the ambient host previously had no keyboard-shortcut dependency of
// its own.
      <KeyboardShortcutsProvider>
        <NavigationProvider>
          <AmbientChatDockPaneHost
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
// class every occupant now shares). The boundary is a descendant of it.
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

describe('ChatDock and Inbox inventory scope (#1053)', () => {
  test('does not turn the route-selected Agent into a hidden dock filter', () => {
    expect(source).toContain('useDerivedSessions(apiBase, null)');
    expect(source).not.toContain('useDerivedSessions(apiBase, selectedAgent)');
// Project scope is an explicit dock presentation filter and remains
// applied after the global session inventory is derived.
    expect(source).toMatch(
      /scopedProjectSlug\s*\?\s*allSessions\.filter\([\s\S]*?session\.projectSlug === scopedProjectSlug/,
    );
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
* archive#4525/archive#4524: `AmbientChatDockProjectBinding.test.tsx`
 * proves the fix's foundation (DockShell-owned chrome state survives the
 * real occupant-switch/remount mechanics) through the REAL host, and
 * `chat-dock-utils.test.ts` table-tests every piece of the actual
 * project-binding LOGIC as pure functions
 * (`resolveDockBadgeProjectName`/`resolveSessionProjectMismatchLabel`/
 * `resolveDirectNewChatProjectSlug`/`resolveNewChatModalDefaultProjectSlug`)
* no test in this repo mounts the full, ~2700-line `ChatWorkspacePane`
 * (see `DockShellControlParity.test.tsx`'s doc comment on why), so those
 * pure functions are what carries the behavioral correctness instead.
 *
 * What remains unverified by either of those is only WIRING — does
 * `ChatWorkspacePane`'s JSX actually pass a pure function's result to the
 * right prop, and does the one property no pure function can carry
* (archive#4525: a fork confirmation must never sync the
 * binding) hold. These are the minimal call-site pins for exactly that —
 * single-line, formatting-insensitive regexes on a function-call/property
 * NAME (a real rename or a swap to a literal reds these; a biome reformat
 * does not), plus the one brace-balanced body extraction above for the
 * property that genuinely has no pure-function home.
 */
describe('ChatDock project-binding wiring (station#4525/#4524, minimal call-site pins)', () => {
  test('the badge project name is wired from resolveDockBadgeProjectName, not a literal or the raw session', () => {
    expect(source).toMatch(/projectName=\{dockBadgeProjectName\}/);
    expect(source).toMatch(
      /const dockBadgeProjectName = resolveDockBadgeProjectName\(/,
    );
// The slug prop carries the switcher's aria-current "Current" marker and
// the directory→coding-layout link guard — nulling it breaks both while
// every rendered-name assertion stays green.
    expect(source).toMatch(/projectSlug=\{dockProjectSlug\}/);
  });

  test('the mobile header project name is wired from the SAME dockBadgeProjectName the desktop badge uses', () => {
    expect(source).toMatch(
      /projectName:\s*dockBadgeProjectName\s*\?\?\s*'No project'/,
    );
  });

  test('session facts (directory/git/coding-layout) are never gated on the badge (station#4525 review HIGH-2)', () => {
// Positive pin, not just a negative one: asserts the EXACT unconditional
// shape (gated only on the pre-existing scopedProjectSlug chat-scope
// filter, exactly as pre-archive#4525) rather than merely excluding one
// named variable. A negative-only check ("does not mention
// dockProjectMatchesActiveSession") would miss the SAME suppression
// reintroduced via an inline comparison instead of that name — this
// does not, because any extra gating changes the matched text.
    expect(source).toMatch(
      /workingDirectory=\{\s*scopedProjectSlug\s*\?\s*null\s*:\s*sessionDisplayCwd\s*\}/,
    );
    expect(source).toMatch(
      /codingLayoutSlug=\{\s*scopedProjectSlug\s*\?\s*null\s*:\s*\(sessionCodingLayout\?\.slug\s*\?\?\s*null\)\s*\}/,
    );
    expect(source).toMatch(
      /gitStatus=\{\s*scopedProjectSlug\s*\?\s*undefined\s*:\s*gitStatus\s*\}/,
    );
 // The pre-fix-reintroduction shape review actually caught, kept
// as a named-regression tripwire too.
    expect(source).not.toContain('dockProjectMatchesActiveSession');
  });

  test('a session/badge mismatch is surfaced via sessionProjectMismatchLabel, not silently dropped (station#4525 review MED-1)', () => {
    expect(source).toMatch(
      /const sessionProjectMismatchLabel = resolveSessionProjectMismatchLabel\(/,
    );
    expect(source).toMatch(
      /sessionProjectMismatchLabel=\{sessionProjectMismatchLabel\}/,
    );
  });

  test('the direct new-chat path resolves its target project through resolveDirectNewChatProjectSlug (station#4525 review HIGH-3)', () => {
    expect(source).toMatch(
      /const targetProjectSlug = resolveDirectNewChatProjectSlug\(/,
    );
    expect(source).toMatch(
      /openChatForAgentInScopedPane\(\s*direct,\s*targetProjectSlug/,
    );
  });

  test('the New Chat modal default resolves through resolveNewChatModalDefaultProjectSlug (station#4525 review MED-3)', () => {
    expect(source).toMatch(
      /activeProjectSlug:\s*resolveNewChatModalDefaultProjectSlug\(/,
    );
  });

  test('handleSwitchProject rebinds the shell and never opens the New Chat modal (station#4524)', () => {
    const body = extractBalancedBody(
      source,
      'const handleSwitchProject = useCallback(',
    );
    expect(body).toContain('setActiveProjectSlug(projectSlug)');
 // The pre-fix behavior (archive#4524's reported bug): the row action opened
// the New Chat modal on its own.
    expect(body).not.toMatch(/setShowNewChatModal/);
    expect(body).not.toMatch(/setNewChatProjectOverride/);
  });

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
      'the non-fork new-chat path must still sync an explicit project choice',
    ).toMatch(/setActiveProjectSlug/);
  });
});
