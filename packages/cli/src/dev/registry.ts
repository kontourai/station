import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { LayoutDefinition } from '@kontourai/station-contracts/layout';
import type { PluginManifest } from '@kontourai/station-contracts/plugin';
import { serializeSDKMock } from './sdk-mock.js';
import { generateDevHTML } from './template.js';

export interface PromptRegistryEntry {
  id: string;
  name: string;
  icon?: string;
  requires?: string[];
  content: string;
  _source: string;
}

interface RegenerateDevHTMLInput {
  cwd: string;
  manifest: PluginManifest;
  layoutPath: string | null;
  pluginsDir: string;
}

export function parsePromptMarkdown(raw: string, filename: string) {
  const match = raw.match(/^---\n([\s\S]*?)\n---/);
  const meta: Record<string, any> = {};
  if (match) {
    let currentKey: string | null = null;
    for (const line of match[1].split('\n')) {
      const colon = line.indexOf(':');
      if (colon > 0 && !line.match(/^\s*-/)) {
        const key = line.slice(0, colon).trim();
        const value = line.slice(colon + 1).trim();
        if (value) {
          meta[key] = value.replace(/['"]/g, '');
          currentKey = null;
        } else {
          currentKey = key;
        }
      } else if (currentKey && line.trim().startsWith('- ')) {
        if (!Array.isArray(meta[currentKey])) {
          meta[currentKey] = [];
        }
        meta[currentKey].push(line.trim().slice(2).replace(/['"]/g, ''));
      }
    }
  }

  const bodyMatch = raw.match(/^---\n[\s\S]*?\n---\n([\s\S]*)$/);
  return {
    id: meta.id || filename.replace('.md', ''),
    name: meta.label || meta.id || filename.replace('.md', ''),
    icon: meta.icon,
    requires: meta.requires,
    content: bodyMatch ? bodyMatch[1].trim() : raw.trim(),
  };
}

export function loadPromptEntries(promptsDir: string, sourceRoot: string) {
  if (!existsSync(promptsDir)) {
    return [];
  }

  return readdirSync(promptsDir)
    .filter((fileName) => fileName.endsWith('.md'))
    .map((fileName) => {
      const entry = parsePromptMarkdown(
        readFileSync(join(promptsDir, fileName), 'utf-8'),
        fileName,
      );
      return {
        ...entry,
        _source: join(sourceRoot, fileName),
      };
    });
}

function loadAgentEntries(baseDir: string, manifest: PluginManifest) {
  return (manifest.agents || []).map((agent: any) => {
    try {
      const agentPath = join(baseDir, agent.source);
      if (!existsSync(agentPath)) {
        return { slug: agent.slug, name: agent.slug };
      }
      const agentSpec = JSON.parse(readFileSync(agentPath, 'utf-8'));
      return {
        slug: agent.slug,
        name: agentSpec.name,
        model: agentSpec.model,
        prompt: agentSpec.prompt,
        mcpServers: agentSpec.tools?.mcpServers || [],
        guardrails: agentSpec.guardrails,
        _source:
          baseDir === process.cwd()
            ? agent.source
            : join(baseDir, agent.source),
      };
    } catch {
      return { slug: agent.slug, name: agent.slug };
    }
  });
}

function loadIntegrations(baseDir: string) {
  const integrationsDir = join(baseDir, 'integrations');
  const integrations: Array<Record<string, any>> = [];
  if (!existsSync(integrationsDir)) {
    return integrations;
  }

  for (const directory of readdirSync(integrationsDir)) {
    const configPath = join(integrationsDir, directory, 'integration.json');
    if (!existsSync(configPath)) {
      continue;
    }
    try {
      const config = JSON.parse(readFileSync(configPath, 'utf-8'));
      config._source =
        baseDir === process.cwd()
          ? `integrations/${directory}/integration.json`
          : configPath;
      integrations.push(config);
    } catch {}
  }

  return integrations;
}

function loadLayoutEntry(baseDir: string, manifest: PluginManifest) {
  const layoutPath = manifest.layout?.source
    ? join(baseDir, manifest.layout.source)
    : null;
  const layout =
    layoutPath && existsSync(layoutPath)
      ? (JSON.parse(readFileSync(layoutPath, 'utf-8')) as LayoutDefinition)
      : null;

  return {
    layout,
    layoutPath,
    layouts: layout
      ? [
          {
            slug: layout.slug,
            name: layout.name,
            icon: layout.icon,
            tabs: layout.tabs || [],
            _source:
              baseDir === process.cwd() ? manifest.layout?.source : layoutPath,
          },
        ]
      : [],
  };
}

function loadDependencyRegistries(
  pluginsDir: string,
  manifest: PluginManifest,
) {
  const depRegistries: Record<string, any> = {};
  for (const dependency of manifest.dependencies || []) {
    const depDir = join(pluginsDir, dependency.id);
    const depManifestPath = join(depDir, 'plugin.json');
    if (!existsSync(depManifestPath)) {
      continue;
    }
    try {
      const depManifest = JSON.parse(
        readFileSync(depManifestPath, 'utf-8'),
      ) as PluginManifest;
      const { layout, layouts } = loadLayoutEntry(depDir, depManifest);
      depRegistries[dependency.id] = {
        name: depManifest.displayName || depManifest.name,
        _dir: depDir,
        agents: loadAgentEntries(depDir, depManifest),
        integrations: loadIntegrations(depDir),
        prompts: depManifest.prompts?.source
          ? loadPromptEntries(
              join(depDir, depManifest.prompts.source),
              join(depDir, depManifest.prompts.source),
            )
          : [],
        actions: (layout as any)?.actions || [],
        layouts,
        dependencies: depManifest.dependencies || [],
        providers: (depManifest.providers || []).map((provider: any) => ({
          type: provider.type,
          module: provider.module,
          _source: join(depDir, provider.module),
        })),
      };
    } catch {}
  }
  return depRegistries;
}

export function regenerateDevHTML({
  cwd,
  manifest,
  layoutPath,
  pluginsDir,
}: RegenerateDevHTMLInput): {
  html: string;
  layout: LayoutDefinition | null;
  layoutSlug: string;
} {
  const layout: LayoutDefinition | null =
    layoutPath && existsSync(layoutPath)
      ? JSON.parse(readFileSync(layoutPath, 'utf-8'))
      : null;
  const tabs = layout?.tabs || [];
  const tabsJson = JSON.stringify(tabs);
  const pluginName = manifest.name;
  const name = manifest.displayName || manifest.name;

  const agents = loadAgentEntries(cwd, manifest);
  const promptEntries = manifest.prompts?.source
    ? loadPromptEntries(
        join(cwd, manifest.prompts.source),
        manifest.prompts.source,
      )
    : [];
  const integrations = loadIntegrations(cwd);
  const depRegistries = loadDependencyRegistries(pluginsDir, manifest);
  const layoutSlug = layout?.slug || pluginName;

  const registryJson = JSON.stringify({
    agents,
    prompts: promptEntries,
    actions: (layout as any)?.actions || [],
    integrations,
    dependencies: manifest.dependencies || [],
    depRegistries,
    layouts: layout
      ? [
          {
            slug: layout.slug,
            name: layout.name,
            icon: layout.icon,
            tabs,
            _source: manifest.layout?.source,
          },
        ]
      : [],
    _actionSource: manifest.layout?.source,
    _cwd: cwd,
  });

  const html = generateDevHTML({
    name: name!,
    pluginName: pluginName!,
    tabsJson,
    registryJson,
    sdkMockJs: serializeSDKMock({ layoutSlug }),
  });

  return { html, layout, layoutSlug };
}
