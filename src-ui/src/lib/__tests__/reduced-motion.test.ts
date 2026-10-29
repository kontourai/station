/** @vitest-environment jsdom */
import { expect, test } from 'vitest';
import { motionTokenMs } from '../reduced-motion';

function styleWith(value: string | null) {
  const element = document.createElement('div');
  if (value !== null) element.style.setProperty('--motion-base', value);
  return element.style;
}

test('motionTokenMs reads seconds and milliseconds, and the reduced-motion collapse', () => {
  expect(motionTokenMs(styleWith('0.2s'), '--motion-base')).toBe(200);
  expect(motionTokenMs(styleWith(' 150ms '), '--motion-base')).toBe(150);
  // tokens.css under prefers-reduced-motion.
  expect(motionTokenMs(styleWith('0.01ms'), '--motion-base')).toBe(0.01);
});

test('motionTokenMs falls back when the token is unset or unparsable', () => {
  expect(motionTokenMs(styleWith(null), '--motion-base')).toBe(0);
  expect(motionTokenMs(styleWith(null), '--motion-base', 200)).toBe(200);
  expect(motionTokenMs(styleWith('var(--nope)'), '--motion-base', 200)).toBe(
    200,
  );
});
