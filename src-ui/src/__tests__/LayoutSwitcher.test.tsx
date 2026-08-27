/**
 * @vitest-environment jsdom
 *
 * Review H1: `data: layouts = []` alone makes a failed
 * `useProjectLayoutsQuery` read indistinguishable from a project genuinely
 * having no layouts, so the menu asserted "No layouts" over a read that
 * never answered. These tests pin the fix: an errored read renders
 * `ErrorState` with a Retry before the empty branch, and the empty copy
 * only renders once the read has actually settled empty.
 */

import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';

const setLayout = vi.fn();
const refetchLayouts = vi.fn();
let layoutsData: Array<{ slug: string; name: string; icon?: string }> = [];
let layoutsError: unknown;

vi.mock('../contexts/NavigationContext', () => ({
  useNavigation: () => ({ setLayout }),
}));

vi.mock('@kontourai/station-sdk', () => ({
  useProjectLayoutsQuery: () => ({
    data: layoutsData,
    error: layoutsError,
    refetch: refetchLayouts,
  }),
}));

import { LayoutSwitcher } from '../components/header/LayoutSwitcher';

function openMenu() {
  fireEvent.click(screen.getByRole('button', { name: 'Switch layout' }));
}

describe('LayoutSwitcher', () => {
  beforeEach(() => {
    layoutsData = [];
    layoutsError = undefined;
    setLayout.mockReset();
    refetchLayouts.mockReset();
  });

  test('an errored read renders the error state with its message, not "No layouts"', () => {
    layoutsData = [];
    layoutsError = new Error('layouts read failed');
    render(<LayoutSwitcher projectSlug="project-alpha" layoutSlug="main" />);
    openMenu();

    expect(screen.getByRole('alert')).toBeTruthy();
    expect(screen.getByText('Unable to load layouts')).toBeTruthy();
    expect(screen.getByText('layouts read failed')).toBeTruthy();
    expect(screen.queryByText('No layouts')).toBeNull();
  });

  test('a settled-empty read still renders the empty copy, with no error state', () => {
    layoutsData = [];
    layoutsError = undefined;
    render(<LayoutSwitcher projectSlug="project-alpha" layoutSlug="main" />);
    openMenu();

    expect(screen.getByText('No layouts')).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  test('clicking Retry calls the query refetch', () => {
    layoutsData = [];
    layoutsError = new Error('layouts read failed');
    render(<LayoutSwitcher projectSlug="project-alpha" layoutSlug="main" />);
    openMenu();

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(refetchLayouts).toHaveBeenCalledTimes(1);
  });
});
