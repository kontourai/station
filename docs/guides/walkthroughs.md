# Import a Walkthrough

A Walkthrough combines a recording's transcript and selected JPEG frames in
one [manifest](../reference/contracts.md#walkthrough). An agent reads that
manifest and the images; it does not need the recorder's API. Visible pointer
dots or ink stay in the images. The importer does not detect marks or identify
application elements.

This is a staged source implementation. The personal-host runtime mounts it
only when its owner supplies `walkthroughImportDependencies` in
[runtime-routes.ts](../../src-server/runtime/routes/runtime-routes.ts), using
lane A's `MediaToolsResolver` and `Transcriber`. This lane provides no download
or recognition implementation. Hosted mounting and published-package behavior
are unverified.

## Import and read

Use a running Station target and its normal CLI authentication:

```bash
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
--yes` (the separate lane A command), then a new import. Unsupported platforms
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

Two imports run concurrently per service instance. Matching in-process request
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
transcriber. It does not prove recognition quality or lane A integration.
