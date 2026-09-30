import type { LiveSurfaceFrameHeader } from '@kontourai/station-contracts/live-surface';
import { describe, expect, test, vi } from 'vitest';
import type { CdpTransport } from '../browser-host.js';
import { CdpProtocolError } from '../cdp-pipe-transport.js';
import {
  ChromiumScreencastDialogPendingError,
  ChromiumScreencastDispatchTimeoutError,
  ChromiumScreencastProducer,
  PENDING_DIALOG_TEXT_MAX,
  screencastDeviceScaleFactor,
} from '../chromium-screencast-producer.js';

const SESSION = 'page-session-1';

/** A minimal JPEG: SOI, an APP0 segment, then SOF0 carrying the size. */
function jpeg(width: number, height: number): Uint8Array {
  return new Uint8Array([
    0xff,
    0xd8,
    // APP0 (length 16)
    0xff,
    0xe0,
    0x00,
    0x10,
    0x4a,
    0x46,
    0x49,
    0x46,
    0x00,
    0x01,
    0x01,
    0x00,
    0x00,
    0x01,
    0x00,
    0x01,
    0x00,
    0x00,
    // SOF0 (length 11): precision, height, width, components
    0xff,
    0xc0,
    0x00,
    0x0b,
    0x08,
    height >> 8,
    height & 0xff,
    width >> 8,
    width & 0xff,
    0x01,
    0x01,
  ]);
}

interface Call {
  method: string;
  params?: Record<string, unknown>;
  sessionId?: string;
}

function fakeCdp(
  respond: (call: Call) => Promise<unknown> | unknown = () => ({}),
) {
  const calls: Call[] = [];
  const listeners = new Map<string, Set<(p: unknown, s?: string) => void>>();
  const cdp: CdpTransport = {
    async send<R>(method: string, params?: object, sessionId?: string) {
      const call = {
        method,
        params: params as Record<string, unknown> | undefined,
        sessionId,
      };
      calls.push(call);
      return (await respond(call)) as R;
    },
    on(event, fn) {
      const set = listeners.get(event) ?? new Set();
      set.add(fn);
      listeners.set(event, set);
      return () => set.delete(fn);
    },
    close: async () => {},
    closed: new Promise(() => {}),
  };
  const emit = (event: string, params: unknown, sessionId = SESSION) => {
    for (const fn of listeners.get(event) ?? []) fn(params, sessionId);
  };
  const listenerCount = (event: string) => listeners.get(event)?.size ?? 0;
  return { cdp, calls, emit, listenerCount };
}

const PARAMS = { maxFps: 10, quality: 60, maxWidth: 640, maxHeight: 400 };
const frameEvent = (
  image: Uint8Array,
  deviceWidth: number,
  sessionId = 7,
  timestamp = 1_700_000_000.5,
  pageScaleFactor = 1,
) => ({
  data: Buffer.from(image).toString('base64'),
  sessionId,
  metadata: { deviceWidth, deviceHeight: 800, timestamp, pageScaleFactor },
});

function producer(
  fake = fakeCdp(),
  extra: Partial<
    ConstructorParameters<typeof ChromiumScreencastProducer>[0]
  > = {},
) {
  return {
    fake,
    producer: new ChromiumScreencastProducer({
      surfaceId: 'browser:abc:g1',
      cdp: fake.cdp,
      cdpSessionId: SESSION,
      ...extra,
    }),
  };
}

describe('device scale factor', () => {
  test('image px per CSS px, bounded to the wire range', () => {
    expect(screencastDeviceScaleFactor(640, 1280)).toBe(0.5);
    expect(screencastDeviceScaleFactor(2560, 1280)).toBe(2);
    expect(screencastDeviceScaleFactor(640, 0)).toBeUndefined();
    expect(screencastDeviceScaleFactor(640, undefined)).toBeUndefined();
    expect(screencastDeviceScaleFactor(64_000, 1)).toBeUndefined();
  });

  test("the page's own zoom is folded in: surface px are LAYOUT CSS px (D1)", () => {
    // Phone 393 DIP wide, a page with no meta viewport laid out at 980 CSS
    // px and shown zoomed out (pageScaleFactor 393/980): 1179 image px span
    // 980 CSS px.
    expect(screencastDeviceScaleFactor(1179, 393, 393 / 980)).toBeCloseTo(
      1179 / 980,
      10,
    );
    expect(screencastDeviceScaleFactor(640, 1280, 0)).toBeUndefined();
  });
});

