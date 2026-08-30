// @vitest-environment jsdom

import { fireEvent, render, screen } from '@testing-library/react';
import { expect, test, vi } from 'vitest';
import { VoiceOrb } from '../VoiceOrb';

test('renders an unsupported microphone disabled with its capability reason', () => {
  const onStart = vi.fn();
  render(
    <VoiceOrb
      state="idle"
      supported={false}
      unsupportedReason="Microphone capture is unavailable in this browser."
      onStart={onStart}
      onStop={vi.fn()}
    />,
  );

  const mic = screen.getByRole('button', { name: 'Microphone unavailable' });
  expect((mic as HTMLButtonElement).disabled).toBe(true);
  expect(mic.getAttribute('title')).toContain('capture is unavailable');
  fireEvent.click(mic);
  expect(onStart).not.toHaveBeenCalled();
});
