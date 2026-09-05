/** @vitest-environment jsdom */

import {
  agentId,
  engineConnectionId,
} from '@kontourai/station-contracts/agent-identity';
import type { EnrichedAgentProjection } from '@kontourai/station-contracts/enriched-agent';
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';

const useAgents = vi.hoisted(() => vi.fn());
const agentsLoaded = vi.hoisted(() => ({ value: true }));

vi.mock('../contexts/AgentsContext', () => ({
  useAgents,
  useAgentsLoaded: () => agentsLoaded.value,
}));

import { AgentPicker } from '../components/scheduler/AgentPicker';
import {
  SCHEDULER_ENGINE_AGENT_REASON,
  schedulerAgentOptions,
  schedulerAgentRunnability,
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
  beforeEach(() => {
    agentsLoaded.value = true;
  });

  test('lists every agent the in-process runner can resolve, and only those', () => {
    // #1536 L2: this used to assert a `schedulerRunnableAgents` helper with no
    // production consumer, under a name describing what the PICKER does. The
    // picker lists `eligible`; runnability decides which of those rows a click
    // may take. Both are asserted here, on the derivation the picker uses.
    const options = schedulerAgentOptions([
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

    // Every Station-engine Agent is a ROW, including the one that cannot run:
    // its reason is the only thing that says what to fix.
    expect(options.eligible.map(({ slug }) => slug)).toEqual([
      'station',
      'reviewer',
      'offline',
    ]);
    // The bound ones are not offered at all — the runner cannot resolve them.
    expect(options.excludedEngineAgents.map(({ slug }) => slug)).toEqual([
      'external-station',
      'claude',
    ]);
    // And only a runnable row is selectable.
    expect(
      options.eligible
        .filter(
          ({ slug }) =>
            schedulerAgentRunnability(options.eligible, slug).runnable,
        )
        .map(({ slug }) => slug),
    ).toEqual(['station', 'reviewer']);
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

  test('withholds the "no runnable agents" verdict until the catalog answers', () => {
    // #1536 H1-2: an unanswered catalog is `[]`, indistinguishable from one that
    // genuinely holds nothing. A verdict waits for the answer.
    agentsLoaded.value = false;
    useAgents.mockReturnValue([]);

    render(<AgentPicker value="station" onChange={vi.fn()} />);

    // The shared loading primitive stands in for the control; its `label` is
    // the placeholder's accessible name.
    expect(screen.getByLabelText('Loading agents')).toBeTruthy();
    expect(screen.queryByText('No runnable agents')).toBeNull();

    agentsLoaded.value = true;
  });
});
