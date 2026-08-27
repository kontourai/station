# Smart Routing Plugin

Deterministic server-side example plugin for routing a request to a model tier.
It is intentionally local, testable, and dependency-free.

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
  "reason": "short-context",
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

- Empty or malformed input returns `modelTier: "default"` with `fallbackUsed: true`.
- Short, simple prompts return `modelTier: "cheap"`.
- Prompts with code, long context, or complex markers such as `architecture`,
  `migration`, `security`, or `debug` return `modelTier: "strong"`.
- Explicit `modelTier` or `tier` values of `cheap`, `strong`, or `default` are
  honored and reported with `reason: "explicit-tier"`.

Each decision records `station.routing.decision` through the plugin server
telemetry context with plugin, tier, reason, and fallback attributes.
