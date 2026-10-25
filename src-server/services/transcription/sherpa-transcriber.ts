import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import {
  MediaProcessError,
  runMediaProcess,
} from '../media-tools/media-process.js';
import type {
  MediaToolsAcquisition,
  SpeechPaths,
} from '../media-tools/media-tools-acquisition.js';
import type {
  TranscribeFileRequest,
  Transcriber,
  TranscriptionResult,
  TranscriptSegment,
  TranscriptToken,
} from './transcriber.js';

const MAX_TRANSCRIPTION_DURATION_MS = 60 * 60 * 1000;
const TRANSCRIPTION_TIMEOUT_MS = 15 * 60 * 1000;
// Two imports plus a small dictation burst; queued uploads must remain bounded.
const MAX_WAITING_TRANSCRIPTIONS = 4;
type AdmissionFailure = Extract<TranscriptionResult, { status: 'failed' }>;
const MAX_INPUT_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_RESULT_BYTES = 2 * 1024 * 1024;
// Upload callers have no authority to make demuxers read other host files or URLs.
// Exclude playlist/virtual demuxers (concat, HLS, DASH, SDP, image sequences).
const INPUT_POLICY = [
  '-protocol_whitelist',
  'file',
  '-format_whitelist',
  'aac,ac3,aiff,amr,ape,asf,au,avi,caf,dts,dv,eac3,flac,flv,g722,g723_1,g726,g729,gsm,loas,m4v,matroska,webm,mov,mp3,mpeg,mpegts,mxf,nut,ogg,oma,rm,smk,spdif,swf,truehd,tta,voc,w64,wav,wv',
];

const ENGINE = {
  runtime: 'sherpa-onnx@2.0.0',
  model: 'parakeet-tdt-110m-int8',
} as const;

class TranscriptionFailure extends Error {
  constructor(
    readonly reason: 'invalid-input' | 'too-long' | 'engine-error',
    message: string,
  ) {
    super(message);
  }
}

/** Bounded silence-aware chunks: prefer a silence midpoint in 20..40s, else split at 40s. */
function chunkBoundaries(durationMs: number, stderr: string): number[] {
  const silences: number[] = [];
  for (const match of stderr.matchAll(
    /silence_end:\s*([\d.]+)\s*\|\s*silence_duration:\s*([\d.]+)/g,
  )) {
    silences.push((Number(match[1]) - Number(match[2]) / 2) * 1000);
  }
  const boundaries = [0];
  let start = 0;
  while (durationMs - start > 40_000) {
    const candidates = silences.filter(
      (t) => t >= start + 20_000 && t <= start + 40_000,
    );
    start = candidates.at(-1) ?? start + 40_000;
    boundaries.push(start);
  }
  boundaries.push(durationMs);
  return boundaries;
}

function parseRecognition(
  stdout: string,
  offsetMs: number,
  durationMs: number,
): TranscriptSegment | undefined {
  // The CLI prints diagnostic lines as well as a JSON object, one result per WAV.
  const line = stdout
    .split(/\r?\n/)
    .find((line) => line.trim().startsWith('{'));
  if (!line)
    throw new TranscriptionFailure(
      'engine-error',
      'Recognizer returned no JSON result.',
    );
  const result: unknown = JSON.parse(line);
  if (!result || typeof result !== 'object')
    throw new TranscriptionFailure(
      'engine-error',
      'Invalid recognition result.',
    );
  const r = result as Record<string, unknown>;
  if (
    typeof r.text !== 'string' ||
    !Array.isArray(r.tokens) ||
    !Array.isArray(r.timestamps) ||
    !Array.isArray(r.durations) ||
    r.tokens.length !== r.timestamps.length ||
    r.tokens.length !== r.durations.length ||
    r.tokens.length > 10_000
  )
    throw new TranscriptionFailure(
      'engine-error',
      'Invalid recognition timing arrays.',
    );
  const tokens: TranscriptToken[] = [];
  let previous = 0;
  for (let i = 0; i < r.tokens.length; i++) {
    const text: unknown = r.tokens[i];
    const time: unknown = r.timestamps[i];
    const duration: unknown = r.durations[i];
    if (
      typeof text !== 'string' ||
      typeof time !== 'number' ||
      !Number.isFinite(time) ||
      time < previous ||
      typeof duration !== 'number' ||
      !Number.isFinite(duration) ||
      duration < 0 ||
      time * 1000 > durationMs + 250
    )
      throw new TranscriptionFailure(
        'engine-error',
        'Invalid recognition token timing.',
      );
    previous = time;
    tokens.push({
      text,
      startMs: offsetMs + Math.min(durationMs, Math.round(time * 1000)),
      endMs:
        offsetMs + Math.min(durationMs, Math.round((time + duration) * 1000)),
    });
  }
  if (!r.text.trim()) return undefined;
  return {
    text: r.text,
    startMs: tokens[0]?.startMs ?? offsetMs,
    endMs: tokens.at(-1)?.endMs ?? offsetMs + durationMs,
    tokens,
  };
}

