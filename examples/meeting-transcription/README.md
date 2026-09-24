# meeting-transcription — example plugin

Reference implementation of a meeting transcription plugin. It contributes one
Workspace Pane, **Meeting Transcription**: add it to a Project, choose **Start
meeting**, and the modal listens through a registered speech-to-text provider.
The transcript goes to chat with Station's own Agent, since this plugin
contributes none.

Station has no plugin toolbar actions. This example used to declare one
(`toolbarActions`), along with `clientBundle` and `providerTypes`; no runtime
reads those fields, so the modal had no way to open.

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

- `plugin.json` — an Agent Plugins 1.0 manifest declaring the Workspace Pane, with the `agents.invoke` permission for sending the transcript to chat
- `src/MeetingTranscriptionPane.tsx` — the Pane: opens the modal and sends its transcript to chat
- `src/MeetingTranscriptionModal.tsx` — full-screen continuous speech capture UI
- `src/useRegisteredSTT.ts` — binds the modal to a registered STT provider through `voiceRegistry`
- `src/index.ts` — exports `components`, keyed by the renderer name the manifest's Pane declares

## Contrast with the old `MeetingTranscriptionModal.tsx`

The previous version (deleted in this commit) used `useMeetingTranscription()` directly,
which hardcoded WebSpeech. This version routes through `voiceRegistry`, subject to
the selection limits above.