describe('ChromiumScreencastProducer frames', () => {
  test('starts a jpeg screencast with the stream params on its own session', async () => {
    const { fake, producer: p } = producer();
    await p.start(PARAMS, () => {});
    expect(fake.calls.at(-1)).toEqual({
      method: 'Page.startScreencast',
      params: {
        format: 'jpeg',
        quality: 60,
        maxWidth: 640,
        maxHeight: 400,
        everyNthFrame: 1,
      },
      sessionId: SESSION,
    });
  });

  test('maps each frame to a header whose DSF is image px per surface px, and acks with the frame id', async () => {
    const { fake, producer: p } = producer();
    const frames: { header: LiveSurfaceFrameHeader; body: Uint8Array }[] = [];
    await p.start(PARAMS, (header, body) => frames.push({ header, body }));
    // A 1280 CSS px page captured into a 640 px image: DSF 0.5.
    fake.emit('Page.screencastFrame', frameEvent(jpeg(640, 400), 1280, 41));
    // Another session's frame is not ours.
    fake.emit(
      'Page.screencastFrame',
      frameEvent(jpeg(640, 400), 1280, 42),
      'other',
    );
    expect(frames).toHaveLength(1);
    expect(frames[0]!.header).toEqual({
      surfaceId: 'browser:abc:g1',
      seq: 1,
      epoch: 0,
      codec: 'jpeg',
      width: 640,
      height: 400,
      deviceScaleFactor: 0.5,
      capturedAt: 1_700_000_000_500,
    });
    expect([...frames[0]!.body]).toEqual([...jpeg(640, 400)]);
    expect(
      fake.calls.some((call) => call.method === 'Page.screencastFrameAck'),
    ).toBe(false);
    p.ack(1);
    expect(fake.calls.at(-1)).toEqual({
      method: 'Page.screencastFrameAck',
      params: { sessionId: 41 },
      sessionId: SESSION,
    });
    // Acking twice sends nothing more.
    const before = fake.calls.length;
    p.ack(1);
    expect(fake.calls.length).toBe(before);
    // A hi-DPI capture (2x) reports DSF 2.
    fake.emit('Page.screencastFrame', frameEvent(jpeg(2560, 1600), 1280, 43));
    expect(frames[1]!.header).toMatchObject({ seq: 2, deviceScaleFactor: 2 });
    // A zoomed-out mobile page: the header maps image px to LAYOUT CSS px.
    fake.emit(
      'Page.screencastFrame',
      frameEvent(jpeg(1179, 2556), 393, 44, 1_700_000_001, 0.4),
    );
    expect(frames[2]!.header.deviceScaleFactor).toBeCloseTo(
      (1179 / 393) * 0.4,
      10,
    );
  });

  test('an unreadable frame is dropped but still acked so the screencast keeps going', async () => {
    const { fake, producer: p } = producer();
    const onFrame = vi.fn();
    await p.start(PARAMS, onFrame);
    fake.emit(
      'Page.screencastFrame',
      frameEvent(new Uint8Array([1, 2, 3, 4]), 1280, 9),
    );
    expect(onFrame).not.toHaveBeenCalled();
    expect(fake.calls.at(-1)).toMatchObject({
      method: 'Page.screencastFrameAck',
      params: { sessionId: 9 },
    });
  });

  test('stop ends the screencast and later frames are ignored', async () => {
    const { fake, producer: p } = producer();
    const onFrame = vi.fn();
    await p.start(PARAMS, onFrame);
    await p.stop();
    expect(fake.calls.at(-1)?.method).toBe('Page.stopScreencast');
    fake.emit('Page.screencastFrame', frameEvent(jpeg(640, 400), 1280));
    expect(onFrame).not.toHaveBeenCalled();
  });
});

