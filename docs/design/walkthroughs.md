# Walkthroughs

**Status (2026-10-25, Feature Preview integration):** The branch combines the
Walkthrough contract, video importer, local acquisition and transcription, CLI,
and MCP reading path. **Walkthroughs** and **Local speech** are separate
Station-wide Feature Previews, **off by default**. Enable them in
**Settings → Advanced → Feature previews**. The owning runtime binds their live
selectors with the shared downloader/recognizer; see [Walkthrough imports](../guides/walkthroughs.md)
and [local speech](../guides/local-speech.md) for gating, costs and recovery.
Publication and unsynthesized human-speech accuracy remain unverified.

## Thesis

A person reviewing Station should be able to use the app, talk about what
they see, and point at things. That recording should then become input an
agent can act on.

Station does not depend on any one capture tool for this. It defines one
input format, the **Walkthrough**. Capture sources write that format, and
agents read only that format. A capture source is an importer, an adapter
from one tool's output to the contract:

| Source | What it can fill in | Status |
| --- | --- | --- |
| Video importer | Transcript, frames, timing | First delivery |
| Annotate importer | Adds pen marks aligned to narration | After the video importer |
| Native Station capture | Adds element and source references, route, console, network | Later |

The seam sits around the data, not around each tool's API. These tools are
separate apps a person runs; what has to be interchangeable is what they
produce. The video importer and the Annotate importer are two real adapters,
which is what the [module map](../architecture/module-map.md) asks of a seam.

Where findings go afterwards (a GitHub issue, a Linear issue, a Station Task)
is not part of this contract. An agent decides, using the Project's existing
tracker integrations ([tracker-backed Tasks](tracker-backed-tasks.md)). That
routing is a skill built on top of this contract and is out of scope here.

"Feedback" and "session tape" are already taken in Station (message ratings
at `/api/feedback`, and chat replay tapes), so this feature is named
Walkthrough.

## The contract

`@kontourai/station-contracts/walkthrough` owns the shape and its
hand-written boundary parser (contracts stay dependency-free; no zod). A
Walkthrough is a manifest plus a directory of frame images.

```ts
interface Walkthrough {
  schema: 'station.walkthrough/v1';
  id: string;
  createdAt: string;            // ISO 8601
  title?: string;
  source: {
    adapter: string;            // 'video-import', later 'annotate', 'native'
    adapterVersion: string;
    originalName?: string;      // file name only, never a path
    durationMs: number;
  };
  capture: {
    platform: 'desktop' | 'web' | 'ios' | 'android' | 'unknown';
    width?: number;
    height?: number;
  };
  coverage: Record<WalkthroughChannel, 'present' | 'absent'>;
  frameSelection?: { candidates: number; kept: number };
  events: WalkthroughEvent[];   // ordered by tMs
}

type WalkthroughChannel =
  'transcript' | 'frames' | 'marks' | 'elements' | 'route' | 'console' | 'network';

type WalkthroughEvent =
  | { kind: 'transcript'; tMs: number; endMs: number; text: string;
      tokens?: { tMs: number; endMs: number; text: string }[] }
  | { kind: 'frame'; tMs: number; frameId: string; file: string;
      width: number; height: number; reasons: FrameReason[] }
  | { kind: 'mark'; tMs: number; shape: 'tap' | 'circle' | 'arrow' | 'rect' | 'stroke';
      points: [number, number][];   // normalized 0..1 of the frame
      frameId?: string; element?: ElementRef }
  | { kind: 'route'; tMs: number; path: string }
  | { kind: 'console'; tMs: number; level: 'error' | 'warn'; message: string }
  | { kind: 'network'; tMs: number; method: string; url: string; status: number };

type FrameReason = 'scene-change' | 'deictic' | 'pause' | 'interval';

interface ElementRef {
  testId?: string;
  selector?: string;
  component?: string;
  source?: { file: string; line?: number };
}
```

Rules the parser enforces:

- **Absent is not empty.** `coverage` states, per channel, whether the
  source could observe it at all. A video import reports `elements`,
  `route`, `console` and `network` as `absent`. Zero console events with
  `console: 'present'` means none happened; with `absent` it means nobody
  looked. The parser refuses an event whose channel is `absent`.
- **Bounds reject; they do not truncate.** The parser refuses a manifest
  over its limits (event count, frame count, text length, duration) rather
  than silently cutting it. An importer that keeps fewer frames than it
  found records both numbers in `frameSelection`.
