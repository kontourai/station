/**
 * @vitest-environment jsdom
 */

import { render, screen } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';

// Deliberately NOT mocking `views/monitoring/view-utils`. The sibling suite
// mocks it wholesale and hands the component a fixed slug list, so the real
// derived name never meets the real counter — which is precisely how the
// '(unnamed)' card shipped reporting a count of 0 for rows it does filter to.
import { MonitoringSidebar } from '../views/monitoring/MonitoringSidebar';

describe('MonitoringSidebar (unnamed agent bucket)', () => {
  // TWO buckets, deliberately different sizes. With one bucket holding every
  // event, `filteredEvents.length` and `stats.summary.totalEvents` both equal
  // the right answer, so a count implemented either of those wrong ways still
  // reads correctly. A second bucket kills both.
  const sluglessEvents = [
    { 'gen_ai.operation.name': 'execute_tool', 'gen_ai.tool.name': 'Bash' },
    { 'gen_ai.operation.name': 'execute_tool', 'gen_ai.tool.name': 'Read' },
    {
      'gen_ai.operation.name': 'execute_tool',
      'gen_ai.tool.name': 'Grep',
      'station.agent.slug': 'alpha',
    },
  ];

  function renderWith(events: unknown[]) {
    render(
      <MonitoringSidebar
        stats={
          {
            summary: { activeAgents: 0, runningAgents: 0, totalEvents: 3 },
            agents: [],
          } as never
        }
        events={events as never}
        filteredEvents={events as never}
        selectedAgents={[]}
        onAgentClick={vi.fn()}
        onConversationClick={vi.fn()}
        resolveModelName={(modelId: string) => modelId}
      />,
    );
  }

  test('offers the bucket at all', () => {
    // An option nobody can choose is how slug-less rows became invisible.
    renderWith(sluglessEvents);
    expect(screen.getByText('(unnamed)')).toBeTruthy();
  });

  test('counts the rows that selecting it produces, not zero', () => {
    // The count used to compare the raw `station.agent.slug` field against a
    // DERIVED name, so nothing matched: the card read 0 and then filtered
    // the log to 2. Both numbers came from the same events; only one was
    // computed the way the list was.
    renderWith(sluglessEvents);
    const unnamed = screen.getByText('(unnamed)').closest('.agent-card');
    const alpha = screen.getByText('alpha').closest('.agent-card');
    expect(unnamed).toBeTruthy();
    expect(alpha).toBeTruthy();
    // 2 and 1, not 3 and 3: the counts must come from the naming rule, not
    // from the length of the whole array or the summary total.
    expect(unnamed?.textContent).toContain('2');
    expect(unnamed?.textContent).not.toMatch(/Events:\s*(0|3)/);
    expect(alpha?.textContent).toContain('1');
  });
});
