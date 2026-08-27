/**
 * A legacy `prompts` binding list → `agent.skills`, in ONE place.
 *
 * The single caller left is `station doctor --migrate-playbooks`, the one-shot
 * helper that reads a legacy `prompts.json` (`playbook-skill-migration.ts`).
 * A live agent save can no longer carry `prompts` at all: the field is gone
 * from the contract and the agent schema refuses a payload that names it, so
 * there is no second derivation of this mapping to keep in step.
 */

export interface AgentPromptTranslation {
  /** `agent.skills` after the translation, in a stable order. */
  skills: string[];
  /** What this translation appended that was not already bound. */
  addedSkills: string[];
  /** `prompts` ids that resolved to a skill. */
  resolvedPromptIds: string[];
  /** `prompts` ids nothing claims. */
  unresolvedPromptIds: string[];
  /** Whether the record carried a `prompts` key at all (so it can be deleted). */
  hadPromptsKey: boolean;
}

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string')
    : [];
}

/**
 * Resolve a record's `prompts` (and any extra skill names a caller wants
 * bound) into the `skills` list that replaces them.
 *
 * Order is deliberate and stable: the skills already bound, then the extra
 * names in the order given, then the ones the `prompts` ids resolved to. A
 * re-run over an already-translated record adds nothing, which is what makes
 * the migration's retry a no-op rather than a growing list.
 */
export function translateAgentPromptBindings(input: {
  currentSkills: unknown;
  /** The record's `prompts` value, as read off disk or off a request body. */
  declaredPrompts: unknown;
  /** Skill names to bind regardless of `prompts` (the migration's `agent:` pins). */
  extraSkillNames?: readonly string[];
  /** Legacy id (a stored UUID or `<ns>:<id>`) → skill name, or undefined. */
  resolveLegacyId: (legacyId: string) => string | undefined;
  /** Treat the record as carrying `prompts` even when the list is empty. */
  hadPromptsKey?: boolean;
}): AgentPromptTranslation {
  const currentSkills = stringList(input.currentSkills);
  const declaredPrompts = stringList(input.declaredPrompts);
  const addedSkills: string[] = [];
  const resolvedPromptIds: string[] = [];
  const unresolvedPromptIds: string[] = [];

  const append = (name: string) => {
    if (currentSkills.includes(name) || addedSkills.includes(name)) return;
    addedSkills.push(name);
  };

  for (const name of input.extraSkillNames ?? []) append(name);
  for (const promptId of declaredPrompts) {
    const skillName = input.resolveLegacyId(promptId);
    if (!skillName) {
      unresolvedPromptIds.push(promptId);
      continue;
    }
    resolvedPromptIds.push(promptId);
    append(skillName);
  }

  return {
    skills: [...currentSkills, ...addedSkills],
    addedSkills,
    resolvedPromptIds,
    unresolvedPromptIds,
    hadPromptsKey: input.hadPromptsKey ?? declaredPrompts.length > 0,
  };
}

/**
 * The agent record with its bindings translated and `prompts` removed.
 *
 * Returns `null` when there is nothing to do, so a caller can skip the write
 * entirely rather than rewriting a record with its own contents — a retry that
 * republishes every agent is a retry that can fail for a new reason.
 */
export function applyAgentPromptTranslation(
  spec: Record<string, unknown>,
  translation: AgentPromptTranslation,
): Record<string, unknown> | null {
  if (translation.addedSkills.length === 0 && !translation.hadPromptsKey) {
    return null;
  }
  const { prompts: _removed, ...rest } = spec;
  return {
    ...rest,
    ...(translation.skills.length > 0 ? { skills: translation.skills } : {}),
  };
}
