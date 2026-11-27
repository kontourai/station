import { STATION_AGENT_ID } from '@kontourai/station-contracts/agent-identity';
import type { ConnectionConfig } from '@kontourai/station-contracts/tool';
import { describe, expect, test } from 'vitest';
import {
  selectFirstChatTarget,
  selectGlobalContextAgents,
  selectHelpPromptTarget,
} from '../components/agent-selection-policy';
import type { AgentData } from '../contexts/AgentsContext';

const readyConnection: ConnectionConfig = {
  id: 'bedrock-runtime',
  kind: 'agent',
  type: 'bedrock-runtime',
  name: 'Managed Runtime',
  enabled: true,
  capabilities: ['agent-runtime'],
  config: {},
  status: 'ready',
} as any;

describe('selectGlobalContextAgents (station#3027)', () => {
  const ownedAgent = {
    slug: 'owned-agent',
    name: 'Owned Agent',
    project: 'project-a',
  } as AgentData;
  const globalAgent = {
    slug: 'global-agent',
    name: 'Global Agent',
  } as AgentData;

  test('keeps only the global agents from a mixed catalog — §3.3 A1', () => {
    expect(selectGlobalContextAgents([ownedAgent, globalAgent])).toEqual([
      globalAgent,
    ]);
  });
});

describe('selectFirstChatTarget (station#1004 review MED)', () => {
  test('the header quick-start never selects a project-owned agent in the global context', () => {
    const ownedAgent: AgentData = {
      slug: 'owned-agent',
      name: 'Owned Agent',
      project: 'project-a',
      execution: { agentConnectionId: 'bedrock-runtime' },
    } as any;

    const target = selectFirstChatTarget({
      agents: [ownedAgent],
      agentConnections: [readyConnection],
    });

    expect(target).toBeUndefined();
  });

  test('selects a project-owned agent when the header is inside that same project', () => {
    const ownedAgent: AgentData = {
      slug: 'owned-agent',
      name: 'Owned Agent',
      project: 'project-a',
      execution: { agentConnectionId: 'bedrock-runtime' },
    } as any;

    const target = selectFirstChatTarget({
      agents: [ownedAgent],
      agentConnections: [readyConnection],
      selectedProjectSlug: 'project-a',
    });

    expect(target).toEqual(ownedAgent);
  });

  test('never selects an agent owned by a different project even with a project identity', () => {
    const ownedAgent: AgentData = {
      slug: 'owned-agent',
      name: 'Owned Agent',
      project: 'project-a',
      execution: { agentConnectionId: 'bedrock-runtime' },
    } as any;

    const target = selectFirstChatTarget({
      agents: [ownedAgent],
      agentConnections: [readyConnection],
      selectedProjectSlug: 'project-b',
    });

    expect(target).toBeUndefined();
  });

  test('still selects a global (unowned) agent regardless of project identity', () => {
    const globalAgent: AgentData = {
      slug: 'global-agent',
      name: 'Global Agent',
      execution: { agentConnectionId: 'bedrock-runtime' },
    } as any;

    expect(
      selectFirstChatTarget({
        agents: [globalAgent],
        agentConnections: [readyConnection],
      }),
    ).toEqual(globalAgent);
    expect(
      selectFirstChatTarget({
        agents: [globalAgent],
        agentConnections: [readyConnection],
        selectedProjectSlug: 'project-a',
      }),
    ).toEqual(globalAgent);
  });
});

describe('selectHelpPromptTarget', () => {
  const kiroConnection: ConnectionConfig = {
    ...readyConnection,
    id: 'kiro-cli',
    type: 'acp',
    name: 'Kiro',
  } as any;
  const stationConnection: ConnectionConfig = {
    ...readyConnection,
    id: 'station',
  } as any;
  const kiro: AgentData = {
    slug: 'kiro-cli',
    name: 'Kiro',
    execution: { agentConnectionId: 'kiro-cli' },
  } as any;
  const station: AgentData = {
    slug: STATION_AGENT_ID,
    name: 'Station Assistant',
    execution: { agentConnectionId: 'station' },
  } as any;

  test('starts on the Station Assistant even when another chat-ready Agent is listed first', () => {
    const agentConnections = [kiroConnection, stationConnection];

    expect(
      selectHelpPromptTarget({ agents: [kiro, station], agentConnections }),
    ).toEqual(station);
    // The Assistant is global, so a Project the header is inside keeps it.
    expect(
      selectHelpPromptTarget({
        agents: [kiro, station],
        agentConnections,
        selectedProjectSlug: 'project-a',
      }),
    ).toEqual(station);
  });

  const assistantCannotStart: Array<[string, AgentData[], ConnectionConfig[]]> =
    [
      [
        'the server marks it unavailable',
        [kiro, { ...station, available: false } as AgentData],
        [kiroConnection, stationConnection],
      ],
      [
        'its engine connection is not selectable',
        [kiro, station],
        [
          kiroConnection,
          { ...stationConnection, status: 'degraded' } as ConnectionConfig,
        ],
      ],
      ['it is not in the catalog', [kiro], [kiroConnection]],
    ];

  test.each(assistantCannotStart)(
    'falls back to the first Agent that can start a chat when %s',
    (_case, agents, agentConnections) => {
      expect(selectHelpPromptTarget({ agents, agentConnections })).toEqual(
        kiro,
      );
    },
  );

  test('has no target when neither the Assistant nor any other Agent can start a chat', () => {
    expect(
      selectHelpPromptTarget({
        agents: [station],
        agentConnections: [],
      }),
    ).toBeUndefined();
  });
});
