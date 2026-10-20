# Station process supervisor

`@kontourai/station-supervisor` is the process that is meant to own a Station
instance's listening sockets and its core server generations. It keeps the
listeners open while one core server generation hands over to the next, rolls a
failed handoff back, and restarts a crashed core, so an upgrade or restart does
not drop connections. Desktop, the tray and the CLI become clients of its
control channel.

**Status: phase 1 core implemented, not adopted.** The control channel, listener
handoff, sequential generation handoff with rollback, and crash restart are
implemented and tested against a fixture core server. No launch mode runs the
supervisor yet, and the core server has no supervised mode. Until adoption,
Station's lifecycle is owned by the existing launchers listed in the
[design](../../docs/design/process-supervisor.md).

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
