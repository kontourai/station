import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  InstallResult,
  RegistryItem,
} from '@kontourai/station-contracts/catalog';
import { validateWorkspacePackagePaths } from '@kontourai/station-shared/workspace-package';
import {
  ParseError,
  parseFrontmatter,
  parseSkillDocument,
  ValidationError,
} from 'agent-skills-ts-sdk';
import {
  assertSafeSkillName,
  PROTOTYPE_AFFECTING_KEYS,
} from '../../domain/skill-paths.js';
import { mapWithConcurrency } from '../../utils/bounded-async.js';
import type { ISkillRegistryProvider } from '../provider-interfaces.js';
import { readBoundedJson } from './catalog-http.js';

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
  body: string;
  formatCompatible: boolean;
}

export class UnsupportedRegistrySkillFormatError extends Error {
  constructor() {
    super(
      'This skill uses metadata that Station cannot install. Its original Markdown is available for inspection; ask its publisher for a supported format.',
    );
    this.name = 'UnsupportedRegistrySkillFormatError';
  }
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
    this.skillsPath = opts?.path ?? 'skills';
    this.branch = opts?.branch || 'main';
    if (this.skillsPath) this.assertRelativePath(this.skillsPath);
  }

  get registryKey(): string {
    return `github:${this.owner}/${this.repo}/${this.branch}/${this.skillsPath}`;
  }

  async refresh(): Promise<void> {
    if (this.pending) await this.pending;
    this.cache = null;
    await this.snapshot();
  }

  async getPackageRevision(id: string): Promise<string | null> {
    const snapshot = await this.snapshot();
    const skill = snapshot.packages.get(id);
    if (!skill) return null;
    return createHash('sha256')
      .update(
        JSON.stringify([
          snapshot.commit,
          snapshot.tree.filter((entry) =>
            entry.path.startsWith(`${skill.directory}/`),
          ),
        ]),
      )
      .digest('hex');
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

  private async request(path: string, signal?: AbortSignal): Promise<Response> {
    const url = `https://api.github.com/repos/${encodeURIComponent(this.owner)}/${encodeURIComponent(this.repo)}/${path}`;
    const response = await fetch(url, {
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(15000)])
        : AbortSignal.timeout(15000),
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
    budget: { remainingBytes: number },
    signal: AbortSignal,
  ): Promise<Buffer> {
    this.assertSha(entry.sha);
    const url = `https://raw.githubusercontent.com/${encodeURIComponent(this.owner)}/${encodeURIComponent(this.repo)}/${commit}/${entry.path.split('/').map(encodeURIComponent).join('/')}`;
    const response = await fetch(url, {
      signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]),
      headers: { 'User-Agent': 'station' },
    });
    if (!response.ok)
      throw new Error(
        `GitHub skill blob acquisition failed: ${response.status}`,
      );
    const chunks: Uint8Array[] = [];
    let length = 0;
    const reader = response.body?.getReader();
    if (!reader) throw new Error('GitHub skill response body is unavailable.');
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      budget.remainingBytes -= value.byteLength;
      if (length > 1024 * 1024 || budget.remainingBytes < 0) {
        await reader.cancel();
        throw new Error('GitHub skill acquisition exceeds its byte budget.');
      }
      chunks.push(value);
    }
    const bytes = Buffer.concat(chunks);
    const digest = createHash('sha1')
      .update(`blob ${bytes.length}\0`)
      .update(bytes)
      .digest('hex');
    if (digest !== entry.sha) {
      throw new Error('GitHub skill registry blob integrity mismatch');
    }
    return bytes;
  }

  private readCatalogDocument(markdown: string): {
    name: string;
    description: string;
    version?: string;
    body: string;
    formatCompatible: boolean;
  } {
    const raw = parseSkillDocument(markdown);
    try {
      const parsed = parseFrontmatter(markdown);
      return {
        name: parsed.metadata.name,
        description: parsed.metadata.description,
        version: parsed.metadata.metadata?.version,
        body: parsed.body,
        formatCompatible: true,
      };
    } catch (error) {
      if (!(error instanceof ParseError || error instanceof ValidationError))
        throw error;
      const { name, description } = raw.metadata;
      if (
        typeof name !== 'string' ||
        !name.trim() ||
        typeof description !== 'string' ||
        !description.trim()
      )
        throw error;
      return {
        name: name.trim(),
        description: description.trim(),
        body: raw.body,
        formatCompatible: false,
      };
    }
  }

  private async readSnapshot(): Promise<CatalogSnapshot> {
    const signal = AbortSignal.timeout(60000);
    const budget = { remainingBytes: 8 * 1024 * 1024 };
    const response = await this.request(
      `commits/${encodeURIComponent(this.branch)}`,
      signal,
    );
    const commit = (await readBoundedJson(response)) as {
      sha: string;
      commit: { tree: { sha: string } };
    };
    this.assertSha(commit.sha);
    this.assertSha(commit.commit.tree.sha);
    const treeResponse = await this.request(
      `git/trees/${commit.commit.tree.sha}?recursive=1`,
      signal,
    );
    const result = (await readBoundedJson(treeResponse)) as {
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
    const prefix = this.skillsPath ? `${this.skillsPath}/` : '';
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
    const markdownEntries = tree.filter(
      (entry) => entry.type === 'blob' && entry.path.endsWith('/SKILL.md'),
    );
    if (markdownEntries.length > 512 || tree.length > 8192)
      throw new Error('GitHub skill catalog exceeds its entry budget.');
    const discovered = await mapWithConcurrency(
      markdownEntries,
      4,
      async (entry): Promise<SkillPackage> => {
        const directory = entry.path.slice(0, -'/SKILL.md'.length);
        const markdown = (
          await this.fetchBlob(entry, commit.sha, budget, signal)
        ).toString('utf-8');
        const document = this.readCatalogDocument(markdown);
        const id = document.name;
        const unsupportedName = PROTOTYPE_AFFECTING_KEYS.includes(id);
        if (!unsupportedName) assertSafeSkillName(id);
        return {
          directory,
          markdown,
          body: document.body,
          formatCompatible: document.formatCompatible,
          item: {
            id,
            displayName: id,
            description: document.description,
            version: document.version,
            installed: false,
            ...(unsupportedName
              ? { status: 'unsupported-skill-name' }
              : !document.formatCompatible
                ? { status: 'unsupported-skill-format' }
                : {}),
            source: `https://github.com/${this.owner}/${this.repo}/tree/${commit.sha}/${directory}`,
          },
        };
      },
      signal,
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

  async install(
    id: string,
    targetDir: string,
    options?: { expectedPackageRevision?: string },
  ): Promise<InstallResult> {
    try {
      assertSafeSkillName(id);
      const snapshot = await this.snapshot();
      const skill = snapshot.packages.get(id);
      if (!skill)
        return {
          success: false,
          message: `Skill '${id}' not found in registry`,
        };
      if (
        options?.expectedPackageRevision &&
        (await this.getPackageRevision(id)) !== options.expectedPackageRevision
      )
        throw new Error('Registry skill source changed; inspect it again.');
      if (!skill.formatCompatible)
        throw new UnsupportedRegistrySkillFormatError();
      const prefix = `${skill.directory}/`;
      const files = snapshot.tree.filter(
        (entry) => entry.type === 'blob' && entry.path.startsWith(prefix),
      );
      if (files.length > 256)
        throw new Error('GitHub skill package exceeds its entry budget.');
      const signal = AbortSignal.timeout(60000);
      const budget = { remainingBytes: 8 * 1024 * 1024 };
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
        const bytes = await this.fetchBlob(
          file,
          snapshot.commit,
          budget,
          signal,
        );
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
      if (error instanceof UnsupportedRegistrySkillFormatError) throw error;
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
    return skill.formatCompatible
      ? skill.body || skill.markdown
      : skill.markdown;
  }
}
