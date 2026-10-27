// @vitest-environment jsdom

import { fireEvent, render, screen } from '@testing-library/react';
import { expect, test, vi } from 'vitest';
import { VoiceOrb } from '../VoiceOrb';

test.each([false, true])(
  'explains unavailable dictation on activation (composer disabled: %s)',
  (disabled) => {
    const onStart = vi.fn();
    render(
      <VoiceOrb
        state="idle"
        supported={disabled}
        disabled={disabled}
        unsupportedReason="Microphone capture is unavailable in this browser."
        onStart={onStart}
        onStop={vi.fn()}
      />,
    );

    const mic = screen.getByRole('button', {
      name: disabled ? 'Speak message' : 'Microphone unavailable',
    });
    expect((mic as HTMLButtonElement).disabled).toBe(false);
    expect(mic.getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(mic);
    expect(
      screen.getByRole('dialog', { name: 'Microphone unavailable' }),
    ).toBeTruthy();
    expect(
      screen.getByText(
        disabled
          ? 'Dictation is unavailable while this composer cannot accept input.'
          : 'Microphone capture is unavailable in this browser.',
      ),
    ).toBeTruthy();
    expect(onStart).not.toHaveBeenCalled();
  },
);

test('batch transcription is visibly busy and offers cancellation', () => {
  const onStart = vi.fn(),
    onStop = vi.fn();
  render(
    <VoiceOrb
      state="transcribing"
      supported
      onStart={onStart}
      onStop={onStop}
    />,
  );
  const mic = screen.getByRole('button', { name: 'Cancel transcription' });
  expect(mic.getAttribute('aria-busy')).toBe('true');
  fireEvent.click(mic);
  expect(onStart).not.toHaveBeenCalled();
  expect(onStop).toHaveBeenCalledTimes(1);
});
