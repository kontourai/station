# CodeQL SARIF fixtures

`pinned-codeql-clean.sarif`, `pinned-codeql-finding.sarif`, and
`pinned-codeql-analysis-error.sarif` are projections of a real hosted-runner
SARIF: kontourai/station Actions run `33187380619` (CodeQL CLI 2.26.3 via
`github/codeql-action@db488dd`, `security-extended`). They preserve the shape
that run actually emitted — `tool.driver.name: "CodeQL"` with an empty
`driver.rules`, every rule under `tool.extensions[]` (one component per query
pack, including rule-free packs), and results that reference rules through
`rule.toolComponent.index` + `rule.index`. The finding fixture's two results
are verbatim real results (locations, messages, `partialFingerprints`): one
error-level result whose fingerprint appears in `scripts/codeql-error-baseline.json`,
and one warning-level result. The analysis-error fixture substitutes a failed
invocation.

`pinned-codeql-legacy-driver-rules.sarif` retains the older emitter shape —
`tool.driver.name: "CodeQL command-line toolchain"` with rules on the driver,
referenced by `ruleId`/`ruleIndex` — adapted from the pinned action's own
`src/testdata/valid-sarif.sarif`. It pins the policy's backward-compatible
resolution path.
