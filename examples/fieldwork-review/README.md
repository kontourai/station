# Fieldwork Review

Fieldwork Review is a Station application plugin. It resolves task and source
files only within the selected project's configured workspace, stores run
artifacts beneath that project's `plugin-data/fieldwork-review/runs` root, and
opens Fieldwork's protected review application in a sandboxed frame.

## Boundary

- Station owns project selection, path confinement, run metadata, host
  navigation, and the frame that presents the review application.
- `@kontourai/fieldwork@0.14.0` owns run creation, review lifecycle, Survey's
  review surface, and reviewed output.
- The plugin creates its main `createFieldworkApplication()` facade lazily.
  Reviewed-source reads use additional short-lived owner facades, closed in
  `finally`. It uses Fieldwork's published facade and parsers rather than
  lower-layer extraction, review, runtime or dispatch APIs.
- Station invokes the plugin server module's `dispose()` lifecycle before
  replacement, update, uninstall, reload, and host shutdown. The host blocks
  new requests, drains active requests and queued project mutations, then
  closes every capability service before plugin authority is changed.
- The browser routes return run summaries and a capability-bearing review
  URL. It does not proxy source text, task content, prompts, credentials,
  provider receipts, or reviewed-output contents. The separate reviewed-source
  owner interface returns parsed descriptors and currentness assessments to
  Station's source-resolution service.

## Try it

The Station repository owns this example's development install in its pinned
pnpm workspace. Use the managed root setup to link the SDK and install the
example-owned Fieldwork dependency:

```bash
cd /path/to/station
npm run dependencies:ci
cd examples/fieldwork-review
npm run build
```

Install the resulting plugin from the Station Plugins page, approve the
trusted `plugin.server` permission through the host-owned review, then add **Fieldwork Review** to a
project. Enter paths relative to the selected project workspace, such as
`task.json` and `source.txt`.

The browser request helper uses raw fetch against the supplied API base; it
does not attach Station's SDK bearer/native transport. Same-origin cookie
access and remote/native access are different qualification cases. This audit
does not establish those live journeys or provider-backed run creation.

The browser receives the review URL only after Station calls the Fieldwork
application facade. The embedded frame is titled, sandboxed, and uses a
no-referrer policy; Fieldwork retains its own review UI and theme inside that
separate loopback origin.

Run storage rejects symlinked owned-path components and corrupt indexes fail
closed without being replaced. Request bodies are limited to 8 KiB. Before
opening a review the plugin checks limits of eight open services overall and
four per project; project mutations are serialized, while different projects
can run concurrently. Each open schedules a close after 30 minutes, with a
30-second retry after a failed close. A successful close first awaits the
service close, then persists `open: false`; disposal reports incomplete closes.
The browser polls availability while a review is open. The server obtains
Fieldwork's reviewed output and discards its contents, returning only a boolean;
an unclassified facade error also becomes `available: false`.

The browser query keys contain the project and run, but not the selected
Station. Switching Stations with matching IDs needs separate cache and state
qualification, as well as the transport qualification above.

## Verification

From the Station repository root:

```bash
npm run test:focused -- examples/fieldwork-review/server/__tests__/plugin-server.test.ts
npm run test:e2e:product -- --spec=tests/fieldwork-review.spec.ts
```
