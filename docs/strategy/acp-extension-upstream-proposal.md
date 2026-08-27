# Upstream ACP proposal draft: session/compact and session/export

> **Status: DRAFT — not filed.** Filing upstream (as an RFD/discussion on
> agentclientprotocol/agent-client-protocol) is an owner call. This is the
> staged text, per ADR 0013 and station#1815 §7. The ACP spec documents no
> path for an extension to become standard; the project's live practice is
> RFDs (e.g. the session-fork RFD) and discussions that stabilize into
> capability-gated core methods (`session/list`, `session/close`,
> `session/delete`, `session/resume` all took this path). This draft is
> shaped for that pipeline. Related existing threads to link when filing:
> discussion #60 (session history), #841 (paginated session/load history),
> the session-fork RFD (precedent for an UNSTABLE capability-gated method).

---

## RFD: `session/compact` and `session/export`

### Summary

Two capability-gated session lifecycle methods:

- `session/compact` — ask the agent to compact the session's context,
  reporting progress via session notifications and completing with a
  structured outcome.
- `session/export` — ask the agent for a durable, agent-native export of a
  session, returned as content or written to a client-designated path.

Advertised via `sessionCapabilities.compact` / `sessionCapabilities.export`
(`{}` = supported, omitted/null = not supported), following the existing
`sessionCapabilities.list`/`resume`/`close`/`delete` convention.

### Motivation (the evidence that this is general, not one vendor's)

Context compaction and session export exist today in multiple agents but
are reachable over ACP only through private extensions or not at all:

- Kiro's ACP surface declares `_kiro/session/compact` and
  `_kiro/session/export` (v3 early-access handshake `_meta`) and emits
  `_kiro.dev/compaction/status` notifications; clients that want to offer
  "compact context" for Kiro must hardcode a vendor namespace that has
  already drifted between that vendor's own docs and wire.
- The Claude agent bridge (agentclientprotocol/claude-agent-acp) surfaces
  compaction status to clients as `_meta`-decorated updates; the
  underlying engine exposes compaction natively.
- Clients (Zed, Station, JetBrains, marimo) all maintain transcript-side
  session records, but an agent-native export (the engine's own full
  record, including detail never streamed to the client) has no wire
  path — each client either shells out to vendor CLIs or does without.

Every client that wants these features today must bind to per-vendor
method names that the vendors themselves mark experimental. The
capability-gating mechanism that stabilized `session/list` fits both
operations exactly.

### Design sketch

```jsonc
// sessionCapabilities (agent → client, initialize)
{
  "compact": {},              // agent supports session/compact
  "export": {                  // agent supports session/export
    "formats": ["jsonl", "markdown"]   // agent-defined format ids
  }
}
```

```jsonc
// client → agent
{ "method": "session/compact", "params": { "sessionId": "..." } }
// → result: { "outcome": "completed" | "unnecessary" | "failed",
//             "tokensBefore": 123456, "tokensAfter": 23456 }  // optional counts

{ "method": "session/export",
  "params": { "sessionId": "...", "format": "jsonl" } }
// → result: { "content": ContentBlock[] } or { "path": "..." }
//   (agent writes only under a client-supplied directory, mirroring
//    fs capability discipline)
```

Progress during a long compaction rides the existing `session/update`
notification stream (a `compaction` status update variant), replacing the
per-vendor status notifications.

### Error semantics

Per the existing convention: calling either method against an agent that
did not advertise the capability is a client bug; agents answer `-32601`.
A supported call that fails answers a JSON-RPC error — not a
`{success: false}` result envelope. (Observed in the wild: one vendor's
extension methods answer soft-failure result envelopes in three different
dialects; making the error channel normative is part of the point of
standardizing.)

### What this deliberately does not include

- **Import** (the inverse of export) — no second implementation evidence;
  session/load + `mcpServers` re-supply already covers the resume case.
- **A compaction policy surface** (when/how aggressively) — engine-owned;
  the method is an imperative, not a policy channel.
- **Cross-agent export portability** — the export format stays
  agent-defined and agent-named; the capability standardizes *reachability*,
  not the artifact schema. Format convergence can follow adoption, not
  precede it.

### Compatibility

Purely additive: both methods are capability-gated, and agents that never
advertise them are unaffected. Vendors with existing private extensions
can advertise both (private + core) during migration, exactly as Kiro v3
already advertises core `sessionCapabilities.list` alongside its private
session extensions.
