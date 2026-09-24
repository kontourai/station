/** @vitest-environment jsdom */

/**
 * The shared switch's accessible state (#2441). The visual half — that the
 * off and on tracks each clear 3:1 against the surface behind them — needs
 * real layout and computed colours, so it lives in
 * tests/toggle-contrast.spec.ts; this file owns what jsdom can prove.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { Toggle } from '../components/Toggle';

function Controlled({ initial = false }: { initial?: boolean }) {
  const [checked, setChecked] = useState(initial);
  return (
    <Toggle
      checked={checked}
      onChange={setChecked}
      label="Send usage data"
      showStateLabel
    />
  );
}

describe('Toggle', () => {
  afterEach(cleanup);

  test('exposes its state as a switch with aria-checked, and flips it on click', () => {
    render(<Controlled />);
    const toggle = screen.getByRole('switch', { name: 'Send usage data' });
    expect(toggle.getAttribute('aria-checked')).toBe('false');
    fireEvent.click(toggle);
    expect(
      screen
        .getByRole('switch', { name: 'Send usage data' })
        .getAttribute('aria-checked'),
    ).toBe('true');
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-checked')).toBe('false');
  });

  test('reports the next state to onChange without owning it', () => {
    const onChange = vi.fn();
    render(<Toggle checked onChange={onChange} label="Enabled" />);
    fireEvent.click(screen.getByRole('switch', { name: 'Enabled' }));
    expect(onChange).toHaveBeenCalledWith(false);
    // Controlled: the prop, not the click, decides what is rendered.
    expect(
      screen
        .getByRole('switch', { name: 'Enabled' })
        .getAttribute('aria-checked'),
    ).toBe('true');
  });

  test('the state word follows the state and is hidden from assistive tech', () => {
    render(<Controlled />);
    const toggle = screen.getByRole('switch', { name: 'Send usage data' });
    const word = () =>
      toggle
        .closest('.station-toggle-field')
        ?.querySelector('.station-toggle__state');
    expect(word()?.textContent).toBe('Off');
    expect(word()?.getAttribute('aria-hidden')).toBe('true');
    fireEvent.click(toggle);
    expect(word()?.textContent).toBe('On');
    // The word must not leak into the switch's accessible name.
    expect(screen.getByRole('switch', { name: 'Send usage data' })).toBe(
      toggle,
    );
  });

  test('without showStateLabel it renders the bare switch, so dense rows keep their width', () => {
    const { container } = render(
      <Toggle checked={false} onChange={() => {}} label="Bare" />,
    );
    expect(container.firstElementChild?.getAttribute('role')).toBe('switch');
    expect(container.querySelector('.station-toggle__state')).toBeNull();
  });

  test('disabled switches cannot be flipped', () => {
    const onChange = vi.fn();
    render(
      <Toggle checked={false} onChange={onChange} label="Locked" disabled />,
    );
    fireEvent.click(screen.getByRole('switch', { name: 'Locked' }));
    expect(onChange).not.toHaveBeenCalled();
  });
});
