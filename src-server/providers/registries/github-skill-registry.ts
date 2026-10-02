import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type {
  InstallResult,
  RegistryItem,
} from '@kontourai/station-contracts/catalog';
import { validateWorkspacePackagePaths } from '@kontourai/station-shared/workspace-package';
import { parseFrontmatter } from 'agent-skills-ts-sdk';
import { assertSafeSkillName } from '../../domain/skill-paths.js';
import type { ISkillRegistryProvider } from '../provider-interfaces.js';

interface GitHubTreeItem {
  path: string;
  type: 'blob' | 'tree' | 'commit';
  sha: string;
  mode: string;
}

interface SkillPackage {
  item: RegistryItem;
  directory: string;
  markdown: string;
}

interface CatalogSnapshot {
  commit: string;
  tree: GitHubTreeItem[];
  packages: Map<string, SkillPackage>;
  ts: number;
}

export class GitHubSkillRegistryProvider implements ISkillRegistryProvider {
  private readonly owner: string;
  private readonly repo: string;
  private readonly skillsPath: string;
  private readonly branch: string;
  private cache: CatalogSnapshot | null = null;
  private pending: Promise<CatalogSnapshot> | null = null;
  private readonly TTL = 5 * 60 * 1000;

  constructor(opts?: {
    owner?: string;
    repo?: string;
    path?: string;
    branch?: string;
  }) {
    this.owner = opts?.owner || 'anthropics';
    this.repo = opts?.repo || 'skills';
    this.skillsPath = opts?.path || 'skills';
    this.branch = opts?.branch || 'main';
    this.assertRelativePath(this.skillsPath);
  }

  private assertRelativePath(path: string): void {
    if (
      path.includes('\\') ||
      path.includes('\0') ||
      path.split('/').some((part) => !part || part === '.' || part === '..')
    ) {
      throw new Error('GitHub skill registry contains an unsafe path');
    }
  }

