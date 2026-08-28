# CodeQL SARIF fixtures

These fixtures are adapted from `github/codeql-action` commit
`db488ddef3bf6cb639b32c2e9a7c0a7ea8271d28`, specifically
[`src/testdata/valid-sarif.sarif`](https://raw.githubusercontent.com/github/codeql-action/db488ddef3bf6cb639b32c2e9a7c0a7ea8271d28/src/testdata/valid-sarif.sarif).
They retain the pinned action's SARIF 2.1.0 schema URL and `CodeQL command-line
toolchain` driver shape. The clean fixture removes its upstream findings; the
finding fixture uses a security-rule-shaped metadata projection to prove
rule-level severity inheritance; the error fixture adds a failed invocation.

`codeql-2.26.3-no-level.sarif` is a bounded observed projection, not a captured
full hosted artifact. It preserves the hosted driver name, 2.26.3 semantic
version, driver-rule inventory, and omitted result level needed to prove
SARIF's standard omitted-result-level default (`warning`).
