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

/** JSON with object keys sorted at every depth, so key order is no difference. */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    const source = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(source)
        .sort()
        .map((key) => [key, canonical(source[key])]),
    );
  }
  return value;
}

/**
 * The whole Agent definition, hashed. Deliberately not
 * `agentDefinitionFingerprint`, which leaves out `execution`: a running
 * session counts any change to its own Agent as a replaced policy, so nothing
 * that definition holds can change under it unnoticed.
 */
function agentPolicyFingerprint(spec: AgentSpec): string {
  return createHash('sha256')
    .update(JSON.stringify(canonical(spec)))
    .digest('hex');
}

/**
 * - `current`: the session's policy is the one in force now.
 * - `settling`: a configuration change is still being applied; ask again.
 * - `replaced`: the session's own Agent definition changed after its policy
 *   was bound. A session cannot re-bind what its engine was started with, so
 *   only a new session runs under the new definition.
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
 * therefore only a prompt to look again: the session's own definition is
 * reloaded under the new stable revision, and the binding advances to it only
 * when that definition is unchanged. The other inputs the evaluator reads
 * (Project tool policy, grants, integration trust, the approval guardian's
 * configuration) are read per call or rebuilt when the binding advances, so
 * they are never decided from a replaced copy.
 */
export interface PreToolPolicyGeneration {
  /** The definition the session's policy was bound to. */
  readonly spec: AgentSpec;
  /** The stable revision the binding was last confirmed under. */
  revision(): number;
  /** Synchronous read for the evaluator's first stage; never reloads. */
  state(): PreToolPolicyGenerationState;
  /**
   * Reloads the Agent when the revision moved and advances the binding when
   * its definition is unchanged. Never advances it past a changed definition.
   */
  refresh(): Promise<PreToolPolicyGenerationState>;
}

export async function bindPreToolPolicyGeneration(options: {
  getStableRevision(): number | null;
  loadAgent(): Promise<AgentSpec>;
}): Promise<PreToolPolicyGeneration> {
  const bound = await loadStablePreToolPolicySpec(options);
  const fingerprint = agentPolicyFingerprint(bound.spec);
  let revision = bound.revision;
  let replaced = false;
  const state = (): PreToolPolicyGenerationState => {
    const current = options.getStableRevision();
    if (current === null) return 'settling';
    if (current === revision) return 'current';
    return replaced ? 'replaced' : 'settling';
  };
  return {
    spec: bound.spec,
    revision: () => revision,
    state,
    async refresh() {
      const current = options.getStableRevision();
      if (current === null || current === revision) return state();
      let spec: AgentSpec | undefined;
      try {
        spec = await options.loadAgent();
      } catch {
        // A deleted or unreadable Agent is not the definition this session
        // was bound to.
        spec = undefined;
      }
      // Changed again during the load: decide nothing from this read.
      if (options.getStableRevision() !== current) return state();
      replaced =
        spec === undefined || agentPolicyFingerprint(spec) !== fingerprint;
      if (!replaced) revision = current;
      return state();
    },
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
