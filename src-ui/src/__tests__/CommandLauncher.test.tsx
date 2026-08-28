/**
 * @vitest-environment jsdom
 */

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { CommandLauncher } from '../components/chat-dock/CommandLauncher';
import {
  buildCommandLauncherPreview,
  COMMAND_LAUNCHER_SUGGESTIONS,
  submitCommandLauncherIntent,
} from '../components/chat-dock/command-launcher-model';

const context = {
  project: 'Station',
  agent: 'Codex',
  model: 'gpt-5.3-codex',
  mode: 'bottom',
  attachments: ['plan.md', 'screen.png'],
};

afterEach(cleanup);

describe('command launcher preview', () => {
  test('uses current context and explicit unavailable states', () => {
    expect(buildCommandLauncherPreview('  Review this  ', context)).toEqual({
      intent: 'Review this',
      project: 'Station',
      agent: 'Codex',
      model: 'gpt-5.3-codex',
      mode: 'bottom',
      attachments: ['plan.md', 'screen.png'],
      attachmentSummary: '2: plan.md, screen.png',
    });

    expect(
      buildCommandLauncherPreview('Explain', {
        project: null,
        agent: '',
        model: undefined,
        mode: null,
        attachments: [],
      }),
    ).toMatchObject({
      project: 'Project unavailable',
      agent: 'Agent unavailable',
      model: 'Model not reported',
      mode: 'Mode unavailable',
      attachmentSummary: 'None',
    });
  });

  test('submits once through the canonical boundary with current attachments', async () => {
    const handleInputChange = vi.fn();
    const handleSend = vi.fn();
    const attachments = [{ id: 'plan' }, { id: 'screen' }];

    await submitCommandLauncherIntent('  Review this  ', attachments, {
      handleInputChange,
      handleSend,
    });

    expect(handleInputChange).toHaveBeenCalledOnce();
    expect(handleInputChange).toHaveBeenCalledWith('Review this');
    expect(handleSend).toHaveBeenCalledOnce();
    expect(handleSend).toHaveBeenCalledWith('Review this', attachments);
  });
});

describe('CommandLauncher', () => {
  test('suggested and typed intent use the same confirmation callback', async () => {
    const suggestion = COMMAND_LAUNCHER_SUGGESTIONS[1];
    const onConfirm = vi.fn();
    const { unmount } = render(
      <CommandLauncher
        context={context}
        onClose={vi.fn()}
        onConfirm={onConfirm}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: suggestion.label }));
    expect(
      screen.getByRole('region', { name: 'Command preview' }).textContent,
    ).toContain(suggestion.intent);
    fireEvent.click(screen.getByRole('button', { name: 'Confirm and send' }));
    await waitFor(() =>
      expect(onConfirm).toHaveBeenCalledWith(suggestion.intent),
    );

    onConfirm.mockClear();
    unmount();
    render(
      <CommandLauncher
        context={context}
        onClose={vi.fn()}
        onConfirm={onConfirm}
      />,
    );
    fireEvent.change(screen.getByLabelText('What should the agent do?'), {
      target: { value: suggestion.intent },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Confirm and send' }));
    await waitFor(() =>
      expect(onConfirm).toHaveBeenCalledWith(suggestion.intent),
    );
  });

  test('dispatches once and closes without waiting for the agent response', () => {
    const onClose = vi.fn();
    const onConfirm = vi.fn(() => new Promise<void>(() => {}));
    render(
      <CommandLauncher
        context={context}
        onClose={onClose}
        onConfirm={onConfirm}
      />,
    );

    fireEvent.change(screen.getByLabelText('What should the agent do?'), {
      target: { value: 'Build the next slice' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Confirm and send' }));

    expect(onConfirm).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledOnce();
  });

  test('focus enters the dialog and cancel performs no submission', () => {
    const trigger = document.createElement('button');
    document.body.append(trigger);
    trigger.focus();
    const onClose = vi.fn();
    const onConfirm = vi.fn();
    render(
      <CommandLauncher
        context={context}
        onClose={onClose}
        onConfirm={onConfirm}
      />,
    );

    expect(document.activeElement).toBe(
      screen.getByLabelText('What should the agent do?'),
    );
    const cancel = screen.getByRole('button', { name: 'Cancel' });
    fireEvent.click(cancel);
    expect(onClose).toHaveBeenCalledOnce();
    expect(onConfirm).not.toHaveBeenCalled();
    trigger.remove();
  });

  test('backdrop is a semantic dismiss button that preserves pointer close', () => {
    const onClose = vi.fn();
    render(
      <CommandLauncher
        context={context}
        onClose={onClose}
        onConfirm={vi.fn()}
      />,
    );

    const dismiss = screen.getByRole('button', {
      name: 'Dismiss command launcher',
    }) as HTMLButtonElement;
    expect(dismiss.type).toBe('button');
    fireEvent.mouseDown(dismiss);
    expect(onClose).toHaveBeenCalledOnce();
  });

  test('backdrop closes once for pointer and native button activation', () => {
    const onPointerClose = vi.fn();
    const pointerView = render(
      <CommandLauncher
        context={context}
        onClose={onPointerClose}
        onConfirm={vi.fn()}
      />,
    );
    const pointerDismiss = screen.getByRole('button', {
      name: 'Dismiss command launcher',
    });
    fireEvent.mouseDown(pointerDismiss);
    fireEvent.click(pointerDismiss);
    expect(onPointerClose).toHaveBeenCalledOnce();
    pointerView.unmount();

    for (const key of ['Enter', ' ']) {
      const onKeyboardClose = vi.fn();
      const keyboardView = render(
        <CommandLauncher
          context={context}
          onClose={onKeyboardClose}
          onConfirm={vi.fn()}
        />,
      );
      const keyboardDismiss = screen.getByRole('button', {
        name: 'Dismiss command launcher',
      });
      keyboardDismiss.focus();
      fireEvent.keyDown(keyboardDismiss, { key });
      // Browsers dispatch click for Enter and Space on native buttons.
      fireEvent.click(keyboardDismiss);
      expect(onKeyboardClose).toHaveBeenCalledOnce();
      keyboardView.unmount();
    }
  });

  /**
   * archive#1206 gap 3. This surface hand-rolled the same
   * `if (returnFocus?.isConnected) returnFocus.focus` as the shared frame and
   * imports only `ResponsiveDialogCloseButton`, so #1187's fix never reached it
   * — a trigger removed while the launcher is open still dropped focus to
   * `<body>`. It now goes through `@kontourai/station-shared/return-focus`, so it inherits the
   * ancestor fallback along with everything else.
   */
  test('restores to the nearest surviving ancestor when the trigger is gone', async () => {
    const list = document.createElement('div');
    const row = document.createElement('div');
    const trigger = document.createElement('button');
    row.append(trigger);
    list.append(row);
    document.body.append(list);
    trigger.focus();

    render(
      <CommandLauncher
        context={context}
        onClose={vi.fn()}
        onConfirm={vi.fn()}
      />,
    );
    row.remove();

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    await waitFor(() => expect(document.activeElement).toBe(list));
    expect(document.activeElement).not.toBe(document.body);
    expect(list.getAttribute('tabindex')).toBe('-1');
    list.remove();
  });
});
