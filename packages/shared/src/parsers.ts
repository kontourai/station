import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve, sep } from 'node:path';
import type { PluginManifest } from '@kontourai/station-contracts/plugin';
import type { ToolDef } from '@kontourai/station-contracts/tool';
import type { AgentSpec, LayoutDefinition } from './types.js';

export function readPluginManifest(dir: string): PluginManifest {
  const path = join(dir, 'plugin.json');
  if (!existsSync(path)) throw new Error(`plugin.json not found in ${dir}`);
  return JSON.parse(readFileSync(path, 'utf-8'));
}

export function readIntegrationDef(toolsDir: string, id: string): ToolDef {
  const path = join(toolsDir, id, 'integration.json');
  if (!existsSync(path)) {
    throw new Error(`Integration '${id}' not found at ${path}`);
  }
  return JSON.parse(readFileSync(path, 'utf-8'));
}

export function readAgentSpec(path: string): AgentSpec {
  if (!existsSync(path)) throw new Error(`Agent spec not found at ${path}`);
  return JSON.parse(readFileSync(path, 'utf-8'));
}

export function readLayoutConfig(path: string): LayoutDefinition {
  if (!existsSync(path)) throw new Error(`Layout config not found at ${path}`);
  return JSON.parse(readFileSync(path, 'utf-8'));
}

export function resolvePluginIntegrations(
  pluginDir: string,
  toolsDir: string,
): Map<string, ToolDef> {
  const manifest = readPluginManifest(pluginDir);
  const tools = new Map<string, ToolDef>();
  for (const agentRef of manifest.agents || []) {
    const agentPath = join(pluginDir, agentRef.source);
    if (!existsSync(agentPath)) continue;
    const agent = readAgentSpec(agentPath);
    for (const serverId of agent.tools?.mcpServers || []) {
      if (tools.has(serverId)) continue;
      try {
        tools.set(serverId, readIntegrationDef(toolsDir, serverId));
      } catch {}
    }
  }
  return tools;
}

