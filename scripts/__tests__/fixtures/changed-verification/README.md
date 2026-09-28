# Changed-verification fixtures

These files describe selector-test boundaries, not application configuration.

`narrow-diff.json` selects one target for the
[representative demo](../../../run-changed-verification.mjs). The demo creates a
disposable checkout at `HEAD`, links its own workspace dependencies, changes
the target and runs the real selector before removing the checkout.

The returned `elapsedMs` measures selection and test execution. Whole-command
wall time also includes checkout creation and cleanup. The
[CLI integration test](../../changed-verification.test.ts) gives that whole
fixture a 120-second liveness limit; it is not a latency target for the selected
tests or a change to the CI lane's deadline. Keep those measurements separate
when investigating a timeout.
