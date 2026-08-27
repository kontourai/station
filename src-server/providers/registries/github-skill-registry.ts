import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
  InstallResult,
  RegistryItem,
} from '@kontourai/station-contracts/catalog';
import { createLogger } from '../../utils/logger.js';
import type { ISkillRegistryProvider } from '../provider-interfaces.js';

const logger = createLogger({ name: 'skill-registry' });

interface GitHubTreeItem {
  path: string;
  type: 'blob' | 'tree';
  url?: string;
}

export class GitHubSkillRegistryProvider implements ISkillRegistryProvider {
  private owner: string;
  private repo: string;
  private skillsPath: string;
  private branch: string;
  private cache: { items: RegistryItem[]; ts: number } | null = null;
  private readonly TTL = 5 * 60 * 1000; // 5 min

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
  }

  private async fetchTree(): Promise<GitHubTreeItem[]> {
    const url = `https://api.github.com/repos/${this.owner}/${this.repo}/git/trees/${this.branch}?recursive=1`;
    const res = await fetch(url, {
      headers: {
        Accept: 'application/vnd.github.v3+json',
        'User-Agent': 'station',
      },
    });
    if (!res.ok) throw new Error(`GitHub API ${res.status}: ${res.statusText}`);
    const data = (await res.json()) as { tree: GitHubTreeItem[] };
    return data.tree;
  }

  private async fetchFileContent(path: string): Promise<string> {
    const url = `https://raw.githubusercontent.com/${this.owner}/${this.repo}/${this.branch}/${path}`;
    const res = await fetch(url, { headers: { 'User-Agent': 'station' } });
    if (!res.ok) throw new Error(`Failed to fetch ${path}: ${res.status}`);
    return res.text();
  }

  async listAvailable(): Promise<RegistryItem[]> {
    if (this.cache && Date.now() - this.cache.ts < this.TTL)
      return this.cache.items;

    try {
      const tree = await this.fetchTree();
      const prefix = `${this.skillsPath}/`;
      // Find directories that contain SKILL.md
      const skillDirs = new Set<string>();
      for (const item of tree) {
        if (
          item.path.startsWith(prefix) &&
          item.path.endsWith('/SKILL.md') &&
          item.type === 'blob'
        ) {
          const dir = item.path.slice(prefix.length).split('/')[0];
          skillDirs.add(dir);
        }
      }

      const items: RegistryItem[] = [];
      // Fetch SKILL.md for each to get name/description from frontmatter
      const { parseFrontmatter } = await import('agent-skills-ts-sdk');
      await Promise.all(
        Array.from(skillDirs).map(async (dir) => {
          try {
            const content = await this.fetchFileContent(
              `${this.skillsPath}/${dir}/SKILL.md`,
            );
            const { metadata } = parseFrontmatter(content);
            items.push({
              id: metadata.name || dir,
              displayName: metadata.name || dir,
              description: metadata.description || '',
              version: metadata.metadata?.version || undefined,
              installed: false,
              source: 'GitHub',
            });
          } catch (e) {
            logger.warn('Failed to parse remote skill', { dir, error: e });
            items.push({
              id: dir,
              displayName: dir,
              description: '',
              installed: false,
              source: 'GitHub',
            });
          }
        }),
      );

      this.cache = { items, ts: Date.now() };
      return items;
    } catch (e) {
      logger.error('Failed to fetch skill registry', { error: e });
      return this.cache?.items || [];
    }
  }

  async listInstalled(): Promise<RegistryItem[]> {
    return []; // Installed skills are tracked by the local skill service
  }

  async install(id: string, targetDir: string): Promise<InstallResult> {
    try {
      const tree = await this.fetchTree();
      const prefix = `${this.skillsPath}/${id}/`;
      const files = tree.filter(
        (item) => item.path.startsWith(prefix) && item.type === 'blob',
      );

      if (files.length === 0)
        return {
          success: false,
          message: `Skill '${id}' not found in registry`,
        };

      const skillDir = join(targetDir, id);
      mkdirSync(skillDir, { recursive: true });

      for (const file of files) {
        const relativePath = file.path.slice(prefix.length);
        const filePath = join(skillDir, relativePath);
        const dir = filePath.substring(0, filePath.lastIndexOf('/'));
        if (dir !== skillDir) mkdirSync(dir, { recursive: true });
        const content = await this.fetchFileContent(file.path);
        writeFileSync(filePath, content, 'utf-8');
      }

      logger.info('Skill installed from registry', { id, files: files.length });
      return {
        success: true,
        message: `Installed ${id} (${files.length} files)`,
      };
    } catch (e: any) {
      return { success: false, message: e.message };
    }
  }

  async uninstall(id: string, targetDir: string): Promise<InstallResult> {
    const skillDir = join(targetDir, id);
    if (!existsSync(skillDir))
      return { success: false, message: `Skill '${id}' not found locally` };
    rmSync(skillDir, { recursive: true, force: true });
    return { success: true, message: `Removed ${id}` };
  }

  async getContent(id: string): Promise<string | null> {
    try {
      const content = await this.fetchFileContent(
        `${this.skillsPath}/${id}/SKILL.md`,
      );
      const { parseFrontmatter } = await import('agent-skills-ts-sdk');
      const { body } = parseFrontmatter(content);
      return body || content;
    } catch {
      return null;
    }
  }
}
