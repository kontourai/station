/**
 * WebSpeechTTSProvider — TTSProvider backed by the SpeechSynthesis API.
 *
 * Extracted from useVoiceMode.ts.
 */
import type { TTSOptions, TTSProvider } from '@kontourai/station-sdk';
import { ListenerManager } from '@kontourai/station-sdk';

class WebSpeechTTSProvider extends ListenerManager implements TTSProvider {
  readonly id = 'webspeech';
  readonly name = 'WebSpeech (Browser)';

  private _speaking = false;

  get isSupported(): boolean {
    return 'speechSynthesis' in window;
  }

  get speaking(): boolean {
    return this._speaking;
  }

  speak(text: string, opts?: TTSOptions): void {
    if (!this.isSupported) return;
    window.speechSynthesis.cancel();
    const utt = new SpeechSynthesisUtterance(text);
    if (opts?.lang) utt.lang = opts.lang;
    if (opts?.rate !== undefined) utt.rate = opts.rate;
    if (opts?.pitch !== undefined) utt.pitch = opts.pitch;
    if (opts?.volume !== undefined) utt.volume = opts.volume;
    utt.onstart = () => {
      this._speaking = true;
      this._notify();
    };
    utt.onend = () => {
      this._speaking = false;
      this._notify();
    };
    utt.onerror = () => {
      this._speaking = false;
      this._notify();
    };
    window.speechSynthesis.speak(utt);
  }

  cancel(): void {
    window.speechSynthesis?.cancel();
    if (this._speaking) {
      this._speaking = false;
      this._notify();
    }
  }

  destroy(): void {
    this.cancel();
    this._clearListeners();
  }
}

export const webSpeechTTSProvider = new WebSpeechTTSProvider();
