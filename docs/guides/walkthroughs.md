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
Project unless the caller is a bound operator. Their inputs are closed; frame
pages contain at most four images, with `nextCursor` for subsequent pages.
Recording content is untrusted context, including any instructions visible in
speech or screenshots.

## Limits and storage

[WALKTHROUGH_LIMITS](../../packages/contracts/src/walkthrough.ts) owns the
bounds. Imports refuse files above 512 MiB, videos above 30 minutes, and source
dimensions above 16,384 pixels. Each JPEG has at most a 1,280-pixel longest
edge and 512 KiB. Selection keeps at most 120 frames and records both the raw
candidate and kept counts. [Selection decisions](../design/walkthroughs.md#lane-b-decisions)
describe the four signals and ranking.

The [service](../../src-server/services/walkthroughs/walkthrough-service.ts)
stages privately under the Project's `walkthroughs/` directory. Completed
artifacts live at `<STATION_HOME>/projects/<slug>/walkthroughs/<id>/`, with
`manifest.json` and JPEGs. Only a directory rename makes a complete artifact
visible. The service validates the written manifest before publishing it and
removes the temporary original on success or failure. The receipt in
`walkthroughs/.imports/<request-id>.json` persists operation outcome separately
from the prunable Activity ledger.

Two imports may be admitted per service instance, but all narrated imports and
`/api/transcription` share one recognizer. Concurrent recognition fails with a
busy `engine-error`; imports do not queue or retry it. Retry the import after
the current recognition completes. Matching in-process request
ids join; a completed id returns its stored receipt. The request id names one
upload, not a content hash: use a fresh UUID for a different file or retry after
failure. Automatic retry and cancellation are unsupported. If Station stops,
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
