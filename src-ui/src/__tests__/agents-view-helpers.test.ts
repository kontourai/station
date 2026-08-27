import {
  agentId,
  engineConnectionId,
} from '@kontourai/station-contracts/agent-identity';
import { createElement, isValidElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, test, vi } from 'vitest';
import { agentReadinessState } from '../components/AgentReadinessCell';
import type { AgentData } from '../contexts/AgentsContext';
import {
  agentFixRoute,
  buildAgentsViewEmptyContent,
  buildAgentsViewItems,
} from '../views/agent-editor/agentsViewHelpers';

describe('agents view helpers', () => {
  test('buildAgentsViewItems consumes persisted Agent rows only', () => {
    const agents = [
      {
        slug: agentId('alpha'),
        name: 'Alpha',
        updatedAt: '2026-01-01T00:00:00Z',
      },
      {
        slug: agentId('workspace-beta'),
        name: 'Beta',
        updatedAt: '2026-01-01T00:00:00Z',
      },
      {
        slug: agentId('acp-agent'),
        name: 'ACP Agent',
        updatedAt: '2026-01-01T00:00:00Z',
        source: 'acp',
        engineConnectionType: 'acp',
      },
    ] satisfies AgentData[];

    const items = buildAgentsViewItems(agents, [
      {
        id: 'conn-1',
        name: 'ACP One',
        icon: '/acp.svg',
        modes: [{}, {}, {}],
      },
    ]);

    expect(items.map((item) => item.id)).toEqual([
      'alpha',
      'workspace-beta',
      'acp-agent',
    ]);
    expect(items[0].name).toBe('Alpha');
    expect(isValidElement(items[0].icon)).toBe(true);
    expect(items[0].section).toBe('Your agents');
  });

  test('groups engine seeds and exposes one action for each readiness state', () => {
    const onChat = vi.fn();
    const onFix = vi.fn();
    const agents = [
      {
        slug: agentId('station'),
        name: 'Station',
        engineDefault: true,
        available: false,
        // "Enable" is spoken on the SERVER's signal, never inferred from
        // `engineDefault` — see `agentFixLabel`.
        enable: { engineConnectionId: engineConnectionId('station') },
        unavailableFix: { kind: 'engine-disabled' },
      },
      { slug: agentId('ready'), name: 'Writer', available: true },
      {
        slug: agentId('needs'),
        name: 'Coder',
        available: false,
        unavailableReason: 'a model connection',
        unavailableFix: { kind: 'model-connection' },
      },
    ] satisfies AgentData[];
    const items = buildAgentsViewItems(agents, [], undefined, {
      onChat,
      onFix,
    });
    // §2's order, not the catalog's: the engines band is first, and each
    // band is contiguous — the rail prints a header on every change of
    // `section`, so interleaved rows would print a heading twice.
    expect(items.map((item) => item.section)).toEqual([
      'Engines on this machine',
      'Your agents',
      'Your agents',
    ]);
    expect(items.map((item) => item.id)).toEqual(['station', 'ready', 'needs']);
    // The state is inline with the name; the trailing slot is action-only.
    expect(items.map((item) => item.subtitle)).toEqual(['', '', '']);
    const markup = renderToStaticMarkup(
      createElement(
        'div',
        undefined,
        items.map((item) => [item.badge, item.trailing]),
      ),
    );
    expect(markup).toContain('Not set up');
    expect(markup).toContain('Ready');
    expect(markup).toContain('Needs: a model connection');
    expect(markup).toContain('Enable');
    expect(markup).toContain('Chat');
    expect(markup).toContain('Connect');
  });

  test('routes each server fix kind to its one repair destination', () => {
    expect(
      agentFixRoute({
        unavailableFix: { kind: 'model-connection' },
      }),
    ).toBe('models');
    expect(
      agentFixRoute({
        unavailableFix: { kind: 'engine-disabled' },
      }),
    ).toBe('enable');
    expect(
      agentFixRoute({
        unavailableFix: { kind: 'cli-missing' },
      }),
    ).toBe('engines');
    // Nothing bound, nothing named: no route, so no guessed "Set up".
    expect(
      agentFixRoute({
        unavailableFix: { kind: 'policy' },
      }),
    ).toBeUndefined();
  });

  test('a prose change never changes the repair route', () => {
    const agent = { unavailableFix: { kind: 'connection-broken' as const } };
    expect(
      agentFixRoute({ ...agent, unavailableReason: 'A model is disabled.' }),
    ).toBe('engines');
    expect(
      agentFixRoute({ ...agent, unavailableReason: 'Anything else.' }),
    ).toBe('engines');
    expect(agentFixRoute({ unavailableFix: { kind: 'none' } })).toBeUndefined();
  });

  test('list rows expose only the one server-derived readiness state', () => {
    const agents = [
      {
        slug: agentId('owned-agent'),
        name: 'Owned Agent',
        updatedAt: '2026-01-01T00:00:00Z',
        project: 'demo-project',
      },
      {
        slug: agentId('orphaned-agent'),
        name: 'Orphaned Agent',
        updatedAt: '2026-01-01T00:00:00Z',
        project: 'ghost-project',
      },
      {
        slug: agentId('global-agent'),
        name: 'Global Agent',
        updatedAt: '2026-01-01T00:00:00Z',
      },
    ] satisfies AgentData[];

    const items = buildAgentsViewItems(agents, [], new Set(['demo-project']));

    expect(items.map((item) => item.subtitle)).toEqual(['', '', '']);
    expect(
      agents.map((agent) => agentReadinessState(agent as AgentData).label),
    ).toEqual(['Ready', 'Ready', 'Ready']);
  });

  test('buildAgentsViewEmptyContent renders onboarding and empty-state copy', () => {
    const onboarding = renderToStaticMarkup(
      buildAgentsViewEmptyContent({
        agentsCount: 0,
        onCreateBlank: () => {},
      }),
    );

    expect(onboarding).toContain('No agents of your own yet');
    expect(onboarding).toContain(
      'Start from a model connection or an installed agent CLI.',
    );

    const emptyState = renderToStaticMarkup(
      buildAgentsViewEmptyContent({
        agentsCount: 2,
        onCreateBlank: () => {},
      }),
    );

    expect(emptyState).toContain('No agents of your own yet');
    expect(emptyState).toContain('New agent');
  });
});
