/**
 * Public agent registry listings as Add engine catalogue entries. A listing
 * is never a built-in: one whose id is a built-in's only enriches that card
 * with display facts, and one that would read as a built-in is refused.
 * Connecting runs only a program the person already installed, found on the
 * host's PATH by the name the registry gives it, with the registry's
 * arguments. Package-runner listings (npx, uvx) are listed with a reason and
 * never run: running one downloads and executes the package.
 */

import {
  type ACPConnectionRegistryEntry,
  type ACPPublicRegistryDistributionKind,
  type ACPPublicRegistryListing,
  validateACPEngineDescriptor,
} from '@kontourai/station-contracts/acp';
import { nameSkeleton } from './acp-engine-descriptors.js';
import type {
  PublicRegistryAgent,
  PublicRegistryRefusal,
} from './public-agent-registry.js';

const PUBLIC_REGISTRY_SOURCE_NAME = 'Public agent registry';

/**
 * Registry ids that list a built-in engine under another id. Each target is
 * a built-in id; the listing enriches that card and is not shown again.
 */
export const BUILTIN_REGISTRY_ALIASES: Readonly<Record<string, string>> = {
  'antigravity-acp': 'antigravity',
  'github-copilot-cli': 'copilot',
  'pi-acp': 'pi',
};

/**
 * Registry listings for an engine Station connects natively; the listing
 * is a bridge to the same product, so it is shown unavailable, by name.
 */
export const NATIVE_ENGINE_LISTINGS: Readonly<Record<string, string>> = {
  'claude-acp': 'Claude Code',
  'codex-acp': 'Codex',
};

const PROGRAM_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/;

/**
 * Programs that run whatever their arguments name: package runners, shells,
 * interpreters, privilege and environment wrappers, and fetchers. A listing
 * that names one would make Station download or run code the registry
 * chooses, so it is never connectable.
 */
const RUNNER_PROGRAMS = new Set([
  'npx',
  'pnpx',
  'bunx',
  'uvx',
  'pipx',
  'npm',
  'pnpm',
  'yarn',
  'bun',
  'deno',
  'uv',
  'sh',
  'bash',
  'zsh',
  'fish',
  'dash',
  'ksh',
  'cmd',
  'powershell',
  'pwsh',
  'node',
  'ruby',
  'perl',
  'php',
  'env',
  'sudo',
  'doas',
  'curl',
  'wget',
  'osascript',
]);

function isRunnerProgram(program: string): boolean {
  const name = program.toLowerCase().replace(/\.(exe|cmd|bat|ps1)$/, '');
  return RUNNER_PROGRAMS.has(name) || /^python[0-9.]*$/.test(name);
}

/** A `cmd` that is a path rather than a program inside the download. */
function namesAPath(cmd: string): boolean {
  return (
    /^([\\/]|~|[A-Za-z]:)/.test(cmd) ||
    cmd.split(/[\\/]/).some((segment) => segment === '..')
  );
}

const OS_KEYS: Readonly<Record<string, string>> = {
  darwin: 'darwin',
  linux: 'linux',
  win32: 'windows',
};
const ARCH_KEYS: Readonly<Record<string, string>> = {
  arm64: 'aarch64',
  x64: 'x86_64',
};
const PLATFORM_LABELS: Readonly<Record<string, string>> = {
  'darwin-aarch64': 'macOS on Apple silicon',
  'darwin-x86_64': 'macOS on Intel',
  'linux-aarch64': 'Linux on ARM64',
  'linux-x86_64': 'Linux on x86-64',
  'windows-aarch64': 'Windows on ARM64',
  'windows-x86_64': 'Windows on x86-64',
};

/** The registry's `os-arch` key for a Node platform and arch, if it has one. */
function publicRegistryPlatformKey(
  platform: string,
  arch: string,
): string | undefined {
  const os = OS_KEYS[platform];
  const cpu = ARCH_KEYS[arch];
  return os && cpu ? `${os}-${cpu}` : undefined;
}

