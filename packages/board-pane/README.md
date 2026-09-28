# @kontourai/station-board-pane

The Console Board as a first-party, in-process React Workspace Pane. It reads
Station operating state and availability, derives the published Console board
model, and routes user intents back through Station.

## Package and entry points

The [manifest](./package.json) marks this as a **private workspace package**.
Its root exports `ConsoleBoardPane` and its host/props types. The
`/workspace-board-pane` entry exposes the React-free descriptor and instance
helpers. That entry belongs to this package, not `station-contracts`.

Exports select TypeScript source. `npm run build --prefix packages/board-pane`
emits local compiler output; it does not change the export map or publish the
package. Station's bundler handles React, CSS and source dependencies. A
`publishConfig.access` value does not override `private: true`.

The implementation uses these package surfaces:

- `@kontourai/station-contracts` — the Workspace Pane descriptor/instance
  and host contracts (`/workspace-pane` and `/workspace-pane-host-contract`).
- `@kontourai/station-sdk` — the operating-state, availability, and board
  intent query hooks.
- `@kontourai/console-ui` — the published `BoardView` and `deriveBoard`.
- `@kontourai/ui` — the shared `Empty`/`Skeleton` primitives.

The [boundary test](./src/__tests__/package-boundary.test.ts) rejects application
internal imports; it does not prove that every dependency behavior is unchanged.
`ConsoleBoardPaneHost` is an alias for `WorkspacePaneHostContract`: navigation
and confirmation use host methods, rather than injected React component slots.
The error primitive is imported from SDK `/error-state`; responsive derivation
lives in the pane. The [core mounter](../../src-ui/src/views/board/BoardWorkspacePane.tsx)
supplies the host contract.

The descriptor currently requires Project context, supports standalone
placement and has preview lifecycle status. A card selection can navigate;
an execution intent goes through the SDK mutation and server resolve/execute
path. A consent-required response prompts confirmation before resubmission.
The board itself does not grant authority or execute arbitrary Console intents.
See [Pane or shell](../../docs/design/pane-or-shell.md) for the design boundary.
