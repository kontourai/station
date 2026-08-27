# SDK scope

Read [the SDK reference](../../docs/reference/sdk.md) for the public tutorial and API surface. Plugins consume stable SDK exports; never import Station app internals. Keep public type and behavior changes documented in the canonical SDK reference rather than duplicating tutorial prose here.

Run focused SDK and affected consumer tests selected by `npm run gate:for`.
