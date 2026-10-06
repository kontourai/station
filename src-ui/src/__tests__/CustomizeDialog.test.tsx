/** @vitest-environment jsdom */
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, expect, test, vi } from 'vitest';
import { DEVELOPER_TOOLS_FLAG } from '../app-shell/destination-registry';
import { CustomizeDialog } from '../components/project-sidebar/CustomizeDialog';

const flags = vi.hoisted(() => ({ value: new Set<string>() }));
vi.mock('../hooks/useSurfaceVisibilityFlags', () => ({
  useSurfaceVisibilityFlags: () => flags.value,
}));
beforeEach(() => {
  flags.value = new Set();
});

test('Customize opens the existing management routes and keeps modified links native', () => {
  const onNavigate = vi.fn();
  render(<CustomizeDialog onClose={vi.fn()} onNavigate={onNavigate} />);
  expect(
    screen
      .getAllByRole('link')
      .map((link) => link.textContent?.replace('›', '').trim()),
  ).toEqual(['Agents', 'Skills', 'Engines & Models', 'Plugins']);
  fireEvent.click(screen.getByRole('link', { name: 'Agents' }));
  expect(onNavigate).toHaveBeenCalledWith('/agents');
  fireEvent.click(screen.getByRole('link', { name: 'Engines & Models' }));
  expect(onNavigate).toHaveBeenCalledWith('/connections/engines');
  onNavigate.mockClear();
  fireEvent.click(screen.getByRole('link', { name: 'Skills' }), {
    metaKey: true,
  });
  expect(onNavigate).not.toHaveBeenCalled();
  expect(
    screen.getByRole('link', { name: 'Skills' }).getAttribute('href'),
  ).toBe('/guidance');
  expect(screen.queryByRole('link', { name: 'Developer' })).toBeNull();
});

test('Customize advertises Developer only while enabled on this device', () => {
  flags.value = new Set([DEVELOPER_TOOLS_FLAG]);
  render(<CustomizeDialog onClose={vi.fn()} onNavigate={vi.fn()} />);
  expect(
    screen.getByRole('link', { name: 'Developer' }).getAttribute('href'),
  ).toBe('/developer');
});
