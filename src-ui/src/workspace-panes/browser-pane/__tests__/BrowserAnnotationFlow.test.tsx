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
