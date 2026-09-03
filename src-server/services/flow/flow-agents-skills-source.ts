/**
 * Canonical skills source: @kontourai/flow-agents (roadmap S3 item 3).
 *
 * The flow-agents npm package ships canonical skills under
 * `skills/<name>/SKILL.md`. Station treats that directory as data from the
 * dependency: the installed package's skills directory is registered as an
 * additional read-only discovery root, and the canonical skills become
 * browsable/assignable Station skills with no copied content or frozen local
 * list of expected skill names.
 *
 * Resolution order (mirroring the policy engine root):
 *   1. FLOW_AGENTS_SKILLS_ROOT env override — explicit but invalid does NOT
 *      fall through (a wrong override must surface).
 *   2. The installed @kontourai/flow-agents package's `skills/` directory.
 */

import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);

/** Source labels for package-contributed skills (extends the skill config
 * `source` vocabulary in config-loader-storage). */
export type CanonicalSkillSourceLabel =
  | 'flow-agents'
  | `agent-plugin:${string}`;

/** A read-only directory of SKILL.md skill folders contributed by a package. */
export interface CanonicalSkillSource {
  /** Directory whose children are `<skill-name>/SKILL.md` folders. */
  root: string;
  /** Source label surfaced in skill listings (e.g. 'flow-agents'). */
  label: CanonicalSkillSourceLabel;
  /** Version of the providing package, when known. */
  version?: string;
  /** Read-only Agent Plugin skills are plugin-owned rather than package-owned. */
  origin?: 'package' | 'plugin';
  /** Agent Plugins discover immediate children only; other sources retain recursion. */
  immediateOnly?: boolean;
  /** Apply the Agent Skills specification before registration. */
  validateAgentSkills?: boolean;
  /** Files and linked resources must remain within this resolved package root. */
  containmentRoot?: string;
}

function hasSkillFolders(root: string): boolean {
  try {
    return fs
      .readdirSync(root, { withFileTypes: true })
      .some(
        (entry) =>
          entry.isDirectory() &&
          fs.existsSync(path.join(root, entry.name, 'SKILL.md')),
      );
  } catch {
    return false;
  }
}

/**
 * Resolve the flow-agents canonical skills source, or null when neither the
 * override nor the installed package provides one (fail-open: Station's own
 * skills are unaffected).
 */
export function resolveFlowAgentsSkillsSource(
  env: NodeJS.ProcessEnv = process.env,
): CanonicalSkillSource | null {
  const override = env.FLOW_AGENTS_SKILLS_ROOT;
  if (override !== undefined && override !== '') {
    return hasSkillFolders(override)
      ? { root: path.resolve(override), label: 'flow-agents' }
      : null;
  }

  try {
    const packageJsonPath = require.resolve(
      '@kontourai/flow-agents/package.json',
    );
    const root = path.join(path.dirname(packageJsonPath), 'skills');
    if (!hasSkillFolders(root)) return null;
    let version: string | undefined;
    try {
      version = (
        JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8')) as {
          version?: string;
        }
      ).version;
    } catch {
      // version stays unknown
    }
    return { root, label: 'flow-agents', ...(version ? { version } : {}) };
  } catch {
    return null;
  }
}

/**
 * All canonical skill sources Station registers by default: the package's
 * top-level `skills/` (general skills) PLUS every `kits/<kit>/skills/`
 * directory. flow-agents 2.0.1 relocated the canonical workflow chain
 * (deliver, fix-bug, plan-work, execute-plan, review-work, verify-work, …)
 * out of the top-level `skills/` and into `kits/builder/skills/`, so the kit
 * directories must be registered for those skills to remain browsable and
 * assignable. An explicit FLOW_AGENTS_SKILLS_ROOT override still pins a
 * single root (and does not fall through when invalid).
 */
export function resolveCanonicalSkillSources(
  env: NodeJS.ProcessEnv = process.env,
): CanonicalSkillSource[] {
  if (env.FLOW_AGENTS_SKILLS_ROOT) {
    const override = resolveFlowAgentsSkillsSource(env);
    return override ? [override] : [];
  }

  let packageJsonPath: string;
  try {
    packageJsonPath = require.resolve('@kontourai/flow-agents/package.json');
  } catch {
    return [];
  }
  const pkgRoot = path.dirname(packageJsonPath);
  let version: string | undefined;
  try {
    version = (
      JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8')) as {
        version?: string;
      }
    ).version;
  } catch {
    // version stays unknown
  }
  const toSource = (root: string): CanonicalSkillSource | null =>
    hasSkillFolders(root)
      ? { root, label: 'flow-agents', ...(version ? { version } : {}) }
      : null;

  const roots = [path.join(pkgRoot, 'skills')];
  try {
    for (const entry of fs.readdirSync(path.join(pkgRoot, 'kits'), {
      withFileTypes: true,
    })) {
      if (entry.isDirectory()) {
        roots.push(path.join(pkgRoot, 'kits', entry.name, 'skills'));
      }
    }
  } catch {
    // no kits/ directory (older flow-agents) — top-level skills only
  }
  return roots
    .map(toSource)
    .filter((source): source is CanonicalSkillSource => source !== null);
}
