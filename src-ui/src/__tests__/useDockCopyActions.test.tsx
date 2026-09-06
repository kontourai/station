/**
 * @vitest-environment jsdom
 *
 * #1536 F moved the dock header's "Copy ID" button and its project-path segment
 * into the header's More menu, so this is where archive#3341's contracts now
 * live: the copied value is the ROUTED conversation id and never the local tab
 * key, and a refused write never claims a copy and never buzzes. The outcome is
 * a toast rather than an inline label, because a menu row is gone by the time
 * the write resolves.
 *
 * Stubs `navigator.clipboard` rather than the `copyToClipboard` seam, for the
 * reason `clipboard-stubs.ts` records: mocking the seam would keep passing if
 * the seam itself started claiming success for a missing clipboard, which is
 * what the whole defect class was made of.
 */

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { useDockCopyActions } from '../components/chat-dock/useDockCopyActions';
import {
  clipboardAbsent,
  clipboardRefuses,
  clipboardWrites,
} from './clipboard-stubs';

const { triggerHapticMock, showToastMock } = vi.hoisted(() => ({
  triggerHapticMock: vi.fn(),
  showToastMock: vi.fn(),
}));

vi.mock('../platform/native/haptics', () => ({
  triggerHaptic: triggerHapticMock,
}));

vi.mock('../contexts/ToastContext', () => ({
  useToast: () => ({ showToast: showToastMock }),
}));

afterEach(() => {
  triggerHapticMock.mockReset();
  showToastMock.mockReset();
  clipboardAbsent();
});

function Probe(props: Parameters<typeof useDockCopyActions>[0]) {
  const actions = useDockCopyActions(props);
  return (
    <>
      {actions.map((action) => (
        <button
          key={action.key}
          type="button"
          onClick={(event) => action.onSelect(event.currentTarget)}
        >
          {action.label}
        </button>
      ))}
    </>
  );
}

function rows(): string[] {
  return screen.getAllByRole('button').map((row) => row.textContent ?? '');
}

describe('useDockCopyActions', () => {
  test('copies the routed conversation id, never the local tab key', async () => {
    const writeText = clipboardWrites();
    render(
      <Probe
        conversationId="station-thread-from-route"
        workingDirectory="/Users/someone/dev/alpha"
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Copy thread ID' }));

    await waitFor(() =>
      expect(writeText).toHaveBeenCalledWith('station-thread-from-route'),
    );
    expect(writeText).not.toHaveBeenCalledWith('local-tab-key');
    expect(showToastMock).toHaveBeenCalledWith('Copied to clipboard');
    expect(triggerHapticMock).toHaveBeenCalledWith('light');
  });

  test('copies the directory the session actually resolved to', async () => {
    const writeText = clipboardWrites();
    render(
      <Probe
        conversationId="station-thread-from-route"
        workingDirectory="/Users/someone/dev/worktrees/wt-9"
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Copy project path' }));

    await waitFor(() =>
      expect(writeText).toHaveBeenCalledWith(
        '/Users/someone/dev/worktrees/wt-9',
      ),
    );
  });

  test('a refused write never claims a copy and never buzzes', async () => {
    clipboardRefuses();
    render(<Probe conversationId="station-thread-from-route" />);

    fireEvent.click(screen.getByRole('button', { name: 'Copy thread ID' }));

    await waitFor(() =>
      expect(showToastMock).toHaveBeenCalledWith(
        "Couldn't copy — this browser refused clipboard access",
      ),
    );
    expect(showToastMock).not.toHaveBeenCalledWith('Copied to clipboard');
    expect(triggerHapticMock).not.toHaveBeenCalled();
  });

  test('an insecure origin with no clipboard API never claims a copy', async () => {
    clipboardAbsent();
    render(<Probe conversationId="station-thread-from-route" />);

    fireEvent.click(screen.getByRole('button', { name: 'Copy thread ID' }));

    await waitFor(() =>
      expect(showToastMock).toHaveBeenCalledWith(
        "Couldn't copy — this browser refused clipboard access",
      ),
    );
    expect(triggerHapticMock).not.toHaveBeenCalled();
  });

  test('omits a row it has no value for rather than offering a copy of nothing', () => {
    render(<Probe conversationId={null} workingDirectory="/tmp/alpha" />);
    expect(rows()).toEqual(['Copy project path']);
  });

  test('omits the path row when the session resolved no directory', () => {
    render(<Probe conversationId="thread-1" workingDirectory={null} />);
    expect(rows()).toEqual(['Copy thread ID']);
  });
});
