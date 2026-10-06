/**
 * @vitest-environment jsdom
 */

import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';
import { InfoTip } from '../components/InfoTip';

describe('InfoTip', () => {
  test('keeps hover help readable across the gap and pins it when clicked', () => {
    vi.useFakeTimers();
    try {
      render(<InfoTip label="Tools">Changes apply to new chats.</InfoTip>);
      const trigger = screen.getByRole('button', { name: 'More about Tools' });
      fireEvent.mouseEnter(trigger);
      const tooltip = screen.getByRole('tooltip');
      fireEvent.mouseLeave(trigger);
      fireEvent.mouseEnter(tooltip);
      act(() => vi.advanceTimersByTime(300));
      expect(screen.getByRole('tooltip')).toBe(tooltip);
      fireEvent.mouseLeave(tooltip);
      act(() => vi.advanceTimersByTime(300));
      expect(screen.queryByRole('tooltip')).toBeNull();
      fireEvent.mouseEnter(trigger);
      fireEvent.click(trigger);
      fireEvent.mouseLeave(trigger);
      act(() => vi.advanceTimersByTime(300));
      expect(screen.getByRole('tooltip')).toBeTruthy();
      fireEvent.click(trigger);
      expect(screen.queryByRole('tooltip')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  test('opens accessible help in a portal and keeps it inside the viewport', () => {
    render(
      <InfoTip label="Approval guardian">Extra screening details</InfoTip>,
    );

    const trigger = screen.getByRole('button', {
      name: 'More about Approval guardian',
    });
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    const bounds = vi
      .spyOn(trigger, 'getBoundingClientRect')
      .mockReturnValue(new DOMRect(100, 500, 18, 18));
    const height = vi
      .spyOn(HTMLElement.prototype, 'offsetHeight', 'get')
      .mockImplementation(function (this: HTMLElement) {
        return this.getAttribute('role') === 'tooltip' ? 305 : 18;
      });
    fireEvent.click(trigger);

    const tooltip = screen.getByRole('tooltip');
    expect(tooltip.textContent).toContain('Extra screening details');
    expect(tooltip.parentElement).toBe(document.body);
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    expect(trigger.getAttribute('aria-describedby')).toBe(tooltip.id);
    const top = Number.parseFloat(tooltip.style.top);
    const below = tooltip.classList.contains('info-tip__content--below');
    expect(below ? top + 305 : top).toBeLessThanOrEqual(
      window.innerHeight - 12,
    );
    expect(below ? top : top - 305).toBeGreaterThanOrEqual(12);
    height.mockRestore();
    bounds.mockRestore();
  });

  test('dismisses with Escape and restores trigger focus', () => {
    render(
      <InfoTip label="Approval guardian">Extra screening details</InfoTip>,
    );
    const trigger = screen.getByRole('button', {
      name: 'More about Approval guardian',
    });
    fireEvent.click(trigger);
    const outerDismiss = vi.fn();
    document.addEventListener('keydown', outerDismiss);
    fireEvent.keyDown(trigger, { key: 'Escape' });
    document.removeEventListener('keydown', outerDismiss);
    expect(outerDismiss).not.toHaveBeenCalled();

    expect(screen.queryByRole('tooltip')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  test('dismisses when the pointer moves to another control', () => {
    render(
      <>
        <InfoTip label="Approval guardian">Extra screening details</InfoTip>
        <button type="button">Elsewhere</button>
      </>,
    );
    fireEvent.click(
      screen.getByRole('button', { name: 'More about Approval guardian' }),
    );
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Elsewhere' }));
    expect(screen.queryByRole('tooltip')).toBeNull();
  });
});
