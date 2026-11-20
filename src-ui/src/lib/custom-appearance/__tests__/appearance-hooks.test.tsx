/** @vitest-environment jsdom */

import { APPEARANCE_HOOKS } from '@kontourai/station-contracts/custom-appearance';
import { render, screen } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';
import { Button } from '../../../components/Button';
import { ContextMenu } from '../../../components/ContextMenu';
import { Dialog } from '../../../components/Dialog';

const selector = (id: string) =>
  APPEARANCE_HOOKS.find((hook) => hook.id === id)!.selector;

/**
 * Where each stable hook is proven: every hook in the contract is rendered by
 * its owner and queried by its selector, in this file or in the owner's own
 * suite. A new hook without a row fails the first test. The three region
 * hooks are one attribute whose value is the dock's placement; its suite
 * renders the dock in one placement.
 */
const PROVEN_IN: Record<string, string> = {
  sidebar: '__tests__/ProjectSidebar.test.tsx',
  'region-left':
    'components/chat-dock/__tests__/DockShell.softKeyboard.test.tsx',
  'region-right':
    'components/chat-dock/__tests__/DockShell.softKeyboard.test.tsx',
  'region-bottom':
    'components/chat-dock/__tests__/DockShell.softKeyboard.test.tsx',
  'chat-header': '__tests__/ChatDockHeaderWorkspaceControls.test.tsx',
  transcript: '__tests__/ChatDockBody.ephemeralRenderGate.test.tsx',
  'user-message': '__tests__/ChatDockBody.ephemeralRenderGate.test.tsx',
  'assistant-message': '__tests__/ChatDockBody.ephemeralRenderGate.test.tsx',
  composer: '__tests__/ChatInputArea.test.tsx',
  dialog: 'this file',
  menu: 'this file',
  button: 'this file',
};

describe('custom appearance hook selectors', () => {
  test('every hook names the suite that renders its owner', () => {
    expect(Object.keys(PROVEN_IN).sort()).toEqual(
      APPEARANCE_HOOKS.map((hook) => hook.id).sort(),
    );
  });

  test('Button renders the button hook', () => {
    render(<Button>Save</Button>);
    expect(
      screen.getByRole('button', { name: 'Save' }).matches(selector('button')),
    ).toBe(true);
  });

  test('Dialog renders the dialog hook on its panel', () => {
    render(
      <Dialog title="Rename" closeLabel="Close rename" onClose={vi.fn()}>
        <p>body</p>
      </Dialog>,
    );
    const panel = screen.getByRole('dialog', { name: 'Rename' });
    expect(panel.matches(selector('dialog'))).toBe(true);
  });

  test('ContextMenu renders the menu hook', () => {
    render(<span data-testid="origin">x</span>);
    render(
      <ContextMenu
        at={{ x: 10, y: 10 }}
        origin={screen.getByTestId('origin')}
        label="Actions"
        actions={[{ key: 'open', label: 'Open', onSelect: vi.fn() }]}
        onClose={vi.fn()}
      />,
    );
    expect(
      screen.getByRole('menu', { name: 'Actions' }).matches(selector('menu')),
    ).toBe(true);
  });
});