/**
 * The program a registry `cmd` names, as it would be found on PATH:
 * `./dist-package\cursor-agent.cmd` is `cursor-agent`. The registry's path is
 * inside its own download, which Station does not use.
 */
export function publicRegistryProgramName(cmd: string): string {
  const base = cmd.split(/[\\/]/).pop() ?? cmd;
  return base.replace(/\.(exe|cmd|bat)$/i, '');
}

/** "Stakpak Team <contact@stakpak.dev>" reads as "Stakpak Team" in a sentence. */
function publisherName(author: string): string {
  return author.replace(/\s*<[^>]*>\s*$/, '') || author;
}

/** Names a plugin provider may not register under, nor a listing read as. */
const RESERVED_NAMES = new Set(['station', 'kontour']);

function listingFacts(agent: PublicRegistryAgent): ACPPublicRegistryListing {
  const distributions: ACPPublicRegistryDistributionKind[] = [];
  if (Object.keys(agent.binary).length > 0) distributions.push('binary');
  for (const pkg of agent.packages) {
    if (!distributions.includes(pkg.kind)) distributions.push(pkg.kind);
  }
  return {
    id: agent.id,
    version: agent.version,
    publishers: [...agent.publishers],
    ...(agent.license ? { license: agent.license } : {}),
    ...(agent.websiteUrl ? { websiteUrl: agent.websiteUrl } : {}),
    ...(agent.repositoryUrl ? { repositoryUrl: agent.repositoryUrl } : {}),
    distributions,
    binaryPlatforms: Object.keys(agent.binary).sort(),
    ...(agent.packages.length > 0
      ? {
          packages: agent.packages.map((pkg) => ({
            kind: pkg.kind,
            package: pkg.package,
            args: [...pkg.args],
          })),
        }
      : {}),
  };
}

function unavailableReason(
  agent: PublicRegistryAgent,
  hostKey: string | undefined,
  hostLabel: string,
): string {
  const native = NATIVE_ENGINE_LISTINGS[agent.id];
  if (native) {
    return `Station connects to ${native} directly. Add ${native} from the engine list instead.`;
  }
  const builds = Object.keys(agent.binary);
  if (builds.length > 0) {
    const listed = builds
      .map((key) => PLATFORM_LABELS[key] ?? key)
      .sort((a, b) => a.localeCompare(b))
      .join(', ');
    return hostKey
      ? `The registry has no ${agent.name} build for ${hostLabel}. It lists builds for ${listed}.`
      : `Station runs on ${hostLabel}, which the registry has no builds for.`;
  }
  const pkg = agent.packages[0];
  if (pkg) {
    return `${agent.name} runs from the ${pkg.package} package, which Station would have to download and run (${pkg.kind}). Station does not do that; install ${agent.name} yourself, then add it as a custom engine.`;
  }
  return `${agent.name} uses a way of running that Station does not support (${agent.unknownDistributions.join(', ') || 'none listed'}).`;
}

export interface PublicRegistryCatalog {
  /** Listings that are not a built-in, available or not. */
  entries: ACPConnectionRegistryEntry[];
  /** Display facts for built-in cards, keyed by built-in id. */
  enrichments: Map<string, ACPPublicRegistryListing>;
  refused: PublicRegistryRefusal[];
}

