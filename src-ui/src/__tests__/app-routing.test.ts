import { describe, expect, test } from 'vitest';
import {
  getLegacyPathRedirect,
  getParentView,
  getPathForView,
  resolveViewFromPath,
} from '../app-shell/routing';
import type { NavigationView } from '../types';

const LEGACY_PATH_CASES = [
  ['/sessions', '/activity'],
  ['/sessions/', '/activity'],
  ['/sessions/?session=x&extra=y', '/activity?session=x&extra=y'],
  ['/sessions?session=x&anything=y', '/activity?session=x&anything=y'],
  ['/developer/config', '/settings?view=station-config'],
  // archive#3313: Feature Previews retired into a Settings section.
  ['/feature-previews', '/settings?view=feature-previews'],
  ['/developer/storage', '/connections/knowledge'],
  ['/developer/mcp', '/connections/tools'],
  ['/developer/mcp/example', '/connections/tools/example'],
  ['/agents/planner/tools', '/agents/planner'],
  ['/agents/planner/workflows', '/agents/planner'],
  // Playbooks are Skills: the retired paths land on the surface that absorbed
  // them, not on a tab that no longer exists.
  ['/prompts', '/guidance?tab=skills'],
  ['/prompts/release-review', '/guidance/release-review?tab=skills'],
  ['/playbooks', '/guidance?tab=skills'],
  ['/playbooks/release-review', '/guidance/release-review?tab=skills'],
  ['/skills', '/guidance?tab=skills'],
  ['/skills/code-review', '/guidance/code-review?tab=skills'],
  ['/integrations', '/connections/tools'],
  ['/integrations/example', '/connections/tools/example'],
  ['/monitoring', '/developer/telemetry'],
  ['/sys/monitoring', '/developer/telemetry'],
  ['/sys/schedule', '/schedule'],
  ['/manage', '/agents'],
  // #765 D2: bare /tasks has no collection view; tasks surface on Home.
  ['/tasks', '/'],
  ['/tasks/', '/'],
  ['/manage/agents', '/agents'],
  ['/manage/agents/planner', '/agents/planner'],
  ['/manage/prompts', '/guidance?tab=skills'],
  ['/manage/prompts/release-review', '/guidance/release-review?tab=skills'],
  ['/manage/plugins', '/plugins'],
  ['/manage/plugins/example', '/plugins/example'],
  ['/manage/integrations', '/connections/tools'],
  ['/manage/integrations/example', '/connections/tools/example'],
  ['/manage/providers', '/connections/models'],
  ['/manage/providers/example', '/connections/models/example'],
  ['/tools', '/connections/tools'],
  ['/connections/providers', '/connections/models'],
  ['/connections/providers/example', '/connections/models/example'],
  ['/connections/agent-apps', '/connections/engines'],
  ['/connections/agent-apps/example', '/connections/engines/example'],
  ['/connections/agents', '/connections/engines'],
  ['/connections/agents/example', '/connections/engines/example'],
  ['/connections/acp', '/connections/engines'],
  ['/connections/environments', '/connections/computers'],
] as const;

const CANONICAL_VIEWS = [
  { type: 'home' },
  { type: 'agents' },
  { type: 'agent-new' },
  { type: 'agent-edit', slug: 'planner' },
  { type: 'guidance', tab: 'skills', selectedId: 'code review' },
  { type: 'connections' },
  { type: 'connections-providers' },
  { type: 'connections-provider-edit', id: 'provider' },
  { type: 'connections-acp-new', providerId: 'custom' },
  { type: 'connections-engines' },
  { type: 'connections-runtime-edit', id: 'engine' },
  { type: 'connections-acp' },
  { type: 'connections-tools' },
  { type: 'connections-tool-edit', id: 'tool' },
  { type: 'connections-knowledge' },
  { type: 'connections-computers' },
  { type: 'plugins' },
  { type: 'registry', tab: 'plugins' },
  { type: 'review-queue' },
  { type: 'activity', sessionId: 'session/one' },
  { type: 'activity', sessionId: 'session/one', focus: 'evidence' },
  { type: 'developer', tab: 'telemetry' },
  { type: 'schedule' },
  { type: 'settings' },
  { type: 'profile' },
  { type: 'notifications' },
  { type: 'task', taskId: 'task/one' },
  { type: 'board', reference: { kind: 'session', id: 'session/one' } },
  {
    type: 'board',
    reference: { kind: 'task', projectId: 'project/one', id: 'task/two' },
  },
  { type: 'project', slug: 'project' },
  { type: 'project-session-board', slug: 'project' },
  { type: 'project-flow-console', slug: 'project', runId: 'run/one' },
  {
    type: 'workspace-pane',
    projectSlug: 'project',
    layoutSlug: 'coding',
    descriptorId: 'pane:terminal',
    instanceId: 'terminal/one',
  },
  { type: 'project-new' },
  { type: 'project-edit', slug: 'project' },
  { type: 'layout', projectSlug: 'project', layoutSlug: 'coding' },
] as const satisfies readonly NavigationView[];
type EnumeratedViewType =
  | (typeof CANONICAL_VIEWS)[number]['type']
  | 'not-found';
