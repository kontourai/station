/**
 * @vitest-environment jsdom
 */

import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';
import { FilteredEmpty } from '../components/state';

describe('FilteredEmpty', () => {
  test('echoes the active query and offers a clear-filter action', () => {
    const onClear = vi.fn();
    render(
      <FilteredEmpty query="  rust  " noun="sessions" onClear={onClear} />,
    );

    expect(
      screen.getByText('Nothing in sessions matches “rust”'),
    ).not.toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Clear filter' }));
    expect(onClear).toHaveBeenCalledOnce();
  });
});
