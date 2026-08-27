/**
 * Every write that changes which agents a skill is bound to.
 *
 * ONE seam, for one reason: a binding change is a read-modify-write on a
 * record an editor may be saving at the same instant. `saveAgent` locks only
 * the write, so a caller that loaded, derived and then saved republished a
 * snapshot taken before the editor's change and silently erased it (review
 * delta HIGH). Everything here goes through `mutateAgent`, whose read, derive
 * and write all happen inside the same per-agent lock.
 *
 * The updaters are synchronous by contract — that is what keeps the lock
 * window closed. Nothing in a binding derivation needs to await.
 */
import type { AgentSpec } from '@kontourai/station-contracts/agent';

/** The one store operation a binding write is allowed to use. */
export interface AgentBindingStore {
  listAgents(): Promise<Array<{ slug: string }>>;
  /**
   * Read → derive → write inside the agent's lock. The updater receives a
   * defensive copy and returns the WHOLE next record, or `null` for "nothing
   * to change" (no write at all).
   */
  mutateAgent(
    slug: string,
    updater: (current: AgentSpec) => AgentSpec | null,
  ): Promise<AgentSpec | null>;
}

/**
 * A binding move that attached where it was asked to but could not clean up.
 *
 * Deliberately its own error: the requested binding IS in place and nothing
 * was lost — the skill is simply bound in more places than asked. Saying that
 * is very different from "the move failed", which is what the caller would
 * otherwise assume.
 */
export class AgentBindingDetachError extends Error {
  readonly publicMessage: string;
  constructor(
    readonly skillName: string,
    readonly attachedTo: string,
    readonly stillBoundTo: readonly string[],
    cause: unknown,
  ) {
    const publicMessage = `'${skillName}' was attached to '${attachedTo}', but it could not be detached from ${stillBoundTo
      .map((slug) => `'${slug}'`)
      .join(', ')}, so it is bound to both. Detach it there by hand.`;
    super(publicMessage, { cause });
    this.name = 'AgentBindingDetachError';
    this.publicMessage = publicMessage;
  }
}

function boundSkills(spec: AgentSpec): string[] {
  const skills = (spec as { skills?: unknown }).skills;
  return Array.isArray(skills)
    ? skills.filter((name): name is string => typeof name === 'string')
    : [];
}

function withSkills(spec: AgentSpec, skills: string[]): AgentSpec {
  return { ...spec, skills } as AgentSpec;
}

/**
 * Make `agentSlug` the only agent bound to `skillName`.
 *
 * ADD FIRST, then remove. The reverse order — which this used to do — lost the
 * binding outright when the second save failed: the skill was already detached
 * from the old agent and never reached the new one, and the request reported an
 * error while the user's binding was simply gone (review delta HIGH). Attaching
 * first means the worst failure leaves the skill bound in TWO places, which is
 * a superset the operator can see and fix, not a deletion they cannot.
 */
export async function setSoleAgentBinding(
  store: AgentBindingStore,
  skillName: string,
  agentSlug: string,
): Promise<void> {
  await store.mutateAgent(agentSlug, (current) => {
    const skills = boundSkills(current);
    return skills.includes(skillName)
      ? null
      : withSkills(current, [...skills, skillName]);
  });

  const stillBound: string[] = [];
  let firstFailure: unknown;
  for (const { slug } of await store.listAgents()) {
    if (slug === agentSlug) continue;
    try {
      await store.mutateAgent(slug, (current) => {
        const skills = boundSkills(current);
        return skills.includes(skillName)
          ? withSkills(
              current,
              skills.filter((name) => name !== skillName),
            )
          : null;
      });
    } catch (error) {
      stillBound.push(slug);
      firstFailure ??= error;
    }
  }
  if (stillBound.length > 0) {
    throw new AgentBindingDetachError(
      skillName,
      agentSlug,
      stillBound,
      firstFailure,
    );
  }
}

/**
 * Follow a skill's rename through every agent that bound it.
 *
 * A rename moves the package; an agent still naming the old one is bound to a
 * skill that no longer exists, and nothing would ever tell its owner (review
 * delta MEDIUM). The bindings are part of the rename, not a separate chore.
 */
export async function renameAgentBindings(
  store: AgentBindingStore,
  previousName: string,
  nextName: string,
): Promise<AgentBindingFanOut> {
  if (previousName === nextName) return { changed: [], failed: [] };
  return fanOut(store, (current) => {
    const skills = boundSkills(current);
    if (!skills.includes(previousName)) return null;
    const next = skills.filter((name) => name !== previousName);
    if (!next.includes(nextName)) next.push(nextName);
    return withSkills(current, next);
  });
}

/** Drop a deleted skill from every agent that bound it. */
export async function removeAgentBindings(
  store: AgentBindingStore,
  skillName: string,
): Promise<AgentBindingFanOut> {
  return fanOut(store, (current) => {
    const skills = boundSkills(current);
    return skills.includes(skillName)
      ? withSkills(
          current,
          skills.filter((name) => name !== skillName),
        )
      : null;
  });
}

/** What a fan-out over every agent record actually did. */
export interface AgentBindingFanOut {
  /** Agents whose record was rewritten. */
  changed: string[];
  /** Agents whose record could not be rewritten, and why. */
  failed: Array<{ slug: string; reason: string }>;
}

export const AGENT_BINDING_PUBLIC_FAILURE_REASON =
  'Agent record could not be updated';

/**
 * Apply one updater to every agent, CONTINUING past a failure.
 *
 * Stopping on the first error left the remaining agents holding a name that no
 * longer exists, with no record of which ones and no way to retry — the
 * identifier the caller would retry with had already moved (review delta-2
 * MEDIUM). Every agent is attempted, and the failures come back as data so the
 * caller can decide: the rename holds the package still, and the delete keeps
 * the package until the fan-out is complete.
 */
async function fanOut(
  store: AgentBindingStore,
  updater: (current: AgentSpec) => AgentSpec | null,
): Promise<AgentBindingFanOut> {
  const changed: string[] = [];
  const failed: AgentBindingFanOut['failed'] = [];
  for (const { slug } of await store.listAgents()) {
    try {
      if ((await store.mutateAgent(slug, updater)) !== null) changed.push(slug);
    } catch (error) {
      failed.push({
        slug,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return { changed, failed };
}

/** A fan-out that could not finish. The caller decides what survives. */
export class AgentBindingFanOutError extends Error {
  readonly publicMessage: string;
  readonly publicFailed: Array<{ slug: string; reason: string }>;
  constructor(
    readonly skillName: string,
    readonly failed: AgentBindingFanOut['failed'],
    detail: string,
  ) {
    const publicFailed = failed.map(({ slug }) => ({
      slug,
      reason: AGENT_BINDING_PUBLIC_FAILURE_REASON,
    }));
    const publicMessage = `${detail}: ${publicFailed
      .map((entry) => `'${entry.slug}' (${entry.reason})`)
      .join(', ')}`;
    super(publicMessage);
    this.name = 'AgentBindingFanOutError';
    this.publicMessage = publicMessage;
    this.publicFailed = publicFailed;
  }
}
