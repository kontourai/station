# Coding Starter

Code-focused layout starter for teams that want a workspace shaped around files, terminal output, diffs, and agent handoff.

## What It Demonstrates

- A file-browser panel that can later be backed by a provider.
- A terminal-output panel for command and test summaries.
- A diff-review tab with explicit behavior, test, and verification prompts.
- A chat handoff button using the host navigation SDK.

## Run It

Install from the local starter registry:

```bash
station registry install coding-starter --manifest examples/registry/manifest.json
```

The starter uses static fixture data so it works immediately. Replace the file list, terminal output, and diff source with plugin providers when you connect it to a real repository.
