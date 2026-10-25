// @vitest-environment jsdom
/**
 * The start composer takes files the way the chat composer does: a pasted
 * image (the clipboard's file items) joins the start's files instead of the
 * text, and each file can be removed before Start.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
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

describe('StartComposer file drops', () => {
  test.each(['files', 'items'])(
    'accepts a screenshot from %s once across nested drop owners',
    (source) => {
      const parent = vi.fn();
      const onAdd = vi.fn();
      const image = new File(['image'], 'screenshot.png', {
        type: 'image/png',
      });
      render(
        <section aria-label="Outer drop owner" onDrop={parent}>
          <StartComposer
            prompt="Keep this draft"
            onPromptChange={vi.fn()}
            agent={{ status: 'ready', needsSetup: false }}
            onOpenAgents={vi.fn()}
            project={{ status: 'ready', label: 'No project', isGlobal: true }}
            onOpenProject={vi.fn()}
            canStart
            pending={false}
            onStart={vi.fn()}
            files={{ list: [], onAdd, onRemove: vi.fn() }}
          />
        </section>,
      );
      const field = screen.getByRole('textbox');
      const dataTransfer = {
        types: ['Files'],
        files: source === 'files' ? [image] : [],
        items:
          source === 'items' ? [{ kind: 'file', getAsFile: () => image }] : [],
      };
      expect(fireEvent.dragOver(field, { dataTransfer })).toBe(false);
      fireEvent.dragEnter(field, { dataTransfer });
      expect(screen.getByRole('status').textContent).toContain('Drop images');
      expect(fireEvent.drop(field, { dataTransfer })).toBe(false);
      expect(onAdd).toHaveBeenCalledExactlyOnceWith([image]);
      expect(parent).not.toHaveBeenCalled();
      expect(screen.queryByRole('status')).toBeNull();
      expect(field).toHaveProperty('value', 'Keep this draft');
      expect(document.activeElement).toBe(field);
    },
  );

  test('plain text drops are left to the editor', () => {
    const onAdd = vi.fn();
    const field = renderComposer({ list: [], onAdd, onRemove: vi.fn() });
    const dataTransfer = { types: ['text/plain'], items: [], files: [] };
    expect(fireEvent.dragOver(field, { dataTransfer })).toBe(true);
    expect(fireEvent.drop(field, { dataTransfer })).toBe(true);
    expect(onAdd).not.toHaveBeenCalled();
  });

  test('a folder drop explains the refusal instead of attaching it', () => {
    const onAdd = vi.fn();
    const field = renderComposer({ list: [], onAdd, onRemove: vi.fn() });
    fireEvent.drop(field, {
      dataTransfer: {
        types: ['Files'],
        files: [],
        items: [
          { kind: 'file', webkitGetAsEntry: () => ({ isDirectory: true }) },
        ],
      },
    });
    expect(screen.getByRole('alert').textContent).toContain(
      'Folders cannot be attached',
    );
    expect(onAdd).not.toHaveBeenCalled();
  });

  test('shows a pasted screenshot and releases its preview when removed', () => {
    const create = vi
      .spyOn(URL, 'createObjectURL')
      .mockReturnValue('blob:screenshot');
    const revoke = vi
      .spyOn(URL, 'revokeObjectURL')
      .mockImplementation(() => undefined);
    function Draft() {
      const [list, setList] = useState<File[]>([]);
      return (
        <StartComposer
          prompt="look"
          onPromptChange={vi.fn()}
          agent={{ status: 'ready', needsSetup: false }}
          onOpenAgents={vi.fn()}
          project={{ status: 'ready', label: 'No project', isGlobal: true }}
          onOpenProject={vi.fn()}
          canStart
          pending={false}
          onStart={vi.fn()}
          files={{
            list,
            onAdd: (added) => setList((current) => [...current, ...added]),
            onRemove: (index) =>
              setList((current) =>
                current.filter((_, position) => position !== index),
              ),
          }}
        />
      );
    }
    render(<Draft />);
    const image = new File(['image'], 'screenshot.png', { type: 'image/png' });
    fireEvent.paste(screen.getByRole('textbox'), {
      clipboardData: clipboardWith([{ kind: 'file', file: image }]),
    });
    expect(
      screen.getByRole('img', { name: 'screenshot.png' }).getAttribute('src'),
    ).toBe('blob:screenshot');
    expect(create).toHaveBeenCalledWith(image);
    fireEvent.click(
      screen.getByRole('button', { name: 'Remove screenshot.png' }),
    );
    expect(screen.queryByRole('img')).toBeNull();
    expect(revoke).toHaveBeenCalledWith('blob:screenshot');
  });
});
