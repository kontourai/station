import { access, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { runMediaProcess } from '../../media-tools/media-process.js';
import { MediaToolsAcquisition } from '../../media-tools/media-tools-acquisition.js';
import { SherpaTranscriber } from '../sherpa-transcriber.js';

const makeTempDir = trackTempDirs();
async function fixture(
  options: {
    duration?: number;
    hang?: boolean;
    badJson?: boolean;
    unknownDuration?: boolean;
    decodedDuration?: number | 'missing';
  } = {},
) {
  const home = makeTempDir('station-speech-fixture-');

  const trace = join(home, 'trace.jsonl');
  const marker = join(home, 'running');
  const input = join(home, 'recording.input');
  await writeFile(input, 'audio fixture');
  const executable = async (name: string, code: string) => {
    const path = join(home, name);
    await writeFile(
      path,
      `#!${process.execPath}\nconst fs=require('node:fs'); const args=process.argv.slice(2); fs.appendFileSync(${JSON.stringify(trace)}, JSON.stringify({tool:${JSON.stringify(name)},args})+'\\n');\n${code}\n`,
      { mode: 0o700 },
    );
    return path;
  };
  const ffprobe = await executable(
    'probe',
    options.hang
      ? `fs.writeFileSync(${JSON.stringify(marker)},String(process.pid));setInterval(()=>{},1000);`
      : `console.log(JSON.stringify({format:args.at(-1)===${JSON.stringify(input)}&&${options.unknownDuration ?? false}?{}:{duration:args.at(-1)===${JSON.stringify(input)}?${options.duration ?? 82}:${options.decodedDuration === 'missing' ? 'undefined' : (options.decodedDuration ?? 82)}}, streams:[{codec_type:'audio'}]}));`,
  );
  const ffmpeg = await executable(
    'convert',
    `if(args.includes('silencedetect=noise=-35dB:d=0.3')) process.stderr.write('silence_end: 31 | silence_duration: 2\\nsilence_end: 66 | silence_duration: 2\\n');else fs.writeFileSync(args.at(-1),'converted audio fixture');`,
  );
  const recognizer = await executable(
    'recognize',
    options.badJson
      ? `console.log('not JSON');`
      : `console.log(JSON.stringify({text:'Look here.',tokens:['Look',' here.'],timestamps:[0.1,0.7],durations:[0.2,0.4]}));`,
  );
  const transcriber = new SherpaTranscriber({
    resolveFfmpeg: async () => ({
      status: 'ready',
      origin: 'host',
      paths: { ffmpeg, ffprobe },
    }),
    resolveSpeech: async () => ({
      status: 'ready',
      origin: 'host',
      paths: {
        executable: recognizer,
        runtimeDir: home,
        encoder: join(home, 'encoder'),
        decoder: join(home, 'decoder'),
        joiner: join(home, 'joiner'),
        tokens: join(home, 'tokens'),
      },
    }),
  });
  return { home, input, trace, marker, transcriber };
}
describe('local transcription adapter', () => {
  test('missing components return unavailable with downloads, never an empty transcript', async () => {
    const home = makeTempDir('station-speech-missing-');

    const tools = new MediaToolsAcquisition(home, {
      locate: async () => null,
      env: {},
    });
    const result = await new SherpaTranscriber(tools).transcribeFile({
      inputPath: join(home, 'missing'),
    });
    expect(result).toMatchObject({
      status: 'unavailable',
      reason: 'needs-consent',
      downloads: expect.arrayContaining([
        expect.objectContaining({ component: 'ffmpeg' }),
        expect.objectContaining({ component: 'speech-runtime' }),
        expect.objectContaining({ component: 'speech-model' }),
      ]),
    });
    expect(result).not.toHaveProperty('segments');
  });
  test.skipIf(process.platform === 'win32')(
    'refuses too-long before conversion rather than truncating',
    async () => {
      const f = await fixture({ duration: 3601 });
      expect(
        await f.transcriber.transcribeFile({ inputPath: f.input }),
      ).toMatchObject({
        status: 'failed',
        reason: 'too-long',
        message: expect.stringContaining('60-minute'),
      });
      const trace = await readFile(f.trace, 'utf8');
      expect(trace).not.toContain('convert');
      expect(trace).not.toContain('recognize');
    },
  );
  test.skipIf(process.platform === 'win32')(
    'silence chunks offset token times to absolute ms and remove temporary audio',
    async () => {
      const f = await fixture();
      const result = await f.transcriber.transcribeFile({ inputPath: f.input });
      expect(result).toMatchObject({
        status: 'transcribed',
        durationMs: 82000,
        segments: [
          { startMs: 100, endMs: 1100 },
          { startMs: 30100, endMs: 31100 },
          { startMs: 65100, endMs: 66100 },
        ],
      });
      if (result.status !== 'transcribed')
        throw new Error(JSON.stringify(result));
      expect(result.segments[1]?.tokens[1]).toEqual({
        text: ' here.',
        startMs: 30700,
        endMs: 31100,
      });
      const calls = (await readFile(f.trace, 'utf8'))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as { tool: string; args: string[] });
      const wav = calls.find((c) => c.tool === 'convert')!.args.at(-1)!;
      await expect(access(wav)).rejects.toThrow();
    },
  );
  test.skipIf(process.platform === 'win32')(
    'abort kills the active owned child and reports aborted',
    async () => {
      const f = await fixture({ hang: true });
      const control = new AbortController();
      const result = f.transcriber.transcribeFile({
        inputPath: f.input,
        signal: control.signal,
      });
      const deadline = Date.now() + 5000;
      while (true) {
        try {
          await access(f.marker);
          break;
        } catch {
          if (Date.now() > deadline) throw new Error('Probe did not start.');
          await new Promise((r) => setTimeout(r, 10));
        }
      }
      const pid = Number(await readFile(f.marker, 'utf8'));
      control.abort();
      expect(await result).toMatchObject({
        status: 'failed',
        reason: 'aborted',
      });
      expect(() => process.kill(pid, 0)).toThrow();
    },
  );
  test.skipIf(process.platform === 'win32')(
    'engine output failure is not transcribed silence',
    async () => {
      const f = await fixture({ badJson: true });
      expect(
        await f.transcriber.transcribeFile({ inputPath: f.input }),
      ).toMatchObject({
        status: 'failed',
        reason: 'engine-error',
        message: expect.stringContaining('no JSON'),
      });
    },
  );
  test('pre-aborted request starts nothing', async () => {
    const f = await fixture();
    expect(
      await f.transcriber.transcribeFile({
        inputPath: f.input,
        signal: AbortSignal.abort(),
      }),
    ).toMatchObject({ status: 'failed', reason: 'aborted' });
    await expect(access(f.trace)).rejects.toThrow();
  });
  test('owned process deadline and output ceiling settle hanging and noisy children', async () => {
    await expect(
      runMediaProcess(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {
        timeoutMs: 100,
      }),
    ).rejects.toMatchObject({ reason: 'timeout' });
    await expect(
      runMediaProcess(
        process.execPath,
        [
          '-e',
          "process.stdout.write('x'.repeat(8192));setInterval(()=>{},1000)",
        ],
        { timeoutMs: 5000, maxOutputBytes: 1024 },
      ),
    ).rejects.toMatchObject({ reason: 'output-limit' });
  });
});

test.skipIf(process.platform === 'win32')(
  'MediaRecorder-style input without container duration is bounded then transcribed from its decoded WAV',
  async () => {
    const f = await fixture({ unknownDuration: true });
    const result = await f.transcriber.transcribeFile({ inputPath: f.input });
    expect(result).toMatchObject({ status: 'transcribed', durationMs: 82000 });
    const trace = await readFile(f.trace, 'utf8');
    expect(trace).toContain('recognize');
    expect(trace).toContain('3601');
  },
);

test.skipIf(process.platform === 'win32')(
  'unknown input duration still requires a finite decoded duration within the limit',
  async () => {
    for (const [decodedDuration, reason] of [
      [3601, 'too-long'],
      ['missing', 'invalid-input'],
    ] as const) {
      const f = await fixture({ unknownDuration: true, decodedDuration });
      expect(
        await f.transcriber.transcribeFile({ inputPath: f.input }),
      ).toMatchObject({ status: 'failed', reason });
      expect(await readFile(f.trace, 'utf8')).not.toContain('recognize');
    }
  },
);
