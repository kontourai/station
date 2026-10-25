import type { STTOptions, STTProvider, STTState } from '@kontourai/station-sdk';
import { ListenerManager } from '@kontourai/station-sdk';
import {
  type LocalTranscriptionResult,
  StationHttpError,
  StationRequestTimeoutError,
  transcribeAudio,
} from '@kontourai/station-sdk/client';

const MAX_AUDIO_BYTES = 32 * 1024 * 1024;
const MAX_RECORDING_MS = 60 * 60_000;
const FAILURE_MESSAGES: Record<
  Extract<LocalTranscriptionResult, { status: 'failed' }>['reason'],
  string
> = {
  'invalid-input':
    'Station could not decode this recording. Try recording again in a browser that supports WebM, Ogg or MP4 audio.',
  'too-long':
    'The recording exceeds the 60-minute limit. Record a shorter message.',
  timeout:
    'Local transcription timed out, including time waiting for the recognizer. Retry with a shorter recording.',
  aborted: 'Local transcription was cancelled. Record the message again.',
  'engine-error':
    'The local recognizer failed. Ask the Station operator to check media tools with station media-tools status, then retry.',
  busy: 'The local recognizer queue is full. Wait a few seconds, then record the message again.',
};

interface Capture {
  controller: AbortController;
  recorder?: MediaRecorder;
  stream?: MediaStream;
  timer?: ReturnType<typeof setTimeout>;
  chunks: Blob[];
  bytes: number;
}