- **Events are ordered by `tMs`,** and every `frameId` a mark names exists.
- **Frame `file` is a relative name inside the Walkthrough directory.** The
  parser refuses absolute paths and `..` segments.

### Lane B decisions

The [contract constants](../../packages/contracts/src/walkthrough.ts) own these
refusal limits: 30 minutes, 4,096 events, 120 frames, 16,384 UTF-16 code units
per text field, 262,144 event-text units in total (including token text),
32,768 tokens in total, 256 units per token, 2,048 points per mark, 16,384 pixels
per source dimension, and 8 MiB per encoded manifest. Optional fields that are
present must validate. Every coverage key is required. Frame IDs and files are
unique; selection `kept` must equal the actual frame count. File names contain
no separators, colon, control characters, `..`, or trailing dot/space.

Upload admission is 512 MiB. The importer caps frame longest edges at 1,280
pixels and refuses JPEGs over 512 KiB. Scene threshold is 0.3. Frame candidates
come from reconstructed whole deictic words (including subword tokens), scene
changes, pauses of at least one second (200 ms after speech ends), and every
ten seconds starting at zero. Candidates within 500 ms merge, preserving
reasons and the strongest signal's time; ranking sums deictic=8, scene=4,
pause=2, interval=1. Half the 120-frame budget reserves evenly spaced coverage
anchors at `max(10 seconds, video duration / 60)`; the remaining budget takes
the strongest candidates, with earlier times breaking ties. Merging moves an
anchor by at most 500 ms, so selected gaps are at most the anchor spacing plus
one second (31 seconds at the 30-minute limit). This guarantee applies to
selection; a decoder that produces no JPEG can leave a larger published gap.
`frameSelection.candidates` counts signals before merging; `kept` counts frames.

The upload uses a UUID request id. Identical in-process requests join once;
reusing a completed id observes its existing receipt rather than re-importing.
Two imports may run at once per service instance. A hidden staging directory
holds the input, frames and validated manifest; one directory rename publishes
only the artifact. The original recording is then removed. Project revision
and drive authority are rechecked under Project publication authority.
A later status read reconciles an interrupted operation against the immutable
manifest. Admitted imports retry `busy` recognizer admission with 250 ms to
5-second exponential backoff inside a 15-minute transcription budget. This
preserves the shared FIFO queue without reserving idle capacity for imports.
Other transcription failures are terminal; cancellation after admission is unsupported.

List pages default to 25, maximum 50. MCP frame pages default to four, maximum
four, each at most 512 KiB, with the complete bounded manifest and a numeric
`nextCursor`. Read authority is Project `view`, import is `drive`; these
currently admit the operator or an active Project owner/admin. Non-operator
Station-control callers also stay in their recorded Project.

## Speech and media tools, on demand

Nothing is installed with Station. After enabling either preview, use
`station media-tools status` to inspect missing components and their sizes,
then `station media-tools download --yes` to consent. Status/import/transcription
never download automatically. This follows the
Browser pane's [Chromium acquisition](../../src-server/services/browser/chromium-acquisition.ts):

1. A tool already on the host (for example `ffmpeg` on `PATH`) is used.
2. Otherwise a pinned build this Station already downloaded into
   `<STATION_HOME>/media-tools/<component>/<version>/` is used.
3. Otherwise the answer is `needs-consent`, with each component's version
   and download size. Status reads never touch the network.

Each archive must match its pinned byte length and SHA-256, recorded per
platform at pin time. Extraction is checked so nothing lands outside the
install directory.

| Component | Pinned source | License | macOS arm64 download |
| --- | --- | --- | --- |
| `ffmpeg`, `ffprobe` | `eugeneware/ffmpeg-static` b6.1.1 (FFmpeg 6.0) | GPL-3.0; run as a separate program, never linked; its license file is kept beside it | 19 MB + 19 MB |
| Speech runtime | `k2-fsa/sherpa-onnx` v2.0.0, shared, no TTS | Apache-2.0 | 40 MB |
| Speech model | NVIDIA Parakeet TDT 110M, int8 (sherpa-onnx `asr-models`) | CC-BY-4.0; attribution shown in Station's notices | 108 MB |

About 186 MB in total on macOS arm64. Builds exist for macOS (arm64, x64),
Linux (x64, arm64) and Windows x64. `ffmpeg-static` has no Windows arm64
build; that platform reports the tool as unavailable rather than guessing.

The device decoder resolves ffmpeg through the same media-tools resolver.
Already-present tools remain available to existing decoding with both previews
off. Its `install-ffmpeg-or-consent-to-pinned-download` remedy requires either
preview and is served by
`station media-tools download --yes`; decoder/status reads never download.

