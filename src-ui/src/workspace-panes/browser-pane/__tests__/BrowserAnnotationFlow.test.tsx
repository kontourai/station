/** @vitest-environment jsdom */
import type { BrowserSessionView } from '@kontourai/station-contracts/workspace-browser-pane';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createRef } from 'react';
import { expect, it, vi } from 'vitest';
import type { BrowserPaneApi } from '../browserPaneApi';

const intake = vi.hoisted(() => vi.fn());
const pickedState = vi.hoisted(() => ({ value: null as unknown }));
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
            picked: pickedState.value,
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
    annotationScreenshot: async () => ({
      blob: await screenshot(),
      scroll: { x: 0, y: 0 },
    }),
    sessionSummary: vi.fn().mockResolvedValue(record),
  } as unknown as BrowserPaneApi;
  const close = vi.fn();
  render(
    <QueryClientProvider client={new QueryClient()}>
      <BrowserAnnotationFlow
        stageRef={createRef<HTMLDivElement>()}
        record={record}
        api={api}
        onClose={close}
        onError={vi.fn()}
      />
    </QueryClientProvider>,
  );
  await waitFor(() => expect(screenshot).toHaveBeenCalledOnce());
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
    annotationScreenshot: vi
      .fn()
      .mockResolvedValue({ blob, scroll: { x: 0, y: 0 } }),
    sessionSummary: vi.fn().mockResolvedValue(record),
  } as unknown as BrowserPaneApi;
  const close = vi.fn();
  render(
    <QueryClientProvider client={new QueryClient()}>
      <BrowserAnnotationFlow
        stageRef={createRef<HTMLDivElement>()}
        record={record}
        api={api}
        onClose={close}
        onError={vi.fn()}
      />
    </QueryClientProvider>,
  );
  fireEvent.click(await screen.findByRole('button', { name: 'Attach' }));
  await waitFor(() => expect(accepted).toHaveBeenCalledOnce());
  const files = accepted.mock.calls[0]![0] as File[];
  expect(files.map((file) => file.name)).toEqual([
    'browser-target-viewport-screenshot-1.png',
    'browser-annotation.json',
  ]);
  const text = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsText(files[1]!);
  });
  const json = JSON.parse(text);
  expect(json).not.toHaveProperty('url');
  expect(json).not.toHaveProperty('picked');
  expect(json).toMatchObject({
    browserSessionId: 'bs_test',
    generation: 1,
    coordinateSpace: 'viewport',
    untrustedPageContent: {
      url: 'https://example.test/',
      notice: expect.stringContaining('untrusted'),
    },
    images: [expect.objectContaining({ kind: 'target-viewport-screenshot' })],
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

it('captures the viewport before marking and includes it alongside an element crop', async () => {
  const bytes = new Uint8Array([1, 2, 3]);
  const original = Object.getOwnPropertyDescriptor(
    Blob.prototype,
    'arrayBuffer',
  );
  Object.defineProperty(Blob.prototype, 'arrayBuffer', {
    configurable: true,
    value: async () => bytes.buffer,
  });
  pickedState.value = {
    targetId: 'private-target',
    screenshot: 'AQID',
    rect: { x: 12, y: 20, width: 30, height: 40 },
    capturedAt: '2026-01-01T00:00:00.000Z',
    name: 'Example',
    selector: 'button',
    html: '<button>',
    styles: {},
    url: 'https://example.test/',
  };
  const accepted = vi.fn();
  intake.mockImplementation(() => async (files: File[]) => accepted(files));
  const record = {
    browserSessionId: 'bs_test',
    generation: 1,
    url: 'https://example.test/',
    state: 'live',
    viewport: { width: 800, height: 600, deviceScaleFactor: 1 },
  } as BrowserSessionView;
  const api = {
    annotationScreenshot: vi
      .fn()
      .mockResolvedValue({
        blob: new Blob([bytes], { type: 'image/png' }),
        scroll: { x: 0, y: 0 },
      }),
    sessionSummary: vi.fn().mockResolvedValue(record),
  } as unknown as BrowserPaneApi;
  render(
    <QueryClientProvider client={new QueryClient()}>
      <BrowserAnnotationFlow
        stageRef={createRef<HTMLDivElement>()}
        record={record}
        api={api}
        onClose={vi.fn()}
        onError={vi.fn()}
      />
    </QueryClientProvider>,
  );
  const attach = await screen.findByRole('button', { name: 'Attach' });
  expect(api.annotationScreenshot).toHaveBeenCalledOnce();
  fireEvent.click(attach);
  await waitFor(() => expect(accepted).toHaveBeenCalledOnce());
  const files = accepted.mock.calls[0]![0] as File[];
  expect(files.map((file) => file.name)).toEqual([
    'browser-target-viewport-screenshot-1.png',
    'browser-target-element-crop-2.png',
    'browser-annotation.json',
  ]);
  const text = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsText(files[2]!);
  });
  const json = JSON.parse(text);
  expect(json).not.toHaveProperty('url');
  expect(json).not.toHaveProperty('picked');
  expect(json).toMatchObject({
    coordinateSpace: 'viewport',
    cropOrigin: { x: 12, y: 20 },
    untrustedPageContent: {
      notice: expect.stringContaining('untrusted'),
      picked: { name: 'Example' },
    },
  });
  expect(text).not.toContain('private-target');
  pickedState.value = null;
  if (original) Object.defineProperty(Blob.prototype, 'arrayBuffer', original);
  else delete (Blob.prototype as { arrayBuffer?: unknown }).arrayBuffer;
});
