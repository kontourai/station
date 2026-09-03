# Demo Workspace Panes

A starter workspace plugin that demonstrates the current Workspace Pane contract with:

- a real `plugin.json`
- versioned `workspacePanes` declarations in `plugin.json`
- a bundled React entrypoint
- a namespaced agent

## What It Shows

- multiple Project-scoped panes (`Welcome`, `Notes`)
- opening the chat dock from plugin UI
- reading auth and agent state from `@kontourai/station-sdk`
- persisting plugin-local state in the browser

## Install

```bash
./station plugin install ./examples/demo-layout
```

Or add the local registry manifest first and install from the registry:

```bash
./station registry ./examples/registry/manifest.json
./station registry install demo-layout
```

## Why Keep This Example

`minimal-layout` is the smallest possible starting point. `demo-layout` is the next step up: it is still approachable, but it demonstrates the actual structure most UI plugins will need in practice.