export function listIntegrationIds(toolsDir: string): string[] {
  if (!existsSync(toolsDir)) return [];
  return readdirSync(toolsDir, { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isDirectory() &&
        existsSync(join(toolsDir, entry.name, 'integration.json')),
    )
    .map((entry) => entry.name);
}

function assertPathInside(
  root: string,
  candidate: string,
  label: string,
): void {
  const rootPath = resolve(root);
  const candidatePath = resolve(candidate);
  if (
    candidatePath !== rootPath &&
    !candidatePath.startsWith(`${rootPath}${sep}`)
  ) {
    throw new Error(`${label} escapes root`);
  }
}

function assertNoSymlinksRecursive(root: string): void {
  const stat = lstatSync(root);
  if (stat.isSymbolicLink()) {
    throw new Error(`Plugin integration contains symlink: ${root}`);
  }
  if (!stat.isDirectory()) return;
  for (const entry of readdirSync(root)) {
    const child = join(root, entry);
    assertPathInside(root, child, 'Plugin integration child');
    assertNoSymlinksRecursive(child);
  }
}

function assertExecutableToken(command: unknown): void {
  if (
    command !== undefined &&
    (typeof command !== 'string' ||
      command.length === 0 ||
      command.length > 128 ||
      !/^[A-Za-z0-9._+-]+$/.test(command))
  ) {
    throw new Error('Plugin integration command must be one executable token');
  }
}

/**
 * Copy bundled tool configs from a plugin's tools/ directory to the project tools dir.
 * Returns the list of tool IDs that were copied.
 */
export function copyPluginIntegrations(
  pluginDir: string,
  projectIntegrationsDir: string,
): string[] {
  const pluginIntegrationsDir = join(pluginDir, 'integrations');
  if (!existsSync(pluginIntegrationsDir)) return [];
  if (lstatSync(pluginIntegrationsDir).isSymbolicLink()) {
    throw new Error('Plugin integrations directory is a symlink');
  }
  mkdirSync(projectIntegrationsDir, { recursive: true });

  let pluginName = '';
  const manifest = readPluginManifest(pluginDir);
  if (typeof manifest.name === 'string') {
    pluginName = manifest.name;
  }

  const prepared: Array<{
    definition: Record<string, unknown>;
    name: string;
    source: string;
    target: string;
  }> = [];
  const copied: string[] = [];
  for (const entry of readdirSync(pluginIntegrationsDir, {
    withFileTypes: true,
  })) {
    if (!entry.isDirectory()) continue;
    const source = join(pluginIntegrationsDir, entry.name);
    const target = join(projectIntegrationsDir, entry.name);
    assertPathInside(
      pluginIntegrationsDir,
      source,
      'Plugin integration source',
    );
    assertPathInside(
      projectIntegrationsDir,
      target,
      'Plugin integration target',
    );
    assertNoSymlinksRecursive(source);
    const sourceDefinitionPath = join(source, 'integration.json');
    if (!existsSync(sourceDefinitionPath)) {
      throw new Error(
        `Integration '${entry.name}' is missing integration.json`,
      );
    }
    if (lstatSync(sourceDefinitionPath).isSymbolicLink()) {
      throw new Error('Plugin integration definition is a symlink');
    }
    const definition = JSON.parse(readFileSync(sourceDefinitionPath, 'utf-8'));
    if (
      (definition.env && Object.keys(definition.env).length > 0) ||
      (definition.secretEnv && Object.keys(definition.secretEnv).length > 0) ||
      (definition.storedEnvNames && definition.storedEnvNames.length > 0)
    ) {
      throw new Error(
        `Plugin integration '${entry.name}' contains credential-bearing configuration; install it through Station's credential storage boundary`,
      );
    }
    assertExecutableToken(definition.command);
    if (pluginName) {
      definition.plugin = pluginName;
    }
    if (existsSync(target)) {
      const targetDefinitionPath = join(target, 'integration.json');
      let ownedByPlugin = false;
      if (
        pluginName &&
        existsSync(targetDefinitionPath) &&
        !lstatSync(targetDefinitionPath).isSymbolicLink()
      ) {
        const existingDefinition = JSON.parse(
          readFileSync(targetDefinitionPath, 'utf-8'),
        );
        ownedByPlugin = existingDefinition.plugin === pluginName;
      }
      if (!ownedByPlugin) {
        throw new Error(
          `Integration '${entry.name}' already exists and is not owned by this plugin`,
        );
      }
    }
    prepared.push({
      definition,
      name: entry.name,
      source,
      target,
    });
  }

  const rollback: Array<{
    backup?: string;
    name: string;
    target: string;
  }> = [];
  const preservedBackups = new Set<string>();
  try {
    for (const entry of prepared) {
      let backup: string | undefined;
      if (existsSync(entry.target)) {
        backup = join(
          projectIntegrationsDir,
          `.station-${entry.name}-${process.pid}-${rollback.length}.bak`,
        );
        assertPathInside(
          projectIntegrationsDir,
          backup,
          'Plugin integration rollback backup',
        );
        renameSync(entry.target, backup);
      }
      rollback.push({ backup, name: entry.name, target: entry.target });
      cpSync(entry.source, entry.target, {
        recursive: true,
      });
      writeFileSync(
        join(entry.target, 'integration.json'),
        JSON.stringify(entry.definition, null, 2),
      );
      copied.push(entry.name);
    }
  } catch (error) {
    const restoredBackups = new Set<string>();
    const rollbackErrors: unknown[] = [];
    for (const entry of rollback.reverse()) {
      try {
        rmSync(entry.target, {
          recursive: true,
          force: true,
        });
        if (entry.backup && existsSync(entry.backup)) {
          renameSync(entry.backup, entry.target);
          restoredBackups.add(entry.backup);
        }
      } catch (rollbackError) {
        if (entry.backup && existsSync(entry.backup)) {
          preservedBackups.add(entry.backup);
        }
        rollbackErrors.push(rollbackError);
      }
    }
    if (rollbackErrors.length > 0) {
      for (const entry of rollback) {
        if (entry.backup && restoredBackups.has(entry.backup)) {
          rmSync(entry.backup, { recursive: true, force: true });
        }
      }
      throw new AggregateError(
        [error, ...rollbackErrors],
        'Plugin integration copy failed and rollback was incomplete.',
      );
    }
    throw error;
  } finally {
    for (const entry of rollback) {
      if (entry.backup && preservedBackups.has(entry.backup)) {
        continue;
      }
      if (entry.backup && !existsSync(entry.backup)) {
        continue;
      }
      if (entry.backup) {
        rmSync(entry.backup, { recursive: true, force: true });
      }
    }
  }
  return copied;
}
