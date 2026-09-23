# meeting-transcription — example plugin

Reference implementation of a meeting transcription toolbar plugin.

Unlike the voice provider plugins, this one doesn't register an STT provider. It
listens through one that is already registered in `voiceRegistry` from
`@kontourai/station-sdk`.

It cannot see which provider the person chose. Station's voice settings keep that
choice in the host UI's internal `useSTT` hook, which is not a plugin export.
`src/useRegisteredSTT.ts` uses the first registered provider that reports itself
supported. In practice this is usually the browser's WebSpeech provider, which
Station registers first, even when the person picked another one.

Station also registers placeholder entries for server-backed voice providers whose
plugin bundle has not loaded. A placeholder reports itself supported but does not
listen, and the SDK gives no way to tell one apart from a working provider. If a
placeholder is first, the modal opens but hears nothing.

## Files

- `plugin.json` — declares a toolbar action (`"Meeting"` button), requires `voice:stt` permission
- `src/MeetingTranscriptionModal.tsx` — full-screen continuous speech capture UI
- `src/useRegisteredSTT.ts` — binds the modal to a registered STT provider through `voiceRegistry`
- `src/index.ts` — exports the modal for the plugin loader to register as a toolbar action

## Contrast with the old `MeetingTranscriptionModal.tsx`

The previous version (deleted in this commit) used `useMeetingTranscription()` directly,
which hardcoded WebSpeech. This version routes through `voiceRegistry`, subject to
the selection limits above.
