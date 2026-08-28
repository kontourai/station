# Agent identity supported-surface inventory

This is the executable removal record for Station archive#1417. Station now uses one
clean, persisted Agent identity surface. The pre-release schema gate rejects an
incompatible home before application data is read or changed; no migration or
compatibility path exists.

| Checklist | Final state |
| --- | --- |
| Synthetic slug helpers and prefix parsing | Removed |
| Alias maps, tombstones, and promotion callbacks | Removed |
| Runtime/ACP Agent manufacture | Replaced by persisted registry defaults |
| CLI, SDK, UI, session, project, layout, approval, and receipt fixtures | Clean exact Agent IDs |
| Public engine connection IDs | Clean `EngineConnectionId` values (`claude`, `codex`, plugin/ACP ID) |
| Internal adapter selectors | Registry-only `runtimeConnectionId`; never serialized as Agent identity |
| Native first-run onboarding | Separate unconfigured catalog; registration atomically creates its same-ID default Agent |
| Plugin lifecycle | Transient load absence retains identity; explicit uninstall removes owned identities |

`npm run agent-identity:inventory -- --require-zero` scans source and tests for
synthetic literals plus the retired helper, SDK namespace parser, alias, migration, and promotion
symbols. Final success requires zero findings, zero unclassified paths, and zero
stale checklist entries. Negative tests that deliberately prove a synthetic ID
is rejected are explicit exemptions; they enforce the clean contract rather than
support the old surface.

<!-- agent-identity-supported-surfaces:start -->
```json
{
  "classifications": {},
  "exemptions": {
    "packages/contracts/src/__tests__/agent-identity.test.ts": "Negative contract test proving synthetic-prefixed IDs are rejected; it supports the clean identity grammar rather than legacy behavior.",
    "src-ui/src/__tests__/identicon.test.ts": "Hash-seed fixture literals only; it imports or calls no supported legacy identity machinery."
  }
}
```
<!-- agent-identity-supported-surfaces:end -->
