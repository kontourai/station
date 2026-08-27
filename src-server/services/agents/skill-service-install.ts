import { existsSync } from 'node:fs';
import { lstat, mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { SkillConfig } from '../../domain/config-loader.js';
import type { ISkillRegistryProvider } from '../../providers/provider-interfaces.js';
import { withLocalSkillMutation } from './skill-local-mutation.js';
import { resolveSkillDirectory, skillsRootDir } from './skill-metadata.js';
import { localSkillRevisionFromDirectory } from './skill-revision.js';

interface SkillInstallConfigLoader {
  saveSkill: (name: string, config: SkillConfig) => Promise<void>;
}

interface InstallSkillDeps {
  name: string;
  projectHomeDir: string;
  projectSlug?: string;
  configLoader: SkillInstallConfigLoader;
  providers: Array<{ provider: ISkillRegistryProvider }>;
  rediscover: () => Promise<void>;
}

interface RemoveSkillDeps {
  name: string;
  projectHomeDir: string;
  projectSlug?: string;
  rediscover: () => Promise<void>;
}

const getSkillTargetDir = skillsRootDir;

export async function installSkillFromRegistry({
  name,
  projectHomeDir,
  projectSlug,
  configLoader,
  providers,
  rediscover,
}: InstallSkillDeps): Promise<{ success: boolean; message: string }> {
  // This is the public boundary used by SkillService and by direct callers.
  // Keep locking here, then call only the owned helper below: nesting the same
  // file capability would deadlock across service instances.
  return withLocalSkillMutation([name], projectHomeDir, projectSlug, () =>
    installSkillFromRegistryOwned({
      name,
      projectHomeDir,
      projectSlug,
      configLoader,
      providers,
      rediscover,
    }),
  );
}

async function installSkillFromRegistryOwned({
  name,
  projectHomeDir,
  projectSlug,
  configLoader,
  providers,
  rediscover,
}: InstallSkillDeps): Promise<{ success: boolean; message: string }> {
  if (providers.length === 0) {
    return { success: false, message: 'No skill registry configured' };
  }

  // The registry id becomes a directory on BOTH sides of the provider's copy
  // (`cp(join(registryRoot, id), join(targetDir, id))`), so it is refused here,
  // before any provider sees it — a `../candidate` id otherwise selected a
  // directory beside the registry root and wrote outside the skills root.
  const skillDir = resolveSkillDirectory(projectHomeDir, name, projectSlug);
  const targetDir = getSkillTargetDir(projectHomeDir, projectSlug);
  await mkdir(targetDir, { recursive: true });

  // Providers only ever receive an exclusive sibling staging parent.  They
  // therefore cannot observe or force-overwrite the live package, including
  // a winner created by setup or another Station process.
  for (const { provider } of providers) {
    // One provider gets one stage. A failed provider must not leave files for
    // the next provider to accidentally validate and publish.
    const stagingParent = await mkdtemp(
      join(dirname(skillDir), `.${name}.install-`),
    );
    const stagedSkillDir = join(stagingParent, name);
    try {
      const result = await provider.install(name, stagingParent);
      if (!result.success) continue;

      try {
        const staged = await lstat(stagedSkillDir);
        if (staged.isSymbolicLink() || !staged.isDirectory()) {
          return {
            success: false,
            message: `Registry skill '${name}' staged an unsafe package`,
          };
        }
        // The revision read is also the package-tree validator: bounded,
        // descriptor-read, no symlink/hardlink tree with a real SKILL.md.
        await localSkillRevisionFromDirectory(stagedSkillDir);
      } catch {
        return {
          success: false,
          message: `Registry skill '${name}' staged an invalid package`,
        };
      }

      // All Station writers take this exact capability.  The condition and
      // rename therefore form the no-overwrite publication protocol; an
      // existing package (including one that won setup's conditional create)
      // is retained rather than being replaced by a provider's force-copy.
      if (existsSync(skillDir)) {
        return { success: false, message: `Skill '${name}' already exists` };
      }
      await rename(stagedSkillDir, skillDir);

      try {
        const items = await provider.listAvailable().catch(() => []);
        const item = items.find((entry) => entry.id === name);
        const version = item?.version ?? 'unknown';
        const installedAt = new Date().toISOString();
        await writeFile(
          join(skillDir, '.station-meta.json'),
          JSON.stringify(
            {
              version,
              installedAt,
              source: 'registry',
            },
            null,
            2,
          ),
        );
        await configLoader.saveSkill(name, {
          name,
          description: item?.description,
          source: 'registry',
          installedAt,
          version,
          path: skillDir,
          origin: 'registry',
        });
      } catch {}

      await rediscover();
      return result;
    } finally {
      // `stagingParent` is ours by mkdtemp construction. Never clean the live
      // target on provider failure or publication conflict.
      await rm(stagingParent, { recursive: true, force: true });
    }
  }
  return {
    success: false,
    message: `No skill registry provider could install ${name}`,
  };
}

export async function removeInstalledSkill({
  name,
  projectHomeDir,
  projectSlug,
  rediscover,
}: RemoveSkillDeps): Promise<{ success: boolean; message: string }> {
  const targetDir = resolveSkillDirectory(projectHomeDir, name, projectSlug);
  if (!existsSync(targetDir)) {
    return { success: false, message: `Skill '${name}' not found` };
  }

  await rm(targetDir, { recursive: true, force: true });
  await rediscover();
  return { success: true, message: `Removed ${name}` };
}
