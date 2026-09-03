/** @vitest-environment jsdom */

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';
import { ChatSettingsPanel } from '../components/chat/ChatSettingsPanel';
import { deviceSettingsStore } from '../lib/device-settings-store';

const dismissSummary = vi.fn();
const showSummary = vi.fn();
vi.mock('@kontourai/station-sdk', () => ({
  useDismissSessionSummaryMutation: () => ({ mutate: dismissSummary }),
  useShowSessionSummaryMutation: () => ({ mutate: showSummary }),
}));

function props() {
  return {
    isOpen: true,
    onClose: vi.fn(),
    chatFontSize: 14,
    setChatFontSize: vi.fn(),
    defaultFontSize: 14,
    showReasoning: false,
    setShowReasoning: vi.fn(),
    showToolDetails: false,
    setShowToolDetails: vi.fn(),
    autoHideEnabled: false,
    setAutoHideEnabled: vi.fn(),
  };
}

describe('ChatSettingsPanel accessibility', () => {
  test('persists smooth answer reveal to this device and defaults it off', () => {
    deviceSettingsStore.reset('featureSettings');
    const rendered = render(<ChatSettingsPanel {...props()} />);

    const toggle = screen.getByRole('switch', {
      name: 'Smooth answer reveal',
    });
    expect(toggle.getAttribute('aria-checked')).toBe('false');

    fireEvent.click(toggle);
    expect(deviceSettingsStore.get('featureSettings').smoothReveal).toBe(true);
    expect(toggle.getAttribute('aria-checked')).toBe('true');
    rendered.unmount();
    deviceSettingsStore.reset('featureSettings');
  });
  test('owns focus, traps both Tab directions, closes on Escape, and restores the trigger', async () => {
    const trigger = document.createElement('button');
    trigger.textContent = 'Settings trigger';
    document.body.append(trigger);
    trigger.focus();
    const panelProps = props();
    const rendered = render(<ChatSettingsPanel {...panelProps} />);
    const dialog = screen.getByRole('dialog', { name: 'Chat Settings' });
    expect(document.activeElement).toBe(dialog);

    const first = screen.getByRole('button', { name: 'A−' });
    const last = screen.getByRole('button', { name: 'Done' });
    first.focus();
    fireEvent.keyDown(dialog, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(last);
    last.focus();
    fireEvent.keyDown(dialog, { key: 'Tab' });
    expect(document.activeElement).toBe(first);

    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(panelProps.onClose).toHaveBeenCalledOnce();
    rendered.rerender(<ChatSettingsPanel {...panelProps} isOpen={false} />);
    await waitFor(() => expect(document.activeElement).toBe(trigger));
    trigger.remove();
  });

  test('does not expose dock position settings', () => {
    render(<ChatSettingsPanel {...props()} />);

    expect(screen.queryByText('Dock Position')).toBeNull();
    expect(screen.queryByRole('menuitemradio')).toBeNull();
  });

  test('dismisses from the non-tabbable overlay without exposing a backdrop button', () => {
    const panelProps = props();
    const { container } = render(<ChatSettingsPanel {...panelProps} />);
    const overlay = container.querySelector('.chat-settings-overlay');
    expect(overlay).toBeTruthy();
    fireEvent.pointerDown(overlay as Element);
    expect(panelProps.onClose).toHaveBeenCalledOnce();
    expect(
      screen.queryByRole('button', { name: 'Close chat settings' }),
    ).toBeNull();
  });

  // #3310: "Summarize session" demoted out of the transcript — this panel is
  // the entry point, present only when a conversation is active.
  test('offers Summarize session for an active conversation and closes after triggering', () => {
    const panelProps = props();
    const onGenerate = vi.fn();
    render(
      <ChatSettingsPanel
        {...panelProps}
        sessionSummary={{
          isGenerating: false,
          onGenerate,
          agentSlug: 'station',
          conversationId: 'c1',
        }}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Summarize session' }));
    expect(onGenerate).toHaveBeenCalledOnce();
    expect(panelProps.onClose).toHaveBeenCalledOnce();
  });

  test('disables the summarize action while generation is in flight', () => {
    const panelProps = props();
    render(
      <ChatSettingsPanel
        {...panelProps}
        sessionSummary={{
          isGenerating: true,
          onGenerate: vi.fn(),
          agentSlug: 'station',
          conversationId: 'c1',
        }}
      />,
    );
    const button = screen.getByRole('button', {
      name: 'Generating summary…',
    });
    expect((button as HTMLButtonElement).disabled).toBe(true);
  });

  test('dismisses and re-shows a persisted summary without regenerating', () => {
    const panelProps = props();
    dismissSummary.mockClear();
    showSummary.mockClear();
    render(
      <ChatSettingsPanel
        {...panelProps}
        sessionSummary={{
          isGenerating: false,
          onGenerate: vi.fn(),
          agentSlug: 'station',
          conversationId: 'c1',
        }}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss summary' }));
    expect(dismissSummary).toHaveBeenCalledWith({
      agentSlug: 'station',
      conversationId: 'c1',
    });
    expect(panelProps.onClose).toHaveBeenCalledOnce();
    fireEvent.click(
      screen.getByRole('button', { name: 'Show dismissed summary' }),
    );
    expect(showSummary).toHaveBeenCalledWith({
      agentSlug: 'station',
      conversationId: 'c1',
    });
  });

  test('renders no session section when no conversation is active', () => {
    render(<ChatSettingsPanel {...props()} />);
    expect(
      screen.queryByRole('button', { name: 'Summarize session' }),
    ).toBeNull();
  });

  test('keeps each full visible toggle label clickable and described', () => {
    const panelProps = props();
    render(<ChatSettingsPanel {...panelProps} />);
    const cases = [
      {
        name: 'Show reasoning',
        hint: 'chat-settings-reasoning-hint',
        setter: panelProps.setShowReasoning,
      },
      {
        name: 'Show tool details',
        hint: 'chat-settings-tools-hint',
        setter: panelProps.setShowToolDetails,
      },
      {
        name: 'Auto-hide dock',
        hint: 'chat-settings-autohide-hint',
        setter: panelProps.setAutoHideEnabled,
      },
    ];
    for (const item of cases) {
      const toggle = screen.getByRole('switch', { name: item.name });
      expect(toggle.getAttribute('aria-describedby')).toBe(item.hint);
      fireEvent.click(screen.getByText(item.name));
      expect(item.setter).toHaveBeenCalledWith(true);
    }
  });
});
