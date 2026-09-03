# Getting Started Starter

Default Workspace Pane starter for new Station plugins. It demonstrates a small, copyable workspace with no external services.

## What It Demonstrates

- Reading scoped agents with `useAgents()`.
- Opening the chat dock with `useNavigation()`.
- Sending host feedback with `useToast()`.
- Wiring named pane renderers through versioned declarations in `plugin.json`.

## Run It

From this repository, install it through the local registry manifest or copy the directory into a Station plugin home:

```bash
station registry install getting-started-starter --manifest examples/registry/manifest.json
```

The plugin is intentionally static. Replace the copy and panels first, then add providers only when a pane needs persistent data.
