// @vitest-environment jsdom

import {
  agentId,
  engineConnectionId,
  engineId,
} from '@kontourai/station-contracts/agent-identity';
import { render, screen } from '@testing-library/react';
import { describe, expect, test } from 'vitest';
import type { AgentData } from '../contexts/AgentsContext';
import { buildAgentsViewItems } from '../views/agent-editor/agentsViewHelpers';

describe('buildAgentsViewItems engine chips', () => {
  test('an engine chip renders only when it distinguishes the agent name', () => {
    const agents: AgentData[] = [
      { slug: agentId('code-reviewer'), name: 'Code Reviewer' },
      {
        slug: agentId('opencode'),
        name: 'OpenCode',
        source: 'local',
        engineId: engineId('opencode'),
        engineDisplayName: 'OpenCode',
        execution: { agentConnectionId: engineConnectionId('opencode-conn') },
      },
      {
        slug: agentId('station'),
        name: 'Amazon Bedrock',
        source: 'local',
        engineId: engineId('station'),
      },
      {
        slug: agentId('kiro'),
        name: 'Kiro',
        source: 'acp',
        engineConnectionType: 'acp',
        connectionName: 'Kiro CLI',
        execution: { agentConnectionId: engineConnectionId('kiro-conn') },
      },
    ];
    const items = buildAgentsViewItems(agents, [
      { id: 'kiro-conn', name: 'Kiro CLI', modes: ['default'] },
    ]);

    const stationItem = items.find((item) => item.id === 'code-reviewer')!;
    const externalItem = items.find((item) => item.id === 'opencode')!;
    const managedItem = items.find((item) => item.id === 'station')!;
    const acpItem = items.find((item) => item.id === 'kiro')!;

    // A plain Station agent gets a "Station" chip — no longer no-badge.
    const stationRender = render(<div>{stationItem.badge}</div>);
    expect(screen.getByText('Station')).toBeTruthy();
    expect(screen.queryByText('External')).toBeNull();
    stationRender.unmount();

    // The badge slot always carries the readiness pill; the ENGINE chip is
    // what must be absent when it would only repeat the name.
    const externalRender = render(<div>{externalItem.badge}</div>);
    expect(externalRender.container.querySelector('.engine-chip')).toBeNull();
    expect(screen.queryByText('OpenCode')).toBeNull();
    externalRender.unmount();

    // An engine-managed default gets a Station chip from its explicit engine.
    const managedRender = render(<div>{managedItem.badge}</div>);
    expect(screen.getByText('Station')).toBeTruthy();
    expect(screen.queryByText('External')).toBeNull();
    managedRender.unmount();

    // An ACP connection's chip names the connection, not "ACP".
    const acpRender = render(<div>{acpItem.badge}</div>);
    expect(screen.getByText('Kiro CLI')).toBeTruthy();
    expect(acpRender.container.querySelector('.engine-chip')?.textContent).toBe(
      'Kiro CLI',
    );
  });
});
