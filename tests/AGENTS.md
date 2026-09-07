# Test scope

Tests prove observable contracts, not implementation accidents. Read the matching source scope as well as this file. Use `npm run test:focused -- <file...>` and keep fixtures hermetic; tests that start child processes or own shared output require the declared resource classification.

Do not represent a selector explanation, a deferred selection, or a rerun as completion evidence. Read [testing guidance](../docs/guides/testing.md) for the canonical lanes and escalation policy.

For fixture and cleanup work, follow [Fixture fidelity and test effectiveness](../docs/guides/testing.md#fixture-fidelity-and-test-effectiveness). Use `helpers/connection-fixtures.ts` for engine identity and `helpers/runtime-conversation-fixture.ts` for explicit conversation-open authority. Route unknown mock requests through `rejectUnexpectedFixtureRequest` and import the audited `test` from `helpers/fixture-audit.ts`; never answer an unmodeled API read with an empty success. Use ordinary Playwright actions for user journeys. Forced clicks, synthetic click dispatch, removing disabled/inert, and visibility-based early success hide the behavior under test. Domain-event injection (provider SSE, clipboard payload tests) is a separate, explicitly named fixture seam.

Run `npm run test:fixtures:check` before the focused browser journey. A source guard's PASS does not qualify legacy baseline sites or replace the runtime journey. Use `npm run test:journeys:profile` for raw CPU/allocation profiles and `npm run test:mutation:smoke` to prove the curated critical assertions fail under a known defect.
