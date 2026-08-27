# Flow Report: dogfood-017-acp-canonical-cutover

- Definition: station-delivery v1
- Subject: dogfood-017-acp-canonical-cutover
- Status: completed
- Current step: readiness
- Next action: run complete; no further action required
- Continuation: resume from readiness, not chat memory

## Gates

- PASS implementation gate: verify:static \(biome + e2e manifest + tsc + unit tests\) passes for the change. satisfied
  - Evidence: ev.1783183245671.1
- PASS verify gate: Behavioral verification recorded for the change: focused Playwright lane, smoke run against a live instance, or equivalent observed-behavior evidence — not just unit tests. satisfied
  - Evidence: ev.1783183390925.2, ev.1783183404858.3
- PASS readiness gate: Veritas merge-readiness evidence for the working tree, attached as a Station-asserted Hachure TrustBundle \(claim \`governance.merge-readiness\`, status \`assumed\`\). Flow 1.3.x replaced the surface.claim model with trust.bundle evidence; the trust model downgrades \`verified\` without backing verification, so the Station-asserted readiness claim is \`assumed\`. Attaching the full Veritas TrustBundle with verification backing \(→ \`verified\`\) is a future enhancement. satisfied
  - Evidence: ev.1783183406978.4

## Accepted Exceptions

None.

## Evidence Manifest

- ev.1783183245671.1: trust.bundle for implement-gate (a1d9de40f76a90d201de6e69743a740eff6737ef07e8699162cf26bb9f1dffd4)
- ev.1783183390925.2: trust.bundle for verify-gate (f2f2d85967e35186a56f5e317d04178e0d0a81e37f571bc29b7fab9acbba8747)
- ev.1783183404858.3: trust.bundle for verify-gate (e6743b704acd37910d8158a24723eab8582750205b0f73a6d30dd82ef8a07d25)
- ev.1783183406978.4: trust.bundle for readiness-gate (958ca87892043ca5a4d6b8f61e43d5b20705e7e0b9fbe926001a7e1ac3775c88)
