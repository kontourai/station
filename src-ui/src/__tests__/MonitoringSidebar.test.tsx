/**
 * @vitest-environment jsdom
 */

import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';
import type { ActivateEvent } from '../utils/activatable';

vi.mock('../views/monitoring-utils', () => ({
  getAgentColor: () => '#00aa88',
}));

vi.mock('../views/monitoring/view-utils', () => ({
  getHistoricalAgentSlugs: () => ['historical-agent'],
  getMonitoringAgentCountLabel: () => '2 agents',
  getRunningConversations: () => [{ id: 'conv:abc12345', color: '#00aa88' }],
}));

import { MonitoringSidebar } from '../views/monitoring/MonitoringSidebar';

describe('MonitoringSidebar', () => {
  test('uses title case labels for headings and statuses', () => {
    const onAgentClick =
      vi.fn<(agentSlug: string, event: ActivateEvent) => void>();
    const onConversationClick =
      vi.fn<(conversationId: string, agentSlug: string) => void>();

    render(
      <MonitoringSidebar
        stats={
          {
            summary: {
              activeAgents: 1,
              runningAgents: 1,
              totalEvents: 0,
            },
            agents: [
              {
                slug: 'runtime-agent',
                name: 'Runtime Agent',
                status: 'running',
                healthy: true,
                model: 'codex',
                messageCount: 4,
              },
            ],
          } as any
        }
        events={[]}
        filteredEvents={[]}
        selectedAgents={[]}
        onAgentClick={onAgentClick}
        onConversationClick={onConversationClick}
        resolveModelName={(modelId) => modelId}
      />,
    );

    expect(screen.getByText('Agents')).toBeTruthy();
    expect(screen.getByText('Running')).toBeTruthy();
    expect(screen.getAllByText('Historical')).toHaveLength(2);

    fireEvent.click(screen.getByText('Runtime Agent'));
    expect(onAgentClick).toHaveBeenCalled();

    fireEvent.click(screen.getByText('abc12345...'));
    expect(onConversationClick).toHaveBeenCalledWith(
      'conv:abc12345',
      'runtime-agent',
    );
  });

  function renderSidebar(
    onAgentClick: ReturnType<
      typeof vi.fn<(agentSlug: string, event: ActivateEvent) => void>
    >,
    onConversationClick: ReturnType<
      typeof vi.fn<(conversationId: string, agentSlug: string) => void>
    >,
  ) {
    return render(
      <MonitoringSidebar
        stats={
          {
            summary: { activeAgents: 1, runningAgents: 1, totalEvents: 0 },
            agents: [
              {
                slug: 'runtime-agent',
                name: 'Runtime Agent',
                status: 'running',
                healthy: true,
                model: 'codex',
                messageCount: 4,
              },
            ],
          } as any
        }
        events={[]}
        filteredEvents={[]}
        selectedAgents={[]}
        onAgentClick={onAgentClick}
        onConversationClick={onConversationClick}
        resolveModelName={(modelId) => modelId}
      />,
    );
  }

  // These cards were selectable by mouse only. They are the filter control
  // for the whole monitoring view, so a keyboard user could not filter at
  // all. The keyboard control is the agent-header ROW, not the card: the
  // running card contains the conversation controls, and a button role on
  // the card would flatten them to presentational in accessibility APIs
  //
  test('the agent-header row is the keyboard control, and Shift carries through', () => {
    const onAgentClick =
      vi.fn<(agentSlug: string, event: ActivateEvent) => void>();
    renderSidebar(
      onAgentClick,
      vi.fn<(conversationId: string, agentSlug: string) => void>(),
    );

    const card = screen.getByText('Runtime Agent').closest('.agent-card');
    // The card is a mouse convenience surface, NOT a button — a button here
    // would swallow the conversation controls nested inside it.
    expect(card?.getAttribute('role')).toBeNull();
    expect(card?.getAttribute('tabindex')).toBeNull();

    const header = screen.getByText('Runtime Agent').closest('.agent-header');
    expect(header?.getAttribute('role')).toBe('button');
    expect(header?.getAttribute('tabindex')).toBe('0');

    fireEvent.keyDown(header as Element, { key: 'Enter' });
    expect(onAgentClick).toHaveBeenCalledTimes(1);
    expect(onAgentClick.mock.calls[0][0]).toBe('runtime-agent');

    // handleAgentClick branches on shiftKey to add to the selection rather
    // than replace it; the keyboard path must be able to reach that branch.
    fireEvent.keyDown(header as Element, { key: 'Enter', shiftKey: true });
    expect(onAgentClick.mock.calls[1][1].shiftKey).toBe(true);
  });

  test('a mouse click on the header does not select the agent twice through the card', () => {
    const onAgentClick =
      vi.fn<(agentSlug: string, event: ActivateEvent) => void>();
    renderSidebar(
      onAgentClick,
      vi.fn<(conversationId: string, agentSlug: string) => void>(),
    );

    // The card's own onClick covers clicks anywhere on it; the header's
    // activation stops propagation so a click there is one selection, not a
    // select-then-immediately-deselect toggle.
    fireEvent.click(
      screen.getByText('Runtime Agent').closest('.agent-header') as Element,
    );
    expect(onAgentClick).toHaveBeenCalledTimes(1);
  });

  test('choosing a conversation by keyboard does not also select its agent', () => {
    const onAgentClick =
      vi.fn<(agentSlug: string, event: ActivateEvent) => void>();
    const onConversationClick =
      vi.fn<(conversationId: string, agentSlug: string) => void>();
    renderSidebar(onAgentClick, onConversationClick);

    // The conversation item sits inside the card's mouse click surface, so
    // an activation that failed to stop propagation would fire both
    // handlers. Mouse clicks already guarded this; the keyboard path has to
    // guard it too.
    fireEvent.keyDown(
      screen.getByText('abc12345...').closest('.conversation-item') as Element,
      { key: 'Enter' },
    );

    expect(onConversationClick).toHaveBeenCalledWith(
      'conv:abc12345',
      'runtime-agent',
    );
    expect(onAgentClick).not.toHaveBeenCalled();
  });

  test('conversation controls stay discoverable: no button role wraps them', () => {
    renderSidebar(
      vi.fn<(agentSlug: string, event: ActivateEvent) => void>(),
      vi.fn<(conversationId: string, agentSlug: string) => void>(),
    );

    // The regression this guards: an ancestor with role="button" flattens
    // descendants to presentational, so "Active Chats" and its conversation
    // controls would never be announced.
    let node = screen
      .getByText('abc12345...')
      .closest('.conversation-item')?.parentElement;
    while (node) {
      expect(node.getAttribute('role')).not.toBe('button');
      node = node.parentElement;
    }
  });
});
