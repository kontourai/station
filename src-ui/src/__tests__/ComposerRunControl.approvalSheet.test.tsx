// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeAll, expect, test, vi } from 'vitest';
import { ApprovalModeChip } from '../components/badges/ApprovalModeChip';
import { ComposerRunControl } from '../components/ComposerRunControl';

/**
 * The approval picker opened from Run setup replaces the Run setup panel on
 * desktop instead of stacking a second surface over it, opens where Run setup
 * did, and stays inside the composer column that hosts the trigger.
 */
beforeAll(() => {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: vi.fn().mockImplementation(() => ({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
      media: '',
      onchange: null,
    })),
  });
});
afterEach(cleanup);

function rect(left: number, top: number, width: number, height: number) {
  return {
    left,
    top,
    width,
    height,
    right: left + width,
    bottom: top + height,
    x: left,
    y: top,
    toJSON: () => ({}),
  } as DOMRect;
}

function renderComposer() {
  render(
    <div data-popover-boundary="" data-testid="composer">
      <ComposerRunControl label="Claude Code · Opus" icon={null}>
        <ApprovalModeChip
          engineConnectionId="claude"
          sessionOverride="never"
          lastAppliedApprovalMode="never"
          onChange={vi.fn()}
        />
      </ComposerRunControl>
    </div>,
  );
  const composer = screen.getByTestId('composer');
  composer.getBoundingClientRect = () => rect(500, 600, 1000, 160);
  const runTrigger = screen.getByTestId('run-setup-trigger');
  runTrigger.getBoundingClientRect = () => rect(1200, 700, 160, 44);
  fireEvent.click(runTrigger);
  const runSetup = screen.getByRole('dialog', {
    name: 'Agent & model',
  });
  const approvalChip = screen.getByRole('button', { name: /^Approval mode:/ });
  // Where the chip sits inside the (soon hidden) Run setup panel.
  approvalChip.getBoundingClientRect = () => rect(1050, 300, 300, 44);
  return { runSetup, approvalChip };
}

const overlayOf = (element: Element) =>
  element.closest('.responsive-surface-overlay') as HTMLElement;

test('the approval picker stands in for Run setup and opens at its anchor, inside the composer', async () => {
  const { runSetup, approvalChip } = renderComposer();
  expect(overlayOf(runSetup).hasAttribute('data-yielded')).toBe(false);

  fireEvent.click(approvalChip);
  const sheet = await screen.findByRole('dialog', { name: 'Approval mode' });

  // One surface at a time: Run setup gives way while the picker is open.
  expect(overlayOf(runSetup).hasAttribute('data-yielded')).toBe(true);
  // The picker is placed from the Run setup trigger, not from the hidden chip.
  const style = overlayOf(sheet).style;
  expect(style.getPropertyValue('--responsive-anchor-left')).toBe('1200px');
  expect(style.getPropertyValue('--responsive-anchor-top')).toBe('700px');
  // And it carries the composer column's edges for the clamp.
  expect(style.getPropertyValue('--responsive-boundary-left')).toBe('500px');
  expect(style.getPropertyValue('--responsive-boundary-right')).toBe('1500px');

  // Escape goes back to Run setup.
  fireEvent.keyDown(sheet, { key: 'Escape' });
  expect(screen.queryByRole('dialog', { name: 'Approval mode' })).toBeNull();
  expect(overlayOf(runSetup).hasAttribute('data-yielded')).toBe(false);
  expect(screen.getByRole('dialog', { name: 'Agent & model' })).toBeTruthy();
});

test('a click outside the picker closes the picker and the hidden Run setup', async () => {
  const { approvalChip } = renderComposer();
  fireEvent.click(approvalChip);
  const sheet = await screen.findByRole('dialog', { name: 'Approval mode' });
  fireEvent.pointerDown(overlayOf(sheet));
  expect(screen.queryByRole('dialog', { name: 'Approval mode' })).toBeNull();
  expect(screen.queryByRole('dialog', { name: 'Agent & model' })).toBeNull();
});

test('the sheet says what is in effect, in the same words as the list', async () => {
  const { approvalChip } = renderComposer();
  fireEvent.click(approvalChip);
  await screen.findByRole('radiogroup', { name: 'Approval mode' });
  expect(
    screen.getByText(
      (_, element) =>
        element?.className === 'composer-mode-sheet__status' &&
        element.textContent ===
          'In effect: Full access, confirmed by Claude Code',
    ),
  ).toBeTruthy();
  expect(screen.getByRole('radio', { name: /^Full access/ })).toBeTruthy();
  expect(screen.queryByText(/Never ask/)).toBeNull();
  expect(
    screen.getByText('Set for this chat · changes apply next turn'),
  ).toBeTruthy();
});
