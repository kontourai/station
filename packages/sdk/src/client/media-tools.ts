import {
  authenticatedFetch,
  type ClientRequestOptions,
  getJson,
  mutateJson,
  readEnvelopeOrThrow,
} from './http';

export type MediaToolComponent = 'ffmpeg' | 'speech-runtime' | 'speech-model';
export interface MediaToolDownload {
  component: string;
  version: string;
  bytes: number;
}
export interface MediaToolsStatus {
  components: readonly (MediaToolDownload & {
    resolution:
      | {
          status: 'ready';
          origin: 'host' | 'downloaded';
          paths: Readonly<Record<string, string>>;
        }
      | { status: 'needs-consent'; downloads: readonly MediaToolDownload[] }
      | { status: 'unsupported-platform'; platform: string };
    progress?: { receivedBytes: number; totalBytes: number };
    failure?: string;
  })[];
}
export interface LocalTranscriptSegment {
  startMs: number;
  endMs: number;
  text: string;
  tokens: readonly { startMs: number; endMs: number; text: string }[];
}
export type LocalTranscriptionResult =
  | {
      status: 'transcribed';
      engine: { runtime: string; model: string };
      durationMs: number;
      segments: readonly LocalTranscriptSegment[];
    }
  | {
      status: 'unavailable';
      reason: 'needs-consent';
      downloads: readonly MediaToolDownload[];
    }
  | { status: 'unavailable'; reason: 'unsupported-platform'; platform: string }
  | {
      status: 'failed';
      reason:
        | 'invalid-input'
        | 'too-long'
        | 'timeout'
        | 'aborted'
        | 'engine-error'
        | 'busy';
      message: string;
    };

export async function getMediaToolsStatus(
  apiBase: string,
  options?: ClientRequestOptions,
): Promise<MediaToolsStatus> {
  return requireData(
    await getJson(
      `${options?.requestScope?.apiBase ?? apiBase}/api/media-tools/status`,
      options,
    ),
  );
}
export async function downloadMediaTools(
  apiBase: string,
  request: { consent: true; components?: readonly MediaToolComponent[] },
  options?: ClientRequestOptions,
): Promise<MediaToolsStatus> {
  if (request?.consent !== true)
    throw new Error('Downloading media tools requires explicit consent: true.');
  return requireData(
    await mutateJson(
      `${options?.requestScope?.apiBase ?? apiBase}/api/media-tools/download`,
      'POST',
      options,
      request,
    ),
  );
}
/** Raw self-contained browser audio bytes, at most 32 MiB; authentication comes from the host credential resolver. */
export async function transcribeAudio(
  apiBase: string,
  audio: Blob,
  options?: Pick<ClientRequestOptions, 'signal' | 'headers' | 'timeoutMs'>,
): Promise<LocalTranscriptionResult> {
  if (audio.size === 0 || audio.size > 32 * 1024 * 1024)
    throw new Error('Audio upload must be nonempty and at most 32 MiB.');
  const response = await authenticatedFetch(`${apiBase}/api/transcription`, {
    method: 'POST',
    body: audio,
    headers: {
      'Content-Type': audio.type || 'application/octet-stream',
      ...options?.headers,
    },
    signal: options?.signal,
    timeoutMs: options?.timeoutMs ?? 16 * 60_000,
    readOnly: true,
  });
  return requireData(response);
}

async function requireData<T>(response: Response): Promise<T> {
  const data = await readEnvelopeOrThrow<T>(response);
  if (data === undefined) throw new Error('Station returned no response data.');
  return data;
}
