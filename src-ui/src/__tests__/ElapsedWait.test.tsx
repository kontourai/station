// @vitest-environment jsdom
import { act, render, screen } from '@testing-library/react';
import { expect, test, vi } from 'vitest';
import { ElapsedWait } from '../components/ElapsedWait';

test('counts elapsed observation time without claiming a deadline or announcing each tick', () => {
  vi.useFakeTimers();
  vi.setSystemTime(10000);
  const view = render(<ElapsedWait startedAt={0} />);
  expect(screen.getByText('Waiting · 10s').getAttribute('aria-live')).toBe(
    'off',
  );
  act(() => vi.advanceTimersByTime(2000));
  expect(screen.getByText('Waiting · 12s')).toBeTruthy();
  view.unmount();
  vi.useRealTimers();
});