export function mapPublicRegistryListings(input: {
  agents: readonly PublicRegistryAgent[];
  /** Built-in catalogue entries, which always win. */
  builtins: ReadonlyArray<Pick<ACPConnectionRegistryEntry, 'id' | 'name'>>;
  /** Ids already taken by another catalogue source (plugins). */
  takenIds: ReadonlySet<string>;
  platform: string;
  arch: string;
  commandExists: (command: string) => boolean;
}): PublicRegistryCatalog {
  const builtinIds = new Set(input.builtins.map(({ id }) => id));
  const builtinNames = new Set(
    input.builtins.map(({ name }) => nameSkeleton(name)),
  );
  const hostKey = publicRegistryPlatformKey(input.platform, input.arch);
  const hostLabel = hostKey
    ? (PLATFORM_LABELS[hostKey] ?? hostKey)
    : `${input.platform} on ${input.arch}`;
  const entries: ACPConnectionRegistryEntry[] = [];
  const enrichments = new Map<string, ACPPublicRegistryListing>();
  const refused: PublicRegistryRefusal[] = [];

  for (const agent of input.agents) {
    const builtinId = builtinIds.has(agent.id)
      ? agent.id
      : BUILTIN_REGISTRY_ALIASES[agent.id];
    if (builtinId !== undefined && builtinIds.has(builtinId)) {
      enrichments.set(builtinId, listingFacts(agent));
      continue;
    }
    if (input.takenIds.has(agent.id)) {
      refused.push({
        id: agent.id,
        reasons: [`id '${agent.id}' is already used by another engine source`],
      });
      continue;
    }
    if (RESERVED_NAMES.has(nameSkeleton(agent.name))) {
      refused.push({
        id: agent.id,
        reasons: [`name '${agent.name}' reads as Station's own`],
      });
      continue;
    }
    if (builtinNames.has(nameSkeleton(agent.name))) {
      refused.push({
        id: agent.id,
        reasons: [`name '${agent.name}' reads as a built-in engine`],
      });
      continue;
    }

    const listing = listingFacts(agent);
    const target =
      hostKey && !NATIVE_ENGINE_LISTINGS[agent.id]
        ? agent.binary[hostKey]
        : undefined;
    const program = target ? publicRegistryProgramName(target.cmd) : undefined;
    const programRefusal = !target
      ? undefined
      : namesAPath(target.cmd)
        ? `The registry names ${agent.name}'s program by a path (${target.cmd.slice(0, 80)}), not as a program in its download. Station does not run it.`
        : program && isRunnerProgram(program)
          ? `The registry runs ${agent.name} through ${program.slice(0, 64)}, which runs whatever it is given. Station does not run it.`
          : undefined;
    let entry: ACPConnectionRegistryEntry;
    if (
      target &&
      program &&
      !programRefusal &&
      PROGRAM_NAME_PATTERN.test(program)
    ) {
      entry = {
        id: agent.id,
        name: agent.name,
        ...(agent.description ? { description: agent.description } : {}),
        command: program,
        args: [...target.args],
        tags: ['registry'],
        detected: input.commandExists(program),
        hostInstall: {
          ...(agent.websiteUrl || agent.repositoryUrl
            ? { docsUrl: agent.websiteUrl ?? agent.repositoryUrl }
            : {}),
          note: `Install ${agent.name} by following ${publisherName(agent.publishers[0])}'s instructions, so ${program} is on the PATH of the computer Station runs on. Station does not download it.`,
        },
        publicRegistry: {
          ...listing,
          hostLaunch: { command: program, args: [...target.args] },
          ...(target.env && Object.keys(target.env).length > 0
            ? { recommendedEnv: { ...target.env } }
            : {}),
        },
      };
    } else {
      entry = {
        id: agent.id,
        name: agent.name,
        ...(agent.description ? { description: agent.description } : {}),
        command: '',
        args: [],
        tags: ['registry'],
        detected: false,
        publicRegistry: {
          ...listing,
          unavailableReason: programRefusal
            ? programRefusal
            : target && program
              ? `The registry names its ${agent.name} program '${program.slice(0, 64)}', which is not a plain program name Station can look up.`
              : unavailableReason(agent, hostKey, hostLabel),
        },
      };
    }
    const errors = validateACPEngineDescriptor({
      name: entry.name,
      description: entry.description,
      ...(entry.hostInstall?.docsUrl || entry.hostInstall?.note
        ? { install: { [input.platform]: entry.hostInstall } }
        : {}),
    });
    if (errors.length > 0) {
      refused.push({ id: agent.id, reasons: errors });
      continue;
    }
    entries.push({
      ...entry,
      source: 'registry',
      sourceName: PUBLIC_REGISTRY_SOURCE_NAME,
    });
  }
  return { entries, enrichments, refused };
}
