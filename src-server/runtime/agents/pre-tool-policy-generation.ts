import { createHash } from 'node:crypto';
import type { AgentSpec } from '@kontourai/station-contracts/agent';

/**
 * Loads an Agent's definition inside one stable agent-configuration revision,
 * or refuses. Throws while a configuration mutation is in flight and when one
 * lands during the load.
 */
export async function loadStablePreToolPolicySpec(options: {
  getStableRevision(): number | null;
  loadAgent(): Promise<AgentSpec>;
}): Promise<{ spec: AgentSpec; revision: number }> {
  const revision = options.getStableRevision();
  if (revision === null) {
    throw new Error(
      'Station agent configuration is not stable; pre-tool policy preparation was denied.',
    );
  }
  const spec = await options.loadAgent();
  if (options.getStableRevision() !== revision) {
    throw new Error(
      'Station agent configuration changed during pre-tool policy preparation; execution was denied.',
    );
  }
  return { spec, revision };
}

/**
 * Arrays whose order binds nothing: sets of names and ids. A probe that
 * reports the same tools in another order, or an `autoApprove` list
 * reordered, is not a change to what a launch binds. Ordered arrays (a
 * command's `args`) keep their order.
 */
const SET_VALUED_KEYS = new Set([
  'toolNames',
  'disabledTools',
  'allowedTools',
  'autoApprove',
  'askBeforeUse',
  'unattendedAutoApprove',
  'available',
  'mcpServers',
  'skills',
  'provideToolServers',
  'provideSkills',
]);

/**
 * JSON with object keys sorted at every depth, so key order is no
 * difference, and set-valued arrays sorted.
 */
function canonical(value: unknown, key?: string): unknown {
  if (Array.isArray(value)) {
    const items = value.map((item) => canonical(item));
    return key !== undefined && SET_VALUED_KEYS.has(key)
      ? items
          .map((item) => [JSON.stringify(item) ?? '', item] as const)
          .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
          .map(([, item]) => item)
      : items;
  }
  if (value && typeof value === 'object') {
    const source = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(source)
        .sort()
        .map((name) => [name, canonical(source[name], name)]),
    );
  }
  return value;
}

function fingerprintOf(value: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(canonical(value)) ?? 'undefined')
    .digest('hex');
}

/** The fingerprint a binding compares: of the Agent record and its launch. */
export function preToolPolicyLaunchFingerprint(read: {
  spec: AgentSpec;
  launch: unknown;
}): string {
  return fingerprintOf({ spec: read.spec, launch: read.launch });
}

/**
 * What a session was launched with, read again from the current
 * configuration by the same resolution its launch used.
 * - `read`: `spec` is the Agent record the evaluator decides from, and
 *   `launch` everything else the engine was started with (the resolved
 *   Agent definition with its tool servers, and the engine connection).
 * - `missing`: a fresh launch would not have it any more (Agent deleted,
 *   connection revoked).
 * - `unreadable`: it could not be read now (a plugin not ready, a file
 *   mid-write); nothing is concluded from it.
 */
export type PreToolPolicyLaunchRead =
  | { state: 'read'; spec: AgentSpec; launch: unknown }
  | { state: 'missing' }
  | { state: 'unreadable' };

/**
 * - `current`: the session runs under the configuration in force now.
 * - `settling`: a configuration change is being applied, or what the session
 *   was launched with could not be read; the same call may pass shortly.
 * - `replaced`: what the session was launched with changed. Its engine cannot
 *   re-bind that, so only a restarted (or successor) engine session runs
 *   under the new configuration.
 */
export type PreToolPolicyGenerationState = 'current' | 'settling' | 'replaced';

/**
 * The agent-configuration generation an external engine session's pre-tool
 * policy was bound under.
 *
 * The agent-configuration revision is global: creating or editing ANY Agent,
 * and every connection, provider, plugin or watched-file reload, moves it.
 * Comparing it alone made every running session of every Agent stale on any of
 * those (2026-11-16: creating an unrelated Agent stopped every running Claude
 * Code conversation, and no retry or new turn recovered). A moved revision is
 * therefore only a prompt to look again: what this session was launched with
 * is read again under the new stable revision, and the binding advances only
 * when that is unchanged.
 *
 * Inputs, and how each stays current:
 * - Fingerprinted (a change replaces the session): the Agent record; the
 *   resolved Agent definition the adapter was started from (each tool
 *   server's resolved command, args, endpoint and transport, its existence,
 *   `enabled` and disabled tools, Project and connection-default tool
 *   servers, plugin-provided integrations, skills, grants, prompt); the tool
 *   servers an ACP-family launch resolves itself from its connection
 *   (`provideToolServers`, `mcpMode: 'add'`, OpenCode native MCP); the engine
 *   connection (Claude/Codex connection config, proxy launch, active
 *   credential profile; the ACP connection record without presentation).
 *   Excluded as binding nothing: recovery bookkeeping, probe timestamps, the
 *   order of set-valued arrays.
 * - Neither (decided): OAuth tokens for remote tool servers, minted per
 *   session; the engine executable path; Station's own per-session server
 *   credentials, checked by those servers per call.
 * - Read per call: Project tool policy (Tool Library), unattended grants,
 *   integration trust and the untrusted-content ledger, config protection,
 *   tool-name provenance.
 * - Rebuilt when the binding advances: the approval guardian (its app
 *   configuration and model).
 */
