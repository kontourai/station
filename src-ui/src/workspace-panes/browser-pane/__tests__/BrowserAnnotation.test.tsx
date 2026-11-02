/** @vitest-environment jsdom */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createRef } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { BrowserAnnotation } from '../BrowserAnnotation';
import type { BrowserPaneApi } from '../browserPaneApi';

afterEach(() => vi.unstubAllGlobals());

it('maps pointer input through a letterboxed canvas and attaches a box with Enter', async () => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    },
  );
  vi.stubGlobal('PointerEvent', MouseEvent);
  const stage = document.createElement('div');
  const canvas = document.createElement('canvas');
  stage.append(canvas);
  document.body.append(stage);
  stage.getBoundingClientRect = () => ({
    left: 0,
    top: 0,
    width: 400,
    height: 400,
    right: 400,
    bottom: 400,
    x: 0,
    y: 0,
    toJSON() {},
  });
  canvas.getBoundingClientRect = stage.getBoundingClientRect;
  const stageRef = createRef<HTMLDivElement>();
  Object.defineProperty(stageRef, 'current', { value: stage });
  const attach = vi.fn();
  const cancel = vi.fn();
  const pick = vi.fn();
  render(
    <BrowserAnnotation
      stageRef={stageRef}
      viewport={{ width: 800, height: 400, deviceScaleFactor: 1 }}
      generation={1}
      sessionId="bs_test"
      api={{ pick } as unknown as BrowserPaneApi}
      onAttach={attach}
      onCancel={cancel}
      pending={false}
    />,
  );
  const surface = await screen.findByLabelText('Annotate browser page');
  Object.defineProperty(surface, 'setPointerCapture', { value: () => {} });
  fireEvent.keyDown(screen.getByRole('group', { name: 'Browser annotation' }), {
    key: 'b',
  });
  fireEvent.pointerDown(surface, { clientX: 50, clientY: 125 });
  fireEvent.pointerMove(surface, { clientX: 150, clientY: 175 });
  fireEvent.pointerUp(surface, { clientX: 150, clientY: 175 });
  fireEvent.keyDown(screen.getByRole('group', { name: 'Browser annotation' }), {
    key: 'Enter',
  });
  await waitFor(() =>
    expect(attach).toHaveBeenCalledWith({
      picked: null,
      marks: [
        {
          kind: 'box',
          points: [
            { x: 100, y: 50 },
            { x: 300, y: 150 },
          ],
        },
      ],
    }),
  );
  fireEvent.keyDown(screen.getByRole('group', { name: 'Browser annotation' }), {
    key: 'Escape',
  });
  expect(cancel).toHaveBeenCalledOnce();
  stage.remove();
});

it('selects with target viewport coordinates and erases the selected element', async () => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    },
  );
  vi.stubGlobal('PointerEvent', MouseEvent);
  const stage = document.createElement('div');
  const canvas = document.createElement('canvas');
  stage.append(canvas);
  document.body.append(stage);
  stage.getBoundingClientRect = () => ({
    left: 10,
    top: 20,
    width: 400,
    height: 400,
    right: 410,
    bottom: 420,
    x: 10,
    y: 20,
    toJSON() {},
  });
  canvas.getBoundingClientRect = stage.getBoundingClientRect;
  const stageRef = createRef<HTMLDivElement>();
  Object.defineProperty(stageRef, 'current', { value: stage });
  const picked = {
    rect: { x: 90, y: 40, width: 30, height: 30 },
    selector: 'button',
    screenshot: 'AA==',
  };
  const pick = vi.fn().mockResolvedValue(picked);
  const attach = vi.fn();
  render(
    <BrowserAnnotation
      stageRef={stageRef}
      viewport={{ width: 800, height: 400, deviceScaleFactor: 1 }}
      generation={7}
      sessionId="bs_test"
      api={{ pick } as unknown as BrowserPaneApi}
      onAttach={attach}
      onCancel={() => {}}
      pending={false}
    />,
  );
  const surface = await screen.findByLabelText('Annotate browser page');
  Object.defineProperty(surface, 'setPointerCapture', { value: () => {} });
  fireEvent.pointerDown(surface, { clientX: 60, clientY: 145 });
  await waitFor(() =>
    expect(pick).toHaveBeenCalledWith('bs_test', { x: 100, y: 50 }, 7, true),
  );
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Attach' })).not.toHaveProperty(
      'disabled',
      true,
    ),
  );
  fireEvent.keyDown(screen.getByRole('group', { name: 'Browser annotation' }), {
    key: 'Enter',
  });
  expect(attach).toHaveBeenCalledWith({ picked, marks: [] });
  fireEvent.keyDown(screen.getByRole('group', { name: 'Browser annotation' }), {
    key: 'e',
  });
  fireEvent.pointerDown(surface, { clientX: 60, clientY: 145 });
  expect(screen.getByRole('button', { name: 'Attach' })).toHaveProperty(
    'disabled',
    true,
  );
  stage.remove();
});
