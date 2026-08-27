import { describe, expect, test } from 'vitest';
import type { NavigationView } from '../../types';
import { routeIdentity, routeSurfaceIdentity } from '../route-identity';

/**
 * The rule table. Each row is two views and whether the entrance should
 * replay between them, which is exactly "did the user navigate?".
 *
 * Before this rule existed the key was `currentView.type` with two hand-
 * written exceptions, so `/agents/a` → `/agents/b`, a different provider
 * record, a different project, a different layout, a different pane, a
 * different session and a different registry tab all changed route without
 * the entrance replaying — while `guidance`'s tab did replay. Inconsistent in
 * both directions.
 */
const REPLAYS: Array<[string, NavigationView, NavigationView]> = [
  [
    'a different agent record',
    { type: 'agent-edit', slug: 'a' },
    { type: 'agent-edit', slug: 'b' },
  ],
  [
    'a different provider record',
    { type: 'connections-provider-edit', id: 'p1' },
    { type: 'connections-provider-edit', id: 'p2' },
  ],
  [
    'a different engine record',
    { type: 'connections-runtime-edit', id: 'r1' },
    { type: 'connections-runtime-edit', id: 'r2' },
  ],
  [
    'a different tool record',
    { type: 'connections-tool-edit', id: 't1' },
    { type: 'connections-tool-edit', id: 't2' },
  ],
  [
    'a different ACP provider',
    { type: 'connections-acp-new', providerId: 'x' },
    { type: 'connections-acp-new', providerId: 'y' },
  ],
  [
    'a different project',
    { type: 'project', slug: 'alpha' },
    { type: 'project', slug: 'beta' },
  ],
  [
    'a different project board',
    { type: 'project-session-board', slug: 'alpha' },
    { type: 'project-session-board', slug: 'beta' },
  ],
  [
    'a different flow run',
    { type: 'project-flow-console', slug: 'alpha', runId: 'run-1' },
    { type: 'project-flow-console', slug: 'alpha', runId: 'run-2' },
  ],
  [
    'a different layout in one project',
    { type: 'layout', projectSlug: 'alpha', layoutSlug: 'coding' },
    { type: 'layout', projectSlug: 'alpha', layoutSlug: 'review' },
  ],
  [
    'a different workspace pane instance',
    {
      type: 'workspace-pane',
      projectSlug: 'alpha',
      descriptorId: 'files',
      instanceId: 'files-1',
    },
    {
      type: 'workspace-pane',
      projectSlug: 'alpha',
      descriptorId: 'files',
      instanceId: 'files-2',
    },
  ],
  [
    'a different session',
    { type: 'activity', sessionId: 's1' },
    { type: 'activity', sessionId: 's2' },
  ],
  [
    'the Activity list vs one session',
    { type: 'activity' },
    { type: 'activity', sessionId: 's1' },
  ],
  [
    'a different task',
    { type: 'task', taskId: 't1' },
    { type: 'task', taskId: 't2' },
  ],
  // Query-backed tabs that ARE navigations: each has its own path, its own
  // palette entry, and swaps the whole surface.
  [
    'a different Guidance tab',
    { type: 'guidance', tab: 'skills' },
    { type: 'guidance', tab: 'commands' },
  ],
  [
    'a different Registry tab',
    { type: 'registry', tab: 'agents' },
    { type: 'registry', tab: 'skills' },
  ],
  [
    'a different Developer tab',
    { type: 'developer', tab: 'logs' },
    { type: 'developer', tab: 'telemetry' },
  ],
  [
    'a different unmatched path',
    { type: 'not-found', path: '/nope' },
    { type: 'not-found', path: '/also-nope' },
  ],
  ['a different surface', { type: 'schedule' }, { type: 'settings' }],
];

const DOES_NOT_REPLAY: Array<[string, NavigationView, NavigationView]> = [
  [
    'an identical view rendered again',
    { type: 'settings' },
    { type: 'settings' },
  ],
  // Incidental detail: the tab an agent editor OPENS on. The editor owns that
  // tab from then on, so re-keying would remount it mid-edit.
  [
    'the same agent reached with a different initial tab',
    { type: 'agent-edit', slug: 'a', initialTab: 'basic' },
    { type: 'agent-edit', slug: 'a', initialTab: 'tools' },
  ],
  // Selecting a row in a split pane's list is not leaving the surface.
  [
    'a different Guidance row selected in the same tab',
    { type: 'guidance', tab: 'skills', selectedId: 'one' },
    { type: 'guidance', tab: 'skills', selectedId: 'two' },
  ],
  // How the URL was reached is provenance, not identity.
  [
    'the same Guidance tab reached via an alias redirect',
    { type: 'guidance', tab: 'skills' },
    { type: 'guidance', tab: 'skills', redirectFromAlias: true },
  ],
];