describe('ChromiumScreencastProducer input', () => {
  const sent = (fake: ReturnType<typeof fakeCdp>) =>
    fake.calls.map(({ method, params }) => ({ method, params }));

  test('an input kind the producer does not declare is refused, never read as a pointer', async () => {
    const { fake, producer: p } = producer();
    expect(p.capabilities.input).not.toContain('button');
    // A kind a later producer adds (the Device pane's hardware buttons)
    // carries `type` like a pointer does; it must not fall through to one.
    const deviceButton = {
      kind: 'button',
      type: 'down',
      x: 5,
      y: 5,
    } as unknown as Parameters<typeof p.dispatch>[0];
    await expect(p.dispatch(deviceButton)).rejects.toThrow(
      /does not take button input/,
    );
    expect(sent(fake)).toEqual([]);
  });

  test('mouse down/move/up map to dispatchMouseEvent with buttons and modifiers', async () => {
    const { fake, producer: p } = producer();
    await p.dispatch({
      kind: 'pointer',
      type: 'down',
      x: 10,
      y: 20,
      button: 'left',
      clickCount: 1,
      modifiers: { shift: true, ctrl: true },
    });
    await p.dispatch({ kind: 'pointer', type: 'move', x: 11, y: 21 });
    await p.dispatch({
      kind: 'pointer',
      type: 'up',
      x: 11,
      y: 21,
      button: 'left',
      clickCount: 1,
    });
    expect(sent(fake)).toEqual([
      {
        method: 'Input.dispatchMouseEvent',
        params: {
          type: 'mousePressed',
          x: 10,
          y: 20,
          button: 'left',
          buttons: 1,
          clickCount: 1,
          modifiers: 10,
        },
      },
      {
        method: 'Input.dispatchMouseEvent',
        params: {
          type: 'mouseMoved',
          x: 11,
          y: 21,
          button: 'none',
          buttons: 1,
          clickCount: 0,
          modifiers: 0,
        },
      },
      {
        method: 'Input.dispatchMouseEvent',
        params: {
          type: 'mouseReleased',
          x: 11,
          y: 21,
          button: 'left',
          buttons: 0,
          clickCount: 1,
          modifiers: 0,
        },
      },
    ]);
    expect(fake.calls.every((call) => call.sessionId === SESSION)).toBe(true);
  });

  test('wheel maps to mouseWheel with its deltas', async () => {
    const { fake, producer: p } = producer();
    await p.dispatch({
      kind: 'pointer',
      type: 'wheel',
      x: 5,
      y: 6,
      deltaX: 0,
      deltaY: 120,
    });
    expect(sent(fake)).toEqual([
      {
        method: 'Input.dispatchMouseEvent',
        params: {
          type: 'mouseWheel',
          x: 5,
          y: 6,
          deltaX: 0,
          deltaY: 120,
          modifiers: 0,
          buttons: 0,
        },
      },
    ]);
  });

  test('touch maps to dispatchTouchEvent start/move/end', async () => {
    const { fake, producer: p } = producer();
    const touch = (type: 'down' | 'move' | 'up', x: number) =>
      p.dispatch({
        kind: 'pointer',
        type,
        x,
        y: 3,
        button: 'left',
        pointerType: 'touch',
      });
    await touch('move', 1); // no active touch: nothing sent
    await touch('down', 1);
    await touch('move', 2);
    await touch('up', 2);
    expect(sent(fake)).toEqual([
      {
        method: 'Input.dispatchTouchEvent',
        params: {
          type: 'touchStart',
          touchPoints: [{ x: 1, y: 3, id: 0 }],
          modifiers: 0,
        },
      },
      {
        method: 'Input.dispatchTouchEvent',
        params: {
          type: 'touchMove',
          touchPoints: [{ x: 2, y: 3, id: 0 }],
          modifiers: 0,
        },
      },
      {
        method: 'Input.dispatchTouchEvent',
        params: { type: 'touchEnd', touchPoints: [], modifiers: 0 },
      },
    ]);
  });

  test('keys carry their virtual key code; Enter carries its text; never commands', async () => {
    const { fake, producer: p } = producer();
    await p.dispatch({
      kind: 'key',
      type: 'down',
      key: 'Enter',
      code: 'Enter',
    });
    await p.dispatch({ kind: 'key', type: 'up', key: 'Enter', code: 'Enter' });
    await p.dispatch({
      kind: 'key',
      type: 'down',
      key: 'a',
      code: 'KeyA',
      modifiers: { meta: true },
    });
    expect(sent(fake)).toEqual([
      {
        method: 'Input.dispatchKeyEvent',
        params: {
          type: 'keyDown',
          key: 'Enter',
          code: 'Enter',
          modifiers: 0,
          windowsVirtualKeyCode: 13,
          nativeVirtualKeyCode: 13,
          text: '\r',
          unmodifiedText: '\r',
        },
      },
      {
        method: 'Input.dispatchKeyEvent',
        params: {
          type: 'keyUp',
          key: 'Enter',
          code: 'Enter',
          modifiers: 0,
          windowsVirtualKeyCode: 13,
          nativeVirtualKeyCode: 13,
        },
      },
      {
        method: 'Input.dispatchKeyEvent',
        params: {
          type: 'rawKeyDown',
          key: 'a',
          code: 'KeyA',
          modifiers: 4,
          windowsVirtualKeyCode: 65,
          nativeVirtualKeyCode: 65,
        },
      },
    ]);
    expect(fake.calls.some((call) => call.params?.commands !== undefined)).toBe(
      false,
    );
  });

  test('a letter key reports the virtual key of the letter it typed (AZERTY)', async () => {
    const { fake, producer: p } = producer();
    // AZERTY: the physical KeyQ position types "a".
    await p.dispatch({
      kind: 'key',
      type: 'down',
      key: 'a',
      code: 'KeyQ',
      modifiers: { ctrl: true },
    });
    expect(fake.calls[0]?.params).toMatchObject({
      windowsVirtualKeyCode: 65,
      nativeVirtualKeyCode: 65,
    });
  });

  test('text maps to insertText', async () => {
    const { fake, producer: p } = producer();
    await p.dispatch({ kind: 'text', text: 'héllo' });
    expect(sent(fake)).toEqual([
      { method: 'Input.insertText', params: { text: 'héllo' } },
    ]);
  });

  test('a dispatch that never settles is refused after its own timeout', async () => {
    vi.useFakeTimers();
    try {
      const { producer: p } = producer(
        fakeCdp(() => new Promise(() => {})),
        { dispatchTimeoutMs: 250 },
      );
      const pending = p.dispatch({ kind: 'text', text: 'x' });
      const outcome = pending.then(
        () => 'resolved',
        (error: unknown) => error,
      );
      await vi.advanceTimersByTimeAsync(249);
      let settled = false;
      void outcome.then(() => {
        settled = true;
      });
      await Promise.resolve();
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      const error = await outcome;
      expect(error).toBeInstanceOf(ChromiumScreencastDispatchTimeoutError);
      expect((error as Error).message).toBe(
        'Input.insertText did not settle in time',
      );
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('ChromiumScreencastProducer held-input cancel', () => {
  test('a held touch is cancelled with touchCancel, never a touchEnd tap', async () => {
    const { fake, producer: p } = producer();
    await p.dispatch({
      kind: 'pointer',
      type: 'down',
      x: 4,
      y: 4,
      button: 'left',
      pointerType: 'touch',
    });
    fake.calls.length = 0;
    await p.cancelHeldInput({
      buttons: ['left'],
      keys: [],
      pointer: { x: 4, y: 4 },
      pointerType: 'touch',
      buttonPointerTypes: { left: 'touch' },
    });
    expect(
      fake.calls.map(({ method, params }) => ({ method, params })),
    ).toEqual([
      {
        method: 'Input.dispatchTouchEvent',
        params: { type: 'touchCancel', touchPoints: [] },
      },
    ]);
  });

  test('a held mouse button moves off the page before releasing, then keys go up', async () => {
    const { fake, producer: p } = producer();
    await p.dispatch({
      kind: 'pointer',
      type: 'down',
      x: 50,
      y: 60,
      button: 'left',
      clickCount: 1,
    });
    fake.calls.length = 0;
    await p.cancelHeldInput({
      buttons: ['left'],
      keys: [{ key: 'Shift', code: 'ShiftLeft' }],
      pointer: { x: 50, y: 60 },
      pointerType: 'mouse',
      buttonPointerTypes: { left: 'mouse' },
    });
    expect(
      fake.calls.map(({ method, params }) => ({ method, params })),
    ).toEqual([
      {
        method: 'Input.dispatchMouseEvent',
        params: {
          type: 'mouseMoved',
          x: -1,
          y: -1,
          button: 'none',
          buttons: 1,
        },
      },
      {
        method: 'Input.dispatchMouseEvent',
        params: {
          type: 'mouseReleased',
          x: -1,
          y: -1,
          button: 'left',
          buttons: 0,
          clickCount: 1,
        },
      },
      {
        method: 'Input.dispatchKeyEvent',
        params: {
          type: 'keyUp',
          key: 'Shift',
          code: 'ShiftLeft',
          modifiers: 0,
          windowsVirtualKeyCode: 16,
          nativeVirtualKeyCode: 16,
        },
      },
    ]);
  });
});

describe('ChromiumScreencastProducer JavaScript dialogs', () => {
  test('an alert is dismissed at once, even with no stream running, and reported', async () => {
    const onDialog = vi.fn();
    const { fake } = producer(fakeCdp(), { onDialog });
    fake.emit('Page.javascriptDialogOpening', {
      type: 'alert',
      message: 'hello from the page',
      url: 'http://127.0.0.1:5173/',
    });
    expect(fake.calls).toEqual([
      {
        method: 'Page.handleJavaScriptDialog',
        params: { accept: false },
        sessionId: SESSION,
      },
    ]);
    expect(onDialog).toHaveBeenCalledWith({
      type: 'alert',
      message: 'hello from the page',
      url: 'http://127.0.0.1:5173/',
      accepted: false,
    });
  });

  test('beforeunload is accepted so a requested navigation is not silently cancelled', () => {
    const { fake } = producer();
    fake.emit('Page.javascriptDialogOpening', {
      type: 'beforeunload',
      message: '',
    });
    expect(fake.calls[0]).toMatchObject({
      method: 'Page.handleJavaScriptDialog',
      params: { accept: true },
    });
  });

  test("another session's dialog is not answered, and dispose stops listening", () => {
    const { fake, producer: p } = producer();
    fake.emit('Page.javascriptDialogOpening', { type: 'alert' }, 'other');
    expect(fake.calls).toEqual([]);
    p.dispose();
    expect(fake.listenerCount('Page.javascriptDialogOpening')).toBe(0);
    fake.emit('Page.javascriptDialogOpening', { type: 'alert' });
    expect(fake.calls).toEqual([]);
  });
});

describe('ChromiumScreencastProducer dialogs held for a person', () => {
  /** A CDP whose input calls stay pending until `release()` (a modal page). */
  function modalCdp() {
    let release: () => void = () => {};
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fake = fakeCdp((call) =>
      call.method.startsWith('Input.') ? blocked.then(() => ({})) : {},
    );
    return { fake, release: () => release() };
  }

  test('a confirm opened while a person holds control waits for them: nothing is answered, and it is reported pending', () => {
    const onDialog = vi.fn();
    const onPendingDialogChange = vi.fn();
    const { fake, producer: p } = producer(fakeCdp(), {
      onDialog,
      onPendingDialogChange,
      holdDialog: () => true,
    });
    fake.emit('Page.javascriptDialogOpening', {
      type: 'confirm',
      message: 'Delete the draft?',
      url: 'http://127.0.0.1:5173/',
    });
    expect(fake.calls).toEqual([]);
    expect(onDialog).not.toHaveBeenCalled();
    expect(p.pendingDialog()).toMatchObject({
      dialogId: 'd1',
      type: 'confirm',
      message: 'Delete the draft?',
    });
    expect(onPendingDialogChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ dialogId: 'd1', type: 'confirm' }),
    );
  });

  test("the person's answer is sent as given — a prompt with its text — and a second answer is refused", async () => {
    const { fake, producer: p } = producer(fakeCdp(), {
      holdDialog: () => true,
    });
    fake.emit('Page.javascriptDialogOpening', {
      type: 'prompt',
      message: 'Your name?',
      defaultPrompt: 'Ada',
    });
    expect(p.pendingDialog()).toMatchObject({ defaultPrompt: 'Ada' });
    expect(await p.answerDialog('d7', { accept: true })).toEqual({
      ok: false,
      code: 'no-dialog',
    });
    expect(
      await p.answerDialog('d1', { accept: true, promptText: 'Grace' }),
    ).toMatchObject({ ok: true, dialog: { type: 'prompt' } });
    expect(fake.calls).toEqual([
      {
        method: 'Page.handleJavaScriptDialog',
        params: { accept: true, promptText: 'Grace' },
        sessionId: SESSION,
      },
    ]);
    expect(p.pendingDialog()).toBeNull();
    expect(await p.answerDialog('d1', { accept: false })).toEqual({
      ok: false,
      code: 'no-dialog',
    });
  });

  test('a dismissed prompt sends no text, and an alert is never sent prompt text', async () => {
    const { fake, producer: p } = producer(fakeCdp(), {
      holdDialog: () => true,
    });
    fake.emit('Page.javascriptDialogOpening', { type: 'prompt', message: '' });
    await p.answerDialog('d1', { accept: false, promptText: 'ignored' });
    fake.emit('Page.javascriptDialogOpening', { type: 'alert', message: '' });
    await p.answerDialog('d2', { accept: true, promptText: 'ignored' });
    expect(fake.calls.map((call) => call.params)).toEqual([
      { accept: false },
      { accept: true },
    ]);
  });

  test('the input that opened a held dialog settles at once instead of waiting on the person', async () => {
    const modal = modalCdp();
    const { fake, producer: p } = producer(modal.fake, {
      holdDialog: () => true,
      dispatchTimeoutMs: 60_000,
    });
    const click = p.dispatch({
      kind: 'pointer',
      type: 'up',
      x: 5,
      y: 5,
      button: 'left',
    });
    let settled = false;
    void click.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    fake.emit('Page.javascriptDialogOpening', { type: 'alert', message: 'hi' });
    await click;
    expect(settled).toBe(true);
    modal.release();
  });

  test('while a dialog waits, input that would act is refused and a hover is dropped (neither reaches CDP)', async () => {
    const { fake, producer: p } = producer(fakeCdp(), {
      holdDialog: () => true,
    });
    fake.emit('Page.javascriptDialogOpening', { type: 'confirm' });
    await expect(
      p.dispatch({ kind: 'text', text: 'typed' }),
    ).rejects.toBeInstanceOf(ChromiumScreencastDialogPendingError);
    await expect(
      p.dispatch({
        kind: 'pointer',
        type: 'down',
        x: 1,
        y: 1,
        button: 'left',
      }),
    ).rejects.toBeInstanceOf(ChromiumScreencastDialogPendingError);
    await p.dispatch({ kind: 'pointer', type: 'move', x: 1, y: 1 });
    expect(fake.calls).toEqual([]);
  });

  test('a held dialog nobody answers is dismissed automatically after the hold, and reported as unanswered', () => {
    vi.useFakeTimers();
    try {
      const onDialog = vi.fn();
      const onPendingDialogChange = vi.fn();
      const { fake, producer: p } = producer(fakeCdp(), {
        onDialog,
        onPendingDialogChange,
        holdDialog: () => true,
        dialogHoldMs: 1_000,
      });
      fake.emit('Page.javascriptDialogOpening', {
        type: 'confirm',
        message: 'Leave?',
      });
      vi.advanceTimersByTime(999);
      expect(fake.calls).toEqual([]);
      vi.advanceTimersByTime(1);
      expect(fake.calls).toEqual([
        {
          method: 'Page.handleJavaScriptDialog',
          params: { accept: false },
          sessionId: SESSION,
        },
      ]);
      expect(onDialog).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'confirm',
          accepted: false,
          unanswered: true,
        }),
      );
      expect(p.pendingDialog()).toBeNull();
      expect(onPendingDialogChange).toHaveBeenLastCalledWith(null);
    } finally {
      vi.useRealTimers();
    }
  });

  test('a held dialog the page closes itself (it navigated away) is no longer pending', () => {
    const { fake, producer: p } = producer(fakeCdp(), {
      holdDialog: () => true,
    });
    fake.emit('Page.javascriptDialogOpening', { type: 'alert' });
    fake.emit('Page.javascriptDialogClosed', { result: false }, 'other');
    expect(p.pendingDialog()).not.toBeNull();
    fake.emit('Page.javascriptDialogClosed', { result: false });
    expect(p.pendingDialog()).toBeNull();
  });

  test('beforeunload is never held, whoever is in control', () => {
    const holdDialog = vi.fn(() => true);
    const { fake, producer: p } = producer(fakeCdp(), { holdDialog });
    fake.emit('Page.javascriptDialogOpening', { type: 'beforeunload' });
    expect(holdDialog).not.toHaveBeenCalled();
    expect(p.pendingDialog()).toBeNull();
    expect(fake.calls[0]).toMatchObject({ params: { accept: true } });
  });

  test('with no person in control the dialog is answered at once, as before', () => {
    const { fake, producer: p } = producer(fakeCdp(), {
      holdDialog: () => false,
    });
    fake.emit('Page.javascriptDialogOpening', { type: 'confirm' });
    expect(p.pendingDialog()).toBeNull();
    expect(fake.calls[0]).toMatchObject({
      method: 'Page.handleJavaScriptDialog',
      params: { accept: false },
    });
  });

  test("a held dialog's text is bounded", () => {
    const { fake, producer: p } = producer(fakeCdp(), {
      holdDialog: () => true,
    });
    fake.emit('Page.javascriptDialogOpening', {
      type: 'prompt',
      message: 'm'.repeat(PENDING_DIALOG_TEXT_MAX + 50),
      defaultPrompt: 'p'.repeat(PENDING_DIALOG_TEXT_MAX + 50),
    });
    expect(p.pendingDialog()?.message).toHaveLength(PENDING_DIALOG_TEXT_MAX);
    expect(p.pendingDialog()?.defaultPrompt).toHaveLength(
      PENDING_DIALOG_TEXT_MAX,
    );
  });
});

