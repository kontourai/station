import type { ChildProcess } from 'node:child_process';
import type { LiveSurfaceStreamParams } from '@kontourai/station-contracts/live-surface';
import { spawnOwnedChild } from '../infra/process-utils.js';
import { JpegStreamSplitter } from './device-frame-codecs.js';
import { locateExecutable, standardFfmpegDirs } from './device-host-tools.js';

/**
 * Server-side H.264 → JPEG decoding for Android device surfaces (#1970, D8).
 *
 * The hub gives Android video only as H.264 access units. Browsers could
 * decode that with WebCodecs, but a live surface is an image stream every
 * viewer (web, desktop, phone over the relay) can draw, so the server
 * decodes: a supervised `ffmpeg` child (registered in the orphan registry
 * through `spawnOwnedChild`, windows hidden) reads Annex-B on stdin and
 * writes concatenated JPEGs on stdout.
 *
 * ffmpeg is NOT shipped or downloaded here. An installed one is used; when
 * none is found the provider answers `decoder-unavailable`, the producer
 * falls back to polling screenshots, and says so. A consent-gated pinned
 * download (the D3 pattern) is a follow-up owned by the device toolchain
 * lane, not this one.
 */

export type DeviceVideoDecoderAvailability =
  | { available: true; path: string }
  | {
      available: false;
      reason: 'decoder-unavailable';
      /** What would make one available; the download is not implemented here. */
      remedy: 'install-ffmpeg-or-consent-to-pinned-download';
    };

export interface DeviceVideoDecoder {
  /**
   * Feed one Annex-B access unit. Never throws. Answers false when the unit
   * was DROPPED (the decoder is behind, or dead), so the caller can
   * resynchronize on a keyframe.
   */
  write(accessUnit: Uint8Array): boolean;
  close(): Promise<void>;
}

export interface DeviceVideoDecoderCallbacks {
  onImage(jpeg: Uint8Array): void;
  /** The decoder stopped on its own (not through `close`). */
  onExit(reason: string): void;
}

export interface DeviceVideoDecoderProvider {
  availability(): Promise<DeviceVideoDecoderAvailability>;
  create(
    path: string,
    params: LiveSurfaceStreamParams,
    callbacks: DeviceVideoDecoderCallbacks,
  ): DeviceVideoDecoder;
}

/** live-surface quality (10..100, higher is better) → mjpeg `-q:v` (31..2). */
export function mjpegQscale(quality: number): number {
  const clamped = Math.min(100, Math.max(10, quality));
  return Math.round(31 - ((clamped - 10) / 90) * 29);
}

/** The exact ffmpeg argument vector; only numbers from validated params vary. */
export function ffmpegDecodeArgs(params: LiveSurfaceStreamParams): string[] {
  const width = Math.floor(params.maxWidth);
  const height = Math.floor(params.maxHeight);
  return [
    '-hide_banner',
    '-loglevel',
    'error',
    '-nostdin',
    // NOT `-fflags nobuffer`: it discards packets (measured 40 in, 30 out,
    // even at end of input).
    '-flags',
    'low_delay',
    '-probesize',
    '32',
    '-analyzeduration',
    '0',
    // Single-threaded decode AND encode: frame threading holds one frame
    // per thread before it emits, which on a many-core host kept a dozen
    // frames of a live screen back (measured: 89 of 100 frames out before
    // stdin closed with default threads, 94 with these).
    '-threads',
    '1',
    '-f',
    'h264',
    '-i',
    'pipe:0',
    '-an',
    '-threads',
    '1',
    // Raw H.264 carries no timestamps; never let rate conversion hold
    // frames back to decide what to duplicate or drop.
    '-fps_mode',
    'passthrough',
    '-vf',
    // Never upscale; keep the aspect; even dimensions. Then convert to
    // full-range 4:2:0: emulators and screen encoders send LIMITED-range
    // yuv420p, which the mjpeg encoder refuses outright ("Non full-range
    // YUV is non-standard", zero images).
    `scale=w='min(${width},iw)':h='min(${height},ih)':force_original_aspect_ratio=decrease:force_divisible_by=2,format=yuvj420p`,
    '-c:v',
    'mjpeg',
    '-q:v',
    String(mjpegQscale(params.quality)),
    '-f',
    'image2pipe',
    '-flush_packets',
    '1',
    'pipe:1',
  ];
}

const MAX_BUFFERED_INPUT_BYTES = 4 * 1024 * 1024;

export function createFfmpegDecoderProvider(
  options: {
    locate?: () => Promise<string | null>;
    spawn?: (
      command: string,
      args: string[],
    ) => {
      proc: ChildProcess;
      release: () => void;
    };
  } = {},
): DeviceVideoDecoderProvider {
  const locate =
    options.locate ?? (() => locateExecutable('ffmpeg', standardFfmpegDirs()));
  const spawn =
    options.spawn ??
    ((command: string, args: string[]) =>
      spawnOwnedChild(command, args, { stdio: ['pipe', 'pipe', 'pipe'] }));
  return {
    async availability() {
      const path = await locate();
      return path
        ? { available: true, path }
        : {
            available: false,
            reason: 'decoder-unavailable',
            remedy: 'install-ffmpeg-or-consent-to-pinned-download',
          };
    },
    create(path, params, callbacks) {
      const { proc, release } = spawn(path, ffmpegDecodeArgs(params));
      const splitter = new JpegStreamSplitter();
      let closed = false;
      let exited = false;
      const exit = new Promise<void>((resolve) => {
        proc.once('exit', (code, signal) => {
          exited = true;
          release();
          resolve();
          if (!closed)
            callbacks.onExit(
              `ffmpeg exited (${signal ?? `code ${code ?? 'unknown'}`})`,
            );
        });
        proc.once('error', (error) => {
          if (exited) return;
          exited = true;
          release();
          resolve();
          if (!closed) callbacks.onExit(`ffmpeg failed: ${error.message}`);
        });
      });
      proc.stdout?.on('data', (chunk: Buffer) => {
        if (closed) return;
        try {
          for (const image of splitter.push(new Uint8Array(chunk)))
            callbacks.onImage(image);
        } catch {
          // A corrupt stream cannot resync reliably: stop, let the owner
          // restart or fall back.
          proc.kill('SIGKILL');
        }
      });
      proc.stderr?.resume();
      // A decoder that falls behind drops input rather than buffering it;
      // `write` reports the drop so the producer asks for a keyframe.
      proc.stdin?.on('error', () => {});
      return {
        write(accessUnit) {
          const stdin = proc.stdin;
          if (closed || exited || !stdin || stdin.destroyed) return false;
          if (stdin.writableLength > MAX_BUFFERED_INPUT_BYTES) return false;
          stdin.write(accessUnit);
          return true;
        },
        async close() {
          if (closed) return exit;
          closed = true;
          proc.stdin?.destroy();
          if (!exited) proc.kill('SIGTERM');
          const timer = setTimeout(() => {
            if (!exited) proc.kill('SIGKILL');
          }, 2_000);
          await exit;
          clearTimeout(timer);
        },
      };
    },
  };
}