describe('routeIdentity', () => {
  test.each(REPLAYS)('replays for %s', (_label, from, to) => {
    expect(routeIdentity(from)).not.toBe(routeIdentity(to));
  });

  test.each(DOES_NOT_REPLAY)('does not replay for %s', (_label, from, to) => {
    expect(routeIdentity(from)).toBe(routeIdentity(to));
  });

  test('every NavigationView type has an identity that starts with its type', () => {
    // Guards the `default` branch: a type added to the union later gets a
    // usable identity, and a hand-written case cannot silently return an
    // identity belonging to a different surface.
    const samples: NavigationView[] = [
      ...REPLAYS.flatMap(([, from, to]) => [from, to]),
      ...DOES_NOT_REPLAY.flatMap(([, from, to]) => [from, to]),
      { type: 'home' },
      { type: 'agents' },
      { type: 'agent-new' },
      { type: 'connections' },
      { type: 'connections-providers' },
      { type: 'connections-engines' },
      { type: 'connections-acp' },
      { type: 'connections-tools' },
      { type: 'connections-knowledge' },
      { type: 'plugins' },
      { type: 'review-queue' },
      { type: 'profile' },
      { type: 'notifications' },
      { type: 'project-new' },
      { type: 'project-edit', slug: 'alpha' },
    ];
    for (const view of samples) {
      const identity = routeIdentity(view);
      expect(identity.startsWith(view.type)).toBe(true);
      expect(identity.length).toBeGreaterThan(0);
    }
  });

  test('two different types can never collide on one identity', () => {
    const identities = new Set<string>();
    const types: NavigationView[] = [
      { type: 'home' },
      { type: 'agents' },
      { type: 'agent-new' },
      { type: 'agent-edit', slug: 'a' },
      { type: 'guidance' },
      { type: 'registry' },
      { type: 'developer' },
      { type: 'activity' },
      { type: 'settings' },
      { type: 'schedule' },
      { type: 'profile' },
      { type: 'notifications' },
      { type: 'project', slug: 'a' },
      { type: 'project-edit', slug: 'a' },
      { type: 'project-session-board', slug: 'a' },
    ];
    for (const view of types) identities.add(routeIdentity(view));
    expect(identities.size).toBe(types.length);
  });
});

describe('routeSurfaceIdentity', () => {
  test('keeps exact route identities distinct while coalescing only Connections split-pane families', () => {
    const models = { type: 'connections-providers' } as const;
    const modelEdit = { type: 'connections-provider-edit', id: 'p1' } as const;
    const engines = { type: 'connections-engines' } as const;
    const engineEdit = { type: 'connections-runtime-edit', id: 'e1' } as const;
    const tools = { type: 'connections-tools' } as const;
    const toolEdit = { type: 'connections-tool-edit', id: 't1' } as const;

    expect(routeIdentity(models)).not.toBe(routeIdentity(modelEdit));
    expect(routeIdentity(engines)).not.toBe(routeIdentity(engineEdit));
    expect(routeIdentity(tools)).not.toBe(routeIdentity(toolEdit));
    expect(routeSurfaceIdentity(models)).toBe(routeSurfaceIdentity(modelEdit));
    expect(routeSurfaceIdentity(engines)).toBe(
      routeSurfaceIdentity(engineEdit),
    );
    expect(routeSurfaceIdentity(tools)).toBe(routeSurfaceIdentity(toolEdit));
    expect(routeSurfaceIdentity(models)).not.toBe(
      routeSurfaceIdentity(engines),
    );
    expect(routeSurfaceIdentity(engines)).not.toBe(routeSurfaceIdentity(tools));
  });

  test('does not broaden surface identity to ACP, new agents, or Activity', () => {
    const acp = { type: 'connections-acp' } as const;
    const acpNew = { type: 'connections-acp-new', providerId: 'p1' } as const;
    const agentNew = { type: 'agent-new' } as const;
    const agentEdit = { type: 'agent-edit', slug: 'a' } as const;
    const activity = { type: 'activity' } as const;
    const session = { type: 'activity', sessionId: 's1' } as const;

    expect(routeSurfaceIdentity(acp)).toBe(routeIdentity(acp));
    expect(routeSurfaceIdentity(acpNew)).toBe(routeIdentity(acpNew));
    expect(routeSurfaceIdentity(agentNew)).toBe(routeIdentity(agentNew));
    expect(routeSurfaceIdentity(agentEdit)).toBe(routeIdentity(agentEdit));
    expect(routeSurfaceIdentity(activity)).toBe(routeIdentity(activity));
    expect(routeSurfaceIdentity(session)).toBe(routeIdentity(session));
  });
});