### Why sherpa-onnx and Parakeet

whisper.cpp publishes no prebuilt binaries in its current release, so
Station could not download it on demand. sherpa-onnx publishes prebuilt
command-line bundles for every desktop platform and runs many model
families, including streaming models for live voice.

A spike on 2026-10-24 (macOS arm64, a 14-second synthesized narration with a
1.5-second pause) compared three models through `sherpa-onnx-offline`:

| Model | Download | Transcript | Timestamps | Speed (real-time factor) |
| --- | --- | --- | --- | --- |
| Whisper tiny.en | 118 MB | One error ("Book here") | None from the published export | 0.04 |
| Moonshine tiny (en) | 30 MB | Correct | None | 0.02 |
| Parakeet TDT 110M int8 | 108 MB | Correct, with punctuation and case | Per token; the pause is visible | 0.06 |

Word timing is what lines frames up with "this" and "here", so Parakeet is
the default. The spike used synthesized speech; accuracy on real narration
is NOT_VERIFIED until the importer runs on real recordings.

Consumers resolve tools through `MediaToolsResolver`
(`src-server/services/media-tools/media-tools-resolver.ts`); resolution never
downloads.

## Local transcription

A server module, `Transcriber`
(`src-server/services/transcription/transcriber.ts`), turns admitted browser audio or
Walkthrough video into segments with token timestamps. Its one adapter runs the
sherpa-onnx recognizer with the pinned model and owns conversion and
segmentation of long input. A missing tool or model is `unavailable`, never
an empty transcript. It has two consumers:

