/**
 * A plugin's prompt files, read as command skills WHERE THEY LIE.
 *
 * What this replaces: `publishPluginPromptGeneration` copied every scanned
 * plugin prompt file into a `<home>/prompts` store on install and deleted them
 * by matching a `source: 'plugin:<name>'` string on uninstall. That is a
 * lifecycle a copy always loses: a plugin removed while Station was not
 * running, a copy hand-edited by a user, a `source` string that drifted — each
 * one strands rows nothing owns.
 *
 * Reading in place has no lifecycle at all. The plugin directory is the record;
 * remove the plugin and the skills are gone at the next discovery, with nothing
 * to reconcile. The context-safety scans (`scanContextText`) still run here, so
 * a plugin cannot smuggle hidden-channel text into a model through this path
 * any more than it could through the old one.
 *
 * These skills are READ-ONLY: they live under `<home>/plugins`, a root Station
 * does not write to, so `isSkillWritable` already refuses to edit them and
 * their `command` declaration comes from the file rather than an install
 * record they do not have.
 */
import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { SkillCommand } from '@kontourai/station-contracts/catalog';
import type { PluginManifest } from '@kontourai/station-contracts/plugin';
import { skillCommandSlug } from '@kontourai/station-contracts/skill-command';
import { isSafeSkillName } from '../../domain/skill-paths.js';
import { assertExistingPathInside } from '../../utils/path-containment.js';
import {
  ContextSafetyError,
  type ContextSafetyFinding,
  scanContextText,
} from '../orchestration/context-safety.js';
import { readPluginManifestFileSyncWithFormat } from './plugin-manifest-loader.js';

/**
 * One `.md` file read out of a plugin's declared `prompts.source` directory.
 *
 * `prompts` is the plugin MANIFEST's own field name (`PluginManifest.prompts`)
 * and stays as authors wrote it — `skills` on that manifest already means the
 * skill-package list, so the two cannot be merged. Inside Station every one of
 * these files becomes a command skill, which is what `scanPluginCommandSkills`
 * returns; this local shape exists only to carry a scanned file that far.
 */
interface PluginPromptFile {
  id: string;
  name: string;
  content: string;
  description?: string;
  icon?: string;
  requires?: string[];
  category?: string;
  tags?: string[];
  agent?: string;
  source: string;
  createdAt: string;
  updatedAt: string;
}

