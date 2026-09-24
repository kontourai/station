import { EventEmitter } from 'node:events';
import { describe, expect, test, vi } from 'vitest';
import {
  androidRotateCommands,
  createDeviceHostActions,
  DeviceToolError,
  runBoundedToolCapture,
} from '../device-host-tools.js';
import {
  createFfmpegDecoderProvider,
  ffmpegDecodeArgs,
  mjpegQscale,
} from '../h264-jpeg-decoder.js';

type RunTool = NonNullable<
  NonNullable<Parameters<typeof createDeviceHostActions>[0]>['run']
>;

describe('Android rotation runs only whitelisted adb argument vectors', () => {
  test('the exact commands for an emulator', () => {
    expect(androidRotateCommands('emulator-5554', 'landscape-left')).toEqual([
      [
        '-s',
        'emulator-5554',
        'shell',
        'settings',
        'put',
        'system',
        'accelerometer_rotation',
        '1',
      ],
      [
        '-s',
        'emulator-5554',
        'shell',
        'cmd',
        'window',
        'user-rotation',
        'free',
      ],
      [
        '-s',
        'emulator-5554',
        'emu',
        'sensor',
        'set',
        'acceleration',
        '9.81:0:0',
      ],
    ]);
  });

  test.each([
    ['R58M123456', 'portrait'],
    ['emulator-5554; rm -rf /', 'portrait'],
    ['emulator-5554', 'sideways'],
    ['emulator-5554', 'toString'],
  ])('refuses serial %s / orientation %s', (serial, orientation) => {
    expect(() =>
      androidRotateCommands(serial, orientation as 'portrait'),
    ).toThrow(DeviceToolError);
  });

  test('runs each vector with no shell; an absent adb is tool-unavailable', async () => {
    const run = vi.fn<RunTool>(async () => {});
    const actions = createDeviceHostActions({
      locateAdb: async () => '/sdk/platform-tools/adb',
      run,
    });
    await actions.rotateAndroid('emulator-5554', 'portrait', 5_000);
    expect(run).toHaveBeenCalledTimes(3);
    expect(run.mock.calls[0]![0]).toBe('/sdk/platform-tools/adb');
    const missing = createDeviceHostActions({
      locateAdb: async () => null,
      run,
    });
    await expect(
      missing.rotateAndroid('emulator-5554', 'portrait', 5_000),
    ).rejects.toMatchObject({ code: 'tool-unavailable' });
  });
});

describe('the H.264 decoder', () => {
  test('no ffmpeg: decoder-unavailable, naming the consent-gated follow-up', async () => {
    const provider = createFfmpegDecoderProvider({ locate: async () => null });
    expect(await provider.availability()).toEqual({
      available: false,
      reason: 'decoder-unavailable',
      remedy: 'install-ffmpeg-or-consent-to-pinned-download',
    });
  });

  test('ffmpeg reads Annex-B on stdin and writes MJPEG images on stdout, never upscaling', () => {
    const args = ffmpegDecodeArgs({
      maxFps: 10,
      quality: 100,
      maxWidth: 720,
      maxHeight: 1280,
    });
    expect(args).toEqual(
      expect.arrayContaining(['-f', 'h264', '-i', 'pipe:0', 'pipe:1']),
    );
    expect(args[args.indexOf('-c:v') + 1]).toBe('mjpeg');
    expect(args[args.indexOf('-f', args.indexOf('-c:v')) + 1]).toBe(
      'image2pipe',
    );
    expect(args[args.indexOf('-vf') + 1]).toContain('min(720,iw)');
    // Review B1: limited-range yuv420p (what emulators send) must be turned
    // full-range before the mjpeg encoder, which refuses it on some ffmpeg
    // builds ("Non full-range YUV is non-standard"). This host's ffmpeg
    // 9.0.1 accepts it either way, so the real-decode test cannot catch a
    // regression here — this structural pin does.
    expect(args[args.indexOf('-vf') + 1]).toMatch(/,format=yuvj420p$/);
    // `-fflags nobuffer` discards packets (40 in, 30 out).
    expect(args).not.toContain('nobuffer');
    expect(mjpegQscale(100)).toBe(2);
    expect(mjpegQscale(10)).toBe(31);
  });
});

describe('runBoundedToolCapture (#1971): stdin, output and deadline', () => {
  /** A child that answers `stdout` and exits `code` on the next tick. */
  function fakeSpawn(stdout: string, code = 0) {
    const calls: { command: string; args: string[]; options: unknown }[] = [];
    const written: string[] = [];
    const spawnTool = ((command: string, args: string[], options: unknown) => {
      calls.push({ command, args, options });
      const child = new EventEmitter() as EventEmitter & {
        stdout: EventEmitter;
        stdin: { on: () => void; end: (text: string) => void } | null;
        kill: () => void;
      };
      child.stdout = Object.assign(new EventEmitter(), { destroy() {} });
      const stdio = (options as { stdio: string[] }).stdio;
      child.stdin =
        stdio[0] === 'pipe'
          ? { on: () => {}, end: (text) => written.push(text) }
          : null;
      child.kill = () => child.emit('close', null);
      setImmediate(() => {
        child.stdout.emit('data', Buffer.from(stdout));
        child.emit('close', code);
      });
      return child;
    }) as never;
    return { spawnTool, calls, written };
  }

  test('without a payload stdin is ignored (EOF, never an open pipe); no shell, hidden window', async () => {
    const fake = fakeSpawn('dark\n');
    await expect(
      runBoundedToolCapture(
        'xcrun',
        ['simctl', 'ui'],
        { timeoutMs: 1_000 },
        fake.spawnTool,
      ),
    ).resolves.toBe('dark\n');
    expect(fake.calls[0]!.options).toMatchObject({
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  });

  test('a payload is piped to stdin and closed', async () => {
    const fake = fakeSpawn('');
    await runBoundedToolCapture(
      'xcrun',
      ['simctl', 'push'],
      { timeoutMs: 1_000, stdin: '{"aps":{}}' },
      fake.spawnTool,
    );
    expect(fake.calls[0]!.options).toMatchObject({
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    expect(fake.written).toEqual(['{"aps":{}}']);
  });

  test('a non-zero exit and an over-long output are tool-failed', async () => {
    await expect(
      runBoundedToolCapture(
        'adb',
        [],
        { timeoutMs: 1_000 },
        fakeSpawn('', 1).spawnTool,
      ),
    ).rejects.toMatchObject({ code: 'tool-failed' });
    await expect(
      runBoundedToolCapture(
        'adb',
        [],
        { timeoutMs: 1_000, maxBuffer: 4 },
        fakeSpawn('0123456789').spawnTool,
      ),
    ).rejects.toMatchObject({ code: 'tool-failed' });
  });
});
