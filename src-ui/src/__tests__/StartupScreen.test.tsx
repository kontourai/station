/** @vitest-environment jsdom */
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, test } from 'vitest';
import { StartupScreen } from '../components/StartupScreen';
import { rememberPreparingStation } from '../lib/startup-presentation';

afterEach(cleanup);

test('after launch, a preparing stage keeps naming the Station being prepared', () => {
  // No launch splash in this document, so this is a wait after launch, such
  // as the preferences read that follows switching Stations.
  rememberPreparingStation('Connecting to Kontour');
  render(<StartupScreen message="Loading your preferences" />);
  expect(
    screen.getByRole('heading', { name: 'Connecting to Kontour' }),
  ).toBeTruthy();
  expect(screen.getByRole('status').textContent).toBe(
    'Loading your preferences',
  );
  // The splash's mark, not anonymous placeholder cards.
  expect(document.querySelector('.station-startup__logo')).not.toBeNull();
  expect(
    document.querySelector('.station-startup')?.getAttribute('aria-busy'),
  ).toBe('true');
});

test('each new stage replaces the status line', () => {
  rememberPreparingStation('Connecting to Kontour');
  const { rerender } = render(
    <StartupScreen message="Preparing this device" />,
  );
  expect(screen.getByRole('status').textContent).toBe('Preparing this device');
  rerender(<StartupScreen message="Loading your preferences" />);
  expect(screen.getAllByRole('status')).toHaveLength(1);
  expect(screen.getByRole('status').textContent).toBe(
    'Loading your preferences',
  );
});
