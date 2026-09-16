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
const navigate = vi.hoisted(() => vi.fn());
vi.mock('../contexts/NavigationContext', () => ({
  useNavigationActions: () => ({ navigate }),
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
  /**
   * #585 / #2144 slice 6 item B: the "Smooth answer reveal" toggle became a
   * two-option "Answer delivery" control over the SAME
   * `featureSettings.smoothReveal` boolean. Both directions are asserted —
   * a picker that only ever wrote `true` would pass the first half alone.
   */
  test('persists answer delivery to this device, both ways, and defaults to token', () => {
    deviceSettingsStore.reset('featureSettings');
    const rendered = render(<ChatSettingsPanel {...props()} />);

    const select = screen.getByLabelText(
      'Answer delivery',
    ) as HTMLSelectElement;
    expect(select.value).toBe('token');
    expect([...select.options].map((option) => option.value)).toEqual([
      'token',
      'smooth',
    ]);

    fireEvent.change(select, { target: { value: 'smooth' } });
    expect(deviceSettingsStore.get('featureSettings').smoothReveal).toBe(true);
    expect(select.value).toBe('smooth');

    fireEvent.change(select, { target: { value: 'token' } });
    expect(deviceSettingsStore.get('featureSettings').smoothReveal).toBe(false);
    expect(select.value).toBe('token');

    // The retired mechanism-named toggle is gone, not merely relabelled.
    expect(
      screen.queryByRole('switch', { name: 'Smooth answer reveal' }),
    ).toBeNull();
    rendered.unmount();
    deviceSettingsStore.reset('featureSettings');
  });

  /**
   * #2144 decision 3: this panel stays a SHORTCUT to the controls someone
   * changes mid-conversation, and links to the rest rather than growing to
   * hold them. The link is asserted through its effect — it closes the panel
   * and navigates — because a link that renders and goes nowhere is exactly
   * the failure a text assertion would miss.
   */
  test('links to the full Chat settings section and closes on the way', () => {
    navigate.mockReset();
    const panelProps = props();
    const rendered = render(<ChatSettingsPanel {...panelProps} />);

    fireEvent.click(screen.getByRole('button', { name: 'More chat settings' }));

    expect(panelProps.onClose).toHaveBeenCalled();
    // The exact deep link, not merely "navigate was called": a link to the
    // section this panel is the shortcut FOR is the whole contract.
    expect(navigate).toHaveBeenCalledWith(
      '/settings?view=chat&highlight=diff-style',
    );
    rendered.unmount();
  });

  /**
   * #585: `paragraph` is sketched on the issue and has no client-side
   * consumer, so offering it would be a control that changes nothing.
   */
  test('offers no third delivery option', () => {
    render(<ChatSettingsPanel {...props()} />);
    const select = screen.getByLabelText(
      'Answer delivery',
    ) as HTMLSelectElement;
    expect(select.options).toHaveLength(2);
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

  test('offers event replay only when developer tools are on and a handler exists', () => {
    deviceSettingsStore.set('developerToolsEnabled', false);
    const onReplayConversation = vi.fn();
    const hidden = render(
      <ChatSettingsPanel
        {...props()}
        onReplayConversation={onReplayConversation}
      />,
    );
    expect(
      screen.queryByRole('button', { name: 'Step through this conversation' }),
    ).toBeNull();
    hidden.unmount();

    deviceSettingsStore.set('developerToolsEnabled', true);
    const shown = render(
      <ChatSettingsPanel
        {...props()}
        onReplayConversation={onReplayConversation}
      />,
    );
    fireEvent.click(
      screen.getByRole('button', { name: 'Step through this conversation' }),
    );
    expect(onReplayConversation).toHaveBeenCalledOnce();
    shown.unmount();
    deviceSettingsStore.reset('developerToolsEnabled');
  });

  test('dismisses from the non-tabbable overlay without exposing a backdrop button', () => {
    const panelProps = props();
    render(<ChatSettingsPanel {...panelProps} />);
    const overlay = document.querySelector('.chat-settings-overlay');
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
