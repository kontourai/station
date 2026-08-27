/**
 * @vitest-environment jsdom
 */

import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';
import { LayoutHeader } from '../components/LayoutHeader';

function renderHeader(onTabPromptSelect = vi.fn()) {
  render(
    <LayoutHeader
      title="Sessions"
      description="Recent work"
      tabPrompts={[{ id: 'p1', label: 'Summarise', prompt: 'summarise' }]}
      onTabPromptSelect={onTabPromptSelect}
    />,
  );
  return onTabPromptSelect;
}

describe('LayoutHeader prompt dropdown', () => {
  test('catches outside clicks without adding a full-viewport tab stop', () => {
    renderHeader();

    const closedTabStops = screen.getAllByRole('button').length;
    fireEvent.click(
      screen.getByRole('button', { name: 'Sessions Quick actions' }),
    );
    const menuItem = screen.getByRole('button', { name: 'Summarise' });

    // Opening the menu may add exactly one tab stop: the menu item. The
    // click-outside catcher is a fixed, full-viewport element — as a `<button>`
    // it is an invisible tab stop between the toggle and the menu that
    // dismisses the menu on Enter, and this package styles no focus ring.
    expect(screen.getAllByRole('button')).toHaveLength(closedTabStops + 1);
    expect(
      screen.queryByRole('button', { name: /Close Sessions prompts/i }),
    ).toBeNull();

    const backdrop = document.querySelector(
      '.workspace-header__dropdown-backdrop',
    );
    expect(backdrop).not.toBeNull();
    expect(backdrop?.tagName).toBe('DIV');
    expect(backdrop?.hasAttribute('tabindex')).toBe(false);

    // Dismissal itself still works.
    fireEvent.click(backdrop as Element);
    expect(menuItem.isConnected).toBe(false);
    expect(
      document.querySelector('.workspace-header__dropdown-backdrop'),
    ).toBeNull();
  });
});
