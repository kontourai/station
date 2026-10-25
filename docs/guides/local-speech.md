# Local speech and media tools

**Local speech** and **Walkthroughs** are Station-wide **Feature Previews, off by
default**. The operator enables them in **Settings → Advanced → Feature previews**
(`/settings?view=feature-previews&highlight=feature-previews`). **Local speech**
gates `POST /api/transcription` and the **Station (local)** speech-to-text provider.
**Walkthroughs** gates recording imports and reads; see the [import guide](walkthroughs.md).
The runtime owns both previews and their shared services in
[local-media-runtime.ts](../../src-server/runtime/bootstrap/local-media-runtime.ts).
Choices persist and apply immediately without a restart.

The operator-only `/api/media-tools/status` and `/api/media-tools/download` routes
are available when **either** preview is enabled. With both off they return
HTTP 404, `success:false`, `code:'feature_preview_disabled'`,
`previewId:'walkthroughs'`, and the Settings path above; the explanation offers
either switch. Transcription uses the same refusal with `previewId:'local-speech'`.
The CLI preserves the server explanation and exits nonzero. A preview grants
neither operator authority nor download consent. No automatic download occurs.

Existing device decoding may use host-installed or already downloaded ffmpeg
with both previews off. It never downloads. The decoder's consent remedy leads
to the gated media-tools routes, so the operator must enable either preview and
consent before acquiring missing tools. Disabling hides access to the download
routes without removing installed executables or breaking existing decoding.

Station acquires optional ffmpeg/ffprobe, sherpa-onnx and the English Parakeet
TDT 110M int8 model only after operator consent. Nothing is fetched by status
or transcription. A GUI-launched server probes standard install prefixes as
well as PATH. Host-installed tools take precedence over verified downloads
under `<STATION_HOME>/media-tools/<component>/<version>/`.

```sh
station media-tools status
station media-tools download --yes
station media-tools status
```

Status reports component, version, pinned download bytes, origin/resolution,
active byte progress and any download failure. A consented retry restarts a
failed component. Downloads are coalesced within the server process. A crash
can leave a private staging directory; it is never admitted as an installation.
The resolver admits a downloaded install only with the matching pin marker and
required files. The local home is operator-owned; the marker is not a defense
against an operator changing installed executables.

The [pin table](../../src-server/services/media-tools/media-tools-pins.ts) owns
URLs, byte lengths and SHA-256 trust roots. The downloader bounds compressed
bytes, verifies length and digest, refuses traversal and all archive links or
special entries before extraction, checks the extracted tree and promotes a
complete staging directory. gzip outputs have fixed names and a 256 MiB
expanded limit. Native tar supplies bz2 support (Windows 10+ tar is required).
The selected pinned tar bundles have no links. Each asset has a 60-second
receive-idle deadline, refreshed by bytes, and a one-hour total cap; steady
downloads may take more than five minutes. License files are private readable
files without executable permission.

macOS arm64/x64 uses universal2 shared no-TTS; Linux x64 uses shared no-TTS;
Linux arm64 uses shared CPU because v2.0.0 publishes no arm64 no-TTS bundle.
Windows x64 uses shared MD Release no-TTS with adjacent DLLs. Windows arm64
reports `unsupported-platform` when no host installation satisfies the request.
The model is shared across supported platforms. A host model may be selected
with `STATION_SPEECH_MODEL_DIR` pointing at its four ONNX/token files.
Third-party attribution is in [NOTICE](../../packaging/licenses/media-tools/NOTICE),
copied to `dist-server/third-party/media-tools/NOTICE` on server builds. FFmpeg's
verified platform license is installed alongside its executables.

## Dictate a message

After enabling **Local speech**, open **Settings → Voice → Speech-to-text** and
select **Station (local)**. Click the composer microphone to record, then click
again to stop. Station uploads the clip to the selected Station and transcribes
it there. The microphone is released before upload; the control shows
**Cancel transcription** while waiting; clicking it aborts the upload/request
and discards any late response. Only the final text lands in the
composer. This is English batch dictation, with no interim text or continuous
streaming. It needs MediaRecorder, microphone permission, and HTTPS or loopback.
A remote client sends its recording to the Station host; recognition does not
run in the client browser.

If tools are missing, ask this Station’s operator to run `station media-tools
status`, then explicitly consent with `station media-tools download --yes`
against that instance. No media-tools consent/download settings panel exists
currently. Missing tools, unsupported hosts, queue overflow, timeouts, recording
limits and microphone failures show a remedy beside the composer. Nothing
retries or downloads automatically. The client bounds recording to 60 minutes
and 32 MiB; the server also validates the uploaded clip.

The UI follows the same live preview query as destination visibility. Disabling
removes the provider and cancels its capture/upload when that choice is observed;
changing Station, changing providers or closing the owning composer also discards
pending dictation. The server preview switch itself does not cancel recognition already admitted.
A toggle made in another client is observed on the existing query’s next
refresh; the route still rechecks persisted preview state on every request.

## Transcription

