// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import {
  CHAT_DOCK_INBOX_EXIT_MS,
  chatModelLabel,
  type DockChrome,
  effectiveChatModelId,
  inboxPanelMounts,
  markDockFirstRunSeen,
  mobileTaskSwitcherMounts,
  projectDisplayName,
  resolveDirectNewChatProjectSlug,
  resolveDockBadgeProjectName,
  resolveNewChatModalDefaultProjectSlug,
  resolveSessionProjectMismatchLabel,
  routeToOpenChatsCollection,
  shouldOpenDockForFirstRun,
  splitWorkingDirectoryPath,
} from '../components/chat-dock/chat-dock-utils';
import type { SelectableModel } from '../utils/modelCapabilities';

describe('chat-dock-utils', () => {
  test('splitWorkingDirectoryPath trims trailing slashes and preserves parent paths', () => {
    expect(
      splitWorkingDirectoryPath('/Users/brian/dev/workspace/project/'),
    ).toEqual({
      parentPath: '/Users/brian/dev/workspace/',
      leafName: 'project',
      hasWorkingDirectory: true,
    });
  });

  test('splitWorkingDirectoryPath handles missing directories', () => {
    expect(splitWorkingDirectoryPath(null)).toEqual({
      parentPath: '',
      leafName: '',
      hasWorkingDirectory: false,
    });
  });
});

describe('first-run dock nudge', () => {
  afterEach(() => {
    window.localStorage.clear();
    Object.defineProperty(navigator, 'webdriver', {
      value: false,
      configurable: true,
    });
  });

  test('nudges once on first run, then never again', () => {
    expect(shouldOpenDockForFirstRun()).toBe(true);
    markDockFirstRunSeen();
    expect(shouldOpenDockForFirstRun()).toBe(false);
  });

  test('never nudges automated sessions (navigator.webdriver)', () => {
    Object.defineProperty(navigator, 'webdriver', {
      value: true,
      configurable: true,
    });
    expect(shouldOpenDockForFirstRun()).toBe(false);
  });
});

/**
 * archive#3314: the sidebar's "N more" and its "Open
 * chats" heading promised the dock inbox from every chrome. The panel mounts
 * only on desktop, and there only in bottom mode or a fullscreen placement, so
 * on mobile the drawer closed and the dock snapped to half showing the CURRENT
 * chat — the overflow chats were nowhere — and an edge placement showed
 * nothing at all.
 *
 * The old test asserted the MECHANISM (openCollection was called, the setting
 * was written) and so stayed green for a button that led nowhere. These assert
 * the DESTINATION: for every chrome, the route lands on a surface that mounts.
 */
describe('routeToOpenChatsCollection (#3314 SF-1)', () => {
  const CHROMES: DockChrome[] = [
    { isMobile: true, dockMode: 'bottom', isFullscreenPlacement: false },
    { isMobile: true, dockMode: 'right', isFullscreenPlacement: false },
    { isMobile: true, dockMode: 'bottom', isFullscreenPlacement: true },
    { isMobile: false, dockMode: 'bottom', isFullscreenPlacement: false },
    { isMobile: false, dockMode: 'right', isFullscreenPlacement: false },
    { isMobile: false, dockMode: 'left', isFullscreenPlacement: false },
    { isMobile: false, dockMode: 'right', isFullscreenPlacement: true },
  ];

  test.each(CHROMES)(
    'every chrome reaches a destination that mounts (%o)',
    (chrome) => {
      const route = routeToOpenChatsCollection(chrome);
      if (route.surface === 'task-switcher-sheet') {
        // Derived, not asserted in prose: the sheet must actually mount here.
        expect(mobileTaskSwitcherMounts(chrome)).toBe(true);
        return;
      }
      // Applying the route's own mode change must make the panel mountable —
      // otherwise this is a button promising a surface that never appears.
      const afterRoute: DockChrome = route.switchToBottomMode
        ? { ...chrome, dockMode: 'bottom' }
        : chrome;
      expect(inboxPanelMounts(afterRoute)).toBe(true);
    },
  );

  test('mobile routes to the task switcher sheet, never the desktop panel', () => {
    expect(
      routeToOpenChatsCollection({
        isMobile: true,
        dockMode: 'bottom',
        isFullscreenPlacement: false,
      }),
    ).toEqual({ surface: 'task-switcher-sheet' });
  });

  test('an edge placement is moved to bottom mode, where the panel exists', () => {
    const chrome: DockChrome = {
      isMobile: false,
      dockMode: 'right',
      isFullscreenPlacement: false,
    };
    expect(inboxPanelMounts(chrome)).toBe(false);
    expect(routeToOpenChatsCollection(chrome)).toEqual({
      surface: 'inbox-panel',
      switchToBottomMode: true,
      snapHalf: true,
    });
  });

  test('a fullscreen placement already mounts the panel and is not snapped', () => {
    expect(
      routeToOpenChatsCollection({
        isMobile: false,
        dockMode: 'right',
        isFullscreenPlacement: true,
      }),
    ).toEqual({
      surface: 'inbox-panel',
      switchToBottomMode: false,
      snapHalf: false,
    });
  });
});

