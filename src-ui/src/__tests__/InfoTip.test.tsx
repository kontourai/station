/**
 * @vitest-environment jsdom
 */

import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, test } from 'vitest';
import { InfoTip } from '../components/InfoTip';

describe('InfoTip', () => {
  test('opens through an accessible button and renders the explanation in a portal', () => {
    render(
      <InfoTip label="Approval guardian">Extra screening details</InfoTip>,
    );

    const trigger = screen.getByRole('button', {
      name: 'More about Approval guardian',
    });
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(trigger);

    const tooltip = screen.getByRole('tooltip');
    expect(tooltip.textContent).toContain('Extra screening details');
    expect(tooltip.parentElement).toBe(document.body);
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    expect(trigger.getAttribute('aria-describedby')).toBe(tooltip.id);
  });

  test('dismisses with Escape and restores trigger focus', () => {
    render(
      <InfoTip label="Approval guardian">Extra screening details</InfoTip>,
    );
    const trigger = screen.getByRole('button', {
      name: 'More about Approval guardian',
    });
    fireEvent.click(trigger);
    fireEvent.keyDown(document, { key: 'Escape' });

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
