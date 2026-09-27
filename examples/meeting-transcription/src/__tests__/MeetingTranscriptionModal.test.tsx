/**
 * @vitest-environment jsdom
 */
import { voiceRegistry } from '@kontourai/station-sdk';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { MeetingTranscriptionModal } from '../MeetingTranscriptionModal';
import { fakeSTT } from './helpers/fake-stt';

const disposers: Array<() => void> = [];
afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose();
});

function renderModal(onSend: (prompt: string) => void = vi.fn()) {
  return render(
    <MeetingTranscriptionModal isOpen onSend={onSend} onClose={vi.fn()} />,
  );
}

describe('MeetingTranscriptionModal through the SDK voice registry', () => {
  test('listens with a registered provider and shows what it hears', () => {
    const stt = fakeSTT('fake-stt');
    disposers.push(voiceRegistry.registerSTT(stt));

    renderModal();

    expect(stt.startListening).toHaveBeenCalledWith({
      continuous: true,
      interimResults: true,
    });
    expect(screen.getByText('Recording…')).toBeTruthy();
    act(() => stt.hear('ship the release on Friday'));
    expect(screen.getByText(/ship the release on Friday/)).toBeTruthy();
  });

  test('skips a registered provider that cannot listen in this browser', () => {
    const unsupported = fakeSTT('unsupported-stt', false);
    disposers.push(voiceRegistry.registerSTT(unsupported));

    renderModal();

    expect(unsupported.startListening).not.toHaveBeenCalled();
    expect(screen.getByText('Speech recognition not supported.')).toBeTruthy();
  });

  test('picks up a provider registered after the modal opened', () => {
    renderModal();
    expect(screen.getByText('Speech recognition not supported.')).toBeTruthy();

    const stt = fakeSTT('late-stt');
    act(() => {
      disposers.push(voiceRegistry.registerSTT(stt));
    });

    expect(stt.startListening).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Pause' }));
    expect(stt.stopListening).toHaveBeenCalled();
  });

  test('extracts action items with the prompt meeting-notes vendors verbatim', () => {
    const stt = fakeSTT('extract-stt');
    disposers.push(voiceRegistry.registerSTT(stt));
    const onSend = vi.fn();

    renderModal(onSend);
    act(() => stt.hear('ship the release on Friday'));
    fireEvent.click(
      screen.getByRole('button', { name: 'Extract action items' }),
    );

    // Same bytes as examples/meeting-notes EXTRACTION_PROMPT_PREFIX; change
    // both together.
    expect(onSend).toHaveBeenCalledExactlyOnceWith(
      'Here is a meeting transcript. Please extract the key action items, decisions made, and any important points:\n\nship the release on Friday',
    );
  });
});