/**
 * archive#3309: one expression for the model the dock header names and the
 * delegation launcher inherits. Two surfaces reading one fact must not
 * compute it twice (archive#3391 is that defect one layer up).
 */
describe('effectiveChatModelId (#3309)', () => {
  test('the live session override wins over what the session reports', () => {
    expect(
      effectiveChatModelId({
        composerModel: 'claude-opus-5',
        sessionModel: 'claude-sonnet-5',
        agentDefaultModel: 'gpt-5',
      }),
    ).toBe('claude-opus-5');
  });

  test('falls back through session, then agent default', () => {
    expect(
      effectiveChatModelId({
        sessionModel: 'claude-sonnet-5',
        agentDefaultModel: 'gpt-5',
      }),
    ).toBe('claude-sonnet-5');
    expect(effectiveChatModelId({ agentDefaultModel: 'gpt-5' })).toBe('gpt-5');
  });

  test('nothing reported is undefined, never an empty or whitespace id', () => {
    expect(effectiveChatModelId({})).toBeUndefined();
    expect(
      effectiveChatModelId({
        composerModel: '',
        sessionModel: '   ',
        agentDefaultModel: null,
      }),
    ).toBeUndefined();
    // A blank override must not shadow a real model behind it.
    expect(
      effectiveChatModelId({ composerModel: '  ', sessionModel: 'gpt-5' }),
    ).toBe('gpt-5');
  });

  test('the exit budget equals the --motion-base token the exit CSS animates on', () => {
    // Read from tokens.css, not restated: the CSS owns the duration and this
    // constant owns when the element leaves the tree, so a drift between them
    // deletes the panel mid-animation. Asserting the number against itself
    // would prove nothing about that pairing.
    const tokens = readFileSync(
      path.resolve(import.meta.dirname, '..', 'tokens.css'),
      'utf8',
    );
    const declared = tokens.match(/--motion-base:\s*([0-9.]+)(m?s);/);
    expect(declared, 'expected --motion-base in tokens.css').not.toBeNull();
    const ms = Number(declared?.[1]) * (declared?.[2] === 'ms' ? 1 : 1000);
    expect(CHAT_DOCK_INBOX_EXIT_MS).toBe(ms);

    // And the exit rule really does animate on that token rather than a
    // literal, so the pairing above is about the same duration.
    const inboxCss = readFileSync(
      path.resolve(
        import.meta.dirname,
        '..',
        'components',
        'chat-dock',
        'ChatDockInboxPanel.css',
      ),
      'utf8',
    );
    expect(inboxCss).toMatch(
      /\.chat-dock-inbox--exiting\s*\{[^}]*animation:\s*chat-dock-inbox-exit\s+var\(--motion-base\)/,
    );
  });
});

/**
 * archive#3309. The header names a model beside a composer pill that names the
 * same model; the ONE way that becomes a lie is asking a different question.
 * Caught live: without the resolved-alias arm the header read "Default
 * (recommended)" while the pill read "Opus 5".
 */
describe('chatModelLabel (#3309)', () => {
  const CATALOG: SelectableModel[] = [
    {
      id: 'default',
      name: 'Default (recommended)',
      resolvedModel: 'claude-opus-5[1m]',
    },
    {
      id: 'claude-opus-5[1m]',
      name: 'Opus 5 (1M context)',
      originalId: 'claude-opus-5[1m]',
    },
    { id: 'claude-fable-5', name: 'Fable', originalId: 'claude-fable-5' },
  ];

  test('an alias the engine resolved names the concrete model, not the alias', () => {
    expect(chatModelLabel('default', CATALOG)).toBe('Opus 5 (1M context)');
    // The exact regression: the alias name must NOT be what a user reads,
    // because the composer two rows below is showing the resolution.
    expect(chatModelLabel('default', CATALOG)).not.toBe(
      'Default (recommended)',
    );
  });

  test('a concrete model keeps its catalog name', () => {
    expect(chatModelLabel('claude-fable-5', CATALOG)).toBe('Fable');
  });

  test('an id the catalog has never heard of is prettified, never shown raw', () => {
    expect(chatModelLabel('claude-opus-5[1m]', [])).toBe('Opus 5 (1M)');
  });

  test('no reported model is null — not "Model not reported" in an identity row', () => {
    expect(chatModelLabel(undefined, CATALOG)).toBeNull();
    expect(chatModelLabel('', CATALOG)).toBeNull();
  });
});

