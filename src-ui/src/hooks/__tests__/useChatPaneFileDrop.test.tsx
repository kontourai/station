/** @vitest-environment jsdom */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useCallback, useRef, useState } from 'react';
import { describe, expect, test } from 'vitest';
import {
  isChatPaneForeignFrameDrop,
  useChatPaneFileDrop,
} from '../useChatPaneFileDrop';

function transfer(
  files: File[],
  items: unknown[] = [],
  types: string[] = ['Files'],
): DataTransfer {
  return {
    types,
    files,
    items,
  } as unknown as DataTransfer;
}

function Harness({
  resetKey = 'one',
  lifecycle,
}: {
  resetKey?: string;
  lifecycle?: 'ready' | 'suspended' | 'disposed';
}) {
  const [error, setError] = useState<string | null>(null);
  const [calls, setCalls] = useState(0);
  const selectFiles = useCallback(
    async () => setCalls((count) => count + 1),
    [],
  );
  const rootRef = useRef<HTMLElement | null>(null);
  const drop = useChatPaneFileDrop({
    selectFiles,
    reportError: setError,
    resetKey,
    rootRef,
  });
  return (
    <section
      data-testid="pane"
      ref={rootRef}
      aria-label="Drop test pane"
      {...(lifecycle ? { 'data-workspace-pane-lifecycle': lifecycle } : {})}
      onDragEnter={drop.onDragEnter}
      onDragOver={drop.onDragOver}
      onDragLeave={drop.onDragLeave}
      onDragEnd={drop.onDragEnd}
      onDrop={drop.onDrop}
    >
      <span data-testid="active">{String(drop.isDraggingFiles)}</span>
      <span data-testid="count">{drop.fileCount}</span>
      <span data-testid="error">{error}</span>
      <span data-testid="calls">{calls}</span>
    </section>
  );
}

describe('useChatPaneFileDrop', () => {
  test('clears synchronously before the one root-owned external drop ingests', async () => {
    render(<Harness />);
    const pane = screen.getByTestId('pane');
    const child = document.createElement('span');
    pane.append(child);
    const dataTransfer = transfer([new File(['x'], 'note.txt')]);
    // The first external entry often targets a transcript/composer child,
    // not the pane root. A null relatedTarget is external, even though the
    // composed path naturally contains the root while React bubbles it.
    fireEvent.dragEnter(child, { dataTransfer, relatedTarget: null });
    expect(screen.getByTestId('active').textContent).toBe('true');
    expect(screen.getByTestId('count').textContent).toBe('1');
    fireEvent.drop(child, { dataTransfer });
    expect(screen.getByTestId('active').textContent).toBe('false');
    await waitFor(() =>
      expect(screen.getByTestId('calls').textContent).toBe('1'),
    );
  });

  test('keeps child boundary events inside the root and clears on outside, Escape, blur, and identity changes', () => {
    const { rerender } = render(<Harness />);
    const pane = screen.getByTestId('pane');
    const child = document.createElement('span');
    pane.append(child);
    const dataTransfer = transfer([new File(['x'], 'note.txt')]);
    fireEvent.dragEnter(pane, { dataTransfer });
    const internalLeave = new Event('dragleave', {
      bubbles: true,
      cancelable: true,
    });
    Object.defineProperties(internalLeave, {
      dataTransfer: { value: dataTransfer },
      relatedTarget: { value: child },
    });
    fireEvent(pane, internalLeave);
    expect(screen.getByTestId('active').textContent).toBe('true');
    fireEvent.dragLeave(pane, { dataTransfer, relatedTarget: null });
    expect(screen.getByTestId('active').textContent).toBe('false');
    fireEvent.dragEnter(pane, { dataTransfer });
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.getByTestId('active').textContent).toBe('false');
    fireEvent.dragEnter(pane, { dataTransfer });
    fireEvent.blur(window);
    expect(screen.getByTestId('active').textContent).toBe('false');
    fireEvent.dragEnter(pane, { dataTransfer });
    rerender(<Harness resetKey="next-session" />);
    expect(screen.getByTestId('active').textContent).toBe('false');
  });

  test('refuses directory drops with a reachable attachment error', () => {
    render(<Harness />);
    const pane = screen.getByTestId('pane');
    fireEvent.dragEnter(pane, {
      dataTransfer: transfer(
        [],
        [{ webkitGetAsEntry: () => ({ isDirectory: true }) }],
      ),
    });
    expect(screen.getByTestId('error').textContent).toBe(
      'Folders cannot be attached. Choose individual files.',
    );
  });

  test('reads item-only Safari and WKWebView drops and clears on lifecycle suspension', async () => {
    const { rerender } = render(<Harness lifecycle="ready" />);
    const pane = screen.getByTestId('pane');
    const file = new File(['x'], 'item-only.txt', { type: 'text/plain' });
    const dataTransfer = transfer(
      [],
      [{ kind: 'file', getAsFile: () => file }],
      [],
    );
    fireEvent.dragEnter(pane, { dataTransfer });
    expect(screen.getByTestId('count').textContent).toBe('1');
    fireEvent.drop(pane, { dataTransfer });
    await waitFor(() =>
      expect(screen.getByTestId('calls').textContent).toBe('1'),
    );
    fireEvent.dragEnter(pane, { dataTransfer });
    rerender(<Harness lifecycle="suspended" />);
    await waitFor(() =>
      expect(screen.getByTestId('active').textContent).toBe('false'),
    );
  });

  test('refuses composed paths that cross a foreign iframe', () => {
    const frame = document.createElement('iframe');
    expect(isChatPaneForeignFrameDrop([document.body, frame])).toBe(true);
    expect(isChatPaneForeignFrameDrop([document.body])).toBe(false);
  });
});
