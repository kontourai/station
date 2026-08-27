# Product-law authoring

Product laws are a small set of executable, user-observable invariants. Read
the [generated product-law reference](../reference/product-laws.md) for the
current public projection; do not copy its law table into explanatory guides.

## Choose a law deliberately

A law names a stable identity, an observable invariant, its owning module and
interface, and the owner responsible for remediation. It must have an exact
behavior observation and an exact fault observation. The contributor workflow
validates both observations from structured test output.

Affected-path disposition is explicit. A behavior change either matches a law
that owns the changed area or is recorded as deliberately outside the current
law set. Do not assign a nearby law by implication merely to make a review
look complete.

## Interpret the observation

- **PASS** means the exact behavior and fault observations both passed.
- **FAIL** means an exact observation failed and the owning behavior needs
  diagnosis.
- **NOT_VERIFIED** means a trustworthy exact observation was unavailable. It is
  not a pass and does not authorize completion.

Product-law observations inform verification; they do not create a second
completion receipt. Follow the repository contribution guide for the current
authoring and verification workflow.