describe("ChromiumScreencastProducer: a person's answer that does not land", () => {
  /** A CDP whose dialog answers never settle (the browser is stuck). */
  const stuckAnswers = () =>
    fakeCdp((call) =>
      call.method === 'Page.handleJavaScriptDialog'
        ? new Promise(() => {})
        : {},
    );

  test('the hold timer that would have fired during the answer is replaced: a fresh one still answers it automatically', async () => {
    vi.useFakeTimers();
    try {
      const onDialog = vi.fn();
      const { fake, producer: p } = producer(stuckAnswers(), {
        holdDialog: () => true,
        dialogHoldMs: 100,
        dispatchTimeoutMs: 200,
        onDialog,
      });
      fake.emit('Page.javascriptDialogOpening', {
        type: 'confirm',
        message: 'x',
      });
      const answer = p.answerDialog('d1', { accept: true });
      // The original hold (100 ms) elapses while the answer is in flight.
      await vi.advanceTimersByTimeAsync(200);
      expect(await answer).toEqual({ ok: false, code: 'page-busy' });
      // Still held, and still bounded: a fresh hold answers it.
      expect(p.pendingDialog()).toMatchObject({ dialogId: 'd1' });
      expect(onDialog).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(100);
      expect(p.pendingDialog()).toBeNull();
      expect(onDialog).toHaveBeenCalledWith(
        expect.objectContaining({ unanswered: true }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  test('a dialog the page closes while the answer is in flight is not resurrected', async () => {
    vi.useFakeTimers();
    try {
      const { fake, producer: p } = producer(stuckAnswers(), {
        holdDialog: () => true,
        dispatchTimeoutMs: 200,
      });
      fake.emit('Page.javascriptDialogOpening', {
        type: 'alert',
        message: 'x',
      });
      const answer = p.answerDialog('d1', { accept: true });
      fake.emit('Page.javascriptDialogClosed', { result: true });
      await vi.advanceTimersByTimeAsync(200);
      expect(await answer).toEqual({ ok: false, code: 'page-busy' });
      expect(p.pendingDialog()).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  test('only Chromium\'s own "No dialog is showing" means there is nothing to answer; a channel failure keeps the dialog held', async () => {
    const noDialog = producer(
      fakeCdp((call) => {
        if (call.method === 'Page.handleJavaScriptDialog')
          throw new CdpProtocolError(
            'Page.handleJavaScriptDialog',
            -32602,
            'No dialog is showing',
          );
        return {};
      }),
      { holdDialog: () => true },
    );
    noDialog.fake.emit('Page.javascriptDialogOpening', { type: 'alert' });
    expect(
      await noDialog.producer.answerDialog('d1', { accept: true }),
    ).toEqual({ ok: false, code: 'no-dialog' });
    expect(noDialog.producer.pendingDialog()).toBeNull();

    const broken = producer(
      fakeCdp((call) => {
        if (call.method === 'Page.handleJavaScriptDialog')
          throw new Error('CDP transport closed');
        return {};
      }),
      { holdDialog: () => true },
    );
    broken.fake.emit('Page.javascriptDialogOpening', { type: 'alert' });
    expect(await broken.producer.answerDialog('d1', { accept: true })).toEqual({
      ok: false,
      code: 'browser-error',
    });
    expect(broken.producer.pendingDialog()).toMatchObject({ dialogId: 'd1' });
  });
});
