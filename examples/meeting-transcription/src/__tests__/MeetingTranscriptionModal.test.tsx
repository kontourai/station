/**
 * @vitest-environment jsdom
 */
import {
  type STTOptions,
  type STTProvider,
  type STTState,
  voiceRegistry,
} from '@kontourai/station-sdk';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { MeetingTranscriptionModal } from '../MeetingTranscriptionModal';

/** A registrable STT provider whose state and transcript the test drives. */
function fakeSTT(id: string, isSupported = true) {
  const listeners = new Set<() => void>();
  const provider = {
    id,
    name: id,
    isSupported,
    state: 'idle' as STTState,
    transcript: '',
    startListening: vi.fn((_opts?: STTOptions) => {
      provider.state = 'listening';
      for (const fn of listeners) fn();
    }),
    stopListening: vi.fn(() => {
      provider.state = 'idle';
      for (const fn of listeners) fn();
    }),
    subscribe: (fn: () => void) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    hear(text: string) {
      provider.transcript = text;
      for (const fn of listeners) fn();
    },
  };
  return provider satisfies STTProvider;
}

const disposers: Array<() => void> = [];
afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose();
});

function renderModal() {
  return render(
    <MeetingTranscriptionModal isOpen onSend={vi.fn()} onClose={vi.fn()} />,
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
});
