// @vitest-environment jsdom

import { render, screen } from '@testing-library/react';
import { expect, test } from 'vitest';
import { IconButton } from '../IconButton';

test('an icon button with no title shows its accessible name as the tooltip', () => {
  render(
    <IconButton aria-label="Reload">
      <span aria-hidden="true">↻</span>
    </IconButton>,
  );
  const button = screen.getByRole('button', { name: 'Reload' });
  expect(button.getAttribute('title')).toBe('Reload');
});

test('an explicit title still wins over the accessible name', () => {
  render(
    <IconButton aria-label="Copy path" title="Copy path (src/example.ts)">
      <span aria-hidden="true">⧉</span>
    </IconButton>,
  );
  const button = screen.getByRole('button', { name: 'Copy path' });
  expect(button.getAttribute('title')).toBe('Copy path (src/example.ts)');
});
