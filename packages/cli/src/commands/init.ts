import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  buildPluginScaffold,
  type PluginScaffoldTemplate,
} from '@kontourai/station-shared/plugin-scaffold';
import pluginScaffoldDependencies from '../../../../config/plugin-scaffold-dependencies.json' with {
  type: 'json',
};
import { CWD } from './helpers.js';

/**
 * `layout` is the pre-Agent-Plugins name for a one-Pane UI starter. It is
 * kept as an alias so existing scripts and guides keep working; it now
 * emits the same Workspace Pane scaffold as `pane`.
 */
export type PluginTemplate = PluginScaffoldTemplate | 'layout';

interface CreatePluginOptions {
  cwd?: string;
  template?: PluginTemplate;
}

export function createPlugin(
  name = 'my-plugin',
  options: CreatePluginOptions = {},
): void {
  const requested = options.template || 'full';
  const template: PluginScaffoldTemplate =
    requested === 'layout' ? 'pane' : requested;
  // The shared builder validates the name against the Agent Plugins grammar
  // before anything touches the filesystem.
  let scaffold: ReturnType<typeof buildPluginScaffold> | undefined;
  try {
    scaffold = buildPluginScaffold({
      name,
      template,
      dependencies: pluginScaffoldDependencies,
    });
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
  if (!scaffold) return;

  const dir = join(options.cwd || CWD, name);
  if (existsSync(dir)) {
    console.error(`Directory ${name} already exists`);
    process.exit(1);
  }

  for (const file of scaffold.files) {
    const target = join(dir, file.path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, file.contents, { flag: 'wx' });
  }

  console.log(
    `\n✅ Created ${template} plugin: ${name}/\n\n   cd ${name}\n${buildNextSteps(template)}`,
  );
}

export function init(name = 'my-plugin'): void {
  createPlugin(name, { template: 'full' });
}

function buildNextSteps(template: PluginScaffoldTemplate): string {
  if (template === 'provider') {
    return '   station plugin install .\n   curl http://localhost:3141/api/plugins/<your-plugin>/ping\n';
  }
  return '   npm install\n   npm run build\n   station plugin install .\n';
}
