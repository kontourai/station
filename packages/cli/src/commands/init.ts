import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_GUARDRAILS } from '@kontourai/station-contracts/agent';
import pluginScaffoldDependencies from '../../../../config/plugin-scaffold-dependencies.json' with {
  type: 'json',
};
import { CWD } from './helpers.js';

export type PluginTemplate = 'full' | 'layout' | 'provider';

interface CreatePluginOptions {
  cwd?: string;
  template?: PluginTemplate;
}

const SDK_VERSION = pluginScaffoldDependencies['@kontourai/station-sdk'];
const SHARED_VERSION = pluginScaffoldDependencies['@kontourai/station-shared'];
/**
 * `@kontourai/station-shared` ships TypeScript source, and Node refuses to
 * strip types for files under `node_modules`, so the scaffolded build script
 * needs a TS-aware loader to import it.
 */
const TSX_VERSION = '^4.23.1';
const REACT_TYPES_VERSION = '^18.2.0';

export function createPlugin(
  name = 'my-plugin',
  options: CreatePluginOptions = {},
): void {
  const template = options.template || 'full';
  const dir = join(options.cwd || CWD, name);
  if (existsSync(dir)) {
    console.error(`Directory ${name} already exists`);
    process.exit(1);
  }

  mkdirSync(dir, { recursive: true });
  mkdirSync(join(dir, 'src'), { recursive: true });

  writeJson(dir, 'plugin.json', buildPluginManifest(name, template));
  writeJson(dir, 'package.json', buildPackageJson(name, template));
  writeJson(dir, 'tsconfig.json', buildTsConfig(template));
  writeText(dir, 'README.md', buildReadme(name, template));

  if (template !== 'provider') {
    writeJson(dir, 'layout.json', buildLayoutDefinition(name, template));
    writeText(dir, 'src/index.tsx', buildEntryPoint(name, template));
    writeText(dir, 'build.ts', buildBuildScript());
  }

  if (template === 'full') {
    mkdirSync(join(dir, 'agents', 'assistant'), { recursive: true });
    writeJson(
      dir,
      'agents/assistant/agent.json',
      buildAgentDefinition('Assistant'),
    );
  }

  if (template === 'provider') {
    mkdirSync(join(dir, 'providers'), { recursive: true });
    writeText(dir, 'providers/branding.js', providerTemplate());
    writeText(dir, 'plugin.mjs', serverModuleTemplate());
  }

  console.log(
    `\n✅ Created ${template} plugin: ${name}/\n\n   cd ${name}\n${buildNextSteps(template)}`,
  );
}

export function init(name = 'my-plugin'): void {
  createPlugin(name, { template: 'full' });
}

function displayName(name: string): string {
  return name
    .split('-')
    .map((word) => word[0].toUpperCase() + word.slice(1))
    .join(' ');
}

function writeJson(dir: string, relativePath: string, value: unknown): void {
  writeFileSync(join(dir, relativePath), `${JSON.stringify(value, null, 2)}\n`);
}

function writeText(dir: string, relativePath: string, value: string): void {
  writeFileSync(join(dir, relativePath), value);
}

function buildPluginManifest(name: string, template: PluginTemplate) {
  const base = {
    name,
    version: '1.0.0',
    sdkVersion: SDK_VERSION,
    displayName: displayName(name),
    description: `A ${template} Station plugin`,
  };

  if (template === 'provider') {
    return {
      ...base,
      serverModule: 'plugin.mjs',
      providers: [{ type: 'branding', module: './providers/branding.js' }],
      settings: [
        {
          key: 'accentColor',
          label: 'Accent Color',
          type: 'string',
          default: '#1d4ed8',
        },
      ],
    };
  }

  const layout = { slug: name, source: './layout.json' };
  if (template === 'layout') {
    return {
      ...base,
      entrypoint: 'src/index.tsx',
      capabilities: ['navigation'],
      permissions: ['navigation.dock'],
      layout,
    };
  }

  return {
    ...base,
    entrypoint: 'src/index.tsx',
    capabilities: ['chat', 'navigation'],
    permissions: ['navigation.dock'],
    agents: [{ slug: 'assistant', source: './agents/assistant/agent.json' }],
    layout,
  };
}

