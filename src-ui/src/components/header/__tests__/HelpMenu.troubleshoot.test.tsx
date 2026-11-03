/**
 * @vitest-environment jsdom
 */

import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';
import { OPEN_REPORT_PROBLEM_EVENT } from '../../../lib/reportProblemEvents';
import { OPEN_TROUBLESHOOT_EVENT } from '../../../lib/troubleshootEvents';
import { HelpMenu } from '../HelpMenu';

describe('HelpMenu — Something wrong? group (#4470)', () => {
  test('groups Troubleshoot with an agent beside Report a problem and dispatches the troubleshoot event', () => {
    // HelpMenu inlines the event literal (entry-chunk reasoning at the call
    // site); listening on the CONSTANT keeps the two from drifting.
    const troubleshoot = vi.fn();
    const report = vi.fn();
    window.addEventListener(OPEN_TROUBLESHOOT_EVENT, troubleshoot);
    window.addEventListener(OPEN_REPORT_PROBLEM_EVENT, report);
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
      const group = screen.getByText('Something wrong?').parentElement!;
      const rows = within(group)
        .getAllByRole('button')
        .map((button) => button.textContent);
      expect(rows).toEqual(['Troubleshoot with an agent', 'Report a problem']);

      fireEvent.click(
        within(group).getByRole('button', {
          name: 'Troubleshoot with an agent',
        }),
      );
      expect(troubleshoot).toHaveBeenCalledTimes(1);
      expect(report).not.toHaveBeenCalled();
      expect(onClose).toHaveBeenCalledTimes(1);
    } finally {
      window.removeEventListener(OPEN_TROUBLESHOOT_EVENT, troubleshoot);
      window.removeEventListener(OPEN_REPORT_PROBLEM_EVENT, report);
    }
  });
});
