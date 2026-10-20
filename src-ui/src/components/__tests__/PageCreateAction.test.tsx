/** @vitest-environment jsdom */

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';

const viewport = vi.hoisted(() => ({ mobile: false }));
vi.mock('../../hooks/useIsMobile', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../hooks/useIsMobile')>()),
  useIsMobile: () => viewport.mobile,
}));

import { PageCreateAction } from '../PageCreateAction';

afterEach(() => {
  cleanup();
  viewport.mobile = false;
});

test('desktop keeps the labelled header button and renders no floating control', () => {
  const onClick = vi.fn();
  render(<PageCreateAction label="Add computer" onClick={onClick} />);
  const add = screen.getByRole('button', { name: 'Add computer' });
  expect(add.textContent).toBe('Add computer');
  expect(document.querySelector('.page-create-action')).toBeNull();
  fireEvent.click(add);
  expect(onClick).toHaveBeenCalledOnce();
});

test('a disabled floating action keeps its name, says why, and does not act', () => {
  viewport.mobile = true;
  const onClick = vi.fn();
  render(
    <PageCreateAction
      label="Add computer"
      onClick={onClick}
      disabled
      disabledReason="Only an operator can add computers."
    />,
  );
  const add = screen.getByRole('button', { name: 'Add computer' });
  expect(add.hasAttribute('disabled')).toBe(true);
  expect(add.getAttribute('title')).toBe('Only an operator can add computers.');
  fireEvent.click(add);
  expect(onClick).not.toHaveBeenCalled();
});