[Transcriber](../../src-server/services/transcription/transcriber.ts) accepts an
absolute local audio/video path. The [sherpa adapter](../../src-server/services/transcription/sherpa-transcriber.ts)
probes audio metadata, converts to temporary 16 kHz mono PCM WAV, detects silences
with ffmpeg, and recognizes one chunk at a time. It prefers silence midpoints
between 20 and 40 seconds and caps chunks at 40 seconds. Token times are
absolute milliseconds. A forced boundary may cut a word; this is a known
quality limit for continuous speech. Only English is supported by this model. MediaRecorder WebM may omit its
container duration: Station still caps conversion at 60 minutes plus one second,
then requires a finite duration within 60 minutes from the decoded WAV. Unknown
input duration cannot bypass the limit or turn a truncated long recording into
success.

The adapter refuses durations over 60 minutes and local files over 2 GiB,
uses a total 15-minute deadline including queue time, bounds child output and total transcript to
2 MiB, registers owned process groups, and handles AbortSignal cancellation.
Temporary audio is removed on success and failure. One adapter is shared by Walkthrough imports and the transcription route. It
handles one recognition request at a time, with up to four requests waiting in
FIFO order. Four slots accommodate the two-import path and a small dictation
burst while bounding retained uploads. A queued abort or deadline removes its
entry without starting recognition. Overflow is a distinct `failed/busy` result;
HTTP returns 503 with `code:busy` and `Retry-After: 5`; direct dictation does
not retry automatically. Admitted Walkthrough imports retry busy admission
with bounded backoff; see the [import guide](walkthroughs.md#limits-and-storage).
Missing components return `unavailable` with downloads, never an empty success.
Only a completed recognizer that hears no speech may return empty segments.

The [HTTP upload](../../src-server/routes/transcription.ts) accepts raw binary
bytes rather than a caller-selected host path. It checks streamed as well as
declared size (32 MiB), limits upload reading to 60 seconds, and checks current
authentication before upload, transcription and response. It is independent of
a Project. The built-UI proxy uses a 60-second media receive-idle window and
a 16-minute transcription response window after upload, preserving the
recognizer deadline through that entry point. The media-tools routes require the operator because they install
executables into the instance home. Both route families mount on personal hosts. Selectors are read for each request
and again before download/recognition after reading its body. Disabling does not
cancel a download or recognition already started. A missing or unreadable preview
store selects off. The preview owner requires real human speech accuracy,
platform loading, resource and operator usability evidence before promotion.
See [API](../reference/api.md#local-speech-and-media-tools),
[SDK](../reference/sdk.md#local-speech-and-media-tools) and
[CLI](../reference/cli.md#local-speech-and-media-tools).


Local dictation accepts self-contained WebM/Matroska, Ogg, MP4/MOV and WAV.
The [input policy](../../src-server/services/media-tools/media-input-policy.ts)
limits audio codecs to AAC, Opus, Vorbis, ALAC and explicit PCM variants;
foreign containers and codecs return `invalid-input`. Safari's
[MP4/AAC recording](https://webkit.org/blog/11353/mediarecorder-api/),
[WebM/Opus support](https://webkit.org/blog/16574/webkit-features-in-safari-18-4/)
and [ALAC/PCM support](https://webkit.org/blog/17333/webkit-features-in-safari-26-0/)
are included. The internal Walkthrough path further limits containers to
MP4/MOV and WebM/Matroska, adding only H.264, HEVC, VP8, VP9 and AV1 video
codecs to that audio policy. Both paths retain file-only protocols and refuse
concat/HLS/DASH/SDP and other playlist or virtual inputs.

The downloaded FFmpeg bundle pin remains `b6.1.1`, an old decoder bundle.
The macOS arm64 binary reports FFmpeg 6.0; its bundle release label does not
establish the binary version on every platform.
Length/digest checks establish the pinned bytes, not current security fixes.
The narrow decode policies reduce exposure but do not qualify this old decoder
as current; refreshing and qualifying the pins remains a known preview limit.
Host-installed tools take precedence and have their own version provenance.
Missing input files return `invalid-input`; missing executable paths return
`engine-error`, whose voice remedy directs the operator to media-tools status.
Unexpected unavailable results settle as visible failures instead of leaving
the provider in transcribing state.

Large media uploads require ordinary HTTP transport. The separate
[virtual-application pilot](local-collaboration-lab.md) retains its 16 KiB
request-body contract; these upload ceilings do not broaden that transport.
Native-peer media delivery remains unqualified.

## Evidence

The acquisition tests own corrupt length/digest, literal consent, offline
status, native archive traversal/link refusal and decoder resolution. Adapter
tests own unavailability, duration rejection, absolute timing, cancellation,
FIFO/overflow/deadline behavior and two-import publication through the real class.
Provider tests exercise the real provider and authenticated SDK upload with fake
fetch responses matching the route, plus live app registration and removal.
Route tests own operator admission and binary upload bounds. See the adjacent
`__tests__` directories. Run with `npm run test:focused -- <file...>`.

`src-server/services/transcription/__tests__/sherpa-transcriber.real.test.ts`
explicitly skips unless macOS and `STATION_REAL_SPEECH=1` are selected. Opting
in consents to fresh real downloads into a disposable isolated Station home,
macOS `say` narration, and a 610-second input. It fails on missing prerequisites
once opted in. `STATION_REAL_SPEECH_EVIDENCE` may name an external JSONL receipt.
Fixture tests do not qualify Linux/Windows shared-library loading or recognition
quality on unsynthesized human narration; record those platform runs separately.
