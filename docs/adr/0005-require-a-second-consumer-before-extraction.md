# Require a second consumer before extraction

**Status:** Accepted. Amended on 2026-10-12 by a maintainer decision on
[#3558](https://github.com/kontourai/station/issues/3558), which splits the rule
into two tiers. "Extraction" in this ADR's title means Tier 2, a standalone
product or repository. The original decision is kept unchanged below; the
[amendment](#amendment-2026-10-12) states the current rule.

## Original decision

Station does not promote an internal subsystem into a standalone Kontour product until a real non-Station consumer exists or is concretely asking. This avoids creating versioned contracts with only one user, while keeping proven subsystems extraction-ready when demand appears.

## Amendment (2026-10-12)

This records item 2 of the "Decisions" section on
[#3558](https://github.com/kontourai/station/issues/3558).

### Tier 1: publishable package

A Station subsystem may become a publishable package with a public contract
while Station is its only consumer. The package is built in Station's workspace
and published the same way as `@kontourai/station-sdk`. It must meet all of
these conditions:

- It imports nothing from Station: no Station source, and no
  `@kontourai/station-*` package, including `@kontourai/station-contracts` and
  `@kontourai/station-shared`. It may depend on public Kontour building-block
  packages such as `@kontourai/thread`. A lint rule or an automated check that
  fails CI enforces this; a convention alone does not satisfy the condition.
- It has its own conformance suite.
- Station consumes it only through its public entry point, never through
  imports into the package's internal files.
- Its versioning stays experimental until a second consumer exists.

A Tier 1 package is Station-owned. It is not a standalone Kontour product and
not a Kontour primitive, so the constitution's rule that Station never becomes
the place where a primitive's semantics live is unaffected. It stays in
Station's repository.

### Tier 2: standalone product or repository

Moving a subsystem into its own Kontour product or repository still requires a
real non-Station consumer that exists or is concretely asking, as the original
decision states.

### Rationale

The original decision avoids versioned contracts with only one user. This
amendment also weighs cross-repository churn while an API is still moving.
Tier 2 keeps the repository split behind a second consumer, so that churn
waits for real demand. Tier 1 does publish a contract with one user, so its
experimental versioning is what keeps Station from making a compatibility
promise before a second consumer exists.

Tier 1 lets other products install and evaluate a subsystem before anyone
splits a repository. Its conditions make a later Tier 2 move easier: the
package already has no Station imports and its own conformance suite, and
Station already uses only its public entry point. Station consumes
[`@kontourai/ephemeris`](https://github.com/kontourai/ephemeris) only through
its published package, which is the consumption shape Tier 1 requires. A copy
of a subsystem's code would fork its source of truth; Tier 1 keeps one.

### Motivating case

[#3558](https://github.com/kontourai/station/issues/3558) plans a durable run
kernel as a workspace package with no Station imports, its own conformance
suite and an exported crash-point test store. Station consumes it from the
first slice. That is a Tier 1 package.

The same decision names a probe,
[#3574](https://github.com/kontourai/station/issues/3574), that expresses the
`@kontourai/flow-agents` continuation driver against the kernel API without
importing Station. The maintainer set that probe as the qualification rule for
this one case: if it passes, the kernel qualifies for Tier 2. A passing probe
stands in place of the second-consumer requirement, for this case only. A
probe written by Station is not itself a consumer, and it does not change the
general rule above. The additional Tier 2 criteria in [CONTEXT.md](../../CONTEXT.md#codebase-design-and-verification)
still apply: a public contract, verification the new product owns, and a
measurable reduction in Station-owned code.

### Unchanged

[ADR 0021](0021-separate-plugin-and-agent-sdk-surfaces.md) still governs
splitting `@kontourai/station-sdk` into separate packages. That rule concerns
the SDK's own entry points, not new subsystem packages.
