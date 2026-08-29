/**
 * @vitest-environment jsdom
 */

import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { OPEN_REPORT_PROBLEM_EVENT } from '../../../lib/reportProblemEvents';
import { HelpMenu } from '../HelpMenu';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('HelpMenu — Report a problem entry point (#766 item 4)', () => {
  test('dispatches the exact event the ReportProblemHost listens on, then closes', () => {
    // HelpMenu deliberately inlines the event-name literal instead of
    // importing `reportProblemEvents` (bundle-chunk reasoning at the call
    // site). This test is what keeps that literal and the shared constant
    // from drifting apart: it listens on the CONSTANT and clicks the button.
    const listener = vi.fn();
    window.addEventListener(OPEN_REPORT_PROBLEM_EVENT, listener);
    const onClose = vi.fn();
    try {
      render(
        <HelpMenu
          isOpen
          prompts={[{ label: 'What can you do?', prompt: 'capabilities' }]}
          onClose={onClose}
          onSelectPrompt={vi.fn()}
        />,
      );

      fireEvent.click(screen.getByRole('button', { name: 'Report a problem' }));

      expect(listener).toHaveBeenCalledTimes(1);
      expect(onClose).toHaveBeenCalledTimes(1);
    } finally {
      window.removeEventListener(OPEN_REPORT_PROBLEM_EVENT, listener);
    }
  });
});
