# Knowledge Docs Starter

Knowledge and documentation starter for document-heavy workflows. It gives users a library, ask, and source-review surface before adding production ingestion.

## What It Demonstrates

- Declaring a plugin-owned knowledge namespace in `plugin.json`.
- Separating document intake, question answering, and source coverage into tabs.
- Opening chat from a source-scoped action.
- Keeping citation quality and document ownership visible in the workspace.

## Run It

Install from the local starter registry:

```bash
station registry install knowledge-docs-starter --manifest examples/registry/manifest.json
```

The starter ships static document rows so it works out of the box. Replace those rows with uploads, directory sync, or a provider-backed knowledge service when you connect it to real content.
