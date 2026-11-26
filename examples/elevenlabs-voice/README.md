# ElevenLabs voice example

The plugin registers ElevenLabs Scribe v2 Realtime speech-to-text and
WebSocket text-to-speech through the Station SDK. A separate realtime voice
adapter remains unconfigured until its owner supplies a concrete transport.

## Install for development

1. Copy this directory to a plugin workspace.
2. Preview and install it with `station plugin preview ./elevenlabs-voice`
   and `station plugin install ./elevenlabs-voice` on a supported local target.
3. Review the trusted `plugin.server` request. Enter the key in the plugin
   settings or supply `ELEVENLABS_API_KEY` to the server process. Keep that key
   on the server. Set the optional TTS voice ID in the plugin settings.

Station builds the declared `src/index.ts` entry point. Its activation registers
the browser providers and returns cleanup that closes active sockets and audio
resources and releases its registry entries.

## Protocol

The browser requests a short-lived authorization from Station with the normal
authenticated SDK client. The server exchanges its key for the appropriate
single-use token and returns a non-cacheable WebSocket URL. Keep that URL out
of logs and settings. [Single-use token API](https://elevenlabs.io/docs/api-reference/tokens/create)

Scribe connects to the realtime endpoint with the `scribe_v2_realtime` model
and voice-activity segmentation. It sends base64 PCM at 16 kHz in JSON frames,
shows partial text, and accumulates committed segments. Stopping preserves the
displayed transcript and retires the current capture. The connection can close
before the provider commits the last partial segment. [Realtime STT protocol](https://elevenlabs.io/docs/api-reference/speech-to-text/v-1-speech-to-text-realtime)

TTS opens the voice's authenticated stream-input endpoint, sends initialization,
text and end-of-input frames, then decodes and plays the assembled MP3 after the
final message. [TTS WebSocket protocol](https://elevenlabs.io/docs/api-reference/text-to-speech/v-1-text-to-speech-voice-id-stream-input)

## Verification

The local tests execute plugin activation and its server minting module with
scripted WebSockets, controlled responses and synthetic audio. They exercise
token types, transcript segments, TTS playback lifecycle, denial and
cancellation. Live provider, billing and physical microphone/playback
acceptance remain unverified.

`node scripts/voice-realtime-live-smoke.mjs --provider elevenlabs-realtime`
reports `NOT_VERIFIED` until a concrete credential-safe realtime transport is
supplied. That separate smoke command does not exercise these STT/TTS classes.
