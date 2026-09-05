// @vitest-environment jsdom
import { afterEach, expect, test, vi } from 'vitest';
import {
  publishPeerPresence,
  readLiveCommandFailureState,
} from '../interactive-workspace-playwright-adapter.mjs';

afterEach(() => {
  document.body.innerHTML = '';
  vi.restoreAllMocks();
  vi.useRealTimers();
});

test('observes closed failure state without copying page text or actor identities', async () => {
  document.body.innerHTML = `<section data-station-performance-surface="task-room-presence" data-viewer-actor-id="private-actor"><header><p role="status">Live room connected.</p></header><button>Join room</button><button disabled>Announce work</button></section><div role="dialog" aria-labelledby="title"><h2 id="title">What Station sends</h2><p>private page content</p></div>`;
  vi.spyOn(Element.prototype, 'getClientRects').mockReturnValue([
    {},
  ] as unknown as DOMRectList);
  const result = await readLiveCommandFailureState({
    evaluate: async (read: () => unknown) => read(),
  });
  expect(result).toEqual({
    stream: 'LIVE',
    join: 'ENABLED',
    announce: 'DISABLED',
    dialog: 'VISIBLE',
    telemetry: 'VISIBLE',
  });
  expect(JSON.stringify(result)).not.toContain('private');
});

test('discards unknown browser values instead of including them in the diagnostic', async () => {
  const result = await readLiveCommandFailureState({
    evaluate: async () => ({
      stream: 'private content',
      join: {},
      announce: 'secret',
      dialog: 'secret',
      telemetry: 'secret',
      credential: 'secret',
    }),
  });
  expect(result).toEqual({
    stream: 'UNKNOWN',
    join: 'UNKNOWN',
    announce: 'UNKNOWN',
    dialog: 'UNKNOWN',
    telemetry: 'UNKNOWN',
  });
});

test('bounds a hung diagnostic and owns a later page teardown rejection', async () => {
  vi.useFakeTimers();
  let reject!: (error: Error) => void;
  const pending = new Promise((_, rejectRead) => {
    reject = rejectRead;
  });
  // A plain response function avoids mock promise tracking hiding rejections.
  const result = readLiveCommandFailureState({ evaluate: () => pending });
  await vi.advanceTimersByTimeAsync(500);
  expect(await result).toMatchObject({ stream: 'UNKNOWN' });
  reject(new Error('private teardown text'));
  await Promise.resolve();
});

test('failure diagnostics cannot replace the actual command input cause', async () => {
  const primary = new Error('private original input failure');
  primary.name = 'TimeoutError';
  const peer = {
    url: () => 'http://fixture.invalid/tasks/task-one',
    waitForFunction: async () => ({
      jsonValue: async () => 'private-actor',
      dispose: async () => {},
    }),
    getByRole: () => ({
      isEnabled: async () => false,
      waitFor: async () => {},
      click: async () => {
        throw primary;
      },
    }),
    waitForResponse: () =>
      Promise.reject(new Error('secondary response teardown')),
    evaluate: () => Promise.reject(new Error('diagnostic page unavailable')),
  };
  const failure = await publishPeerPresence(
    peer,
    {},
    3,
    peer.url(),
    'task-one',
  ).catch((error: unknown) => error);
  expect(failure).toMatchObject({ cause: { cause: primary } });
  expect((failure as Error).message).toBe(
    'Collaboration presence join failed: Live command join input TIMEOUT; iteration=3; joinOutcome=NOT_OBSERVED; stream=UNKNOWN; join=UNKNOWN; announce=UNKNOWN; dialog=UNKNOWN; telemetry=UNKNOWN',
  );
  expect((failure as Error).message).not.toContain('private');
});