function buildLayoutDefinition(name: string, template: PluginTemplate) {
  const tabs =
    template === 'full'
      ? [
          { id: 'home', label: 'Home', component: `${name}-home` },
          { id: 'notes', label: 'Notes', component: `${name}-notes` },
        ]
      : [{ id: 'home', label: 'Home', component: `${name}-home` }];

  const definition: Record<string, unknown> = {
    name: displayName(name),
    slug: name,
    icon: template === 'layout' ? '🧩' : '🚀',
    description:
      template === 'layout'
        ? 'A layout-focused plugin scaffold'
        : 'A full-featured plugin scaffold',
    tabs,
  };

  if (template === 'full') {
    definition.availableAgents = [`${name}:assistant`];
    definition.defaultAgent = `${name}:assistant`;
  }

  return definition;
}

function buildAgentDefinition(agentName: string) {
  return {
    name: agentName,
    prompt: 'You are a helpful assistant for this plugin.',
    guardrails: { ...DEFAULT_GUARDRAILS },
    tools: { mcpServers: [], available: [], autoApprove: [] },
  };
}

function buildPackageJson(name: string, template: PluginTemplate) {
  const scripts: Record<string, string> = {};
  if (template !== 'provider') {
    // Not `station plugin build`: a plugin scaffolded outside this repo has
    // no guarantee `station` is on PATH — nothing installs it as a side
    // effect of scaffolding, whether or not `@kontourai/station-cli` is
    // published. The CLI's build command is a thin wrapper around
    // `buildPlugin`, so the scaffold calls that directly through the
    // published `@kontourai/station-shared` instead of assuming a CLI
    // install.
    scripts.build = 'tsx build.ts';
    scripts.dev = 'tsx build.ts --dev';
  }

  return {
    name,
    version: '1.0.0',
    type: 'module',
    scripts,
    // The host provides these packages at runtime, but plugin authors also
    // need their published versions locally for TypeScript and `npm run build`.
    // Keep the ranges compatible with the public npm registry rather than
    // copying a possibly unpublished workspace version.
    peerDependencies:
      template === 'provider'
        ? undefined
        : {
            '@kontourai/station-sdk': SDK_VERSION,
            '@kontourai/station-shared': SHARED_VERSION,
            react: '^18.0.0 || ^19.0.0',
          },
    devDependencies:
      template === 'provider'
        ? undefined
        : {
            // These public registry packages provide plugin types and build
            // helpers locally; the host still provides them at runtime.
            '@kontourai/station-sdk': SDK_VERSION,
            '@kontourai/station-shared': SHARED_VERSION,
            // `tsconfig.json` sets `types: ['react']`, so without these the
            // scaffold does not typecheck on a machine that has no Station
            // checkout to borrow types from.
            '@types/react': REACT_TYPES_VERSION,
            tsx: TSX_VERSION,
          },
  };
}

function buildBuildScript(): string {
  return `import { buildPlugin } from '@kontourai/station-shared/build';

// Station's own \`station plugin build\` is this call. Driving it directly
// keeps the plugin buildable with nothing but npm and this repository.
const mode = process.argv.includes('--dev') ? 'dev' : 'production';
const result = await buildPlugin(process.cwd(), mode);

if (!result.built) {
  console.log('No entrypoint in plugin.json — nothing to bundle.');
} else {
  console.log(\`Built \${result.bundlePath}\`);
  if (result.cssPath) console.log(\`Built \${result.cssPath}\`);
}
`;
}

function buildTsConfig(template: PluginTemplate) {
  if (template === 'provider') {
    return {
      compilerOptions: {
        module: 'ESNext',
        moduleResolution: 'Bundler',
        target: 'ES2022',
      },
    };
  }

  return {
    compilerOptions: {
      jsx: 'react-jsx',
      module: 'ESNext',
      moduleResolution: 'Bundler',
      strict: true,
      target: 'ES2022',
      types: ['react'],
    },
    include: ['src'],
  };
}