true satisfies NavigationView['type'] extends EnumeratedViewType ? true : false;

describe('app-shell routing', () => {
  test.each(LEGACY_PATH_CASES)(
    'redirects every legacy path %s to canonical %s',
    (legacy, canonical) =>
      expect(getLegacyPathRedirect(legacy)).toBe(canonical),
  );

  test.each(CANONICAL_VIEWS)(
    'round-trips canonical view $type through its canonical path',
    (view) => {
      const path = getPathForView(view);
      expect(path).not.toBeNull();
      expect(resolveViewFromPath(path!)).toEqual(view);
    },
  );

  test('enumerates the non-navigable not-found view type', () => {
    expect(getPathForView({ type: 'not-found', path: '/missing' })).toBeNull();
  });

  test('retains the accepted trailing-slash Agents root spelling', () => {
    expect(resolveViewFromPath('/agents/')).toEqual({ type: 'agents' });
  });

  test('resolves read-only developer tabs and redirects monitoring deep links', () => {
    expect(resolveViewFromPath('/developer')).toEqual({ type: 'developer' });
    expect(resolveViewFromPath('/developer/system')).toEqual({
      type: 'developer',
      tab: 'system',
    });
    expect(resolveViewFromPath('/developer/telemetry')).toEqual({
      type: 'developer',
      tab: 'telemetry',
    });
    for (const path of [
      '/developer/logs/anything',
      '/developer/system/garbage',
    ]) {
      expect(resolveViewFromPath(path)).toEqual({ type: 'not-found', path });
    }
    expect(resolveViewFromPath('/developer/garbage')).toEqual({
      type: 'not-found',
      path: '/developer/garbage',
    });
    expect(getPathForView({ type: 'developer', tab: 'logs' })).toBe(
      '/developer/logs',
    );
    expect(getPathForView({ type: 'developer' })).toBe('/developer');
  });

  test.each([
    ['/developer/config', '/settings?view=station-config'],
    ['/developer/storage', '/connections/knowledge'],
    ['/developer/mcp', '/connections/tools'],
    ['/developer/mcp/new', '/connections/tools/new'],
    ['/developer/mcp/example%20server', '/connections/tools/example%20server'],
  ])('redirects retired developer path %s to %s', (legacy, canonical) => {
    expect(getLegacyPathRedirect(legacy)).toBe(canonical);
  });

  test.each([
    [
      '/developer/mcp/example?source=notification',
      '/connections/tools/example?source=notification',
    ],
    ['/developer/config?foo=bar', '/settings?view=station-config&foo=bar'],
    [
      '/developer/config?view=caller-choice&foo=bar&view=duplicate',
      '/settings?view=station-config&foo=bar',
    ],
    [
      '/agents/planner/tools?source=notification',
      '/agents/planner?source=notification',
    ],
    ['/agents/planner/workflows?tab=history', '/agents/planner?tab=history'],
    [
      '/prompts/release-review?source=notification',
      '/guidance/release-review?tab=skills&source=notification',
    ],
    [
      '/connections/agents/claude?source=notification',
      '/connections/engines/claude?source=notification',
    ],
  ])(
    'preserves search while redirecting legacy path %s',
    (legacy, canonical) => {
      expect(getLegacyPathRedirect(legacy)).toBe(canonical);
    },
  );

  test('redirects retired agent subviews before resolving the editor route', () => {
    for (const legacy of [
      '/agents/planner/tools',
      '/agents/planner/workflows',
    ]) {
      const redirect = getLegacyPathRedirect(legacy);
      expect(redirect).toBe('/agents/planner');
      expect(resolveViewFromPath(redirect!)).toEqual({
        type: 'agent-edit',
        slug: 'planner',
      });
    }
  });
  test('getParentView returns semantic Station parents instead of browser history', () => {
    expect(getParentView({ type: 'home' })).toBeNull();
    expect(
      getParentView({ type: 'connections-provider-edit', id: 'ollama' }),
    ).toEqual({ type: 'connections-providers' });
    expect(
      getParentView({
        type: 'layout',
        projectSlug: 'station',
        layoutSlug: 'coding',
      }),
    ).toEqual({ type: 'project', slug: 'station' });
    expect(getParentView({ type: 'activity', sessionId: 'run-1' })).toEqual({
      type: 'activity',
    });
    expect(getParentView({ type: 'registry', tab: 'plugins' })).toEqual({
      type: 'registry',
    });
    expect(getParentView({ type: 'settings' })).toEqual({ type: 'home' });
  });
  test('resolveViewFromPath maps agent, connection, and project routes', () => {
    expect(resolveViewFromPath('/agents/new')).toEqual({ type: 'agent-new' });
    expect(resolveViewFromPath('/connections/models/demo')).toEqual({
      type: 'connections-provider-edit',
      id: 'demo',
    });
    expect(resolveViewFromPath('/connections/engines')).toEqual({
      type: 'connections-engines',
    });
    expect(resolveViewFromPath('/connections/acp')).toEqual({
      type: 'connections-acp',
    });
    expect(resolveViewFromPath('/projects/demo/layouts/coding')).toEqual({
      type: 'layout',
      projectSlug: 'demo',
      layoutSlug: 'coding',
    });
    expect(
      resolveViewFromPath(
        '/projects/demo/panes/builtin%3Aflow-run-console/console-1',
      ),
    ).toEqual({
      type: 'workspace-pane',
      projectSlug: 'demo',
      descriptorId: 'builtin:flow-run-console',
      instanceId: 'console-1',
    });
    expect(
      resolveViewFromPath(
        '/projects/demo/layouts/coding/panes/pane%3Abuiltin%3Acoding%3Afile-browser/files-1',
      ),
    ).toEqual({
      type: 'workspace-pane',
      projectSlug: 'demo',
      layoutSlug: 'coding',
      descriptorId: 'pane:builtin:coding:file-browser',
      instanceId: 'files-1',
    });
    expect(
      resolveViewFromPath(
        '/projects/demo/layouts/coding/panes/pane%3Abuiltin%3Acoding/coding-1',
      ),
    ).toEqual({
      type: 'workspace-pane',
      projectSlug: 'demo',
      layoutSlug: 'coding',
      descriptorId: 'pane:builtin:coding',
      instanceId: 'coding-1',
    });
    expect(resolveViewFromPath('/projects/demo/session-board')).toEqual({
      type: 'project-session-board',
      slug: 'demo',
    });
    expect(resolveViewFromPath('/tasks/task%2Falpha')).toEqual({
      type: 'task',
      taskId: 'task/alpha',
    });
    expect(resolveViewFromPath('/projects/demo/flow-console')).toEqual({
      type: 'project-flow-console',
      slug: 'demo',
    });
    expect(
      resolveViewFromPath('/projects/demo/flow-console?run=run-1'),
    ).toEqual({
      type: 'project-flow-console',
      slug: 'demo',
      runId: 'run-1',
    });
  });

  test('resolveViewFromPath resolves /registry/:tab deep links', () => {
    expect(resolveViewFromPath('/registry')).toEqual({ type: 'registry' });
    expect(resolveViewFromPath('/registry/plugins')).toEqual({
      type: 'registry',
      tab: 'plugins',
    });
    expect(resolveViewFromPath('/registry/integrations')).toEqual({
      type: 'registry',
      tab: 'integrations',
    });
    // An unknown tab segment falls back to plain registry behavior rather
    // than propagating an unvalidated string into the view.
    expect(resolveViewFromPath('/registry/not-a-real-tab')).toEqual({
      type: 'registry',
    });
  });

  test('resolveViewFromPath keeps root as the task-first home regardless of persisted project state', () => {
    expect(
      resolveViewFromPath('/', {
        lastProject: 'alpha',
        lastProjectLayout: 'coding',
      }),
    ).toEqual({ type: 'home' });
    expect(
      resolveViewFromPath('/', {
        lastProject: 'alpha',
      }),
    ).toEqual({ type: 'home' });
  });

  test('resolveViewFromPath keeps root restore and playbook compatibility aliases distinct', () => {
    expect(resolveViewFromPath('/')).toEqual({ type: 'home' });
    expect(
      resolveViewFromPath('/', {
        lastProject: 'alpha',
        lastProjectLayout: 'coding',
      }),
    ).toEqual({ type: 'home' });
    expect(resolveViewFromPath('/guidance?tab=skills')).toEqual({
      type: 'guidance',
      tab: 'skills',
    });
    expect(resolveViewFromPath('/guidance?tab=commands')).toEqual({
      type: 'guidance',
      tab: 'commands',
    });
    expect(resolveViewFromPath('/guidance/skill%20one?tab=skills')).toEqual({
      type: 'guidance',
      tab: 'skills',
      selectedId: 'skill one',
    });
    // A tab the UI no longer has is not a tab: it is dropped rather than
    // carried into a view that cannot render it.
    expect(resolveViewFromPath('/guidance?tab=playbooks')).toEqual({
      type: 'guidance',
    });
    // `?filter=commands` narrows the Skills list, so it has to survive a URL
    // round trip.
    expect(resolveViewFromPath('/guidance?tab=skills&filter=commands')).toEqual(
      {
        type: 'guidance',
        tab: 'skills',
        filter: 'commands',
      },
    );
    expect(
      getPathForView({ type: 'guidance', tab: 'skills', filter: 'commands' }),
    ).toBe('/guidance?tab=skills&filter=commands');
    // A filter nothing defines is dropped rather than carried into the view.
    expect(resolveViewFromPath('/guidance?tab=skills&filter=nonsense')).toEqual(
      { type: 'guidance', tab: 'skills' },
    );
  });

  test('resolveViewFromPath returns not-found for unmatched non-root paths', () => {
    expect(resolveViewFromPath('/this-route-does-not-exist')).toEqual({
      type: 'not-found',
      path: '/this-route-does-not-exist',
    });
    // archive#settings-revamp: the dead `/providers` alias
    // (never emitted by getPathForView, only defensively consumed) is
    // removed — the bare path is a genuine 404 now, same as any other
    // unmatched route. The canonical `/connections/providers` and
    // `/connections/providers` routes are unaffected (see the alias
    // table above).
    expect(resolveViewFromPath('/providers')).toEqual({
      type: 'not-found',
      path: '/providers',
    });
    expect(resolveViewFromPath('/providers/demo')).toEqual({
      type: 'not-found',
      path: '/providers/demo',
    });
    // Even with a last project, an unmatched non-root path is a 404 — it must
    // not silently redirect to the last project (that hid broken deep links).
    expect(
      resolveViewFromPath('/nonsense-xyz', {
        lastProject: 'alpha',
        lastProjectLayout: 'coding',
      }),
    ).toEqual({ type: 'not-found', path: '/nonsense-xyz' });
    // Root still restores.
    expect(
      resolveViewFromPath('/', {
        lastProject: 'alpha',
        lastProjectLayout: 'coding',
      }),
    ).toEqual({ type: 'home' });
  });

  test('resolveViewFromPath rejects missing or malformed Task ids as 404s', () => {
    // #765 D2: the redirect layer canonicalises bare /tasks to Home before
    // this resolver ever runs (LEGACY_PATH_CASES above), so direct navigation
    // no longer dead-ends on "No view matches /tasks". At THIS layer the bare
    // path stays a 404 rather than inventing a task-collection view — and a
    // real task deep link must never be redirected away from its id.
    expect(getLegacyPathRedirect('/tasks')).toBe('/');
    expect(getLegacyPathRedirect('/tasks/')).toBe('/');
    expect(getLegacyPathRedirect('/tasks/alpha')).toBeNull();
    expect(resolveViewFromPath('/tasks')).toEqual({
      type: 'not-found',
      path: '/tasks',
    });
    expect(resolveViewFromPath('/tasks/')).toEqual({
      type: 'not-found',
      path: '/tasks/',
    });
    expect(resolveViewFromPath('/tasks/%E0%A4%A')).toEqual({
      type: 'not-found',
      path: '/tasks/%E0%A4%A',
    });
  });

  /**
   * 4-HOME-012. `/projects/<slug>/<anything>` used to render the project
   * dashboard, so a mistyped or stale deep link was indistinguishable from a
   * working one — and it contradicted `routing.ts`'s own comment that a
   * non-root path matching no route is a genuine 404.
   */
  test('a project subroute that matches no project route is a 404, not the project page', () => {
    expect(
      resolveViewFromPath('/projects/audit-alpha/zzz-does-not-exist'),
    ).toEqual({
      type: 'not-found',
      path: '/projects/audit-alpha/zzz-does-not-exist',
    });
    expect(resolveViewFromPath('/projects/audit-alpha/coding')).toEqual({
      type: 'not-found',
      path: '/projects/audit-alpha/coding',
    });
    expect(
      resolveViewFromPath('/projects/audit-alpha/layouts/coding/extra/more'),
    ).toEqual({
      type: 'not-found',
      path: '/projects/audit-alpha/layouts/coding/extra/more',
    });
  });

  /**
   * The third segment under a layout is its TAB — `setLayoutTab` navigates to
   * exactly this shape and `NavigationStore`'s pathname parse reads it back as
   * `activeTab`. It used to 404, which made every tab of every layout,
   * including every plugin-provided one, land on "Page not found" (seen in
   * `tests/meeting-notes.spec.ts` on `.../layouts/meeting-notes/library` and in
   * `tests/mcp-ui-layout.spec.ts` on `.../layouts/mixed/tool-ui`).
   *
   * 4-HOME-012's rule is preserved by NAMING the segment rather than
   * discarding it: a stale tab id stays visible on the view and in the URL,
   * and `LayoutView` falls back to the layout's first tab — the behaviour it
   * already had for a remembered-but-since-deleted tab.
   */
  test('a layout tab segment resolves to its layout and names the tab', () => {
    expect(
      resolveViewFromPath(
        '/projects/audit-alpha/layouts/meeting-notes/library',
      ),
    ).toEqual({
      type: 'layout',
      projectSlug: 'audit-alpha',
      layoutSlug: 'meeting-notes',
      tab: 'library',
    });
    expect(
      resolveViewFromPath('/projects/audit-alpha/layouts/coding/extra'),
    ).toEqual({
      type: 'layout',
      projectSlug: 'audit-alpha',
      layoutSlug: 'coding',
      tab: 'extra',
    });
    // No tab segment means no `tab` on the view, not an empty one.
    expect(
      resolveViewFromPath('/projects/audit-alpha/layouts/coding'),
    ).not.toHaveProperty('tab');
    // …and the path the view produces round-trips the tab.
    expect(
      getPathForView({
        type: 'layout',
        projectSlug: 'audit-alpha',
        layoutSlug: 'meeting-notes',
        tab: 'library',
      }),
    ).toBe('/projects/audit-alpha/layouts/meeting-notes/library');
    expect(
      getPathForView({
        type: 'layout',
        projectSlug: 'audit-alpha',
        layoutSlug: 'meeting-notes',
      }),
    ).toBe('/projects/audit-alpha/layouts/meeting-notes');
  });

  test('the exact project route, and its trailing-slash spelling, still resolve', () => {
    expect(resolveViewFromPath('/projects/audit-alpha')).toEqual({
      type: 'project',
      slug: 'audit-alpha',
    });
    expect(resolveViewFromPath('/projects/audit-alpha/')).toEqual({
      type: 'project',
      slug: 'audit-alpha',
    });
    expect(resolveViewFromPath('/projects/audit-alpha?chat=thread-1')).toEqual({
      type: 'project',
      slug: 'audit-alpha',
    });
    expect(
      resolveViewFromPath('/projects/audit-alpha/layouts/coding/'),
    ).toEqual({
      type: 'layout',
      projectSlug: 'audit-alpha',
      layoutSlug: 'coding',
    });
  });

  test('fails closed for malformed Workspace Pane direct routes', () => {
    expect(resolveViewFromPath('/projects/demo/panes')).toEqual({
      type: 'not-found',
      path: '/projects/demo/panes',
    });
    expect(resolveViewFromPath('/projects/demo/panes/%E0%A4%A')).toEqual({
      type: 'not-found',
      path: '/projects/demo/panes/%E0%A4%A',
    });
  });

  test('getPathForView serializes navigable views', () => {
    expect(getPathForView({ type: 'home' })).toBe('/');
    expect(resolveViewFromPath('/activity?session=thread%2Falpha')).toEqual({
      type: 'activity',
      sessionId: 'thread/alpha',
    });
    expect(
      getPathForView({ type: 'activity', sessionId: 'thread/alpha' }),
    ).toBe('/activity?session=thread%2Falpha');
    // archive#4052: the one-shot evidence focus intent rides the
    // session deep link. It only means anything alongside a session, and any
    // other `focus` value is ignored rather than carried.
    expect(
      resolveViewFromPath('/activity?session=thread%2Falpha&focus=evidence'),
    ).toEqual({
      type: 'activity',
      sessionId: 'thread/alpha',
      focus: 'evidence',
    });
    expect(
      resolveViewFromPath('/activity?session=thread%2Falpha&focus=bogus'),
    ).toEqual({ type: 'activity', sessionId: 'thread/alpha' });
    expect(resolveViewFromPath('/activity?focus=evidence')).toEqual({
      type: 'activity',
    });
    expect(getPathForView({ type: 'agents' })).toBe('/agents');
    expect(
      getPathForView({
        type: 'layout',
        projectSlug: 'alpha',
        layoutSlug: 'coding',
      }),
    ).toBe('/projects/alpha/layouts/coding');
    expect(
      getPathForView({
        type: 'workspace-pane',
        projectSlug: 'alpha project',
        descriptorId: 'builtin:flow/run',
        instanceId: 'instance / one',
      }),
    ).toBe(
      '/projects/alpha%20project/panes/builtin%3Aflow%2Frun/instance%20%2F%20one',
    );
    expect(
      getPathForView({
        type: 'workspace-pane',
        projectSlug: 'alpha project',
        layoutSlug: 'coding layout',
        descriptorId: 'pane:builtin:coding:file-browser',
        instanceId: 'files / one',
      }),
    ).toBe(
      '/projects/alpha%20project/layouts/coding%20layout/panes/pane%3Abuiltin%3Acoding%3Afile-browser/files%20%2F%20one',
    );
    expect(
      getParentView({
        type: 'workspace-pane',
        projectSlug: 'alpha',
        layoutSlug: 'coding',
        descriptorId: 'pane:builtin:coding:terminal',
        instanceId: 'terminal',
      }),
    ).toEqual({ type: 'layout', projectSlug: 'alpha', layoutSlug: 'coding' });
    expect(
      getPathForView({ type: 'project-session-board', slug: 'alpha' }),
    ).toBe('/projects/alpha/session-board');
    expect(
      getPathForView({ type: 'project-flow-console', slug: 'alpha' }),
    ).toBe('/projects/alpha/flow-console');
    expect(
      getPathForView({
        type: 'project-flow-console',
        slug: 'alpha',
        runId: 'run-1',
      }),
    ).toBe('/projects/alpha/flow-console?run=run-1');
    expect(
      getParentView({ type: 'project-flow-console', slug: 'alpha' }),
    ).toEqual({ type: 'project', slug: 'alpha' });
    expect(getPathForView({ type: 'connections-acp' })).toBe(
      '/connections/acp',
    );
    expect(getPathForView({ type: 'task', taskId: 'task/alpha' })).toBe(
      '/tasks/task%2Falpha',
    );
  });

  test('getPathForView emits the canonical route for Models and Agent apps', () => {
    expect(getPathForView({ type: 'connections-providers' })).toBe(
      '/connections/models',
    );
    expect(
      getPathForView({ type: 'connections-provider-edit', id: 'demo' }),
    ).toBe('/connections/models/demo');
    expect(getPathForView({ type: 'connections-engines' })).toBe(
      '/connections/engines',
    );
    expect(
      getPathForView({ type: 'connections-runtime-edit', id: 'demo' }),
    ).toBe('/connections/engines/demo');
  });

  test('getPathForView emits /registry/:tab when a tab is set', () => {
    expect(getPathForView({ type: 'registry' })).toBe('/registry');
    expect(getPathForView({ type: 'registry', tab: 'plugins' })).toBe(
      '/registry/plugins',
    );
    expect(getPathForView({ type: 'registry', tab: 'integrations' })).toBe(
      '/registry/integrations',
    );
  });
});
