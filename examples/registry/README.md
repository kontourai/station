# Example Registry Manifest

This directory holds the two registry manifests Station ships. The Registry
marketplace can also connect this manifest as an additional source through
Add marketplace → Station JSON manifest, using its absolute path on the host.
Its entries still use the existing plugin preview, consent and installation
transaction. Source labels and author metadata do not establish verified
publisher identity or execution qualification.

- **`default.json` is the one that ships as a default.** When `registryUrl` is
  unset and the bundled file is present, Station uses this local catalog.
  Its plugin entries have no declared package dependencies or host build commands;
  that does not remove installation review, runtime prerequisites or permission
  grants. Missing bundled files yield no fallback registry.
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

The default catalog includes the
[Station-curated engineering collection](../matt-pocock-engineering/README.md).
It is an ordinary Agent Plugin with pinned attributed Skills and visual
definitions; choosing an agent, project/tracker setup and concrete action
authority are still required. A catalog listing alone does not qualify its
installed model journey.

## Scope

This is the reproducible local fixture proof on which Phase 2 was closed. It is
not evidence that a registry has been published at a stable URL. Hosted
publication is separate distribution work and requires its own provider/CLI
verification.

## Local Use

```bash
./station registry ./examples/registry/manifest.json
./station registry
```

Read `plugins[].id` in `manifest.json` for the current fixture entries.
The CLI's `registry install <id>` submits no preview consent; executable or
lifecycle-bearing entries are refused by the installer. [#2809](https://github.com/kontourai/station/issues/2809)
tracks that caller. For now use the Registry UI's reviewed preview flow, or
`./station plugin install ./examples/demo-layout` for the supported local
target. Setting a local CLI catalog does not configure an unrelated remote host.
