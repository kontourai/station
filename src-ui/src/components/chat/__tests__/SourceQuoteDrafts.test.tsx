/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { SourceQuoteDrafts } from '../SourceQuoteDrafts';

afterEach(cleanup);

const terminal = {
  version: 1 as const,
  kind: 'terminal' as const,
  origin: 'http://station.test',
  cwd: '/work/alpha',
  excerpt: 'npm ERR! missing script',
};

test('a terminal chip shows its directory and output, and removes itself', () => {
  const onRemove = vi.fn();
  render(
    <SourceQuoteDrafts
      quotes={[terminal]}
      origin="http://station.test"
      onRemove={onRemove}
    />,
  );
  const chips = screen.getByRole('region', { name: 'Quoted context' });
  expect(chips.textContent).toContain('Terminal · /work/alpha');
  expect(chips.querySelector('pre')?.textContent).toBe(terminal.excerpt);
  fireEvent.click(
    screen.getByRole('button', { name: 'Remove terminal output 1' }),
  );
  expect(onRemove).toHaveBeenCalledWith(0);
});

test("another Station's terminal output is not shown here", () => {
  render(
    <SourceQuoteDrafts
      quotes={[terminal]}
      origin="http://other.test"
      onRemove={() => {}}
    />,
  );
  expect(screen.queryByText(terminal.excerpt)).toBeNull();
  expect(
    screen.getByText('This output belongs to another Station.'),
  ).toBeTruthy();
});