export interface PreToolPolicyGeneration {
  /** The Agent record the session's policy was bound to. */
  readonly spec: AgentSpec;
  /** The stable revision the binding was last confirmed under. */
  revision(): number;
  /** Synchronous read for the evaluator's first stage; never reloads. */
  state(): PreToolPolicyGenerationState;
  /**
   * Reads the launch inputs again when the revision moved and advances the
   * binding when they are unchanged. Never advances past a change. A
   * replaced verdict is kept until the revision moves again; an unreadable
   * one is read again on the next call.
   */
  refresh(): Promise<PreToolPolicyGenerationState>;
}

export async function bindPreToolPolicyGeneration(options: {
  getStableRevision(): number | null;
  readLaunch(): Promise<PreToolPolicyLaunchRead>;
}): Promise<PreToolPolicyGeneration> {
  const revisionAtBind = options.getStableRevision();
  if (revisionAtBind === null)
    throw new Error(
      'Station agent configuration is not stable; pre-tool policy preparation was denied.',
    );
  const bound = await options.readLaunch();
  if (options.getStableRevision() !== revisionAtBind)
    throw new Error(
      'Station agent configuration changed during pre-tool policy preparation; execution was denied.',
    );
  if (bound.state !== 'read')
    throw new Error(
      'The Agent this session runs could not be read; pre-tool policy preparation was denied.',
    );
  const fingerprint = preToolPolicyLaunchFingerprint(bound);
  let revision = revisionAtBind;
  // The last verdict short of current, and the revision it was reached at.
  let verdict: { state: 'replaced' | 'unreadable'; at: number } | undefined;
  const state = (): PreToolPolicyGenerationState => {
    // A replaced session stays replaced while a later change is applied: a
    // retry then is refused again, so it is never told to retry.
    if (verdict?.state === 'replaced') return 'replaced';
    const current = options.getStableRevision();
    return current !== null && current === revision ? 'current' : 'settling';
  };
  return {
    spec: bound.spec,
    revision: () => revision,
    state,
    async refresh() {
      const current = options.getStableRevision();
      if (current === null || current === revision) return state();
      // Replaced is kept until the configuration moves again; a read that
      // failed is tried again on the next call.
      if (verdict?.state === 'replaced' && verdict.at === current)
        return state();
      const read = await options.readLaunch();
      // Changed again during the read: decide nothing from it.
      if (options.getStableRevision() !== current) return state();
      if (read.state === 'unreadable') {
        verdict = { state: 'unreadable', at: current };
      } else if (
        read.state === 'missing' ||
        preToolPolicyLaunchFingerprint(read) !== fingerprint
      ) {
        verdict = { state: 'replaced', at: current };
      } else {
        verdict = undefined;
        revision = current;
      }
      return state();
    },
  };
}

/**
 * The binding of a session whose start could not be bound (a configuration
 * change raced it, or its configuration could not be read): it refuses
 * every call as replaced, and reports itself replaced, so the session's next
 * turn restarts it and binds again rather than refusing until it is parked.
 */
export function unboundPreToolPolicyGeneration(
  spec: AgentSpec,
): PreToolPolicyGeneration {
  return {
    spec,
    revision: () => -1,
    state: () => 'replaced',
    refresh: async () => 'replaced',
  };
}

/**
 * Each external session's binding by its provider thread, read by the
 * conversation seam to start a successor once a binding is replaced. Held
 * weakly: the evaluator the engine adapter keeps for the session's life holds
 * the binding, so a session the adapter dropped has nothing left to protect
 * and is never reported.
 */
export class PreToolPolicyGenerations {
  private readonly bindings = new Map<
    string,
    WeakRef<PreToolPolicyGeneration>
  >();
  private readonly finalization = new FinalizationRegistry<string>(
    (threadId) => {
      if (this.bindings.get(threadId)?.deref() === undefined)
        this.bindings.delete(threadId);
    },
  );

  register(threadId: string, binding: PreToolPolicyGeneration): void {
    this.bindings.set(threadId, new WeakRef(binding));
    this.finalization.register(binding, threadId);
  }

  /** True only when this thread's bound Agent definition has been replaced. */
  async replaced(threadId: string): Promise<boolean> {
    const binding = this.bindings.get(threadId)?.deref();
    return binding ? (await binding.refresh()) === 'replaced' : false;
  }
}