export class SherpaTranscriber implements Transcriber {
  private busy = false;
  private readonly waiting: (() => void)[] = [];

  private acquire(
    signal: AbortSignal | undefined,
    deadline: number,
  ): Promise<AdmissionFailure | undefined> {
    const failure = (
      reason: 'aborted' | 'timeout' | 'busy',
    ): AdmissionFailure => ({
      status: 'failed',
      reason,
      message:
        reason === 'busy'
          ? 'The local recognizer queue is full (4 waiting requests). Retry shortly.'
          : reason === 'timeout'
            ? 'Transcription timed out while waiting for the local recognizer.'
            : 'Transcription aborted.',
    });
    if (signal?.aborted) return Promise.resolve(failure('aborted'));
    if (!this.busy) {
      this.busy = true;
      return Promise.resolve(undefined);
    }
    if (this.waiting.length >= MAX_WAITING_TRANSCRIPTIONS)
      return Promise.resolve(failure('busy'));
    return new Promise((resolve) => {
      const cleanup = () => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
      };
      const grant = () => {
        cleanup();
        resolve(undefined);
      };
      const cancel = (reason: 'aborted' | 'timeout') => {
        this.waiting.splice(this.waiting.indexOf(grant), 1);
        cleanup();
        resolve(failure(reason));
      };
      const abort = () => cancel('aborted');
      const timer = setTimeout(
        () => cancel('timeout'),
        Math.max(1, deadline - Date.now()),
      );
      this.waiting.push(grant);
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
    });
  }

  private release(): void {
    // Transfer ownership before resuming the waiter so newcomers cannot overtake it.
    const next = this.waiting.shift();
    if (next) next();
    else this.busy = false;
  }
  constructor(
    private readonly tools: Pick<
      MediaToolsAcquisition,
      'resolveFfmpeg' | 'resolveSpeech'
    >,
  ) {}
  async transcribeFile(
    request: TranscribeFileRequest,
  ): Promise<TranscriptionResult> {
    const deadline = Date.now() + TRANSCRIPTION_TIMEOUT_MS;
    const admissionFailure = await this.acquire(request.signal, deadline);
    if (admissionFailure) return admissionFailure;
    let temp: string | undefined;
    try {
      if (request.signal?.aborted)
        throw new MediaProcessError('aborted', 'Transcription aborted.');
      if (Date.now() >= deadline)
        throw new MediaProcessError('timeout', 'Transcription timed out.');
      const ffmpeg = await this.tools.resolveFfmpeg();
      const speech = await this.tools.resolveSpeech();
      for (const r of [ffmpeg, speech])
        if (r.status === 'unsupported-platform')
          return {
            status: 'unavailable',
            reason: 'unsupported-platform',
            platform: r.platform,
          };
      const downloads = [ffmpeg, speech].flatMap((r) =>
        r.status === 'needs-consent' ? r.downloads : [],
      );
      if (downloads.length)
        return { status: 'unavailable', reason: 'needs-consent', downloads };
      if (ffmpeg.status !== 'ready' || speech.status !== 'ready')
        throw new Error('Media tool resolution invariant violated.');
      if (!isAbsolute(request.inputPath))
        throw new TranscriptionFailure(
          'invalid-input',
          'Transcription requires an absolute local file path.',
        );
      const input = await stat(request.inputPath);
      if (!input.isFile() || input.size === 0 || input.size > MAX_INPUT_BYTES)
        throw new TranscriptionFailure(
          'invalid-input',
          'Input must be a nonempty file at most 2 GiB.',
        );
      const run = (command: string, args: string[], cwd?: string) =>
        runMediaProcess(command, args, {
          signal: request.signal,
          timeoutMs: deadline - Date.now(),
          cwd,
          maxOutputBytes: MAX_RESULT_BYTES,
        });
      const duration = async (path: string): Promise<number | undefined> => {
        const output = await run(ffmpeg.paths.ffprobe, [
          '-v',
          'error',
          ...INPUT_POLICY,
          '-select_streams',
          'a:0',
          '-show_entries',
          'format=duration:stream=codec_type',
          '-of',
          'json',
          path,
        ]).catch((error: unknown) => {
          if (error instanceof MediaProcessError && error.reason === 'exit')
            throw new TranscriptionFailure(
              'invalid-input',
              'Input is not supported self-contained audio/video.',
            );
          throw error;
        });
        const probe = JSON.parse(output.stdout) as {
          format?: { duration?: string };
          streams?: { codec_type?: string }[];
        };
        if (!probe.streams?.some((s) => s.codec_type === 'audio'))
          throw new TranscriptionFailure(
            'invalid-input',
            'Input has no decodable audio.',
          );
        // MediaRecorder WebM omits duration. Conversion is capped at 60m + 1s,
        // then the decoded WAV must prove a finite duration within the limit.
        if (probe.format?.duration === undefined) return undefined;
        const ms = Number(probe.format.duration) * 1000;
        if (!Number.isFinite(ms) || ms <= 0)
          throw new TranscriptionFailure(
            'invalid-input',
            'Input has no finite duration.',
          );
        if (ms > MAX_TRANSCRIPTION_DURATION_MS)
          throw new TranscriptionFailure(
            'too-long',
            'Audio exceeds the 60-minute transcription limit.',
          );
        return ms;
      };
      await duration(request.inputPath);
      temp = await mkdtemp(join(tmpdir(), 'station-transcribe-'));
      const wav = join(temp, 'audio.wav');
      try {
        await run(ffmpeg.paths.ffmpeg, [
          '-v',
          'error',
          '-nostdin',
          ...INPUT_POLICY,
          '-i',
          request.inputPath,
          '-map',
          '0:a:0',
          '-vn',
          '-ac',
          '1',
          '-ar',
          '16000',
          '-c:a',
          'pcm_s16le',
          '-t',
          String(MAX_TRANSCRIPTION_DURATION_MS / 1000 + 1),
          wav,
        ]);
      } catch (error) {
        if (error instanceof MediaProcessError && error.reason === 'exit')
          throw new TranscriptionFailure(
            'invalid-input',
            'Audio decoding failed.',
          );
        throw error;
      }
      const decodedDuration = await duration(wav);
      if (decodedDuration === undefined)
        throw new TranscriptionFailure(
          'invalid-input',
          'Decoded audio has no finite duration.',
        );
      const durationMs = Math.round(decodedDuration);
      const silence = await run(ffmpeg.paths.ffmpeg, [
        '-hide_banner',
        '-nostdin',
        '-i',
        wav,
        '-af',
        'silencedetect=noise=-35dB:d=0.3',
        '-f',
        'null',
        '-',
      ]);
      const boundaries = chunkBoundaries(durationMs, silence.stderr);
      const segments: TranscriptSegment[] = [];
      let outputBytes = 0;
      for (let i = 1; i < boundaries.length; i++) {
        const start = boundaries[i - 1]!;
        const end = boundaries[i]!;
        const chunk = join(temp, 'chunk.wav');
        await run(ffmpeg.paths.ffmpeg, [
          '-v',
          'error',
          '-nostdin',
          '-y',
          '-ss',
          (start / 1000).toFixed(6),
          '-i',
          wav,
          '-t',
          ((end - start) / 1000).toFixed(6),
          '-c:a',
          'pcm_s16le',
          chunk,
        ]);
        const paths: SpeechPaths = speech.paths;
        const result = await run(
          paths.executable,
          [
            `--encoder=${paths.encoder}`,
            `--decoder=${paths.decoder}`,
            `--joiner=${paths.joiner}`,
            `--tokens=${paths.tokens}`,
            '--model-type=nemo_transducer',
            '--num-threads=2',
            chunk,
          ],
          paths.runtimeDir,
        );
        const segment = parseRecognition(result.stdout, start, end - start);
        if (segment) {
          outputBytes += Buffer.byteLength(JSON.stringify(segment));
          if (outputBytes > MAX_RESULT_BYTES)
            throw new TranscriptionFailure(
              'engine-error',
              'Transcript exceeds output limit.',
            );
          segments.push(segment);
        }
      }
      return { status: 'transcribed', engine: ENGINE, durationMs, segments };
    } catch (error) {
      const reason = request.signal?.aborted
        ? 'aborted'
        : error instanceof TranscriptionFailure
          ? error.reason
          : error instanceof MediaProcessError &&
              (error.reason === 'timeout' || error.reason === 'aborted')
            ? error.reason
            : (error as NodeJS.ErrnoException).code === 'ENOENT'
              ? 'invalid-input'
              : 'engine-error';
      return {
        status: 'failed',
        reason,
        message: error instanceof Error ? error.message : String(error),
      };
    } finally {
      try {
        if (temp) await rm(temp, { recursive: true, force: true });
      } finally {
        this.release();
      }
    }
  }
}
