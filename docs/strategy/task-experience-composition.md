# Task Experience Composition

> **Status:** experimental tracer bullet for #495, stacked on the unmerged #496
> durable Task workspace. The labels **Direct**, **Deliver**, **Learn**, and
> **Operate** are working product language, not final public naming.

Station is the place where one durable Task stays visible while a user changes
the kind of work they are doing. It does not become the authority for every
kind of work. Each experience keeps one owning product and must disclose both
that authority and its real availability.

| Experience | Owning authority | Current Station behavior | Next dependency-backed behavior |
| --- | --- | --- | --- |
| Direct | Station | Always available for exact Task identity, workspace binding, local files, diffs, artifacts, receipts, and optional external references. Inspection makes no verification claim. | Retain as the useful core experience when no optional Kontour product is installed. |
| Deliver | Builder Kit | Unavailable with a plugin-management fallback. Generic external Task metadata cannot establish Builder identity, availability, or completion. | Project the Builder surface from #251 and canonical lifecycle from #290 after typed producer contracts land. Only canonical receipt evidence may support a completion claim. |
| Learn | Knowledge Kit | Unavailable with a Knowledge-configuration fallback. Generic external Task metadata cannot establish Knowledge identity, provenance, or freshness. | Project the Knowledge pilot from #252 and render the store's published provenance and freshness without making Station the store. |
| Operate | Console | Unavailable with a link to the Console project. Generic external Task metadata cannot establish Console identity, availability, or operating state. Station has no Console state writer. | Consume a published Console surface or Task deep link after a typed producer contract lands. Console remains authoritative for projections and operating state. |

## Trust boundary

Task graph links with `targetType: "external"` are opaque handles with arbitrary
JSON metadata. They remain neutral references in Direct. Station does not use
`metadata.experience`, an HTTP(S) destination, or owner-shaped lifecycle fields
to promote one into Builder Kit, Knowledge Kit, or Console authority. Doing so
would let an untrusted reference hide an arbitrary destination behind a
first-party label.

A typed, versioned cross-product reference contract with trusted producer and
destination rules is required before any optional experience can become
available. Unknown producers and contract versions must remain opaque. Station
issue [#551](https://github.com/kontourai/station/issues/551) owns that contract
follow-up.

## Acceptance evidence

| AC id | Status | Command/test evidence | Source evidence | Gaps |
| --- | --- | --- | --- | --- |
| M1-AC1 | PARTIAL | `npx vitest run src-ui/src/__tests__/task-experiences.test.ts src-ui/src/__tests__/TaskWorkspaceView.test.tsx`; live Playwright desktop/mobile acceptance | `TaskWorkspaceView.tsx` keeps Task identity and workspace binding mounted while experience selection changes; the selection resets on a different Task id. | Installed Builder, Knowledge, and Console projections are not landed. |
| M1-AC2 | VERIFIED for tracer bullet | Focused unit and live browser suites cover unavailable fallbacks and prove hostile owner-shaped metadata remains a neutral Direct reference. | `task-experiences.ts` keeps Direct available and every optional experience unavailable until a trusted contract exists. | Dependency-specific recovery actions may change when their published surfaces land. |
| M1-AC3 | NOT_VERIFIED | Pending headless Builder and Knowledge conformance runs. | Station imports neither kit in this slice. | #251, #252, and #290 dependency stacks are not landed together. |
| M1-AC4 | VERIFIED for tracer bullet | View and live browser tests assert Direct inspection language, absent completion state, and refusal to interpret hostile metadata containing `lifecycle: "complete"`. | Owner-boundary copy says Station does not infer verification, completion, provenance, freshness, or operating state. | Canonical Builder receipt rendering remains dependent on #290. |
| M1-AC5 | PARTIAL | Focused tests prove a Console-shaped generic reference cannot create an Operate link or owner state. | This slice adds no server route, Console dependency, or Console state writer. | A published Console Task surface/deep-link contract is still pending, so Operate remains unavailable. |
| M1-AC6 | PARTIAL | Completed `dogfood-019-task-experiences`: exact `npm run verify:static`, live E2E, and Veritas readiness gates passed with zero exceptions. | This document separates current experimental behavior from dependency-backed next behavior and keeps working labels provisional. | Product owner ratification and user-facing naming evidence remain pending. |

No row above is release evidence. Independent code/security re-review and live
browser proof are complete, and the real Flow report is preserved under
`docs/strategy/dogfood/dogfood-019-task-experiences/`. The branch remains a
stacked experimental candidate until #496 and the relevant product contracts
land and merge is explicitly authorized.
