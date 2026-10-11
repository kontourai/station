import type { AgentCapabilities } from '@agentclientprotocol/sdk';

/**
 * #3411: how a capability probe obtains the ACP session it reads `modes` and
 * `configOptions` from without leaving a new stored session behind on every
 * probe.
 *
 * `session/new` is the only source of those two fields that every agent
 * supports, and agents that persist sessions write each one to their own
 * on-disk store. The probe used to call it on every run and never touch the
 * session again, so one Station instance added roughly 240 stored sessions a
 * day per connected agent. The spec gives three ways out, used in this order:
 *
 * 1. `session/delete` (`sessionCapabilities.delete`): create, read, delete.
 *    Nothing is retained, across restarts included.
 * 2. `session/resume` (`sessionCapabilities.resume`) or `session/load`
 *    (`agentCapabilities.loadSession`): reattach to the probe's own earlier
 *    session. Both responses carry `modes` and `configOptions`, so the
 *    shape of the evidence matches a fresh `session/new`. Resume is
 *    preferred because it replays no history.
 *
 *    The VALUES can differ, though. Grok Build answers a reattach from the
 *    session's own stored model and reasoning effort, not the agent's current
 *    default, so a reattached probe would keep reporting a default the user
 *    has since changed. The caller therefore mints a fresh session (and
 *    retains that one instead) on every user-initiated probe, whenever the
 *    agent reports a different name or version, and once the retained
 *    session is {@link PROBE_SESSION_REFRESH_MS} old. That bounds growth to a
 *    few stored sessions a day per connection instead of one per probe.
 *    A reattach still writes to the agent's store: Grok appends about 670
 *    bytes to the session's update log per resume, roughly 160 KB a day per
 *    connection at the 5-minute probe cadence.
 * 3. Neither advertised: `session/new` every time, which is the old behaviour
 *    and the only one such an agent allows.
 *
 * `session/close` is deliberately not used. The spec defines it as cancelling
 * work and freeing the session's runtime resources, not removing it from the
 * store, and the probe destroys the engine process right afterwards anyway.
 */
/**
 * How long a retained probe session may be reattached to before the probe
 * mints a fresh one. There is no generic signal that an agent's default
 * model or effort changed (it lives in each agent's private config), so a
 * coarse refresh bounds how stale a reattached answer can be. Six hours keeps
 * growth to about four sessions a day per connection.
 */
export const PROBE_SESSION_REFRESH_MS = 6 * 60 * 60_000;

export interface ProbeSessionProcess {
  newSession(
    cwd: string,
  ): Promise<ProbeSessionResponse & { sessionId: string }>;
  resumeSession(sessionId: string, cwd: string): Promise<ProbeSessionResponse>;
  loadSession(sessionId: string, cwd: string): Promise<ProbeSessionResponse>;
}

export interface ProbeSessionResponse {
  modes?: {
    availableModes: Array<{ id: string; name: string; description?: string }>;
    currentModeId?: string;
  } | null;
  configOptions?: any[] | null;
}

export type ProbeSessionOrigin = 'created' | 'resumed' | 'loaded';

/**
 * What the probe must do with the session once it has read it:
 * - `delete`: the agent can delete it, so it is deleted.
 * - `retain`: the agent can reattach to it, so it is kept for the next probe.
 * - `unmanaged`: the agent offers neither; the session stays in its store.
 */
export type ProbeSessionDisposition = 'delete' | 'retain' | 'unmanaged';

export interface ProbeSessionObservation extends ProbeSessionResponse {
  sessionId: string;
  origin: ProbeSessionOrigin;
  disposition: ProbeSessionDisposition;
}

/** The reattach method this agent advertises, if any (resume preferred). */
function probeSessionReattachMethod(
  agentCapabilities: AgentCapabilities | null | undefined,
): 'resume' | 'load' | null {
  if (agentCapabilities?.sessionCapabilities?.resume != null) return 'resume';
  if (agentCapabilities?.loadSession === true) return 'load';
  return null;
}

export async function acquireProbeSession({
  process,
  agentCapabilities,
  cwd,
  retainedSessionId,
  onReattachFailed,
}: {
  process: ProbeSessionProcess;
  agentCapabilities: AgentCapabilities | null | undefined;
  cwd: string;
  /**
   * The session to reattach to, or `null` to mint a fresh one. The caller
   * decides when a retained session is too old to trust: see
   * `ACPProbe.reattachableProbeSession`.
   */
  retainedSessionId: string | null;
  onReattachFailed?: (error: unknown, step: 'resume' | 'load') => void;
}): Promise<ProbeSessionObservation> {
  if (agentCapabilities?.sessionCapabilities?.delete != null) {
    const created = await process.newSession(cwd);
    return { ...created, origin: 'created', disposition: 'delete' };
  }

  const reattach = probeSessionReattachMethod(agentCapabilities);
  if (!reattach) {
    const created = await process.newSession(cwd);
    return { ...created, origin: 'created', disposition: 'unmanaged' };
  }

  if (retainedSessionId) {
    try {
      const reattached =
        reattach === 'resume'
          ? await process.resumeSession(retainedSessionId, cwd)
          : await process.loadSession(retainedSessionId, cwd);
      return {
        ...reattached,
        sessionId: retainedSessionId,
        origin: reattach === 'resume' ? 'resumed' : 'loaded',
        disposition: 'retain',
      };
    } catch (error) {
      // The agent dropped the session, or never had it: a fresh one replaces
      // it and becomes the one retained.
      onReattachFailed?.(error, reattach);
    }
  }
  const created = await process.newSession(cwd);
  return { ...created, origin: 'created', disposition: 'retain' };
}
