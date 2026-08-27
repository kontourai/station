/**
 * @vitest-environment jsdom
 */

import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';
import { PageBreadcrumb } from '../components/header/PageBreadcrumb';

describe('PageBreadcrumb', () => {
  test('uses a real button for an ancestor while keeping the current page static', () => {
    const onNavigateUp = vi.fn();
    render(
      <PageBreadcrumb
        segments={[
          { label: 'Agents', onClick: onNavigateUp },
          { label: 'Editor' },
        ]}
      />,
    );

    const ancestor = screen.getByRole('button', { name: 'Agents' });
    fireEvent.click(ancestor);

    expect(onNavigateUp).toHaveBeenCalledOnce();
    expect(screen.getByText('Editor').getAttribute('aria-current')).toBe(
      'page',
    );
  });
});
