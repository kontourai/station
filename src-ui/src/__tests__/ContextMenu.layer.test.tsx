/** @vitest-environment jsdom */

/**
 * A point-anchored `ContextMenu` opened from inside a raised surface (a
 * dialog, a sheet) takes the layer just above it, as `ActionOverflowMenu`
 * does; otherwise it would paint behind the surface it was opened from.
 */

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { ContextMenu } from '../components/ContextMenu';

beforeEach(() => {
  document.documentElement.style.setProperty('--layer-navigation', '9350');
});

afterEach(() => {
  cleanup();
  document.documentElement.style.removeProperty('--layer-navigation');
});

function renderMenuFrom(hostZIndex: number | null) {
  render(
    <div
      data-testid="host"
      style={
        hostZIndex === null
          ? undefined
          : { position: 'fixed', zIndex: hostZIndex }
      }
    >
      <span data-testid="origin">link</span>
    </div>,
  );
  render(
    <ContextMenu
      at={{ x: 10, y: 10 }}
      origin={screen.getByTestId('origin')}
      label="Link actions"
      actions={[{ key: 'open', label: 'Open link', onSelect: vi.fn() }]}
      onClose={vi.fn()}
    />,
  );
  return {
    menu: screen.getByRole('menu', { name: 'Link actions' }),
    backdrop: screen.getByRole('button', { name: 'Close menu' }),
  };
}

describe('ContextMenu layer', () => {
  test('above a dialog-layer host, with its backdrop between them', () => {
    const { menu, backdrop } = renderMenuFrom(10000);
    expect(menu.style.zIndex).toBe('10002');
    expect(backdrop.style.zIndex).toBe('10001');
  });

  test('on its own layer when the host sits below it', () => {
    const { menu, backdrop } = renderMenuFrom(null);
    expect(menu.style.zIndex).toBe('');
    expect(backdrop.style.zIndex).toBe('');
  });
});