function buildEntryPoint(name: string, template: PluginTemplate): string {
  const imports =
    template === 'full'
      ? "import { useState } from 'react';\nimport { type LayoutComponentProps, useNavigation } from '@kontourai/station-sdk';"
      : "import { type LayoutComponentProps, useNavigation } from '@kontourai/station-sdk';";

  const notesComponent =
    template === 'full'
      ? `
function Notes() {
  const [value, setValue] = useState('');
  return (
    <section style={{ padding: '1.5rem' }}>
      <h2>Scratchpad</h2>
      <textarea
        value={value}
        onChange={(event) => setValue(event.target.value)}
        placeholder="Keep notes for this layout..."
        style={{ minHeight: 220, width: '100%' }}
      />
    </section>
  );
}
`
      : '';

  const components =
    template === 'full'
      ? `export const components = {\n  '${name}-home': Home,\n  '${name}-notes': Notes,\n};`
      : `export const components = {\n  '${name}-home': Home,\n};`;

  return `${imports}

function Home({ onShowChat }: LayoutComponentProps) {
  const { setDockState } = useNavigation();

  return (
    <section style={{ padding: '1.5rem', display: 'grid', gap: '1rem' }}>
      <h1>${displayName(name)}</h1>
      <p>
        This scaffold is ready for you to replace with real UI, queries, and plugin-specific actions.
      </p>
      <button
        type="button"
        onClick={() => {
          setDockState(true);
          onShowChat?.();
        }}
      >
        Open Chat
      </button>
    </section>
  );
}
${notesComponent}
${components}

export default Home;
`;
}

function providerTemplate(): string {
  return `export default function createBrandingProvider(settings = {}) {
  return {
    async getAppName() {
      return 'Station';
    },
    async getTheme() {
      return {
        '--accent-primary': settings.accentColor || '#1d4ed8',
      };
    },
  };
}
`;
}

function serverModuleTemplate(): string {
  return `export const hooks = {
  onRequest(context) {
    console.log('[plugin request:start]', context.pluginName, context.correlationId);
  },
  onResponse(context) {
    console.log('[plugin request:end]', context.pluginName, context.correlationId, context.status);
  },
};

export default function register(app, { config }) {
  app.get('/ping', (c) =>
    c.json({
      ok: true,
      accentColor: config.get('accentColor'),
    }),
  );
}
`;
}

function buildReadme(name: string, template: PluginTemplate): string {
  const createCommand =
    template === 'provider'
      ? `./station plugin create ${name} --template=provider`
      : template === 'layout'
        ? `./station plugin create ${name} --template=layout`
        : `./station plugin create ${name}`;

  const usage =
    template === 'provider'
      ? `Install the plugin, then call \`/api/plugins/${name}/ping\` to verify the server module and settings wiring.`
      : `Install the plugin and add its layout to a project from the Plugins screen.`;

  const building =
    template === 'provider'
      ? ''
      : `
## Building

\`\`\`bash
npm install
npm run build   # production bundle in dist/
npm run dev     # dev bundle with inline sourcemaps
\`\`\`

\`npm run build\` runs \`build.ts\`, which calls \`buildPlugin()\` from
\`@kontourai/station-shared\` — the same function Station itself runs.

\`@kontourai/station-sdk\` and \`@kontourai/station-shared\` are supplied by the
Station host at runtime, so they are peer dependencies and are left out of
\`dist/\`.
`;

  return `# ${displayName(name)}

Created with:

\`\`\`bash
${createCommand}
\`\`\`

## Template

- \`${template}\`
${building}
## Next Steps

- Replace the scaffolded files with your real plugin behavior.
- ${usage}
- Update \`plugin.json\` metadata before publishing.
`;
}

function buildNextSteps(template: PluginTemplate): string {
  if (template === 'provider') {
    return '   ./station plugin install .\n   curl http://localhost:3141/api/plugins/<your-plugin>/ping\n';
  }
  return '   npm install\n   npm run build\n';
}