describe('projectDisplayName', () => {
  const PROJECTS = [
    { slug: 'alpha', name: 'Alpha' },
    { slug: 'beta', name: 'Beta' },
  ];

  test('looks up the display name by slug', () => {
    expect(projectDisplayName('alpha', PROJECTS)).toBe('Alpha');
  });

  test('falls back to the slug itself when the project is not in the list', () => {
    expect(projectDisplayName('ghost', PROJECTS)).toBe('ghost');
  });

  test('null/undefined in, null out — never invents a name for "nothing bound"', () => {
    expect(projectDisplayName(null, PROJECTS)).toBeNull();
    expect(projectDisplayName(undefined, PROJECTS)).toBeNull();
  });
});

describe('resolveDockBadgeProjectName (station#4525)', () => {
  const PROJECTS = [
    { slug: 'alpha', name: 'Alpha' },
    { slug: 'beta', name: 'Beta' },
  ];

  const cases: {
    name: string;
    input: Parameters<typeof resolveDockBadgeProjectName>[0];
    expected: string | null;
  }[] = [
    {
      name: 'a project chat-scope filter always wins, plain lookup',
      input: {
        scopedProjectSlug: 'beta',
        dockProjectSlug: 'alpha',
        sessionProjectSlug: 'alpha',
        sessionProjectName: 'Alpha (session)',
        projects: PROJECTS,
      },
      expected: 'Beta',
    },
    {
      name: 'no scope, no binding -> null (the "No project" state)',
      input: {
        scopedProjectSlug: null,
        dockProjectSlug: null,
        sessionProjectSlug: undefined,
        sessionProjectName: undefined,
        projects: PROJECTS,
      },
      expected: null,
    },
    {
      name: 'no scope, bound, session belongs to the SAME project -> prefers the richer session-name resolution',
      input: {
        scopedProjectSlug: null,
        dockProjectSlug: 'alpha',
        sessionProjectSlug: 'alpha',
        sessionProjectName: 'Alpha (via connection)',
        projects: PROJECTS,
      },
      expected: 'Alpha (via connection)',
    },
    {
      name: 'session matches but its richer name is blank -> falls back to the bound slug, not empty',
      input: {
        scopedProjectSlug: null,
        dockProjectSlug: 'alpha',
        sessionProjectSlug: 'alpha',
        sessionProjectName: '',
        projects: PROJECTS,
      },
      expected: 'alpha',
    },
    {
      name: 'no scope, bound, session belongs to a DIFFERENT project -> plain lookup of the BOUND slug, never the session name',
      input: {
        scopedProjectSlug: null,
        dockProjectSlug: 'alpha',
        sessionProjectSlug: 'beta',
        sessionProjectName: 'Beta (session)',
        projects: PROJECTS,
      },
      expected: 'Alpha',
    },
    {
      name: 'no scope, bound, no active session at all -> plain lookup of the bound slug',
      input: {
        scopedProjectSlug: null,
        dockProjectSlug: 'alpha',
        sessionProjectSlug: undefined,
        sessionProjectName: undefined,
        projects: PROJECTS,
      },
      expected: 'Alpha',
    },
    {
      name: 'bound project not in the list -> falls back to the raw slug, never a session name',
      input: {
        scopedProjectSlug: null,
        dockProjectSlug: 'ghost',
        sessionProjectSlug: 'beta',
        sessionProjectName: 'Beta (session)',
        projects: PROJECTS,
      },
      expected: 'ghost',
    },
  ];

  for (const { name, input, expected } of cases) {
    test(name, () => {
      expect(resolveDockBadgeProjectName(input)).toBe(expected);
    });
  }
});

describe('resolveSessionProjectMismatchLabel (station#4525 review MED-1)', () => {
  const cases: {
    name: string;
    input: Parameters<typeof resolveSessionProjectMismatchLabel>[0];
    expected: string | null;
  }[] = [
    {
      name: 'a project chat-scope filter suppresses the mismatch label entirely',
      input: {
        scopedProjectSlug: 'beta',
        dockProjectSlug: 'alpha',
        sessionProjectSlug: 'gamma',
        sessionProjectName: 'Gamma',
      },
      expected: null,
    },
    {
      name: 'no active session (or a projectless one) -> no label',
      input: {
        scopedProjectSlug: null,
        dockProjectSlug: 'alpha',
        sessionProjectSlug: undefined,
        sessionProjectName: undefined,
      },
      expected: null,
    },
    {
      name: 'session matches the bound project -> no label (the common, coherent case)',
      input: {
        scopedProjectSlug: null,
        dockProjectSlug: 'alpha',
        sessionProjectSlug: 'alpha',
        sessionProjectName: 'Alpha',
      },
      expected: null,
    },
    {
      name: "session belongs to a DIFFERENT project than the bound badge -> the session's own name, muted",
      input: {
        scopedProjectSlug: null,
        dockProjectSlug: 'alpha',
        sessionProjectSlug: 'beta',
        sessionProjectName: 'ProjectB',
      },
      expected: 'ProjectB',
    },
    {
      name: 'mismatch but the session has no resolved name -> falls back to its own slug, never blank',
      input: {
        scopedProjectSlug: null,
        dockProjectSlug: 'alpha',
        sessionProjectSlug: 'beta',
        sessionProjectName: '',
      },
      expected: 'beta',
    },
    {
      name: 'no binding at all but the session HAS a project -> still a mismatch (undefined !== null)',
      input: {
        scopedProjectSlug: null,
        dockProjectSlug: null,
        sessionProjectSlug: 'beta',
        sessionProjectName: 'ProjectB',
      },
      expected: 'ProjectB',
    },
  ];

  for (const { name, input, expected } of cases) {
    test(name, () => {
      expect(resolveSessionProjectMismatchLabel(input)).toBe(expected);
    });
  }
});

