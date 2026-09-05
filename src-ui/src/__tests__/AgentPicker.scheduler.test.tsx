/** @vitest-environment jsdom */

import {
  agentId,
  engineConnectionId,
} from '@kontourai/station-contracts/agent-identity';
import type { EnrichedAgentProjection } from '@kontourai/station-contracts/enriched-agent';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';

const useAgents = vi.hoisted(() => vi.fn());

vi.mock('../contexts/AgentsContext', () => ({ useAgents }));

import { AgentPicker } from '../components/scheduler/AgentPicker';
import {
  SCHEDULER_ENGINE_AGENT_REASON,
  schedulerAgentOptions,
  schedulerAgentRunnability,
  schedulerRunnableAgents,
} from '../components/scheduler/schedulerAgentOptions';

const agent = (
  slug: string,
  overrides: Partial<EnrichedAgentProjection> = {},
): EnrichedAgentProjection => ({
  slug: agentId(slug),
  name: slug,
  ...overrides,
});

describe('scheduler Agent options', () => {
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

  test('separates the engine-binding contract from current readiness', () => {
    const options = schedulerAgentOptions([
      agent('station', {
        available: false,
        unavailableReason: 'No model resolves yet.',
      }),
      agent('claude', {
        name: 'Claude Code',
        execution: { agentConnectionId: engineConnectionId('claude') },
      }),
      agent('reviewer'),
    ]);

    // An eligible-but-unready Agent is still listed; a bound one never is.
    expect(options.eligible.map(({ slug }) => slug)).toEqual([
      'station',
      'reviewer',
    ]);
    expect(options.excludedEngineAgents.map(({ slug }) => slug)).toEqual([
      'claude',
    ]);
    // The default is the first eligible Agent that can actually run.
    expect(options.defaultSlug).toBe('reviewer');
  });

  test('reports an engine-bound agent as unrunnable for the scheduler even when the server calls it available', () => {
    const agents = [
      agent('claude', {
        available: true,
        execution: { agentConnectionId: engineConnectionId('claude') },
      }),
    ];

    expect(schedulerAgentRunnability(agents, 'claude')).toEqual({
      runnable: false,
      reason: SCHEDULER_ENGINE_AGENT_REASON,
    });
    expect(schedulerAgentOptions(agents).defaultSlug).toBeNull();
  });

  test('passes the server reason through for an eligible agent that cannot run', () => {
    expect(
      schedulerAgentRunnability(
        [
          agent('station', {
            available: false,
            unavailableReason: 'No model resolves yet.',
          }),
        ],
        'station',
      ),
    ).toEqual({ runnable: false, reason: 'No model resolves yet.' });
  });

  test('keeps a bound non-runnable agent visible when no agent is selectable', () => {
    useAgents.mockReturnValue([
      agent('claude', {
        name: 'Claude Code',
        execution: { agentConnectionId: engineConnectionId('claude') },
      }),
    ]);

    render(<AgentPicker value="claude" onChange={vi.fn()} />);

    const trigger = screen.getByRole('button', {
      name: /Claude Code.*not runnable here/i,
    });
    expect((trigger as HTMLButtonElement).disabled).toBe(true);
    expect(trigger.textContent).not.toContain('No runnable agents');
  });

  test('lists an eligible-but-unready agent as a disabled row carrying its reason', () => {
    const onChange = vi.fn();
    useAgents.mockReturnValue([
      agent('station', {
        name: 'Station',
        available: false,
        unavailableReason: 'No model resolves yet.',
      }),
      agent('reviewer', { name: 'Reviewer' }),
    ]);

    render(<AgentPicker value="reviewer" onChange={onChange} />);
    fireEvent.click(screen.getByRole('button', { name: /Reviewer/ }));

    const stationRow = screen.getByRole('button', { name: /Station/ });
    expect((stationRow as HTMLButtonElement).disabled).toBe(true);
    expect(stationRow.textContent).toContain('No model resolves yet.');
    fireEvent.click(stationRow);
    expect(onChange).not.toHaveBeenCalled();
  });
});
