# Smart Routing Plugin

Deterministic server-side example plugin for routing a request to a model tier.
It is intentionally local, testable, and dependency-free.
It returns a recommendation; it does not select a model or launch an Agent.
The server module needs the trusted `plugin.server` grant even though the
legacy manifest's explicit permissions array is empty. Installation and host
review follow the [plugin guide](../../docs/guides/plugins.md#installation-flow).

## Route

`POST /api/plugins/smart-routing/decide`

```json
{
  "prompt": "Summarize this short note quickly."
}
```

Response:

```json
{
  "modelTier": "cheap",
  "reason": "budget-intent",
  "fallbackUsed": false,
  "signals": {
    "charCount": 34,
    "wordCount": 5,
    "hasBudgetIntent": true,
    "hasCodeBlock": false,
    "hasComplexIntent": false,
    "hasLongContext": false
  }
}
```

The plugin also supports `GET /decide?prompt=...` for simple manual checks.

## Routing Rules

- Without a supported explicit tier, empty or malformed input returns
  `modelTier: "default"` with `fallbackUsed: true`.
- Short, simple prompts return `modelTier: "cheap"`.
- Prompts with code, long context, or complex markers such as `architecture`,
  `migration`, `security`, or `debug` return `modelTier: "strong"`.
- Explicit `modelTier` or `tier` values of `cheap`, `strong`, or `default` are
  honored and reported with `reason: "explicit-tier"`.

The route calls the optional `recordRoutingDecision` hook on its host telemetry
context. Station's implementation records `station.routing.decision` with
plugin, tier, reason and fallback attributes. Calling the pure `decideRoute`
helper does not emit that metric or exercise HTTP authentication.
