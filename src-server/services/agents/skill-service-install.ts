import { existsSync } from 'node:fs';
import { lstat, mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { SkillConfig } from '../../domain/config-loader.js';
import type { ISkillRegistryProvider } from '../../providers/provider-interfaces.js';
import { withLocalSkillMutation } from './skill-local-mutation.js';
import {
  assertSkillPackageDirectory,
  resolveSkillDirectory,
  skillsRootDir,
} from './skill-metadata.js';
import { localSkillRevisionFromDirectory } from './skill-revision.js';

interface SkillInstallConfigLoader {
  /**
   * Directory-addressed, like every other write since #1619: the install has
   * just published the package at `skillDir`, and a name-addressed save
   * resolves `<home>/skills/<name>` with no slug — so a scoped install put the
   * package in the project root and its record in the machine one (review M3,
   * the last production write left name-addressed).
   */
  saveSkillIn: (directory: string, config: SkillConfig) => Promise<void>;
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
  /**
   * The package's OWN directory, resolved by the caller from where discovery
   * found it (#1619). Derived here from the name and a project slug no route
   * supplies, a remove answered "not found" for every workspace package.
   */
  targetDir: string;
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
  // An install's directory is name-derived: it is a create, and there is no
  // discovered package to read one from (#1619).
  return withLocalSkillMutation(
    [resolveSkillDirectory(projectHomeDir, name, projectSlug)],
    () =>
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
  let published = false;
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
      published = true;

      // The best-effort half is the PROVIDER's metadata: a registry that
      // cannot say what version it just served is not a failed install, and
      // the package on disk is complete without it.
      //
      // The try has to cover the CALL, not just its promise. Narrowed to
      // `.catch()` this protected against a rejection only, so a provider that
      // threw synchronously — or returned something that is not a promise —
      // failed an install that had already published its package, which is the
      // opposite of what the sentence above promises (delta review 4, M1).
      let items: Awaited<ReturnType<typeof provider.listAvailable>> = [];
      try {
        const listed = await provider.listAvailable();
        if (Array.isArray(listed)) items = listed;
      } catch {}
      const item = items.find((entry) => entry.id === name);
      const version = item?.version ?? 'unknown';
      const installedAt = new Date().toISOString();
      try {
        await writeFile(
          join(skillDir, '.station-meta.json'),
          JSON.stringify({ version, installedAt, source: 'registry' }, null, 2),
        );
      } catch {}
      // The RECORD is not best-effort, and its writer now asserts containment
      // (#1619). Swallowing that throw meant an install that wrote a package
      // outside the roots — or could not write its record at all — returned
      // success with no manifest behind it (delta review 3, L3). A failure
      // here is the install's failure.
      await configLoader.saveSkillIn(skillDir, {
        name,
        description: item?.description,
        source: 'registry',
        installedAt,
        version,
        path: skillDir,
        origin: 'registry',
      });

      // Nothing failed, so a rediscovery that fails is the only thing that
      // went wrong and is reported as itself. Deliberately NOT in the
      // `finally` below: a throw from there overwrites the return.
      await rediscover();
      return result;
    } catch (error) {
      // REDISCOVER WHATEVER HAPPENED AFTER THE RENAME. The package is on disk
      // from that moment, and this branch makes a recordless package
      // answerable from discovery (#1614) — so a failed record write that
      // skipped rediscovery left a skill the install reported as failed
      // turning up in the listing anyway, at the next discovery somebody else
      // ran (delta review 4, L1). Deleting the published tree instead would be
      // wrong for the containment case, where the tree is outside the roots
      // and Station has just refused to touch it.
      //
      // Its failure is SWALLOWED here, and this is the whole point: an
      // exception from a `finally` — or from this path — replaces the one in
      // flight, so a rediscovery that fails on an unrelated unreadable
      // directory turned a containment refusal into an errno about somewhere
      // else, the same wrong-explanation defect fixed one layer in as M3
      // (delta review 5, F1). Discovery reads directories unguarded at every
      // depth, so any unreadable one in the skills or plugins tree reaches it.
      // The install's own error is what a caller needs.
      if (published) {
        try {
          await rediscover();
        } catch {}
      }
      throw error;
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
  targetDir,
  rediscover,
}: RemoveSkillDeps): Promise<{ success: boolean; message: string }> {
  // The floor beneath a directory the caller resolved: a remove deletes a
  // whole package tree, so it must be a package directory in a root Station
  // writes and nothing else.
  assertSkillPackageDirectory(projectHomeDir, name, targetDir);
  if (!existsSync(targetDir)) {
    return { success: false, message: `Skill '${name}' not found` };
  }

  await rm(targetDir, { recursive: true, force: true });
  await rediscover();
  return { success: true, message: `Removed ${name}` };
}
