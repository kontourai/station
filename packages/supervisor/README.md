# Station process supervisor

`@kontourai/station-supervisor` is the process that is meant to own a Station
instance's listening sockets and its core server generations. It holds the
listening sockets while one core server generation hands over to the next,
rolls a failed handoff back, and restarts a crashed core. New connections wait
in the kernel backlog during a swap instead of being refused.

Existing connections are not carried across a handoff. The outgoing generation
drains them for a bounded time: busy keep-alive connections close after their
response, idle ones close after a short grace, and SSE streams are ended. A
generation still running at its drain deadline is terminated along with any
connections it still holds; only an active voice call extends that deadline,
up to a cap. Clients reconnect to the next generation. Desktop, the tray and
the CLI become clients of the supervisor's control channel.

**Status: phase 1 implemented, adopted by `station start` and `station
service run`.** The control channel, listener handoff, sequential generation
handoff with rollback, and crash restart are implemented. The core server
runs as a supervised generation (it parks until promoted, binds its
listeners through the supervisor, and drains on handoff). `station start`
starts this supervisor, and so do `station service run` (the installed
service, the container image, and the archive launcher's service child) and
everything that starts through it; `STATION_DIRECT_LAUNCH=1` opts out.
`station restart`, `station stop`, and `station supervisor status` reach it
by running the bundle as a client (`--request`). Desktop still runs its own
sidecar; see the [design](../../docs/design/process-supervisor.md).

- Design and phases: [Station process supervisor](../../docs/design/process-supervisor.md)
- Ownership decision: [process supervisor decision](../../docs/decisions/process-supervisor.md)
- Wire protocol: [`./protocol`](src/protocol.ts), exported as
  `@kontourai/station-supervisor/protocol` for future control-channel clients

## Build and test

The package is private and is not published. The root `esbuild.config.mjs`
bundles [`src/main.ts`](src/main.ts) into `dist-server/station-supervisor.js`
with the options in [`build-options.mjs`](build-options.mjs). The bundle imports
only Node built-ins, so it runs with no `node_modules` beside it;
[`bundle.test.ts`](src/__tests__/bundle.test.ts) checks that.

```sh
npm run typecheck:supervisor
npm run test:focused -- packages/supervisor/src/__tests__/handoff.test.ts
```
