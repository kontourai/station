/**
 * WebSpeechSTTProvider — STTProvider backed by the Web Speech API.
 */
import type { STTOptions, STTProvider, STTState } from '@kontourai/station-sdk';
import { ListenerManager } from '@kontourai/station-sdk';

const ERROR_RESET_MS = 1500;

class WebSpeechSTTProvider extends ListenerManager implements STTProvider {
  readonly id = 'webspeech';
  readonly name = 'WebSpeech (Browser)';

  private _state: STTState = 'idle';
  private _transcript = '';
  private _rec: any = null;
  private _errorMessage: string | undefined;
  private _errorTimer: ReturnType<typeof setTimeout> | null = null;

  get isSupported(): boolean {
    return this.unsupportedReason === undefined;
  }

  get unsupportedReason(): string | undefined {
    const win = window as any;
    if (!(win.SpeechRecognition ?? win.webkitSpeechRecognition)) {
      return 'Speech recognition is unavailable in this browser.';
    }
    if (typeof navigator.mediaDevices?.getUserMedia !== 'function') {
      return 'Microphone capture is unavailable in this browser.';
    }
    if (window.isSecureContext === false) {
      return 'Microphone input requires a secure browser connection.';
    }
    return undefined;
  }

  get errorMessage(): string | undefined {
    return this._errorMessage;
  }

  get state(): STTState {
    return this._state;
  }
  get transcript(): string {
    return this._transcript;
  }

  startListening(opts?: STTOptions): void {
    const win = window as any;
    const SpeechRec = win.SpeechRecognition ?? win.webkitSpeechRecognition;
    if (!SpeechRec || !this.isSupported) return;

    this._clearErrorTimer();
    this._errorMessage = undefined;
    this._rec?.abort();
    this._transcript = '';

    // Request mic permission explicitly — required in WebViews / mobile
    const startRec = () => {
      const rec = new SpeechRec();
      rec.continuous = opts?.continuous ?? false;
      rec.interimResults = opts?.interimResults ?? false;
      if (opts?.lang) rec.lang = opts.lang;

      rec.onstart = () => this._setState('listening');

      rec.onresult = (e: any) => {
        const t = Array.from(e.results as any[])
          .map((r: any) => r[0].transcript)
          .join(' ')
          .trim();
        if (t) {
          this._transcript = t;
          this._notify();
        }
      };

      rec.onerror = (e: any) => {
        console.warn('[STT] SpeechRecognition error:', e?.error ?? e);
        this._setError('Speech recognition failed. Try the microphone again.');
      };

      rec.onend = () => {
        // Don't override an error state that hasn't expired yet
        if (this._state === 'listening') this._setState('idle');
      };

      this._rec = rec;
      try {
        rec.start();
      } catch (err) {
        console.warn('[STT] Failed to start:', err);
        this._setError('The microphone could not start. Try again.');
      }
    };

    // Ensure mic permission before starting — getUserMedia triggers the prompt
    if (navigator.mediaDevices?.getUserMedia) {
      navigator.mediaDevices
        .getUserMedia({ audio: true })
        .then((stream) => {
          // Got permission — stop the stream immediately, SpeechRecognition manages its own
          stream.getTracks().forEach((t) => t.stop());
          startRec();
        })
        .catch((err) => {
          console.warn('[STT] Mic permission denied:', err);
          this._setError(
            err instanceof DOMException && err.name === 'NotAllowedError'
              ? 'Microphone permission was denied. Allow microphone access and try again.'
              : 'Microphone input is unavailable. Check browser support and permissions.',
          );
        });
    }
  }

  stopListening(): void {
    this._clearErrorTimer();
    this._rec?.stop();
    this._rec = null;
  }

  destroy(): void {
    this._clearErrorTimer();
    this._rec?.abort();
    this._rec = null;
    this._clearListeners();
  }

  private _setError(message: string): void {
    this._clearErrorTimer();
    this._errorMessage = message;
    this._setState('error');
    this._errorTimer = setTimeout(() => {
      this._errorTimer = null;
      this._errorMessage = undefined;
      this._setState('idle');
    }, ERROR_RESET_MS);
  }

  private _clearErrorTimer(): void {
    if (this._errorTimer !== null) {
      clearTimeout(this._errorTimer);
      this._errorTimer = null;
    }
  }

  private _setState(s: STTState): void {
    this._state = s;
    this._notify();
  }
}

export const webSpeechSTTProvider = new WebSpeechSTTProvider();
