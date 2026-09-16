# Minimal Workspace

A host-only Agent Plugins 1.0 package with one Station Workspace Pane. It lists
Agent definitions, opens the existing chat dock on an explicit click, and shows
a toast. It contributes no portable Skills or MCP servers; other conformant
clients can read the package but receive no portable components.

The package ID and source directory remain `minimal-layout`, preserving installed
identity. The friendly display name is **Minimal Workspace**.

## Requirements

Use a Station build with Agent Plugins 1.0 consumption, the
`io.kontourai.station` namespace, and the public SDK context for direct and placed
plugin Panes. This example imports only the public Station SDK and React. It has
no relative dependency on Station's source or build scripts. Availability of a
candidate build does not imply that its SDK or CLI has been published to npm.

## Install and place

1. Preview the source with `station plugin preview ./examples/minimal-layout`,
   or enter its path in **Plugins → Install plugin**.
2. Review the declared `navigation.dock` permission and install. Installation
   registers the contribution; it does not attach it to every Project.
3. Open the target Project, choose **Add pane**, select **Minimal Workspace**,
   and open the offered occurrence.
4. Read the Agent definitions. A listed definition does not imply that its
   engine is connected or ready.
5. Choose **Open Chat Dock**. This is local navigation: it opens the existing
   dock and shows a toast. It does not send a prompt, select an Agent, start a
   conversation, or navigate to another Project.

If activation is pending or the Pane is unavailable, use the host's displayed
reason and available recovery controls. Do not bypass an unavailable occurrence by
mounting its component directly. Project Layouts remain the host's named views;
this package no longer declares a legacy plugin Layout.

## Develop and package

The manifest points at `./src/index.tsx`. Station's supported build command
bundles that authored source and its CSS:

```sh
cd examples/minimal-layout
station plugin build
station plugin preview .
station plugin install .
```

When copying the example outside this repository, run those commands from the copied directory and install compatible SDK/React development dependencies with
your package manager's reviewed, script-disabled workflow. `npm run build` is
an optional TypeScript/declaration build; `npm run dev` watches it. Neither
command installs the plugin. The package includes its authored `src/` files so
its manifest entrypoint remains present after packing.

There is no automatic package-install hook, no copy into Station's source tree,
and no `file:../../...` dependency. Installing into a real Station remains an
explicit operator action.

## Manifest and behavior migration

| Previous behavior/input | Current behavior/input |
| --- | --- |
| Top-level Station `entrypoint`, `capabilities`, `permissions` | These fields live under `extensions["io.kontourai.station"]`; the root uses the published Agent Plugins 1.0 schema. |
| `layout` plus `layout.json` with one workspace tab | One explicit `workspacePanes` declaration; descriptor and renderer IDs are retained from the structural migration candidate. |
| Title/description read through optional legacy Layout props | Authored Minimal Workspace presentation; no ambient Layout identity is needed. |
| `useAgents()` | The same public SDK hook, supplied by the host's admitted Project/Pane SDK context. |
| Open Chat Dock through `setDockState(true)` and optional `onShowChat` | The canonical SDK navigation call remains. The unused optional legacy callback is removed. No sending or default-Agent behavior is introduced. |
| Toast after opening the dock | Preserved through the public `useToast()` hook. |
| `postinstall` copied output into a repository-relative workspace directory | Removed; preview/install and Project placement are explicit. |

This package adds no command-palette contribution and does not choose the
unresolved local command-withdrawal semantics in
[#1419](https://github.com/kontourai/station/issues/1419). The rest of the example
migration remains tracked by [#265](https://github.com/kontourai/station/issues/265);
this example does not establish that every old parser or adapter can be deleted.
