# Contracts scope

`@kontourai/station-contracts/*` owns stable cross-package domain shapes. Read [the contracts reference](../../docs/reference/contracts.md). Keep modules domain-oriented; do not put runtime helpers, parsers, build helpers, or Node utilities here. New consumers import the owning contract subpath directly.

Make compatibility changes explicit and run the focused contract/consumer tests selected for the edited paths.
