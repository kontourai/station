/**
 * The exit status a pre-push step uses for one thing only: a finding in the
 * commit being pushed. `.githooks/pre-push` refuses a push on this status
 * and on nothing else from these steps; any other non-zero status (a crash,
 * a module that will not load, a kill, a timeout) is reported as a WARNING
 * and the push continues, because `--no-verify` is not allowed here and a
 * refusal must always be about the pushed commit. 40 is outside the statuses
 * Node itself exits with (1 to 14, and 128 plus a signal number), so a
 * runtime failure cannot read as a finding. The hook hard-codes the same
 * number; the hook tests push real findings through it.
 */
export const PREPUSH_FINDING_EXIT = 40;
