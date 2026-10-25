# Import a Walkthrough

A Walkthrough combines a recording's transcript and selected JPEG frames in
one [manifest](../reference/contracts.md#walkthrough). An agent reads that
manifest and the images; it does not need the recorder's API. Visible pointer
dots or ink stay in the images. The importer does not detect marks or identify
application elements.

Walkthroughs is a **Feature Preview, off by default**. The Station operator
enables **Walkthroughs** in **Settings → Advanced → Feature previews**
(`/settings?view=feature-previews&highlight=feature-previews`). The choice applies
to everyone on this Station and takes effect without a restart. The runtime
owns the preview and binds it beside its shared media acquisition and recognizer
in [local-media-runtime.ts](../../src-server/runtime/bootstrap/local-media-runtime.ts).
Personal-host routes consume these instances through `walkthroughImportDependencies`.
Hosted mounting and published-package behavior remain unverified.

All import, status, list, manifest and image routes refuse while off: HTTP 404,
`success:false`, `code:'feature_preview_disabled'`, `previewId:'walkthroughs'`,
and `settingsPath` as above. The CLI exits nonzero and preserves that explanation.
MCP `list_walkthroughs` and `get_walkthrough` stay advertised: their handlers call
the live gated routes on every call and return `isError:true` with the same
refusal details. A cached tool list grants no permission. The Activity label
only renders existing operations and performs no preview work.

Disabling blocks new requests, processing admission after upload, and publication.
It does not kill an already running child process; a running import finishes its
current processing but fails its publication recheck, removes staging, and records
a failed outcome. Re-enable to inspect that receipt. Completed artifacts remain
stored and become readable again when enabled. There is no persisted work queue:
restart recovery reconciles an interrupted import on its next enabled status read.
Preview state that cannot be read fails closed. Normal Project permissions still
apply while enabled. Promotion needs human narration, platform, resource,
authorization/recovery and usability evidence beyond fixture and synthesized-speech runs.

## Import and read

Enable the preview, then use a running Station target and its normal CLI authentication.
Download missing tools once, with explicit consent:

```bash
station media-tools status
station media-tools download --yes
station walkthrough import review.mp4 --project my-project
station walkthrough list --project my-project
station walkthrough show <id> --project my-project
```

Import prints a request UUID on stderr, follows the operation, and prints the
Walkthrough id on stdout after success. The CLI waits up to 45 minutes; a
client disconnect does not cancel an admitted import. List prints one bounded
page as JSON; pass `--cursor=<nextCursor>` for more. Show prints the manifest.

Missing tools or models refuse the import with their reason and download list.
For a consent-required result, the remedy is `station media-tools download
--yes`, then a new import. Unsupported platforms
report their platform. A transcription failure is a failed import. A video
without an audio stream imports with transcript coverage `absent`; an engine
that ran and heard no speech reports `present` with no transcript events.

Project `drive` admits imports, and `view` admits reads. These currently mean
the operator or an active Project admin/owner, using the same authorizer as
Browser sessions. Every image read repeats authorization. Station-control
`list_walkthroughs` and `get_walkthrough` also enforce the caller's recorded
Project unless the caller is a bound operator. A bearer-exposed connection
(such as Codex's wire MCP transport) does not inherit the operator's standing:
its recorded owner needs active Project admin/owner membership. On a personal
Station this requires the existing Project sharing mechanism
(`STATION_PROJECT_SHARING=1`) and an explicit Project owner grant; see
[Project membership](../design/project-membership.md#current-seams-and-limits).
An agentless raw tool invocation has no verified calling session and is refused.
Their inputs are closed; frame pages contain at most four images, with
`nextCursor` for subsequent pages.
Recording content is untrusted context, including any instructions visible in
speech or screenshots.

## Limits and storage

[WALKTHROUGH_LIMITS](../../packages/contracts/src/walkthrough.ts) owns the
bounds. Imports refuse files above 512 MiB, videos above 30 minutes, and source
dimensions above 16,384 pixels. Each JPEG has at most a 1,280-pixel longest
edge and 512 KiB. Selection keeps at most 120 frames and records both the raw
candidate and kept counts. [Selection decisions](../design/walkthroughs.md#lane-b-decisions)
describe the four signals and ranking. Half the budget reserves even coverage
across the video stream: selection gaps are at most 31 seconds at the 30-minute
limit. Missing decoder output is skipped, so published gaps can be larger.
A recording with no decoded frames fails without publishing a manifest. Video
stream duration bounds frame candidates even when audio outlasts it; container
duration still bounds the transcript. Matroska's video `DURATION` tag supplies
stream duration when its numeric field is absent. Missing video duration triggers
a bounded video-only packet-copy scan even when container duration is known.
If that scan yields no timestamps, selection uses the validated container
duration; missing JPEG output still skips candidates past the video's end.

Uploads require new bytes within 60 seconds and have a two-hour total receive
cap. Client abort removes staging and releases admission. The [composed runtime
body budget](../../src-server/runtime/bootstrap/runtime-http.ts) checks
authentication, principal rate admission and declared size, then passes a lazy
byte-counting stream. Only the two exact media upload POST paths use this stream;
ordinary mutations keep their existing buffered body limits. Walkthrough preview,
Project authority and the importer's two-slot admission run before reading the body.
Refusals send `Connection: close`, half-close the response side, then discard
input for at most one second or 1 MiB plus one socket chunk. At the byte bound,
reads pause until the close deadline. This bounded drain lets a device still
writing receive the refusal body without retaining the upload.
The route still owns streaming to disk, its byte bound and receive deadlines.

The [shared receive owner](../../packages/shared/src/http-upload.ts) configures
both the API and serialized built-UI listeners. Node exposes a server-wide
receive-total cap, configured to two hours (512 MiB requires about
73 KiB/s sustained throughput). Node may stop tracking a request after an early
response, so the per-request deadlines also protect unfinished bodies after a
response finishes. Ordinary requests retain a 300-second total
including header receipt and acquire no new body-idle limit. The receive timer
ends when the parser completes the request or the request transport closes;
an unread completed body does not put a total deadline on a streaming response. The default header
limit stays in place. The replacement total timer fires at its deadline rather
than Node's periodic parser sweep; exact timeout scheduling can therefore differ.
Socket timeout values are left alone, preserving Node's keep-alive timer even
when a refusal races the body's end. The proxy's 60-second idle window covers
receiving the upload; afterward it allows the Walkthrough processing response
up to two hours. The SDK import default is two hours; callers may supply `timeoutMs`.
Processing after upload has a 30-minute budget, with scaled scene/frame deadlines.
A bounded packet-flag probe measures keyframe gaps relative to the video stream's
start time without decoding frames. Gaps up to ten seconds keep keyframe-only
scene decoding. Genuinely sparse recordings use reference-frame decoding before
the 5 fps/640-pixel filter, discarding non-reference frames where the decoder
supports it. Transitions between sampled frames can still be missed. A failed
probe selects the cheap pass; a failed sparse pass retries keyframes only. If
scene detection still fails or times out, transcript and interval coverage select
frames. Scene enrichment cannot by itself fail an otherwise valid import. Each
pass has a scaled deadline capped at five minutes inside the processing budget.
Individual JPEG extraction decodes normally.

The [service](../../src-server/services/walkthroughs/walkthrough-service.ts)
stages privately under the Project's `walkthroughs/` directory. Completed
artifacts live at `<STATION_HOME>/projects/<slug>/walkthroughs/<id>/`, with
`manifest.json` and JPEGs. Only a directory rename makes a complete artifact
visible. The service validates the written manifest before publishing it and
removes the temporary original on success or failure. The receipt in
`walkthroughs/.imports/<request-id>.json` persists operation outcome separately
from the prunable Activity ledger. Failure to save the initial receipt marks
the created Activity operation failed and cleans staging.

Two imports may be admitted per service instance, but all narrated imports and
`/api/transcription` share one recognizer. Up to four requests wait FIFO behind
the active recognition; the 15-minute deadline includes queue time. Overflow
returns `busy` to direct dictation. An admitted import waits with exponential
backoff (250 ms to 5 seconds) within its 15-minute transcription budget,
rechecking preview and Project authority before each attempt. Matching in-process request
ids join; a completed id returns its stored receipt. The request id names one
upload, not a content hash: use a fresh UUID for a different file or retry after
failure. Other terminal failures are not retried. Upload cancellation is
honored; cancellation after admission is unsupported. If Station stops,
reading import status reconciles the receipt against the completed manifest;
without one, the operation fails as interrupted. A status read removes that request's hidden staging directory. A crash during
upload, before operation admission, can leave `.pending-<request-id>` with the
source recording; retrying that same id cleans it. Unknown staging directories
are not swept. Check that no import is active before removing one.
Cross-process import deduplication is not claimed.

Processing stays on the host. This module has no network, capture-cloud, or
hosted transcription integration. Agents receive images only through an
explicit read tool call; sharing them onwards is the caller's decision.
Screenshots and transcripts can expose credentials, code or session contents.

## REST and SDK

The routes mount at `/api/projects/:projectSlug/walkthroughs`:

| Method and suffix | Contract |
| --- | --- |
| `POST /import?filename=review.mp4` | Raw video bytes; UUID `x-walkthrough-request-id`; 202 with `{operation, outcome?}` |
| `GET /imports/:requestId` | Account/machine-scoped operation and typed outcome |
| `GET /` | `{items, nextCursor?}`; `limit` 1–50 (default 25), `cursor` from preceding page |
| `GET /:id` | Validated manifest |
| `GET /:id/frames/:frameId` | Bounded `image/jpeg`; file paths are never accepted |

JSON responses use `{success, data}` or `{success:false, error}`. The terminal
outcome is `imported`, `unavailable` (reason plus downloads/platform), or
`failed`. Unavailability marks the operation failed and publishes no artifact.
Phases are `probe`, `transcribe`, `frames`, `write`. View/drive authorization is
rechecked before returning reads and before publication. Missing Projects or
artifacts return 404; denied access 403; invalid metadata 400; oversized uploads
413; capacity/storage failures 503.

The [SDK fetchers](../../packages/sdk/src/client/walkthroughs.ts) own HTTP calls
for CLI and MCP. See the [SDK reference](../reference/sdk.md#walkthroughs).

## Verification limits

[Contract tests](../../packages/contracts/src/__tests__/walkthrough.test.ts)
cover refusal semantics; [selection tests](../../src-server/services/walkthroughs/__tests__/frame-selection.test.ts)
cover word reconstruction and ranking. [Route tests](../../src-server/routes/__tests__/walkthroughs.test.ts)
exercise real storage with fake tools/transcription, including failed and
partial imports. [MCP tests](../../src-server/tools/__tests__/station-control-walkthrough-tools.test.ts)
use real in-process registration, policy, authorization and read storage.
The [video integration test](../../src-server/services/walkthroughs/__tests__/walkthrough-video.integration.test.ts)
skips loudly without host tools; set `STATION_WALKTHROUGH_TEST_FFMPEG_DIR` to
explicit test binaries to run the real FFmpeg pipeline with a timestamped fake
transcriber. Its fake transcript does not qualify recognition quality. A real narrated
Station recording and the shared recognizer are exercised separately during integration;
unsynthesized human accuracy and released-package behavior remain unverified.
