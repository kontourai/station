/**
 * Name every reason a changed-test diagnostic is not a complete account of
 * its run. Producer and verifier import this pure policy so the completion
 * flag cannot drift across the CLI/coordinator boundary.
 */
export function incompleteDiagnosticReasons(diagnostics) {
  const reasons = [];
  const executions = Array.isArray(diagnostics?.executions)
    ? diagnostics.executions
    : [];
  for (const execution of executions) {
    const kind = execution?.kind ?? 'unknown';
    if (execution?.infrastructureError)
      reasons.push(`${kind}: the Vitest child did not run to completion`);
    if (execution?.error) reasons.push(`${kind}: ${execution.error}`);
    if (execution?.empty)
      reasons.push(
        `${kind}: Vitest ${execution.emptyReason ?? 'selected zero tests'}`,
      );
    const failed = execution?.counts?.failed;
    // A JSON reporter can finish and still have its parent Vitest process
    // exit non-zero (for example, a reporter or worker failure after the
    // passing assertions were written). Preserve the reported counts, but
    // never call that a complete clean diagnostic merely because no assertion
    // was marked failed.
    if (
      Number.isInteger(execution?.exitCode) &&
      execution.exitCode !== 0 &&
      execution?.infrastructureError !== true &&
      failed === 0
    )
      reasons.push(
        `${kind}: Vitest exited ${execution.exitCode} without reporting a failed test`,
      );
    if (
      Number.isInteger(failed) &&
      failed > 0 &&
      execution?.failureIdentitiesComplete !== true
    )
      reasons.push(
        `${kind}: ${failed} failing test(s), ${execution?.failureIdentityCount ?? 0} identified, ${execution?.omittedFailureIdentities ?? 0} omitted`,
      );
    if (!execution?.counts && !execution?.error && !execution?.empty)
      reasons.push(`${kind}: no test counts were recorded`);
  }
  if (
    executions.length === 0 &&
    (diagnostics?.selection?.deferredLanes?.length ?? 0) === 0
  )
    reasons.push('no test executed and no deferred lane was named');
  return reasons;
}
