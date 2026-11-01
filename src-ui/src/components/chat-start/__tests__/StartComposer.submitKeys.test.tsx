// @vitest-environment jsdom
/**
 * #4387: the first-run Home composer ignored Return and Ctrl+Return; only the
 * Start button sent, while the reply composer sends on Return. The start
 * composer now takes the reply composer's submit keys: Return per the device
 * setting (`auto` sends on a fine pointer, inserts a newline on touch),
 * Ctrl/Cmd+Return always, Shift+Return never, and never mid-IME-composition.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { deviceSettingsStore } from '../../../lib/device-settings-store';

let coarsePointer = false;
vi.mock('../../../hooks/useIsMobile', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../hooks/useIsMobile')>()),
  useDockSlotDevice: () => ({ viewportWidth: 1280, coarsePointer }),
}));

const { StartComposer } = await import('../StartComposer');

beforeEach(() => {
  coarsePointer = false;
});

afterEach(() => {
  cleanup();
  deviceSettingsStore.reset('chatReturnBehavior');
});

function renderComposer({ canStart = true } = {}) {
  const onStart = vi.fn();
  render(
    <StartComposer
      prompt="Say hi in 5 words"
      onPromptChange={() => undefined}
      agent={{ status: 'ready', needsSetup: false }}
      onOpenAgents={() => undefined}
      project={{ status: 'ready', label: 'No project', isGlobal: true }}
      onOpenProject={() => undefined}
      canStart={canStart}
      pending={false}
      onStart={onStart}
    />,
  );
  const field = screen.getByRole('textbox', {
    name: 'What would you like done?',
  });
  return { field, onStart };
}

describe('StartComposer submit keys', () => {
  test('Return starts the chat on a fine pointer', () => {
    const { field, onStart } = renderComposer();
    const notPrevented = fireEvent.keyDown(field, { key: 'Enter' });
    expect(onStart).toHaveBeenCalledTimes(1);
    expect(notPrevented).toBe(false);
  });

  test('Ctrl+Return and Cmd+Return start the chat', () => {
    const { field, onStart } = renderComposer();
    fireEvent.keyDown(field, { key: 'Enter', ctrlKey: true });
    fireEvent.keyDown(field, { key: 'Enter', metaKey: true });
    expect(onStart).toHaveBeenCalledTimes(2);
  });

  test('Shift+Return and an IME confirmation insert, never start', () => {
    const { field, onStart } = renderComposer();
    expect(fireEvent.keyDown(field, { key: 'Enter', shiftKey: true })).toBe(
      true,
    );
    expect(fireEvent.keyDown(field, { key: 'Enter', keyCode: 229 })).toBe(true);
    expect(onStart).not.toHaveBeenCalled();
  });

  test('on a touch keyboard Return is a newline and Ctrl+Return still starts', () => {
    coarsePointer = true;
    const { field, onStart } = renderComposer();
    expect(fireEvent.keyDown(field, { key: 'Enter' })).toBe(true);
    expect(onStart).not.toHaveBeenCalled();
    fireEvent.keyDown(field, { key: 'Enter', ctrlKey: true });
    expect(onStart).toHaveBeenCalledTimes(1);
  });

  test('the Return-key device setting applies here as in the reply composer', () => {
    deviceSettingsStore.set('chatReturnBehavior', 'newline');
    const { field, onStart } = renderComposer();
    expect(fireEvent.keyDown(field, { key: 'Enter' })).toBe(true);
    expect(onStart).not.toHaveBeenCalled();
  });

  test('a start that is not ready does not run from the keyboard', () => {
    const { field, onStart } = renderComposer({ canStart: false });
    fireEvent.keyDown(field, { key: 'Enter' });
    expect(onStart).not.toHaveBeenCalled();
  });
});
