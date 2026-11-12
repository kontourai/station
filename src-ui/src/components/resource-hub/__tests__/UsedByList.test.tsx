/**
 * @vitest-environment jsdom
 */

import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';
import { UsedByList } from '../UsedByList';

describe('UsedByList', () => {
  test('opens each dependent from its own link and says what it is', () => {
    const open = vi.fn();
    render(
      <UsedByList
        state={{
          kind: 'ready',
          entries: [
            {
              key: 'agent:reviewer',
              name: 'Reviewer',
              detail: 'Agent',
              onOpen: open,
            },
            { key: 'project:site', name: 'Site', detail: 'Project' },
          ],
        }}
        emptyDescription="Agents that choose it appear here."
      />,
    );
    const region = screen.getByRole('region', { name: 'Used by' });
    fireEvent.click(within(region).getByRole('button', { name: 'Reviewer' }));
    expect(open).toHaveBeenCalledTimes(1);
    // No way to open it: plain text, not a dead button.
    expect(within(region).queryByRole('button', { name: 'Site' })).toBeNull();
    expect(within(region).getByText('Site')).toBeTruthy();
    expect(within(region).getByText('Project')).toBeTruthy();
  });

  test('states empty, withheld and failed reads differently, never as zero', () => {
    const retry = vi.fn();
    const { rerender } = render(
      <UsedByList
        state={{ kind: 'ready', entries: [] }}
        emptyDescription="Agents that choose it appear here."
      />,
    );
    expect(screen.getByText('Not used yet')).toBeTruthy();
    rerender(
      <UsedByList
        state={{ kind: 'withheld' }}
        emptyDescription="Agents that choose it appear here."
      />,
    );
    expect(screen.queryByText('Not used yet')).toBeNull();
    expect(screen.getByText('Not shown')).toBeTruthy();
    rerender(
      <UsedByList
        state={{ kind: 'error', onRetry: retry }}
        emptyDescription="Agents that choose it appear here."
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(retry).toHaveBeenCalledTimes(1);
  });
});
