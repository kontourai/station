export function sshForwardProvenanceWarning(
  recordedSha: string | undefined,
  reportedSha: string | undefined,
): string | null {
  if (!reportedSha)
    return 'Provenance unknown: the remote Station did not report a build sha.';
  if (!recordedSha)
    return 'Provenance unknown: no observed build sha was recorded.';
  if (recordedSha === reportedSha) return null;
  return `Version mismatch: launched ${recordedSha.slice(0, 12)}, remote reports ${reportedSha.slice(0, 12)}.`;
}

/**
 * What this device actually knows about the forwarded host's instance probe.
 *
 * station#3711: this used to be a boolean `hostReachable` fed from the query's
 * `isSuccess`, with `false` rendered as "Host offline" — so the row asserted
 * the host's power/network state during its own FIRST RENDER, before any probe
 * had completed, and equally for a malformed response or an auth failure.
 * Three states, because the boolean was conflating three facts:
 */
export type SshForwardProbeState =
  /** The probe has not produced a verdict yet. Claim nothing. */
  | 'checking'
  /** The probe completed and the instance answered. */
  | 'reached'
  /**
   * The probe failed. That is consistent with the host being off — and with
   * it being awake and answering everything else. This device observes only
   * its own failed request, never the host's power state.
   */
  | 'unreached';

/**
 * Derive the probe state from the query flags, HERE rather than at the call
 * site — the original defect was the caller collapsing `isSuccess` to a
 * boolean, and a caller-side ternary could quietly regress to exactly that
 * shape while every label test stayed green (station#3713 review). With the
 * derivation in this module, the caller passes the flags through and the
 * discriminating case (neither success nor error = still checking) is pinned
 * by this module's own tests.
 */
export function deriveSshForwardProbeState(query: {
  isSuccess: boolean;
  isError: boolean;
}): SshForwardProbeState {
  if (query.isSuccess) return 'reached';
  if (query.isError) return 'unreached';
  return 'checking';
}

export function sshForwardLifecycleLabel(input: {
  transport?: string;
  launcherError?: string;
  launcherUnknown?: boolean;
  probe: SshForwardProbeState;
}): string | null {
  if (
    input.transport === 'ssh-forward' &&
    (input.launcherError === 'launcher closed' || input.launcherUnknown)
  ) {
    return 'Launcher closed';
  }
  if (input.probe === 'unreached') return "Can't reach this Station";
  // 'checking' deliberately renders nothing rather than a spinner label: the
  // row already exists and a claim either way would be invented.
  return null;
}
