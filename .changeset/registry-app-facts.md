---
'@kontourai/station-contracts': minor
---

Plugin catalog entries say what each app is. `RegistryItem.app` carries the
facts read from a local package's manifest and layouts when the catalog is
listed: its screens and panes, where it opens, what it works with, the agents,
prompt actions and knowledge it brings, the tool servers it needs, and whether
one of its views is a sandboxed tool view. A plugin with no screen reads
`{ kind: 'none' }`. `deriveRegistryAppFacts` and `parseRegistryAppFacts` are
the contract's derivation and reader.
