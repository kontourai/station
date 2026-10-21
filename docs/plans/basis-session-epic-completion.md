# Basis and session surfaces: remaining epic work

Status: in progress. This plan tracks the remaining Station work for [#418](https://github.com/kontourai/station/issues/418); it is not a shipped-feature claim.

## Delivery

Keep the remaining work on `feat/basis-epic-418` and open one PR after its acceptance cases pass. The branch starts from published integration commit `d96f54887837be058c5e5119b8028daab0befea1`. Merge subsequent integration work or final `main` normally before publication. Preserve the earlier frozen rollup and its evidence.

## Acceptance

- [ ] Exact-answer inventory: tools, turn-scoped declared Outputs, decisions and explicit delegation Session references. Lineage never means support. Protocol 3 opts into the shape; older readers retain typed gaps. Continuations bind the dialect, authority and exact scope.
- [ ] Outputs in Basis: associate immutable Task Outputs only through recorded declaration provenance, never paths, titles or matching bytes. Unassociated kept Outputs remain separate.
- [ ] Inventory presentation: follow inputs, execution, outputs/claims, support/evidence and sources. Preserve explicit gaps, current versus kept scope, and item-local attention.
- [x] #3990: hosted assessments are not captured; malformed or oversized stored indices are corrupt; transient reads stay unavailable. Exercise the real module and fault injection.
- [ ] #3863: pin the invariant's Station-only scope, correct Task-creation wording, log exact identifiers, and repair peer credential isolation in room collaboration.
- [ ] #3951: a narrow side dock presents inventory without squeezing the transcript into a split column. Verify 400px geometry and focus return.
- [ ] #3959: Escape closes the appropriate inventory layer without navigating to a parent view; fault injection must detect loss of the event claim.
- [ ] #3975 and #3978: repair the mobile composer prerequisite and app-shell accessible names at their owners, preserving existing journeys.
- [ ] #3867 and the complete journey: exercise the MCP reader with real Session identity/ownership, inspection before Keep, exact retention, restart, revocation, publishing entry points, keyboard focus and accessibility relationships.
- [ ] Review documentation, regenerate derived content, run routed checks and Veritas readiness, and retain final combined evidence before the single PR.

## Ownership boundaries

The master integration owns the frozen Basis rollup, its Task-tab integration, current-answer refusal fixture, Details host and reserved-tab revocation repair. Its 1280×900 and 2400px geometry/mutation acceptance must be executed separately; source containment is not acceptance evidence.

Durable inbox and turn-boundary work (#3858/#3859) remains with the runtime workstream. Chat-card workspace labels, motion and scheduling remain with chat polish. Upstream semantic producers keep their own contracts; missing assessment, reviewed-source, narrative or gate facts remain honest gaps. This branch does not infer a supported answer from tool completion or Output existence.

## Local progress

- Assessment state regression: four cases failed on the old owner, passed after repair, failed under old-source injection, and passed restored (11 tests).
- Inventory: exact-turn Output cursor/restart, bounded lineage owner, protocol forwarding and dialect-bound paging pass locally. Removing the storage turn filter and protocol gate produced assertion failures; restored inventory/Output suites passed (47 tests). Server test typechecking passed for this slice.
- Task Outputs: the real store and routes now check exact producing-turn association, same-byte Outputs from another turn, separate unassociated Outputs, unchanged GET files, and execution-only standing. Focused source/route suites pass (96 tests); mutation and browser proof remain pending.

## Evidence rules

Each repaired behavior needs its own baseline or injected failure and restored result at the actual owner or caller boundary. Focused tests are local diagnostic evidence. Browser, real-device, provider, hosted qualification and publication results remain separate. Record unresolved prerequisites explicitly.
