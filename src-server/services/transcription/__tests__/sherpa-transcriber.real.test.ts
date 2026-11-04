import { appendFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { createFfmpegDecoderProvider } from '../../devices/h264-jpeg-decoder.js';
import { runMediaProcess } from '../../media-tools/media-process.js';
import { MediaToolsAcquisition } from '../../media-tools/media-tools-acquisition.js';
import { SherpaTranscriber } from '../sherpa-transcriber.js';

const makeTempDir = trackTempDirs();

/** Explicit opt-in: real network, ~186 MB download, macOS say, and 610s of decoded audio. */
test(
  'real pinned downloads and local short/ten-minute transcription',
  async (context) => {
    if (
      process.env.STATION_REAL_SPEECH !== '1' ||
      process.platform !== 'darwin'
    ) {
      context.skip(
        'Requires macOS say and STATION_REAL_SPEECH=1 (consents to real downloads in a disposable home).',
      );
      return;
    }
    const home = makeTempDir('station-real-speech-');
    const record = async (data: unknown) => {
      const text = `${JSON.stringify(data)}\n`;
      console.log(text.trim());
      if (process.env.STATION_REAL_SPEECH_EVIDENCE)
        await appendFile(process.env.STATION_REAL_SPEECH_EVIDENCE, text);
    };
    try {
      const tools = new MediaToolsAcquisition(home, {
        locate: async () => null,
        env: {},
      });
      const downloadStart = performance.now();
      await (await tools.startDownload({ consent: true })).completion;
      const status = await tools.status();
      expect(
        status.components.every((c) => c.resolution.status === 'ready'),
      ).toBe(true);
      await record({
        kind: 'download',
        elapsedMs: performance.now() - downloadStart,
        status,
      });
      const ffmpeg = await tools.resolveFfmpeg();
      if (ffmpeg.status !== 'ready') throw new Error(JSON.stringify(ffmpeg));
      expect(
        await createFfmpegDecoderProvider({ mediaTools: tools }).availability(),
      ).toEqual({ available: true, path: ffmpeg.paths.ffmpeg });
      const narration = join(home, 'narration.aiff');
      await runMediaProcess(
        '/usr/bin/say',
        [
          '-o',
          narration,
          'Look here. This is the Station walkthrough. Open the project, review the task, and check the result. Local speech stays on this computer.',
        ],
        { timeoutMs: 60_000 },
      );
      const transcriber = new SherpaTranscriber(tools);
      const playlist = join(home, 'playlist.ffconcat');
      await writeFile(playlist, `ffconcat version 1.0\nfile '${narration}'\n`);
      expect(
        await transcriber.transcribeFile({ inputPath: playlist }),
      ).toMatchObject({ status: 'failed', reason: 'invalid-input' });
      const shortStart = performance.now();
      const short = await transcriber.transcribeFile({ inputPath: narration });
      const shortMs = performance.now() - shortStart;
      await record({
        kind: 'short',
        elapsedMs: shortMs,
        result: short,
        rtf: short.status === 'transcribed' ? shortMs / short.durationMs : null,
      });
      expect(short.status).toBe('transcribed');
      if (short.status !== 'transcribed')
        throw new Error(JSON.stringify(short));
      expect(
        short.segments
          .map((s) => s.text)
          .join(' ')
          .toLowerCase(),
      ).toContain('station');
      expect(short.segments.flatMap((s) => s.tokens).length).toBeGreaterThan(
        10,
      );
      const long = join(home, 'ten-minutes.wav');
      await runMediaProcess(
        ffmpeg.paths.ffmpeg,
        [
          '-v',
          'error',
          '-nostdin',
          '-stream_loop',
          '-1',
          '-i',
          narration,
          '-t',
          '610',
          '-ac',
          '1',
          '-ar',
          '16000',
          '-c:a',
          'pcm_s16le',
          long,
        ],
        { timeoutMs: 60_000 },
      );
      const longStart = performance.now();
      const result = await transcriber.transcribeFile({ inputPath: long });
      const elapsedMs = performance.now() - longStart;
      await record({
        kind: 'long',
        elapsedMs,
        result,
        rtf:
          result.status === 'transcribed'
            ? elapsedMs / result.durationMs
            : null,
        parentMemory: process.memoryUsage(),
      });
      expect(result.status).toBe('transcribed');
      if (result.status !== 'transcribed')
        throw new Error(JSON.stringify(result));
      expect(result.durationMs).toBeGreaterThanOrEqual(600_000);
      expect(result.segments.at(-1)!.startMs).toBeGreaterThan(550_000);
      for (const segment of result.segments) {
        expect(segment.endMs).toBeLessThanOrEqual(result.durationMs);
        expect(segment.startMs).toBeLessThanOrEqual(segment.endMs);
      }
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  },
  15 * 60_000,
);
