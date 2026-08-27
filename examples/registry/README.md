# Example Registry Manifest

This directory holds the two registry manifests Station ships.

- **`default.json` is the one that ships as a default.** When `registryUrl` is
  unset, Station serves this manifest, so a fresh install can browse and install
  working examples with no configuration. It lists only the dependency-free
  starters, so installing one never needs the network.
- **`manifest.json` is the fuller catalog**, adding the examples that pull npm
  dependencies (`enterprise-layout`, `survey-review-workbench`,
  `fieldwork-review`). Point `registryUrl` at it to expose those too.
- Relative `source` values resolve from this directory, so both are reproducible
  from any checkout.
- `npm run proof:registry-manifest` validates `manifest.json` through both the
  server registry provider and the CLI registry resolver.
  `src-server/providers/registries/__tests__/default-registry.test.ts` holds
  `default.json` to its stricter contract: every source resolves, no listed
  plugin declares dependencies or a host `build` command, and it stays a subset
  of `manifest.json` so the two cannot drift apart.

## Scope

This is the reproducible local fixture proof on which Phase 2 was closed. It is
not evidence that a registry has been published at a stable URL. Hosted
publication is separate distribution work and requires its own provider/CLI
verification.

## Local Use

```bash
./station registry ./examples/registry/manifest.json
./station registry install demo-layout
```

Read `plugins[].id` in `manifest.json` for the current fixture entries.
