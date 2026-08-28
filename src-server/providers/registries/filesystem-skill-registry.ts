import { existsSync } from 'node:fs';
import { cp, readdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import type {
  InstallResult,
  RegistryItem,
} from '@kontourai/station-contracts/catalog';
import { parseFrontmatter } from 'agent-skills-ts-sdk';
import { appHomeProfileDir } from '../app-home/app-home-profiles.js';
import type { ISkillRegistryProvider } from '../provider-interfaces.js';

/**
 * archive#896 wave 2 (docs/design/connections-onboarding.md §1.1's named gap):
 * also lists the Station-owned app-home profile skills dirs — read-only
 * listing sources, still additive/browse-only. The existing `existsSync`
 * guard in `listAvailable`/`install`/`getContent` already makes an absent
 * profile (never opted in, or opted in but no skills imported) a silent
 * no-op, so these two extra roots are safe to always include.
 */
function defaultSkillRoots() {
  const home = homedir();
  return [
    join(home, '.codex', 'skills'),
    join(home, '.claude', '.agents', 'skills'),
    join(appHomeProfileDir('codex-runtime'), 'skills'),
    join(appHomeProfileDir('claude-runtime'), 'skills'),
  ];
}

export class FilesystemSkillRegistryProvider implements ISkillRegistryProvider {
  constructor(private roots: string[] = defaultSkillRoots()) {}

  async listAvailable(): Promise<RegistryItem[]> {
    const items: RegistryItem[] = [];
    const seen = new Set<string>();

    for (const root of this.roots) {
      if (!existsSync(root)) continue;
      const entries = await readdir(root, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const skillDir = join(root, entry.name);
        const skillPath = join(skillDir, 'SKILL.md');
        if (!existsSync(skillPath)) continue;

        const raw = await readFile(skillPath, 'utf-8');
        const { metadata } = parseFrontmatter(raw);
        const id = metadata.name || basename(skillDir);
        if (seen.has(id)) continue;
        seen.add(id);

        items.push({
          id,
          displayName: metadata.name || basename(skillDir),
          description: metadata.description || '',
          installed: false,
          source: root,
          version: metadata.metadata?.version || undefined,
        });
      }
    }

    return items;
  }

  async listInstalled(): Promise<RegistryItem[]> {
    return [];
  }

  async install(id: string, targetDir: string): Promise<InstallResult> {
    for (const root of this.roots) {
      const sourceDir = join(root, id);
      if (!existsSync(join(sourceDir, 'SKILL.md'))) continue;
      await cp(sourceDir, join(targetDir, id), {
        recursive: true,
        force: true,
      });
      return { success: true, message: `Installed ${id} from ${root}` };
    }

    return {
      success: false,
      message: `Skill '${id}' not found in local registry sources`,
    };
  }

  async uninstall(id: string, _targetDir: string): Promise<InstallResult> {
    return { success: false, message: `Local registry does not own ${id}` };
  }

  async getContent(id: string): Promise<string | null> {
    for (const root of this.roots) {
      const skillPath = join(root, id, 'SKILL.md');
      if (existsSync(skillPath)) {
        return readFile(skillPath, 'utf-8');
      }
    }
    return null;
  }
}
