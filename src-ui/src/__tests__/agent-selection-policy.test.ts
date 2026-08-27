import type { ConnectionConfig } from '@kontourai/station-contracts/tool';
import { describe, expect, test } from 'vitest';
import {
  selectDirectNewChatAgent,
  selectFirstChatTarget,
  selectGlobalContextAgents,
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

  test('excludes a project-owned agent — §3.3 A1', () => {
    expect(selectGlobalContextAgents([ownedAgent])).toEqual([]);
  });

  test('includes a global agent', () => {
    expect(selectGlobalContextAgents([globalAgent])).toEqual([globalAgent]);
  });

  test('keeps only the global agents from a mixed catalog', () => {
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

/**
 * kontourai/station#3309 review SF-7: the header's pinned New chat button
 * decides between opening a chat directly and opening the picker. Nothing
 * covered that decision — no test can render `ChatDock`, so the rule is named
 * here and driven across all three populations.
 */
describe('selectDirectNewChatAgent (#3309 New chat one-vs-many)', () => {
  const only = { slug: 'station', name: 'Station' } as AgentData;
  const other = { slug: 'claude', name: 'Claude Code' } as AgentData;

  test('exactly one chat-ready agent opens that chat directly', () => {
    expect(selectDirectNewChatAgent([only])).toBe(only);
  });

  test('several chat-ready agents open the picker instead of guessing', () => {
    expect(selectDirectNewChatAgent([only, other])).toBeNull();
  });

  test('none chat-ready still opens the picker — it is what explains why', () => {
    expect(selectDirectNewChatAgent([])).toBeNull();
  });
});
