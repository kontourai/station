// @vitest-environment jsdom
import { act, render, screen } from '@testing-library/react';
import { expect, test, vi } from 'vitest';
import { ElapsedWait } from '../components/ElapsedWait';

test('counts elapsed observation time without claiming a deadline or announcing each tick', () => {
  vi.useFakeTimers();
  vi.setSystemTime(10000);
  const view = render(<ElapsedWait startedAt={0} />);
  expect(screen.getByText('Waiting · 0:10').getAttribute('aria-live')).toBe(
    'off',
  );
  act(() => vi.advanceTimersByTime(2000));
  expect(screen.getByText('Waiting · 0:12')).toBeTruthy();
  view.unmount();
  vi.useRealTimers();
});