  private async request(path: string): Promise<Response> {
    const url = `https://api.github.com/repos/${encodeURIComponent(this.owner)}/${encodeURIComponent(this.repo)}/${path}`;
    const response = await fetch(url, {
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': 'station',
      },
    });
    if (!response.ok) throw new Error(`GitHub API ${response.status}`);
    return response;
  }

  private assertSha(sha: string): void {
    if (!/^[0-9a-f]{40}$/.test(sha)) {
      throw new Error(
        'GitHub skill registry returned an invalid object identity',
      );
    }
  }

  private async fetchBlob(
    entry: GitHubTreeItem,
    commit: string,
  ): Promise<Buffer> {
    this.assertSha(entry.sha);
    const url = `https://raw.githubusercontent.com/${encodeURIComponent(this.owner)}/${encodeURIComponent(this.repo)}/${commit}/${entry.path.split('/').map(encodeURIComponent).join('/')}`;
    const response = await fetch(url, { headers: { 'User-Agent': 'station' } });
    if (!response.ok)
      throw new Error(
        `GitHub skill blob acquisition failed: ${response.status}`,
      );
    const bytes = Buffer.from(await response.arrayBuffer());
    const digest = createHash('sha1')
      .update(`blob ${bytes.length}\0`)
      .update(bytes)
      .digest('hex');
    if (digest !== entry.sha) {
      throw new Error('GitHub skill registry blob integrity mismatch');
    }
    return bytes;
  }

  private async readSnapshot(): Promise<CatalogSnapshot> {
    const response = await this.request(
      `commits/${encodeURIComponent(this.branch)}`,
    );
    const commit = (await response.json()) as {
      sha: string;
      commit: { tree: { sha: string } };
    };
    this.assertSha(commit.sha);
    this.assertSha(commit.commit.tree.sha);
    const treeResponse = await this.request(
      `git/trees/${commit.commit.tree.sha}?recursive=1`,
    );
    const result = (await treeResponse.json()) as {
      sha: string;
      truncated: boolean;
      tree: GitHubTreeItem[];
    };
    if (
      result.sha !== commit.commit.tree.sha ||
      result.truncated !== false ||
      !Array.isArray(result.tree)
    ) {
      throw new Error('GitHub skill registry returned an incomplete tree');
    }
    const prefix = `${this.skillsPath}/`;
    const tree = result.tree.filter((entry) => entry.path.startsWith(prefix));
    for (const entry of tree) {
      this.assertRelativePath(entry.path);
      this.assertSha(entry.sha);
      if (
        entry.type === 'commit' ||
        (entry.type === 'blob' && !['100644', '100755'].includes(entry.mode))
      ) {
        throw new Error(
          'GitHub skill registry contains a linked package entry',
        );
      }
    }
    const discovered = await Promise.all(
      tree
        .filter(
          (entry) => entry.type === 'blob' && entry.path.endsWith('/SKILL.md'),
        )
        .map(async (entry): Promise<SkillPackage> => {
          const directory = entry.path.slice(0, -'/SKILL.md'.length);
          const markdown = (await this.fetchBlob(entry, commit.sha)).toString(
            'utf-8',
          );
          const { metadata } = parseFrontmatter(markdown);
          const id = metadata.name || basename(directory);
          assertSafeSkillName(id);
          return {
            directory,
            markdown,
            item: {
              id,
              displayName: id,
              description: metadata.description || '',
              version: metadata.metadata?.version || undefined,
              installed: false,
              source: `https://github.com/${this.owner}/${this.repo}/tree/${commit.sha}/${directory}`,
            },
          };
        }),
    );
    const packages = new Map<string, SkillPackage>();
    // Resolve every name before publishing the snapshot: partial discovery can
    // hide a duplicate name and turn an ambiguous install into a first match.
    for (const skill of discovered) {
      if (packages.has(skill.item.id)) {
        throw new Error(
          `GitHub skill registry has ambiguous skill name '${skill.item.id}'`,
        );
      }
      packages.set(skill.item.id, skill);
    }
    return { commit: commit.sha, tree, packages, ts: Date.now() };
  }

  private async snapshot(): Promise<CatalogSnapshot> {
    if (this.cache && Date.now() - this.cache.ts < this.TTL) return this.cache;
    if (!this.pending) {
      this.pending = this.readSnapshot();
    }
    try {
      const snapshot = await this.pending;
      this.cache = snapshot;
      return snapshot;
    } finally {
      this.pending = null;
    }
  }

  async listAvailable(): Promise<RegistryItem[]> {
    return Array.from(
      (await this.snapshot()).packages.values(),
      (entry) => entry.item,
    );
  }

  async listInstalled(): Promise<RegistryItem[]> {
    return []; // Installed skills are tracked by the local skill service.
  }

  private assertPackagePaths(paths: string[]): void {
    validateWorkspacePackagePaths(paths);
    const siblings = new Map<string, Set<string>>();
    for (const path of paths) {
      const parts = path.split('/');
      for (let index = 0; index < parts.length; index++) {
        const parent = parts.slice(0, index).join('/');
        const names = siblings.get(parent) ?? new Set<string>();
        names.add(parts[index]!);
        siblings.set(parent, names);
      }
    }
    // Different child filenames must not hide aliased directory spellings.
    for (const names of siblings.values())
      validateWorkspacePackagePaths([...names]);
  }

  async install(id: string, targetDir: string): Promise<InstallResult> {
    try {
      assertSafeSkillName(id);
      const snapshot = await this.snapshot();
      const skill = snapshot.packages.get(id);
      if (!skill)
        return {
          success: false,
          message: `Skill '${id}' not found in registry`,
        };
      const prefix = `${skill.directory}/`;
      const files = snapshot.tree.filter(
        (entry) => entry.type === 'blob' && entry.path.startsWith(prefix),
      );
      this.assertPackagePaths(
        files.map((file) => file.path.slice(prefix.length)),
      );
      const skillDir = join(targetDir, id);
      await mkdir(skillDir);
      const createdDirectories = new Set<string>();
      for (const file of files) {
        const parts = file.path.slice(prefix.length).split('/').slice(0, -1);
        for (let length = 1; length <= parts.length; length++) {
          const directory = parts.slice(0, length).join('/');
          if (createdDirectories.has(directory)) continue;
          // A differently spelled filesystem alias must fail with EEXIST,
          // rather than being reused by recursive mkdir.
          await mkdir(join(skillDir, directory));
          createdDirectories.add(directory);
        }
      }
      for (const file of files) {
        const filePath = join(skillDir, file.path.slice(prefix.length));
        const bytes = await this.fetchBlob(file, snapshot.commit);
        await writeFile(filePath, bytes, {
          flag: 'wx',
          mode: file.mode === '100755' ? 0o755 : 0o644,
        });
      }
      return {
        success: true,
        message: `Installed ${id} (${files.length} files, commit ${snapshot.commit})`,
      };
    } catch (error) {
      return {
        success: false,
        message:
          error instanceof Error
            ? error.message
            : 'GitHub skill acquisition failed',
      };
    }
  }

  async uninstall(id: string, targetDir: string): Promise<InstallResult> {
    assertSafeSkillName(id);
    const skillDir = join(targetDir, id);
    if (!existsSync(skillDir))
      return { success: false, message: `Skill '${id}' not found locally` };
    await rm(skillDir, { recursive: true, force: true });
    return { success: true, message: `Removed ${id}` };
  }

  async getContent(id: string): Promise<string | null> {
    const skill = (await this.snapshot()).packages.get(id);
    if (!skill) return null;
    return parseFrontmatter(skill.markdown).body || skill.markdown;
  }
}
