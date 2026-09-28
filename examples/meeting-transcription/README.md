# meeting-transcription — example plugin

Reference implementation of a meeting transcription plugin. It contributes one
Workspace Pane, **Meeting Transcription**: add it to a Project, choose **Start
meeting**, and the modal listens through a registered speech-to-text provider.
Sending requests chat with Station's own Agent, since this plugin contributes
none; it is not a confirmed model response or a persisted Knowledge record.

**Source-build gap:** the public plugin builder currently refuses the Pane's
runtime import of `@kontourai/station-contracts/agent-identity`: that source is
outside the allowed plugin/SDK build roots. The SDK exports the identity types,
but not the `agentId`/`STATION_AGENT_ID` runtime helpers used here. Component
tests do not establish an installable bundle. Resolve that public SDK packaging
boundary before treating this source example as a working installed plugin;
do not disable the builder's containment check.

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

An earlier implementation used `useMeetingTranscription()` directly,
which hardcoded WebSpeech. This version routes through `voiceRegistry`, subject to
the selection limits above.

Sending opens chat for Station's own Agent through the public SDK; it does not
create a raw or compiled Knowledge record or rebuild an index. Use the separate
[Meeting Notes example](../meeting-notes/README.md) for those record operations.
The component tests use registered-provider doubles; microphone access, provider
selection in a deployed client, and a real transcript-to-Agent journey need
separate runtime qualification.

The modal appends each transcript value emitted by the selected provider; it
does not normalize cumulative versus incremental provider output. **Send**
requests chat and then closes and clears the modal without awaiting a delivery
acknowledgement. The SDK declines a missing Agent catalog entry, so an open
modal alone does not establish that sending will start a Session.
