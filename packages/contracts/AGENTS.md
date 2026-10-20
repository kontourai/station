# Contracts scope

`@kontourai/station-contracts/*` owns stable cross-package domain shapes. Read [the contracts reference](../../docs/reference/contracts.md). Keep modules domain-oriented. New consumers import the owning contract subpath directly.

A module may export pure helpers over its own shapes: boundary parsers and validators, reducers, classifiers and projection/page helpers. They must be pure and environment-free: no Node built-ins and no filesystem, network or process access. Take time as a parameter (a `now` default is the most a helper reads), and depend on nothing beyond published sibling Kontour packages. Service implementations, build helpers and Node utilities belong in `@kontourai/station-shared` or the owning app.

Each helper has one implementation, in the contract module that owns its shapes. Do not copy a contracts helper into `@kontourai/station-shared` or wrap it there; a consumer imports the contract subpath, and shared may only re-export it unchanged. Copies drift: a shared copy of `skillToGuidanceAsset` silently dropped `provenance`.

Make compatibility changes explicit and run the focused contract/consumer tests selected for the edited paths.
