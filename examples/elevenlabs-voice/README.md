# elevenlabs-voice — example plugin

Voice plugin example with legacy STT/TTS implementations and a separately
injected realtime adapter. It is **not currently a qualified working reference**:
[#2784](https://github.com/kontourai/station/issues/2784) tracks differences between
the legacy token/audio/transcript code and the provider's documented protocol.

The package contains:
- `plugin.json` — canonical `entrypoint`, `settings`, and supported permissions
- `plugin.mjs` — server module: attempts to exchange the server-held API key for a signed URL
- `src/ElevenLabsSTTProvider.ts` — legacy microphone/PCM and transcript implementation
- `src/ElevenLabsTTSProvider.ts` — legacy text submission and accumulated MP3 playback
- `src/index.ts` — host activation registers legacy STT/TTS plus a truthfully unconfigured realtime adapter and returns exact-registration cleanup

## Install for development

1. Copy this directory outside the repo (plugins live in separate repos)
2. Preview and install the copied directory through the supported local target:
   `station plugin preview ./elevenlabs-voice`, then `station plugin install ./elevenlabs-voice`.
3. Review the trusted `plugin.server` request through the host's separate review.
   Configure the key in the server process as `ELEVENLABS_API_KEY` or through its
   declared plugin setting. This package does not load a copied plugin's `.env`.

Station builds the declared `src/index.ts` entrypoint during installation.

When the admitted browser bundle loads, its `activate({ apiBase })` registers
legacy STT/TTS and an unconfigured realtime adapter. The host retains the
returned cleanup for withdrawal/reload. Installation alone does not establish
activation or provider readiness. A concrete transport can replace that registration
without losing disposal ownership. Its ephemeral signed endpoint stays in a
transport lease closure and must not be logged or persisted.

## Credentialed smoke

The root command
`node scripts/voice-realtime-live-smoke.mjs --provider elevenlabs-realtime`
has no concrete ElevenLabs runner. Missing credentials return `NOT_VERIFIED`;
supplying one still returns `NOT_VERIFIED` until a transport is implemented.
That command does not validate the legacy STT/TTS path.

The provider's [token API](https://elevenlabs.io/docs/api-reference/tokens/create)
returns a token, while this example expects a signed URL. Its
[STT protocol](https://elevenlabs.io/docs/api-reference/speech-to-text/v-1-speech-to-text-realtime)
uses JSON audio messages and `message_type` transcript events; the legacy client
sends raw PCM buffers and reads `type: "transcript"`. A local mocked-client probe
confirmed that current transcript events are ignored. No live audio or provider
request was performed during this audit.
