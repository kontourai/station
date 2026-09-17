/** @vitest-environment jsdom */

import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, test } from 'vitest';
import { ToastProvider, toastStore, useToast } from '../ToastContext';

afterEach(() => {
  toastStore.dismissAll();
  toastStore.clearHistory();
});

function Probe() {
  const { showToast } = useToast();
  return (
    <>
      <button
        type="button"
        onClick={() =>
          showToast('Plugin warning', undefined, 0, undefined, 'warning')
        }
      >
        Plugin tone
      </button>
      <button
        type="button"
        onClick={() => showToast('Session notice', 'session-one', 0)}
      >
        Session notice
      </button>
    </>
  );
}

test('one host toast entry preserves explicit tone and existing session attribution', () => {
  render(
    <ToastProvider>
      <Probe />
    </ToastProvider>,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Plugin tone' }));
  fireEvent.click(screen.getByRole('button', { name: 'Session notice' }));
  expect(toastStore.getSnapshot()).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        message: 'Plugin warning',
        type: 'warning',
        sessionId: undefined,
      }),
      expect.objectContaining({
        message: 'Session notice',
        type: 'info',
        sessionId: 'session-one',
      }),
    ]),
  );
});
