# elevenlabs-voice — example plugin

Reference implementation of an ElevenLabs voice plugin for Station.

Shows the full plugin contract:
- `plugin.json` — canonical `entrypoint`, `settings`, and supported permissions
- `plugin.mjs` — server module: issues single-use WebSocket tokens so the API key never reaches the browser
- `src/ElevenLabsSTTProvider.ts` — STTProvider connecting to `wss://api.elevenlabs.io/v1/speech-to-text/stream`
- `src/ElevenLabsTTSProvider.ts` — TTSProvider connecting to `wss://api.elevenlabs.io/v1/text-to-speech/{voice_id}/stream-input`
- `src/index.ts` — host activation registers legacy STT/TTS plus a truthfully unconfigured realtime adapter and returns exact-registration cleanup

## To use as a real plugin

1. Copy this directory outside the repo (plugins live in separate repos)
2. Add your ElevenLabs API key to `.env`: `ELEVENLABS_API_KEY=sk-...`
3. Install from the directory: `station plugin install ./elevenlabs-voice`

Station builds the declared `src/index.ts` entrypoint during installation.

The browser host activates legacy STT/TTS and an unconfigured realtime
registration on installation, then calls their exact cleanup before reload or
disable. A host-provided concrete transport can replace that registration
without losing disposal ownership. Its ephemeral signed endpoint stays in a
transport lease closure and must not be logged or persisted.

## Credentialed smoke

Run `node scripts/voice-realtime-live-smoke.mjs --provider elevenlabs-realtime`
only with a configured credential. Missing authorization returns
`NOT_VERIFIED`; it is never a passing or silently skipped smoke.
