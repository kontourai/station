# @kontourai/station-cli

## 0.6.0

### Minor Changes

- d926a67: Expose exact authorized terminal tool-result reads and identity-only Task Keep
  operations through typed clients and CLI commands. Protected reads validate
  Thread projections, withhold stale content, and preserve generic failure states.

## 0.5.0

### Minor Changes

- b118d6e: Command Station Slice B (#1984, #1986, #1991): the CLI now dispatches through a
  Commander program, `station [dir]` (in a TTY) lazily opens a running Station in
  the browser (finding it through the instance registry and the
  `GET /api/system/instance` probe) and offers inline / service / temp-home when
  none is running, `station service` (in a TTY) presents an interactive menu, and
  a one-time short-TTL local-bootstrap token lets that opener hand the local
  browser a paired credential through the URL fragment without any peer-address
  trust.
  
  Commander is bundled (a devDependency esbuild inlines into `dist/station.mjs`),
  not added to `dependencies`: the published tarball still carries only the
  audited `@napi-rs/keyring` runtime dependency (`bundle.test.ts`). The
  interactive menus use Node's built-in `readline/promises` rather than a new
  prompt dependency, so nothing new reaches the runtime install graph.

## 0.4.0

### Patch Changes

- Updated dependencies [2b01d6a]
  - @kontourai/station-shared@0.4.0
