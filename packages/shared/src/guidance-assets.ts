import type {
  GuidanceAsset,
  Skill,
} from '@kontourai/station-contracts/catalog';

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
  };
}
