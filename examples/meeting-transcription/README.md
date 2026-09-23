# meeting-transcription — example plugin

Reference implementation of a meeting transcription toolbar plugin.

Unlike the voice provider plugins, this one doesn't register an STT provider. It
consumes one that a voice plugin registered in `voiceRegistry` from
`@kontourai/station-sdk`, so it works with WebSpeech, ElevenLabs Scribe, or any other
registered provider.

The SDK does not tell plugins which provider the person selected in Station's voice
settings. That choice lives in the host UI's internal `useSTT` hook, which is not a
plugin export. `src/useRegisteredSTT.ts` therefore uses the first registered provider
that reports itself supported.

## Files

- `plugin.json` — declares a toolbar action (`"Meeting"` button), requires `voice:stt` permission
- `src/MeetingTranscriptionModal.tsx` — full-screen continuous speech capture UI
- `src/useRegisteredSTT.ts` — binds the modal to a registered STT provider through `voiceRegistry`
- `src/index.ts` — exports the modal for the plugin loader to register as a toolbar action

## Contrast with the old `MeetingTranscriptionModal.tsx`

The previous version (deleted in this commit) used `useMeetingTranscription()` directly,
which hardcoded WebSpeech. This version routes through `voiceRegistry`, so ElevenLabs
Scribe works when that provider is registered.
