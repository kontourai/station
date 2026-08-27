/**
 * Nova Sonic Voice plugin — client bundle entry point.
 */
import { voiceRegistry } from '@kontourai/station-sdk';
import { NovaSonicProvider } from './NovaSonicProvider';

declare const station: { apiBase: string };

const apiBase = typeof station !== 'undefined' ? station.apiBase : '';

voiceRegistry.registerSTT(new NovaSonicProvider(apiBase));
// NovaSonicProvider also implements TTSProvider (same session)
voiceRegistry.registerTTS(new NovaSonicProvider(apiBase));
