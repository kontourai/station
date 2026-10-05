import type {
  AgentCapabilities,
  ListSessionsResponse,
} from '@agentclientprotocol/sdk';

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
 *    evidence is the same as a fresh `session/new`, and at most one probe
 *    session exists per connection and directory. Resume is preferred
 *    because it replays no history.
 * 3. Neither advertised: `session/new` every time, which is the old behaviour
 *    and the only one such an agent allows.
 *
 * `session/close` is deliberately not used. The spec defines it as cancelling
 * work and freeing the session's runtime resources, not removing it from the
 * store, and the probe destroys the engine process right afterwards anyway.
 */
export interface ProbeSessionProcess {
  newSession(
    cwd: string,
  ): Promise<ProbeSessionResponse & { sessionId: string }>;
  resumeSession(sessionId: string, cwd: string): Promise<ProbeSessionResponse>;
  loadSession(sessionId: string, cwd: string): Promise<ProbeSessionResponse>;
  listSessions(cwd: string): Promise<ListSessionsResponse>;
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

/**
 * The most recently updated session the agent lists for exactly `cwd`. The
 * `cwd` filter is re-applied here because the request's filter is advisory
 * from Station's point of view: adopting a session from another directory
 * could mean reattaching to one of the user's own conversations.
 */
function newestSessionFor(
  listed: ListSessionsResponse,
  cwd: string,
): string | null {
  const matching = (listed.sessions ?? []).filter(
    (session) => session.cwd === cwd,
  );
  matching.sort((a, b) =>
    String(b.updatedAt ?? '').localeCompare(String(a.updatedAt ?? '')),
  );
  return matching[0]?.sessionId ?? null;
}

export async function acquireProbeSession({
  process,
  agentCapabilities,
  cwd,
  retainedSessionId,
  recoverFromList,
  allowReattach = true,
  onReattachFailed,
}: {
  process: ProbeSessionProcess;
  agentCapabilities: AgentCapabilities | null | undefined;
  cwd: string;
  /** The session this probe retained from an earlier run in the same `cwd`. */
  retainedSessionId: string | null;
  /**
   * Whether a missing `retainedSessionId` may be recovered with
   * `session/list`. Only true for Station's private probe workspace, where
   * every session in that directory is a probe session; a user-configured
   * directory may hold the user's own sessions.
   */
  recoverFromList: boolean;
  /** False after a probe whose session phase failed, so a hung reattach cannot wedge every later probe. */
  allowReattach?: boolean;
  onReattachFailed?: (error: unknown, step: 'list' | 'resume' | 'load') => void;
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

  let candidate = allowReattach ? retainedSessionId : null;
  if (
    allowReattach &&
    !candidate &&
    recoverFromList &&
    agentCapabilities?.sessionCapabilities?.list != null
  ) {
    try {
      candidate = newestSessionFor(await process.listSessions(cwd), cwd);
    } catch (error) {
      onReattachFailed?.(error, 'list');
    }
  }
  if (candidate) {
    try {
      const reattached =
        reattach === 'resume'
          ? await process.resumeSession(candidate, cwd)
          : await process.loadSession(candidate, cwd);
      return {
        ...reattached,
        sessionId: candidate,
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
