import type { GuidanceAsset, Skill, SkillStats } from './catalog';

/** A guidance asset nobody has run yet. */
export function createGuidanceStats(): SkillStats {
  return {
    runs: 0,
    successes: 0,
    failures: 0,
    qualityScore: null,
  };
}

/**
 * The success rate, as a whole percentage, or `null` when no outcome has been
 * recorded — the honest answer for "no evidence", never 0.
 *
 * Always COMPUTED from the counters and never stored, so a persisted score can
 * not drift from the successes/failures behind it. Every consumer shares this
 * one derivation.
 */
export function computeGuidanceQualityScore(
  stats: Pick<SkillStats, 'successes' | 'failures'>,
): number | null {
  const totalOutcomes = stats.successes + stats.failures;
  if (totalOutcomes === 0) {
    return null;
  }
  return Math.round((stats.successes / totalOutcomes) * 100);
}

export function skillToGuidanceAsset(skill: Skill): GuidanceAsset {
  return {
    id: skill.id,
    kind: 'skill',
    name: skill.name,
    body: skill.body ?? '',
    description: skill.description,
    tags: skill.tags,
    source: skill.source,
    storageMode: skill.path ? 'skill-package' : 'markdown-file',
    runtimeMode: 'skill-catalog',
    packaging: {
      installable: true,
      installed: skill.installed,
      installedVersion: skill.installedVersion,
      version: skill.version,
      path: skill.path,
      source: skill.source,
      resources: skill.resources,
      scripts: skill.scripts,
    },
    provenance: skill.provenance,
  };
}