describe('resolveDirectNewChatProjectSlug (station#4525 review HIGH-3)', () => {
  test('the ambient dock (no immutable scope) inherits the shell binding', () => {
    expect(
      resolveDirectNewChatProjectSlug({
        hasImmutableProjectScope: false,
        immutableProjectSlug: undefined,
        dockChromeProjectSlug: 'alpha',
      }),
    ).toBe('alpha');
  });

  test('the ambient dock with no binding creates a genuinely unbound chat', () => {
    expect(
      resolveDirectNewChatProjectSlug({
        hasImmutableProjectScope: false,
        immutableProjectSlug: undefined,
        dockChromeProjectSlug: null,
      }),
    ).toBeUndefined();
  });

  // The exact repro: New Chat inside a project's own Coding layout
  // must target THAT project, never the ambient device-global binding —
  // passing the binding here trips `shouldRouteScopedChatProject` into
  // navigating away instead of creating a chat.
  test('an immutably project-scoped layout ALWAYS targets its own project, never the ambient binding', () => {
    expect(
      resolveDirectNewChatProjectSlug({
        hasImmutableProjectScope: true,
        immutableProjectSlug: 'the-layouts-own-project',
        dockChromeProjectSlug: 'a-totally-different-globally-bound-project',
      }),
    ).toBe('the-layouts-own-project');
  });
});

describe('resolveNewChatModalDefaultProjectSlug (station#4525 review MED-3)', () => {
  test('a fork confirmation always wins outright, over every other default', () => {
    expect(
      resolveNewChatModalDefaultProjectSlug({
        forkProjectSlug: 'fork-source-project',
        hasImmutableProjectScope: true,
        immutableProjectSlug: 'layout-project',
        dockChromeProjectSlug: 'bound-project',
        routeActiveProjectSlug: 'viewed-project',
      }),
    ).toBe('fork-source-project');
  });

  test('an immutably project-scoped layout defaults to its own project', () => {
    expect(
      resolveNewChatModalDefaultProjectSlug({
        forkProjectSlug: undefined,
        hasImmutableProjectScope: true,
        immutableProjectSlug: 'layout-project',
        dockChromeProjectSlug: 'bound-project',
        routeActiveProjectSlug: 'viewed-project',
      }),
    ).toBe('layout-project');
  });

  test('the ambient dock with a bound project defaults to the binding, not the currently-viewed route project', () => {
    expect(
      resolveNewChatModalDefaultProjectSlug({
        forkProjectSlug: undefined,
        hasImmutableProjectScope: false,
        immutableProjectSlug: undefined,
        dockChromeProjectSlug: 'bound-project',
        routeActiveProjectSlug: 'viewed-project',
      }),
    ).toBe('bound-project');
  });

  // an unbound user gets the pre-archive#4525 behavior back —
  // navigating to a project and opening New Chat preselects that project.
  test('the ambient dock with NO binding falls back to the route-level currently-viewed project (pre-fix behavior restored)', () => {
    expect(
      resolveNewChatModalDefaultProjectSlug({
        forkProjectSlug: undefined,
        hasImmutableProjectScope: false,
        immutableProjectSlug: undefined,
        dockChromeProjectSlug: null,
        routeActiveProjectSlug: 'viewed-project',
      }),
    ).toBe('viewed-project');
  });

  test('no binding and no viewed project -> undefined (genuinely unbound default)', () => {
    expect(
      resolveNewChatModalDefaultProjectSlug({
        forkProjectSlug: undefined,
        hasImmutableProjectScope: false,
        immutableProjectSlug: undefined,
        dockChromeProjectSlug: null,
        routeActiveProjectSlug: null,
      }),
    ).toBeUndefined();
  });
});
