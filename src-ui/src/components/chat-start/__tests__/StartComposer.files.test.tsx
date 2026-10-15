// @vitest-environment jsdom
/**
 * The start composer takes files the way the chat composer does: a pasted
 * image (the clipboard's file items) joins the start's files instead of the
 * text, and each file can be removed before Start.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { StartComposer, type StartComposerFiles } from '../StartComposer';

afterEach(cleanup);

function renderComposer(files?: StartComposerFiles) {
  render(
    <StartComposer
      prompt="look"
      onPromptChange={() => undefined}
      agent={{ status: 'ready', needsSetup: false }}
      onOpenAgents={() => undefined}
      project={{ status: 'ready', label: 'No project', isGlobal: true }}
      onOpenProject={() => undefined}
      canStart
      pending={false}
      onStart={() => undefined}
      files={files}
    />,
  );
  return screen.getByRole('textbox', { name: 'What would you like done?' });
}

function clipboardWith(items: Array<{ kind: string; file?: File }>) {
  return {
    items: items.map((item) => ({
      kind: item.kind,
      getAsFile: () => item.file ?? null,
    })),
    files: [],
  };
}

describe('StartComposer files', () => {
  test('a pasted image joins the start’s files, not its text', () => {
    const onAdd = vi.fn();
    const field = renderComposer({ list: [], onAdd, onRemove: vi.fn() });
    const image = new File([new Uint8Array([1])], 'clip.png', {
      type: 'image/png',
    });
    const pasted = fireEvent.paste(field, {
      clipboardData: clipboardWith([{ kind: 'file', file: image }]),
    });
    expect(onAdd).toHaveBeenCalledWith([image]);
    // Handled: the browser's own paste did not also run.
    expect(pasted).toBe(false);
  });

  test('a plain-text paste is left to the field', () => {
    const onAdd = vi.fn();
    const field = renderComposer({ list: [], onAdd, onRemove: vi.fn() });
    const pasted = fireEvent.paste(field, {
      clipboardData: clipboardWith([{ kind: 'string' }]),
    });
    expect(onAdd).not.toHaveBeenCalled();
    expect(pasted).toBe(true);
  });

  test('each file is listed with its own remove', () => {
    const onRemove = vi.fn();
    renderComposer({
      list: [new File(['a'], 'a.txt'), new File(['b'], 'b.txt')],
      onAdd: vi.fn(),
      onRemove,
    });
    expect(
      screen
        .getByRole('list', { name: 'Files for this chat' })
        .querySelectorAll('li'),
    ).toHaveLength(2);
    fireEvent.click(screen.getByRole('button', { name: 'Remove b.txt' }));
    expect(onRemove).toHaveBeenCalledWith(1);
    expect(screen.getByRole('button', { name: 'Attach files' })).toBeTruthy();
  });

  test('without a files owner there is no paperclip and paste is the field’s', () => {
    const field = renderComposer(undefined);
    expect(screen.queryByRole('button', { name: 'Attach files' })).toBeNull();
    const pasted = fireEvent.paste(field, {
      clipboardData: clipboardWith([
        { kind: 'file', file: new File(['x'], 'x.png') },
      ]),
    });
    expect(pasted).toBe(true);
  });
});
