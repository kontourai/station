import { existsSync } from 'node:fs';
import { cp, lstat, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import type {
  InstallResult,
  RegistryItem,
} from '@kontourai/station-contracts/catalog';
import { parseFrontmatter } from 'agent-skills-ts-sdk';
import { localSkillRevisionFromDirectory } from '../../services/agents/skill-revision.js';
import { appHomeProfileDir } from '../app-home/app-home-profiles.js';
import type { ISkillRegistryProvider } from '../provider-interfaces.js';
import {
  assertConfinedPath,
  assertNoLinksBelow,
  readBoundedFile,
  readConfinedFile,
} from './confined-local-read.js';

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
    join(appHomeProfileDir('codex'), 'skills'),
    join(appHomeProfileDir('claude'), 'skills'),
  ];
}

/** The read bound for one SKILL.md, the same as a skill package file's. */
const SKILL_DOCUMENT_MAX_BYTES = 1024 * 1024;

const missing = (error: unknown) =>
  error instanceof Error &&
  'code' in error &&
  (error.code === 'ENOENT' || error.code === 'ENOTDIR');

export class FilesystemSkillRegistryProvider implements ISkillRegistryProvider {
  private readonly roots: string[];
  private children?: FilesystemSkillRegistryProvider[];

  constructor(
    roots: string[] = defaultSkillRoots(),
    private readonly options: {
      /**
       * Refuse a listing in which two roots hold the same skill name instead
       * of keeping the first. A source whose skills were found by a scan sets
       * it: its roots are one library, so a repeated name is ambiguous, not an
       * override.
       */
      refuseAmbiguousNames?: boolean;
      /**
       * The folder a person added as a source. Every read stays inside it by
       * real path and follows no link (`confined-local-read.ts`): a linked
       * SKILL.md is not listed, and a linked or escaping directory refuses the
       * listing. Default skill folders leave it unset, because a person may
       * link skills into their own folders on purpose.
       */
      confineTo?: string;
    } = {},
  ) {
    this.roots = [...roots];
  }

  get registryKey(): string {
    return this.roots.join('|');
  }

  catalogProviders(): FilesystemSkillRegistryProvider[] {
    this.children ??= this.roots.map(
      (root) => new FilesystemSkillRegistryProvider([root]),
    );
    return this.children;
  }

  /**
   * The skill package directory for `id` under `root`, or null when there is
   * none. Confined: reached without links, and its SKILL.md is a regular file.
   */
  private async skillDirectory(
    root: string,
    id: string,
  ): Promise<string | null> {
    const directory = join(root, id);
    const confineTo = this.options.confineTo;
    if (!confineTo)
      return existsSync(join(directory, 'SKILL.md')) ? directory : null;
    try {
      if (!(await assertConfinedPath(confineTo, directory)).isDirectory())
        return null;
      const document = await lstat(join(directory, 'SKILL.md'));
      if (!document.isFile()) return null;
      // Before its files are hashed, read or copied: no link and no
      // multiply linked file anywhere in the package.
      await assertNoLinksBelow(confineTo, directory);
      return directory;
    } catch (error) {
      if (missing(error)) return null;
      throw error;
    }
  }

  private async readSkillDocument(path: string): Promise<string> {
    const confineTo = this.options.confineTo;
    return (
      confineTo
        ? await readConfinedFile(confineTo, path, SKILL_DOCUMENT_MAX_BYTES)
        : await readBoundedFile(path, SKILL_DOCUMENT_MAX_BYTES)
    ).toString('utf-8');
  }

  async getPackageRevision(id: string): Promise<string | null> {
    for (const root of this.roots) {
      const directory = await this.skillDirectory(root, id);
      if (directory) return localSkillRevisionFromDirectory(directory);
    }
    return null;
  }

  async listAvailable(): Promise<RegistryItem[]> {
    const items: RegistryItem[] = [];
    const seen = new Set<string>();
    const confineTo = this.options.confineTo;

    for (const root of this.roots) {
      if (!existsSync(root)) continue;
      // A root reached through a link leaves the source: refuse the listing.
      if (confineTo) await assertConfinedPath(confineTo, root);
      const entries = await readdir(root, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const skillDir = join(root, entry.name);
        const skillPath = join(skillDir, 'SKILL.md');
        if (confineTo) {
          // A linked SKILL.md is not this source's: it is not listed or read.
          const document = await lstat(skillPath).catch((error: unknown) => {
            if (missing(error)) return null;
            throw error;
          });
          if (!document?.isFile()) continue;
        } else if (!existsSync(skillPath)) continue;

        const raw = await this.readSkillDocument(skillPath);
        const { metadata } = parseFrontmatter(raw);
        const id = metadata.name || basename(skillDir);
        if (seen.has(id)) {
          if (this.options.refuseAmbiguousNames)
            throw new Error(`Skill library has ambiguous skill name '${id}'`);
          continue;
        }
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

  async install(
    id: string,
    targetDir: string,
    options?: { expectedPackageRevision?: string },
  ): Promise<InstallResult> {
    for (const root of this.roots) {
      const sourceDir = await this.skillDirectory(root, id);
      if (!sourceDir) continue;
      if (
        options?.expectedPackageRevision &&
        (await localSkillRevisionFromDirectory(sourceDir)) !==
          options.expectedPackageRevision
      )
        throw new Error('Registry skill source changed; inspect it again.');
      await cp(sourceDir, join(targetDir, id), {
        recursive: true,
        force: true,
        // A link swapped into the package is copied as a link, never
        // followed; the revision check below then refuses it.
        verbatimSymlinks: true,
      });
      // Confined, the copy is always re-read: the revision refuses a link or
      // anything that left the source between the check and the copy.
      const copied =
        options?.expectedPackageRevision || this.options.confineTo
          ? await localSkillRevisionFromDirectory(join(targetDir, id))
          : undefined;
      if (
        options?.expectedPackageRevision &&
        copied !== options.expectedPackageRevision
      )
        throw new Error('Registry skill package digest mismatch.');
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
      const directory = await this.skillDirectory(root, id);
      if (directory) return this.readSkillDocument(join(directory, 'SKILL.md'));
    }
    return null;
  }
}
