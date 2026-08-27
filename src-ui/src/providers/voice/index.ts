/**
 * Default voice provider registrations.
 *
 * Import this module once at app startup (e.g. in App.tsx) to register the
 * built-in WebSpeech STT and TTS providers into the voiceRegistry.
 */
import { voiceRegistry } from '@kontourai/station-sdk';

import { webSpeechSTTProvider } from './WebSpeechSTTProvider';
import { webSpeechTTSProvider } from './WebSpeechTTSProvider';

voiceRegistry.registerSTT(webSpeechSTTProvider);
voiceRegistry.registerTTS(webSpeechTTSProvider);
