/**
 * One derivation of the words this app uses for host pressure.
 *
 * The server classifies posture once (`src-server/services/infra/resource-posture.ts`)
 * and `admitScheduledJob` defers scheduled work for BOTH `degraded` and
 * `critical`. The two states are not the same fact for a reader, though, and
 * the chrome banner has always said so: `critical` is "At capacity", `degraded`
 * is "Busy". Schedule reads the same posture, so it has to use the same words —
 * a page that says "host at capacity" at 86% CPU while the banner above it says
 * "Busy" is a label nothing derived.
 *
 * Every consumer takes its wording from `hostPressureWord` below; nothing
 * re-tests `kind` for presentation.
 */

/** The two postures that defer scheduled runs and are worth telling a user about. */
export type HostPressureKind = 'degraded' | 'critical';

/**
 * Narrow a posture reading to the pressure states. `healthy`, `unavailable`
 * (the probe fails open) and an absent reading are all "nothing to say".
 */
export function hostPressureKind(
  posture: { kind?: string } | undefined,
): HostPressureKind | undefined {
  return posture?.kind === 'degraded' || posture?.kind === 'critical'
    ? posture.kind
    : undefined;
}

/** The distinguishing phrase. The only place the two states get different words. */
function hostPressureWord(kind: HostPressureKind): string {
  return kind === 'critical' ? 'at capacity' : 'busy';
}

/** Chrome banner badge: "At capacity" / "Busy". */
export function hostPressureBadge(kind: HostPressureKind): string {
  const word = hostPressureWord(kind);
  return `${word.charAt(0).toUpperCase()}${word.slice(1)}`;
}

/** The subject phrase a paused surface names: "host at capacity" / "host busy". */
export function hostPressureSubject(kind: HostPressureKind): string {
  return `host ${hostPressureWord(kind)}`;
}
