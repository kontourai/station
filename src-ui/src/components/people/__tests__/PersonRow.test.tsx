/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { PersonRow } from '../PersonRow';

afterEach(cleanup);

/** A row whose open state is held by its parent, as both surfaces do. */
function Harness({
  pinned = false,
  onToggle,
}: {
  pinned?: boolean;
  onToggle?: (open: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <ul>
      <PersonRow
        principalId="human:test:ada"
        name="Ada Lovelace"
        badge={<span>Tailscale</span>}
        meta="1 device · 0 tokens"
        actions={
          <select aria-label="Group for Ada Lovelace">
            <option>Member</option>
          </select>
        }
        open={open}
        onToggle={(next) => {
          onToggle?.(next);
          setOpen(next);
        }}
        pinned={pinned}
        pinnedReason="Finish the new token first"
        body={<p>Ada’s devices</p>}
      />
    </ul>
  );
}

const toggle = () => screen.getByRole('button', { name: /Ada Lovelace/ });

describe('PersonRow (#3586)', () => {
  test('the native toggle opens and closes the body, wired by aria-expanded and aria-controls', () => {
    render(<Harness />);
    const button = toggle();
    expect(button.tagName).toBe('BUTTON');
    expect(button.getAttribute('type')).toBe('button');
    expect(button.getAttribute('aria-expanded')).toBe('false');
    expect(button.getAttribute('aria-controls')).toBeNull();
    expect(screen.queryByText('Ada’s devices')).toBeNull();

    fireEvent.click(button);
    expect(button.getAttribute('aria-expanded')).toBe('true');
    const bodyId = button.getAttribute('aria-controls');
    expect(bodyId).toBeTruthy();
    expect(document.getElementById(bodyId as string)?.textContent).toBe(
      'Ada’s devices',
    );
    expect(button.closest('li')?.classList.contains('person-row--open')).toBe(
      true,
    );

    fireEvent.click(button);
    expect(button.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByText('Ada’s devices')).toBeNull();
  });

  test('the name, badge and meta are in the toggle; the actions are its siblings', () => {
    render(<Harness />);
    const button = toggle();
    expect(button.textContent).toContain('Ada Lovelace');
    expect(button.textContent).toContain('Tailscale');
    expect(button.textContent).toContain('1 device · 0 tokens');
    const select = screen.getByLabelText('Group for Ada Lovelace');
    expect(button.contains(select)).toBe(false);
    fireEvent.click(select);
    expect(button.getAttribute('aria-expanded')).toBe('false');
    expect(
      button.closest('[data-principal-id]')?.getAttribute('data-principal-id'),
    ).toBe('human:test:ada');
  });

  test('a pinned row is open, says why, and refuses to close', () => {
    const onToggle = vi.fn();
    render(<Harness pinned onToggle={onToggle} />);
    const button = toggle();
    expect(button.getAttribute('aria-expanded')).toBe('true');
    expect(button.getAttribute('aria-disabled')).toBe('true');
    expect(button.getAttribute('title')).toBe('Finish the new token first');
    expect(screen.getByText('Ada’s devices')).toBeTruthy();
    fireEvent.click(button);
    expect(onToggle).not.toHaveBeenCalled();
    expect(button.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByText('Ada’s devices')).toBeTruthy();
  });

  test('without onToggle the row is static: no toggle, no body', () => {
    render(
      <ul>
        <PersonRow
          principalId="human:test:grace"
          name="Grace Hopper"
          meta="Project admin"
          open
          body={<p>never shown</p>}
          actions={<button type="button">Revoke access</button>}
        />
      </ul>,
    );
    expect(screen.getAllByRole('button').map((b) => b.textContent)).toEqual([
      'Revoke access',
    ]);
    expect(screen.getByText('Grace Hopper')).toBeTruthy();
    expect(screen.getByText('Project admin')).toBeTruthy();
    expect(screen.queryByText('never shown')).toBeNull();
  });
});
