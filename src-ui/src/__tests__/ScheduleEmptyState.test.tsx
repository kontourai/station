/**
 * @vitest-environment jsdom
 */

import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';
import { ScheduleEmptyState } from '../views/schedule/ScheduleEmptyState';

describe('ScheduleEmptyState', () => {
  test('keeps the starter CTA for a genuinely empty schedule', () => {
    render(
      <ScheduleEmptyState
        filterText=""
        onClearFilter={vi.fn()}
        onSelectTemplate={vi.fn()}
      />,
    );
    expect(
      screen.getByText(
        'No scheduled jobs yet. Pick a template to get started:',
      ),
    ).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Clear filter' })).toBeNull();
  });

  test('echoes and clears a filter instead of presenting a first-run state', () => {
    const onClearFilter = vi.fn();
    render(
      <ScheduleEmptyState
        filterText="nightly"
        onClearFilter={onClearFilter}
        onSelectTemplate={vi.fn()}
      />,
    );
    expect(
      screen.getByText('Nothing in scheduled jobs matches “nightly”'),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Clear filter' }));
    expect(onClearFilter).toHaveBeenCalledOnce();
  });
});