- the **video importer**, below;
- **voice**: a new speech-to-text provider, "Station (local)", registered in
  the SDK's `voiceRegistry` beside the Web Speech provider. It records
  push-to-talk audio in the client and sends the clip to the server for
  transcription, so voice works where the browser has no speech recognition
  on the selected Station host (a remote client uploads its audio). Streaming dictation with a streaming model is
  a later step. This is the local speech-to-text the voice epic
  ([#84](https://github.com/kontourai/station/issues/84)) folded in from
  [#197](https://github.com/kontourai/station/issues/197); unlike #197's
  sketch, Station pins and verifies its own downloads instead of driving a
  package manager.

### Lane A decisions

- `station media-tools status` lists components, versions and pinned bytes;
  `station media-tools download --yes` starts an operator-only download.
  `GET /api/media-tools/status` reports progress and failures; the download
  endpoint accepts only literal `consent: true`.
- macOS uses the universal2 shared no-TTS CLI; Linux x64 uses shared no-TTS;
  Windows x64 uses shared MD Release no-TTS. v2.0.0 has no Linux arm64 no-TTS
  CLI: that platform uses the CPU shared bundle, including unused TTS tools.
  Windows arm64 has no downloadable pin.
- No VAD model is needed. ffmpeg detects silences at -35 dB for at least
  300 ms. Chunks prefer a silence midpoint between 20 and 40 seconds;
  continuous speech splits at 40 seconds. Token times gain the chunk offset.
  A forced boundary can cut a word; overlapping recognition/deduplication is
  deferred until evidence warrants it.
- Input duration is limited to 60 minutes (reject, never truncate), local file
  size to 2 GiB, total wait plus execution to 15 minutes, and transcript output to 2 MiB.
  One adapter is shared across importer and transcription routes. Only one
  transcription runs at once; at most four requests wait FIFO and honor queued
  cancellation. Overflow returns `failed/busy` (HTTP 503, `Retry-After: 5`).
  This bounds recognition work and retained uploads across previews.
  `POST /api/transcription` is authenticated and Project-independent, accepts
  a raw browser audio body up to 32 MiB, and streams to a private temporary file.
- Archive links and special files are refused before extraction; the selected
  upstream archives contain none. FFmpeg gzip expands into fixed binary names.
  The [pins](../../src-server/services/media-tools/media-tools-pins.ts) record
  every selected URL, exact byte count and SHA-256.
- Attribution lives beside Station's existing third-party notices under
  `packaging/licenses/media-tools/NOTICE` and is copied into server builds.


Local transcription accepts self-contained media containers, not playlist or
virtual inputs (concat/HLS/DASH/SDP). ffprobe and input decoding use narrow container
and codec allowlists plus file-only protocols before reading media, so an uploaded payload
cannot request network resources or delegate file selection to a playlist.
Obscure containers outside the allowlist return `invalid-input`; this narrows the
original "any ffmpeg input" proposal at the authenticated upload boundary.

## The video importer

Input: one local video file with narration (`.mp4`, `.mov`, `.webm`), from
any recorder, including the built-in phone screen recorders with "show
touches" turned on.

Pipeline:

1. **Probe.** `ffprobe` reads duration, dimensions and whether there is an
   audio stream. A file over the duration limit is refused. A file with no
   audio is imported with `transcript: 'absent'`.
2. **Transcribe.** `ffmpeg` extracts 16 kHz mono audio and the
   Transcription module produces segments with token timestamps.
3. **Choose frames.** Candidates come from four signals, then are merged
   within a short window and ranked:
   - **deictic words** in the transcript: "this", "here", "that", "these",
     "there", "look", taken at the word's timestamp;
   - **scene changes** from `ffmpeg`'s scene score;
   - **pauses** in speech, just after the person stops talking;
   - ten-second **interval candidates**, with half the frame budget reserved
     for even coverage across the video stream (at most a 31-second selected
     gap for a 30-minute video, before failed JPEG extractions are skipped).
4. **Extract.** Selected frames are written as JPEG, longest edge capped.
5. **Write.** The manifest and frames are written as one Walkthrough
   directory under the Project: `<STATION_HOME>/projects/<slug>/walkthroughs/<id>/`.

What this importer does not do: detect circles, taps or ink in the video.
The agent that reads a Walkthrough can see images, so a visible touch dot or
pen stroke in a well-chosen frame is enough. The importer's job is to pick
the frame and line it up with what was said. Mark detection can be added
later if real recordings show the agent missing what was pointed at.

### Expected quality

| Channel | Expected |
| --- | --- |
| Transcript | Good on clear narration in a quiet room (NOT_VERIFIED on real speech) |
| Frames at the right moment | Good when the person says "this" or "here" while pointing |
| What was pointed at | Visible in the frame when touches or a pen are on screen; not otherwise |
| Component or source file | Not available from video (`elements: 'absent'`) |
| Console and network | Not available from video |

## Interfaces

- **CLI:** `station walkthrough import <file> --project <slug>`, and
  `station media-tools status` / `station media-tools download --yes` to
  inspect or consent to downloading the media tools.
  `station walkthrough list` and `station walkthrough show <id>` read imports;
  all three Walkthrough commands require `--project <slug>`.
- **Routes:** under `/api/projects/:projectSlug/walkthroughs`, Project
  `view` to read and `drive` to import, listed in the pairing route-scope
  table.
- **Station-control MCP:** `list_walkthroughs` and `get_walkthrough`, which
  returns the manifest and frames as image content in bounded pages.
- **Import as a long-running operation,** reported with the existing
  `ActionOperation` statuses and phase progress (probe, transcribe, frames,
  write).

## Privacy

A recording can show code, session contents and credentials. Everything in
the first delivery runs on the host: no capture-tool cloud and no hosted
transcription. Walkthroughs are stored with the Project and shared only when
an agent or person explicitly attaches them to something outside Station.

## Not in this delivery

- The Annotate importer, native capture, and mark detection in video.
- Streaming dictation for voice.
- The triage skill that groups a Walkthrough into findings and routes them
  to a tracker.
- A UI for recording or reviewing Walkthroughs.

### Import verification repairs

The importer retains container duration for transcript bounds and uses video-stream
duration for frame candidates, including Matroska `DURATION` stream tags. When
video duration is absent, a video-only packet-copy scan runs even if the container
has a duration. An empty video-only scan falls back to the validated container
duration, with missing JPEG output still skipped. Duration-less WebM uses
packet-copy scans capped at 30 minutes
plus one second; reaching the cap fails rather than publishing truncated success.
An extraction that writes no JPEG is skipped. Counts describe actual JPEGs, and
zero decoded frames fails without publishing an artifact.

A bounded keyframe timing probe selects keyframe-only scene decoding when gaps
are at most one second; sparse or unavailable timings use full decode. Both
modes sample at 5 fps and fit within 640 by 640 pixels without upscaling,
preserving aspect ratio before the 0.3 scene threshold. Transitions between
sampled frames may be missed. The scene deadline is `min(300s, 30s + 0.5 × video duration)`;
individual frame extraction uses `min(90s, 30s + 0.02 × video duration)`.
Each subprocess is additionally bounded by the remaining 30-minute processing
budget. Detection quality on arbitrary real screen recordings is not qualified
by the synthetic fixture. The [import guide](../guides/walkthroughs.md#limits-and-storage)
owns upload progress, cancellation and recovery behavior.