function parsePluginFrontmatter(content: string): {
  meta: Record<string, any>;
  body: string;
} {
  const match = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) return { meta: {}, body: content.trim() };
  const meta: Record<string, any> = {};
  for (const line of match[1].split('\n')) {
    const colon = line.indexOf(':');
    if (colon === -1) continue;
    const key = line.slice(0, colon).trim();
    const value = line.slice(colon + 1).trim();
    meta[key] = value.startsWith('[')
      ? value
          .slice(1, -1)
          .split(',')
          .map((item) => item.trim().replace(/["']/g, ''))
      : value.replace(/["']/g, '');
  }
  return { meta, body: match[2].trim() };
}

/**
 * A skill the registry serves straight out of a plugin, with no `SKILL.md` and
 * no `skill.json` behind it.
 */
export interface PluginCommandSkill {
  name: string;
  description: string;
  body: string;
  /**
   * The plugin's manifest. The scanner does not report which `.md` file a
   * prompt came from, and the manifest is the honest stand-in: its directory
   * is the plugin's own, which is what a listing should name as the source and
   * what `deriveOrigin` reads to classify this as `origin: 'plugin'`.
   */
  location: string;
  source: string;
  legacyIds: string[];
  command: SkillCommand;
}

export interface PluginCommandSkillLogger {
  warn: (message: string, meta?: Record<string, unknown>) => void;
}

/** One prompt file the context-safety scan refused, and why. */
export interface BlockedPluginPromptFile {
  file: string;
  findings: ContextSafetyFinding[];
}

/**
 * Read a plugin's declared prompt files once, separating the ones that pass
 * the context-safety scan from the ones that do not.
 *
 * ONE derivation, two readers: `scanPluginPromptGeneration` (install and
 * discovery) throws on any blocked file, and `scanPluginPromptFileSafety`
 * (install PREVIEW) reports them per file. They cannot disagree about what is
 * unsafe, which is the whole reason preview exists — it tells a user what the
 * installer is about to do.
 *
 * Path-shape violations still THROW here rather than being reported per file:
 * a symlinked or non-regular prompt file is not a finding about content, it is
 * a plugin reaching outside its own root.
 */
function collectPluginPromptFiles(
  pluginDir: string,
  pluginName: string,
): { prompts: PluginPromptFile[]; blockedFiles: BlockedPluginPromptFile[] } {
  const manifestPath = join(pluginDir, 'plugin.json');
  if (!existsSync(manifestPath)) return { prompts: [], blockedFiles: [] };
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8')) as Pick<
    PluginManifest,
    'prompts'
  >;
  if (!manifest.prompts?.source) return { prompts: [], blockedFiles: [] };
  const promptsDir = join(pluginDir, manifest.prompts.source);
  assertExistingPathInside(pluginDir, promptsDir, 'Plugin prompts source');
  for (const file of readdirSync(promptsDir)) {
    if (!file.endsWith('.md')) continue;
    const stat = lstatSync(join(promptsDir, file));
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new ContextSafetyError({
        blocked: true,
        findings: [
          {
            excerpt: file,
            message:
              'Plugin prompt files must be regular files inside the plugin root.',
            ruleId: 'plugin-prompt-file-boundary',
            severity: 'block',
          },
        ],
        source: `plugin '${pluginName}' prompt files`,
      });
    }
  }
  const prompts: PluginPromptFile[] = [];
  const blockedFiles: BlockedPluginPromptFile[] = [];
  for (const file of readdirSync(promptsDir).filter((entry) =>
    entry.endsWith('.md'),
  )) {
    const raw = readFileSync(join(promptsDir, file), 'utf-8');
    const hidden = scanContextText(raw, {
      profile: 'hidden-only',
      source: `plugin prompt '${pluginName}/${file}'`,
    });
    const { meta, body } = parsePluginFrontmatter(raw);
    const bodySafety = scanContextText(body, {
      source: `plugin prompt '${pluginName}/${file}' body`,
    });
    if (hidden.blocked || bodySafety.blocked) {
      blockedFiles.push({
        file,
        findings: [...hidden.findings, ...bodySafety.findings],
      });
      continue;
    }
    const id = meta.id || basename(file, '.md');
    const now = new Date().toISOString();
    prompts.push({
      id: `${pluginName}:${id}`,
      name: meta.label || meta.name || id,
      content: body,
      description: meta.description,
      icon: meta.icon,
      requires: meta.requires,
      category: meta.category,
      tags: meta.tags,
      agent: meta.agent,
      source: `plugin:${pluginName}`,
      createdAt: now,
      updatedAt: now,
    });
  }
  return { prompts, blockedFiles };
}

export function scanPluginPromptGeneration(
  pluginDir: string,
  pluginName: string,
): PluginPromptFile[] {
  const { prompts, blockedFiles } = collectPluginPromptFiles(
    pluginDir,
    pluginName,
  );
  if (blockedFiles.length > 0) {
    throw new ContextSafetyError({
      blocked: true,
      findings: blockedFiles.flatMap((blocked) => blocked.findings),
      source: `plugin '${pluginName}' prompt files`,
    });
  }
  return prompts;
}

/**
 * The install PREVIEW's read of the same scan, per file.
 *
 * Preview must refuse exactly what install refuses. Reporting "valid" for a
 * plugin the installer will reject is worse than refusing late: the user
 * approves it on the strength of a preview that never looked.
 */
export function scanPluginPromptFileSafety(
  pluginDir: string,
  pluginName: string,
): BlockedPluginPromptFile[] {
  return collectPluginPromptFiles(pluginDir, pluginName).blockedFiles;
}

/**
 * Every plugin prompt in `<home>/plugins`, as a command skill.
 *
 * One plugin failing to scan — a context-safety block, an unreadable manifest —
 * removes that plugin's skills and nobody else's. A whole discovery that threw
 * because one plugin was malformed would take every other plugin's commands
 * down with it.
 */
export function scanPluginCommandSkills(
  projectHomeDir: string,
  logger: PluginCommandSkillLogger,
  /**
   * Names already claimed by a discovered skill. Suffixing against ONLY the
   * other plugin prompts let a local skill of the same slug overwrite this
   * one in the registry and take its `legacyIds` with it, so `<ns>:<id>`
   * stopped resolving while the plugin was still installed (review M2).
   */
  takenNames: ReadonlySet<string> = new Set(),
): PluginCommandSkill[] {
  const pluginsRoot = join(projectHomeDir, 'plugins');
  if (!existsSync(pluginsRoot)) return [];

  let entries: string[];
  try {
    entries = readdirSync(pluginsRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch (error) {
    logger.warn('Plugin command-skill scan could not read the plugins root', {
      pluginsRoot,
      error,
    });
    return [];
  }

  const skills: PluginCommandSkill[] = [];
  const taken = new Set<string>(takenNames);
  for (const pluginName of entries) {
    const pluginDir = join(pluginsRoot, pluginName);
    let prompts: ReturnType<typeof scanPluginPromptGeneration>;
    try {
      // Agent Plugins own their portable `skills/` vocabulary. Unknown root
      // fields are ignored by that spec and must not silently reactivate the
      // legacy Station `prompts` contribution path.
      if (
        readPluginManifestFileSyncWithFormat(join(pluginDir, 'plugin.json'))
          .format === 'agent-plugin-1.0'
      ) {
        continue;
      }
      prompts = scanPluginPromptGeneration(pluginDir, pluginName);
    } catch (error) {
      logger.warn(
        error instanceof ContextSafetyError
          ? 'Plugin prompt files were refused by the context-safety scan'
          : 'Plugin prompt files could not be scanned',
        { pluginName, error },
      );
      continue;
    }
    for (const prompt of prompts) {
      // The command word is derived exactly as it is for an authored skill,
      // so a plugin prompt file keeps the `/command` its users already type.
      const desired =
        skillCommandSlug(prompt.name) || skillCommandSlug(pluginName);
      let name = desired;
      let suffix = 2;
      while (!isSafeSkillName(name) || taken.has(name)) {
        name = `${desired || 'plugin-prompt'}-${suffix}`;
        suffix += 1;
      }
      taken.add(name);
      skills.push({
        name,
        description: prompt.description ?? '',
        body: prompt.content,
        location: join(pluginDir, 'plugin.json'),
        source: prompt.source ?? `plugin:${pluginName}`,
        // `<ns>:<id>` — the identity layouts and stored references already
        // hold, so `GET /api/skills/<ns>:<id>` keeps resolving after the
        // merge.
        legacyIds: [prompt.id],
        command: { enabled: true },
      });
    }
  }
  return skills;
}