/** Batch dictation: recording → transcribing → one final transcript notification. */
export class LocalSpeechSTTProvider
  extends ListenerManager
  implements STTProvider
{
  readonly id = 'station-local';
  readonly name = 'Station (local)';
  private _state: STTState = 'idle';
  private _transcript = '';
  private _errorMessage: string | undefined;
  private capture: Capture | undefined;

  constructor(private readonly apiBase: string) {
    super();
  }
  get state(): STTState {
    return this._state;
  }
  get transcript(): string {
    return this._transcript;
  }
  get errorMessage(): string | undefined {
    return this._errorMessage;
  }
  get unsupportedReason(): string | undefined {
    if (typeof MediaRecorder === 'undefined')
      return 'MediaRecorder is unavailable. Use a browser with audio recording support, such as current Chrome, Firefox or Safari.';
    if (typeof navigator.mediaDevices?.getUserMedia !== 'function')
      return 'Microphone capture is unavailable. Open Station over HTTPS or on this computer’s loopback address in a browser with microphone support.';
    if (window.isSecureContext === false)
      return 'Microphone input requires HTTPS or this computer’s loopback address.';
    return undefined;
  }
  get isSupported(): boolean {
    return this.unsupportedReason === undefined;
  }

  startListening(opts?: STTOptions): void {
    if (this.capture) return;
    this._transcript = '';
    this._errorMessage = undefined;
    if (this.unsupportedReason) {
      this.fail(undefined, this.unsupportedReason);
      return;
    }
    if (opts?.lang && !/^en(?:-|$)/i.test(opts.lang)) {
      this.fail(
        undefined,
        'Station (local) supports English only. Select an English language or another speech provider.',
      );
      return;
    }
    const capture: Capture = {
      controller: new AbortController(),
      chunks: [],
      bytes: 0,
    };
    this.capture = capture;
    this.setState('listening');
    void this.record(capture);
  }

  private async record(capture: Capture): Promise<void> {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (this.capture !== capture) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      capture.stream = stream;
      const mimeType = [
        'audio/webm;codecs=opus',
        'audio/ogg;codecs=opus',
        'audio/mp4',
      ].find((type) => MediaRecorder.isTypeSupported(type));
      const recorder = new MediaRecorder(
        stream,
        mimeType ? { mimeType } : undefined,
      );
      capture.recorder = recorder;
      recorder.ondataavailable = (event) => {
        if (this.capture !== capture || !event.data.size) return;
        capture.bytes += event.data.size;
        if (capture.bytes > MAX_AUDIO_BYTES) {
          this.fail(
            capture,
            'The recording exceeds the 32 MiB upload limit. Record a shorter message.',
          );
          return;
        }
        capture.chunks.push(event.data);
      };
      recorder.onerror = () =>
        this.fail(
          capture,
          'Microphone recording failed. Check the input device and record again.',
        );
      recorder.onstop = () => {
        void this.transcribe(capture);
      };
      recorder.start(1000);
      capture.timer = setTimeout(
        () => this.fail(capture, FAILURE_MESSAGES['too-long']),
        MAX_RECORDING_MS,
      );
    } catch (error) {
      if (this.capture !== capture) return;
      this.fail(
        capture,
        error instanceof DOMException && error.name === 'NotAllowedError'
          ? 'Microphone permission was denied. Allow microphone access in this browser’s site settings, then try again.'
          : 'The microphone could not start. Check the input device and browser microphone permissions, then try again.',
      );
    }
  }

  stopListening(): void {
    const capture = this.capture;
    if (!capture || this._state === 'transcribing') return;
    if (!capture.recorder) {
      this.cancelListening();
      return;
    }
    this.setState('transcribing');
    try {
      capture.recorder.stop();
    } catch {
      this.fail(
        capture,
        'The microphone could not finish recording. Check the input device and record again.',
      );
    }
  }

  cancelListening(): void {
    const capture = this.capture;
    this.capture = undefined;
    if (capture) {
      this.releaseRecording(capture);
      capture.controller.abort();
    }
    this._transcript = '';
    this._errorMessage = undefined;
    this.setState('idle');
  }

  destroy(): void {
    this.cancelListening();
    this._clearListeners();
  }

  private releaseRecording(capture: Capture): void {
    clearTimeout(capture.timer);
    if (capture.recorder) {
      capture.recorder.ondataavailable = null;
      capture.recorder.onstop = null;
      capture.recorder.onerror = null;
      if (capture.recorder.state !== 'inactive') capture.recorder.stop();
    }
    capture.stream?.getTracks().forEach((track) => track.stop());
  }

  private async transcribe(capture: Capture): Promise<void> {
    if (this.capture !== capture) return;
    this.releaseRecording(capture);
    this.setState('transcribing');
    const audio = new Blob(capture.chunks, {
      type: capture.recorder?.mimeType || capture.chunks[0]?.type,
    });
    capture.chunks = [];
    if (!audio.size) {
      this.fail(
        capture,
        'The microphone recorded no audio. Check the input device and try again.',
      );
      return;
    }
    try {
      const result = await transcribeAudio(this.apiBase, audio, {
        signal: capture.controller.signal,
      });
      if (this.capture !== capture) return;
      switch (result.status) {
        case 'transcribed':
          this._transcript = result.segments
            .map((segment) => segment.text.trim())
            .filter(Boolean)
            .join(' ');
          this.capture = undefined;
          if (!this._transcript) {
            this.fail(
              undefined,
              'No speech was detected. Check the microphone and speak again.',
            );
            return;
          }
          this.setState('idle');
          return;
        case 'unavailable':
          switch (result.reason) {
            case 'needs-consent':
              this.fail(
                capture,
                'Local speech tools need an explicit download. Ask this Station’s operator to run station media-tools status, then station media-tools download --yes against this instance. Retry when all components are ready.',
              );
              return;
            case 'unsupported-platform':
              this.fail(
                capture,
                `Local speech is unavailable on ${result.platform}. Select another speech provider or connect to a supported Station host.`,
              );
              return;
          }
          break;
        case 'failed':
          this.fail(capture, FAILURE_MESSAGES[result.reason]);
          return;
      }
    } catch (error) {
      if (this.capture !== capture) return;
      const message =
        error instanceof StationHttpError
          ? error.code === 'feature_preview_disabled'
            ? 'Local speech is off. Ask the Station operator to enable Local speech in Settings → Advanced → Feature previews, then select Station (local) again.'
            : error.code === 'busy'
              ? FAILURE_MESSAGES.busy
              : error.status === 401 || error.status === 403
                ? 'Station refused local transcription. Reconnect or sign in to this Station, then try again.'
                : error.code === 'upload-too-large'
                  ? 'The recording exceeds the 32 MiB upload limit. Record a shorter message.'
                  : error.code === 'invalid-input'
                    ? FAILURE_MESSAGES['invalid-input']
                    : 'Station could not transcribe this recording. Check the Station connection and retry.'
          : error instanceof StationRequestTimeoutError
            ? FAILURE_MESSAGES.timeout
            : 'Could not reach local transcription. Check the Station connection and retry.';
      this.fail(capture, message);
    }
  }

  private fail(capture: Capture | undefined, message: string): void {
    if (capture && this.capture !== capture) return;
    if (capture) {
      this.releaseRecording(capture);
      capture.controller.abort();
    }
    this.capture = undefined;
    this._errorMessage = message;
    this.setState('error');
  }
  private setState(state: STTState): void {
    this._state = state;
    this._notify();
  }
}
