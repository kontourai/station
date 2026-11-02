/** @vitest-environment jsdom */
import type { BrowserSessionView } from '@kontourai/station-contracts/workspace-browser-pane';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createRef } from 'react';
import { expect, it, vi } from 'vitest';
import type { BrowserPaneApi } from '../browserPaneApi';

const intake = vi.hoisted(() => vi.fn());
vi.mock('../useBrowserArtifactIntake', () => ({
  useBrowserArtifactIntake: () => intake,
}));
vi.mock('../BrowserAnnotation', () => ({
  BrowserAnnotation: (props: {
    onAttach(value: unknown): void;
    onCancel(): void;
  }) => (
    <>
      <button
        type="button"
        onClick={() =>
          props.onAttach({
            picked: null,
            marks: [
              {
                kind: 'box',
                points: [
                  { x: 0, y: 0 },
                  { x: 1, y: 1 },
                ],
              },
            ],
          })
        }
      >
        Attach
      </button>
      <button type="button" onClick={props.onCancel}>
        Cancel
      </button>
    </>
  ),
}));

import { BrowserAnnotationFlow } from '../BrowserAnnotationFlow';

it('invalidates a pending handoff when the annotation is cancelled', async () => {
  let finish!: (value: Blob) => void;
  const screenshot = vi.fn(
    () =>
      new Promise<Blob>((resolve) => {
        finish = resolve;
      }),
  );
  const delivered = vi.fn();
  intake.mockImplementation((isCurrent: () => boolean) => async () => {
    if (isCurrent()) delivered();
  });
  const record = {
    browserSessionId: 'bs_test',
    generation: 1,
    url: 'https://example.test/',
    state: 'live',
    viewport: { width: 800, height: 600, deviceScaleFactor: 1 },
  } as BrowserSessionView;
  const api = {
    screenshot,
    sessionSummary: vi.fn().mockResolvedValue(record),
  } as unknown as BrowserPaneApi;
  const close = vi.fn();
  render(
    <BrowserAnnotationFlow
      stageRef={createRef<HTMLDivElement>()}
      record={record}
      api={api}
      onClose={close}
      onError={vi.fn()}
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Attach' }));
  expect(screenshot).toHaveBeenCalledOnce();
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  finish(new Blob(['image'], { type: 'image/png' }));
  await waitFor(() => expect(api.sessionSummary).toHaveBeenCalledOnce());
  expect(delivered).not.toHaveBeenCalled();
  expect(close).toHaveBeenCalledOnce();
});

it('hands the image and its structured viewport marks to the same conversation intake', async () => {
  const bytes = new Uint8Array([1, 2, 3]);
  const blob = new Blob([bytes], { type: 'image/png' });
  Object.defineProperty(blob, 'arrayBuffer', {
    value: async () => bytes.buffer,
  });
  const accepted = vi.fn();
  intake.mockImplementation(
    (isCurrent: () => boolean) => async (files: File[]) => {
      expect(isCurrent()).toBe(true);
      accepted(files);
    },
  );
  const record = {
    browserSessionId: 'bs_test',
    generation: 1,
    url: 'https://example.test/',
    state: 'live',
    viewport: { width: 800, height: 600, deviceScaleFactor: 1 },
  } as BrowserSessionView;
  const api = {
    screenshot: vi.fn().mockResolvedValue(blob),
    sessionSummary: vi.fn().mockResolvedValue(record),
  } as unknown as BrowserPaneApi;
  const close = vi.fn();
  render(
    <BrowserAnnotationFlow
      stageRef={createRef<HTMLDivElement>()}
      record={record}
      api={api}
      onClose={close}
      onError={vi.fn()}
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Attach' }));
  await waitFor(() => expect(accepted).toHaveBeenCalledOnce());
  const files = accepted.mock.calls[0]![0] as File[];
  expect(files.map((file) => file.name)).toEqual([
    'browser-annotation.png',
    'browser-annotation.json',
  ]);
  const text = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsText(files[1]!);
  });
  expect(JSON.parse(text)).toMatchObject({
    browserSessionId: 'bs_test',
    generation: 1,
    imageKind: 'target-viewport-screenshot',
    marks: [
      {
        kind: 'box',
        points: [
          { x: 0, y: 0 },
          { x: 1, y: 1 },
        ],
      },
    ],
  });
  expect(close).toHaveBeenCalledOnce();
});
