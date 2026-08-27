# meeting-transcription — example plugin

Reference implementation of a meeting transcription toolbar plugin.

Unlike the voice provider plugins, this one doesn't register an STT provider — it
consumes the *active* STT provider via `useSTT()` from `@kontourai/station-sdk`. This means
it automatically benefits from whichever STT provider the user has selected (WebSpeech,
ElevenLabs, etc.).

## Files

- `plugin.json` — declares a toolbar action (`"Meeting"` button), requires `voice:stt` permission
- `src/MeetingTranscriptionModal.tsx` — full-screen continuous speech capture UI, uses `useSTT()`
- `src/index.ts` — exports the modal for the plugin loader to register as a toolbar action

## Contrast with the old `MeetingTranscriptionModal.tsx`

The previous version (deleted in this commit) used `useMeetingTranscription()` directly,
which hardcoded WebSpeech. This version routes through `useSTT()`, so ElevenLabs Scribe
works automatically if that provider is active.
