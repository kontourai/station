/** @vitest-environment jsdom */
import { fireEvent, render, screen } from '@testing-library/react';
import { expect, test, vi } from 'vitest';
import { Button } from '../components/Button';

test('SDK loading preserves the action name and submit contract while refusing repeated activation', () => {
  const onClick = vi.fn();
  const ref = { current: null as HTMLButtonElement | null };
  const { rerender } = render(
    <Button ref={ref} loading onClick={onClick}>
      Save
    </Button>,
  );
  const button = screen.getByRole('button', { name: 'Save' });
  expect(ref.current).toBe(button);
  expect(button).toHaveProperty('type', 'submit');
  expect(button).toHaveProperty('disabled', true);
  expect(button.getAttribute('aria-busy')).toBe('true');
  fireEvent.click(button);
  expect(onClick).not.toHaveBeenCalled();
  rerender(
    <Button ref={ref} onClick={onClick}>
      Save
    </Button>,
  );
  expect(screen.getByRole('button', { name: 'Save' })).toBe(button);
  expect(button).toHaveProperty('disabled', false);
  fireEvent.click(button);
  expect(onClick).toHaveBeenCalledOnce();
});
