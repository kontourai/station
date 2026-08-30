/** @vitest-environment jsdom */

import {
  agentId,
  engineConnectionId,
} from '@kontourai/station-contracts/agent-identity';
import type { EnrichedAgentProjection } from '@kontourai/station-contracts/enriched-agent';
import { render, screen } from '@testing-library/react';
import { createElement } from 'react';
import { describe, expect, test, vi } from 'vitest';

const useAgents = vi.hoisted(() => vi.fn());

vi.mock('../contexts/AgentsContext', () => ({ useAgents }));

import {
  AgentPicker,
  schedulerRunnableAgents,
} from '../components/scheduler/AgentPicker';

const agent = (
  slug: string,
  overrides: Partial<EnrichedAgentProjection> = {},
): EnrichedAgentProjection => ({
  slug: agentId(slug),
  name: slug,
  ...overrides,
});

describe('scheduler Agent picker', () => {
  test('offers only agents the in-process scheduler runner can resolve', () => {
    const offered = schedulerRunnableAgents([
      agent('station'),
      agent('external-station', {
        execution: { agentConnectionId: engineConnectionId('claude') },
      }),
      agent('reviewer'),
      agent('claude', {
        execution: { agentConnectionId: engineConnectionId('claude') },
      }),
      agent('offline', { available: false }),
    ]);

    expect(offered.map(({ slug }) => slug)).toEqual(['station', 'reviewer']);
  });

  test('keeps a bound non-runnable agent visible when no agent is selectable', () => {
    useAgents.mockReturnValue([
      agent('claude', {
        name: 'Claude Code',
        execution: { agentConnectionId: engineConnectionId('claude') },
      }),
    ]);

    render(createElement(AgentPicker, { value: 'claude', onChange: vi.fn() }));

    const trigger = screen.getByRole('button', {
      name: /Claude Code.*not runnable here/i,
    });
    expect(trigger).toBeDisabled();
    expect(trigger).not.toHaveTextContent('No runnable agents');
  });
});
