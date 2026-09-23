import {
  AGENT_PLUGIN_MANIFEST_SCHEMA_1_0,
  isAgentPluginName,
  STATION_AGENT_PLUGIN_EXTENSION_ID,
} from '@kontourai/station-contracts/agent-plugin';

/**
 * Starter plugin packages in the one plugin format (Agent Plugins 1.0 plus the
 * Station extension namespace). `station plugin create` and the in-app
 * "New plugin" flow both write what this module returns, so a scaffold made
 * from either door installs through the same preview and consent path.
 *
 * Pure: it returns file contents and writes nothing. Each caller owns its own
 * filesystem rules (the CLI refuses an existing directory; the server refuses
 * a non-empty Project folder and any write outside it).
 */

export const PLUGIN_SCAFFOLD_TEMPLATES = ['pane', 'full', 'provider'] as const;
export type PluginScaffoldTemplate = (typeof PLUGIN_SCAFFOLD_TEMPLATES)[number];
export const DEFAULT_PLUGIN_SCAFFOLD_TEMPLATE: PluginScaffoldTemplate = 'pane';

export function isPluginScaffoldTemplate(
  value: unknown,
): value is PluginScaffoldTemplate {
  return (
    typeof value === 'string' &&
    (PLUGIN_SCAFFOLD_TEMPLATES as readonly string[]).includes(value)
  );
}

/**
 * Registry ranges for the two Station packages a scaffold depends on. The
 * caller supplies them from `config/plugin-scaffold-dependencies.json` (the
 * single, publicly verified authority): this package ships as source and
 * cannot read a file outside its own root.
 */
export interface PluginScaffoldDependencies {
  '@kontourai/station-sdk': string;
  '@kontourai/station-shared': string;
}

export interface PluginScaffoldInput {
  name: string;
  template?: PluginScaffoldTemplate;
  /** Human title; derived from the name when omitted. */
  displayName?: string;
  dependencies: PluginScaffoldDependencies;
}

export interface PluginScaffoldFile {
  /** POSIX path relative to the plugin root. Never absolute, never `..`. */
  path: string;
  contents: string;
}

export interface PluginScaffold {
  name: string;
  template: PluginScaffoldTemplate;
  displayName: string;
  files: PluginScaffoldFile[];
}

export class PluginScaffoldInputError extends Error {
  readonly name = 'PluginScaffoldInputError';
  constructor(
    readonly code: 'invalid-name' | 'invalid-template' | 'invalid-display-name',
    message: string,
  ) {
    super(message);
  }
}

/**
 * `@kontourai/station-shared` ships TypeScript source, and Node refuses to
 * strip types for files under `node_modules`, so the scaffolded build script
 * needs a TS-aware loader to import it.
 */
const TSX_VERSION = '^4.23.1';
const REACT_TYPES_VERSION = '^18.2.0';
const MAX_DISPLAY_NAME_LENGTH = 128;
/**
 * The title lands in plugin.json, the README heading and the entrypoint.
 * The server's manifest loader refuses invisible Unicode, so a scaffold
 * carrying it would be written and then be uninstallable; a newline would
 * also inject Markdown into the README. Refused here: control characters
 * (newlines included), Unicode format characters (zero-width, bidi
 * overrides), line and paragraph separators, and HTML comment openers.
 */
const UNSAFE_DISPLAY_NAME = /[\p{Cc}\p{Cf}\u2028\u2029]|<!--/u;

export function defaultPluginDisplayName(name: string): string {
  return name
    .split(/[-.]/)
    .filter(Boolean)
    .map((word) => word[0].toUpperCase() + word.slice(1))
    .join(' ');
}

interface PaneSpec {
  /** Segment used in the pane and renderer ids. */
  key: string;
  title: string;
}

/**
 * The renderer name, which is also the `components` key. The host registers
 * every plugin's components in ONE map keyed by this string, so an
 * unprefixed name like `workspace` from two plugins would collide and the
 * first plugin's Pane would go dark. Prefixing with the plugin name keeps
 * each scaffold's components its own.
 */
export function pluginScaffoldComponentName(name: string, key: string): string {
  return `${name}-${key}`;
}

function workspacePane(name: string, pane: PaneSpec) {
  const encoded = encodeURIComponent(name);
  return {
    version: '1.0',
    id: `pane:plugin%3A${encoded}:main:${pane.key}`,
    name: pane.title,
    rendererId: `renderer:plugin%3A${encoded}:plugin-component:${pane.key}`,
    renderer: {
      kind: 'plugin-component',
      name: pluginScaffoldComponentName(name, pane.key),
    },
    placement: {
      supportedRegions: ['primary'],
      preferredRegion: 'primary',
    },
    modes: [{ id: 'default', contextRequirement: { project: true } }],
    provenance: { origin: 'plugin', pluginId: name },
    lifecycle: { stage: 'stable' },
  };
}

function panesFor(
  template: PluginScaffoldTemplate,
  displayName: string,
): PaneSpec[] {
  if (template === 'provider') return [];
  const workspace = { key: 'workspace', title: displayName };
  return template === 'full'
    ? [workspace, { key: 'notes', title: `${displayName} Notes` }]
    : [workspace];
}

function buildManifest(
  name: string,
  template: PluginScaffoldTemplate,
  displayName: string,
  dependencies: PluginScaffoldDependencies,
) {
  const station: Record<string, unknown> = {
    schemaVersion: '1.0',
    title: displayName,
    sdkVersion: dependencies['@kontourai/station-sdk'],
  };
  if (template === 'provider') {
    station.serverModule = './plugin.mjs';
    // Both are enforced at runtime: without them the install succeeds and
    // the provider and server routes silently never load. Both are
    // trusted-tier, so the person installing sees them called out.
    station.permissions = ['providers.register', 'plugin.server'];
    station.providers = [
      { type: 'branding', module: './providers/branding.js' },
    ];
    station.settings = [
      {
        key: 'accentColor',
        title: 'Accent Color',
        type: 'string',
        default: '#1d4ed8',
      },
    ];
  } else {
    station.entrypoint = './src/index.tsx';
    station.capabilities = ['chat', 'navigation'];
    station.permissions = ['navigation.dock'];
    station.workspacePanes = panesFor(template, displayName).map((pane) =>
      workspacePane(name, pane),
    );
    if (template === 'full') {
      station.agents = [
        { slug: 'assistant', source: './agents/assistant/agent.json' },
      ];
    }
  }
  return {
    $schema: AGENT_PLUGIN_MANIFEST_SCHEMA_1_0,
    name,
    version: '0.1.0',
    description: `${displayName}: a Station plugin (${template} template).`,
    extensions: { [STATION_AGENT_PLUGIN_EXTENSION_ID]: station },
  };
}

function buildPackageJson(
  name: string,
  template: PluginScaffoldTemplate,
  dependencies: PluginScaffoldDependencies,
) {
  if (template === 'provider') {
    return { name, version: '0.1.0', private: true, type: 'module' };
  }
  return {
    name,
    version: '0.1.0',
    private: true,
    type: 'module',
    // Not `station plugin build`: a plugin scaffolded outside this repo has
    // no guarantee `station` is on PATH. The CLI's build command is a thin
    // wrapper around `buildPlugin`, so the scaffold calls that directly
    // through the published `@kontourai/station-shared`.
    scripts: { build: 'tsx build.ts', dev: 'tsx build.ts --dev' },
    // The host provides these packages at runtime, but authors also need
    // their published versions locally for TypeScript and `npm run build`.
    peerDependencies: {
      '@kontourai/station-sdk': dependencies['@kontourai/station-sdk'],
      '@kontourai/station-shared': dependencies['@kontourai/station-shared'],
      react: '^18.0.0 || ^19.0.0',
    },
    devDependencies: {
      '@kontourai/station-sdk': dependencies['@kontourai/station-sdk'],
      '@kontourai/station-shared': dependencies['@kontourai/station-shared'],
      '@types/react': REACT_TYPES_VERSION,
      tsx: TSX_VERSION,
    },
  };
}

function buildTsConfig() {
  return {
    compilerOptions: {
      jsx: 'react-jsx',
      module: 'ESNext',
      moduleResolution: 'Bundler',
      strict: true,
      target: 'ES2022',
      types: ['react'],
      skipLibCheck: true,
    },
    include: ['src'],
  };
}

const BUILD_SCRIPT = `import { buildPlugin } from '@kontourai/station-shared/build';

// Station's own \`station plugin build\` is this call. Driving it directly
// keeps the plugin buildable with nothing but npm and this folder.
const mode = process.argv.includes('--dev') ? 'dev' : 'production';
const result = await buildPlugin(process.cwd(), mode);

if (!result.built) {
  console.log('No entrypoint in plugin.json: nothing to bundle.');
} else {
  console.log(\`Built \${result.bundlePath}\`);
  if (result.cssPath) console.log(\`Built \${result.cssPath}\`);
}
`;

function cssPrefix(name: string): string {
  // Class names are scoped by the plugin name so two scaffolds cannot
  // restyle each other; periods are not valid inside a bare class token.
  return name.replaceAll('.', '-');
}

function buildEntryPoint(
  name: string,
  template: PluginScaffoldTemplate,
  displayName: string,
): string {
  const css = cssPrefix(name);
  const title = JSON.stringify(displayName);
  const notes =
    template === 'full'
      ? `
function Notes() {
  const [value, setValue] = useState('');
  return (
    <main className="${css}-shell">
      <section className="${css}-panel">
        <h2>Scratchpad</h2>
        <textarea
          className="${css}-notes"
          value={value}
          onChange={(event) => setValue(event.target.value)}
          placeholder="Keep notes for this Project…"
        />
      </section>
    </main>
  );
}
`
      : '';
  const reactImport =
    template === 'full'
      ? "import { type ComponentType, useState } from 'react';"
      : "import type { ComponentType } from 'react';";
  const components =
    template === 'full'
      ? `  ${JSON.stringify(pluginScaffoldComponentName(name, 'workspace'))}: Workspace,\n  ${JSON.stringify(pluginScaffoldComponentName(name, 'notes'))}: Notes,`
      : `  ${JSON.stringify(pluginScaffoldComponentName(name, 'workspace'))}: Workspace,`;

  return `import { useAgents, useNavigation, useToast } from '@kontourai/station-sdk';
${reactImport}
import './pane.css';

/**
 * A Workspace Pane. \`plugin.json\` declares it under
 * \`extensions["io.kontourai.station"].workspacePanes\`, and its
 * \`renderer.name\` is the key in \`components\` below. Keep the plugin-name
 * prefix: every plugin's components share one host registry.
 */
function Workspace() {
  const agents = useAgents();
  const { setDockState } = useNavigation();
  const { showToast } = useToast();

  const openChat = () => {
    setDockState(true);
    showToast({ type: 'info', message: 'Chat opened' });
  };

  return (
    <main className="${css}-shell">
      <section className="${css}-panel">
        <p className="${css}-kicker">Station plugin</p>
        <h1>{${title}}</h1>
        <p>Replace this Pane with your plugin's own UI.</p>
        <h2>Agents on this Station</h2>
        {agents.length === 0 ? (
          <p className="${css}-hint">No Agents are defined yet.</p>
        ) : (
          <ul>
            {agents.map((agent: { slug: string; name: string }) => (
              <li key={agent.slug}>{agent.name}</li>
            ))}
          </ul>
        )}
        <button type="button" className="${css}-primary" onClick={openChat}>
          Open chat
        </button>
      </section>
    </main>
  );
}
${notes}
export const components = {
${components}
} satisfies Record<string, ComponentType>;

export default Workspace;
`;
}

function buildCss(name: string): string {
  const css = cssPrefix(name);
  return `.${css}-shell {
  min-height: 100%;
  padding: 24px;
  background: var(--bg-primary);
  color: var(--text-primary);
}

.${css}-panel {
  max-width: 720px;
  border: 1px solid var(--border-primary);
  border-radius: 8px;
  padding: 20px;
  background: var(--bg-secondary);
}

.${css}-kicker {
  margin: 0 0 8px;
  color: var(--accent-primary);
  font-size: 0.75rem;
  font-weight: 700;
  text-transform: uppercase;
}

.${css}-hint {
  color: var(--text-secondary);
}

.${css}-primary {
  min-height: 44px;
  border: 0;
  border-radius: 6px;
  padding: 10px 14px;
  background: var(--accent-primary);
  color: var(--text-on-accent);
  cursor: pointer;
  font: inherit;
  font-weight: 700;
}

.${css}-notes {
  width: 100%;
  min-height: 220px;
  font: inherit;
}

@media (max-width: 760px) {
  .${css}-shell {
    padding: 16px;
  }
}
`;
}

function buildAgentDefinition() {
  return {
    name: 'Assistant',
    prompt: 'You are a helpful assistant for this plugin.',
  };
}

const PROVIDER_MODULE = `export default function createBrandingProvider(settings = {}) {
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

const SERVER_MODULE = `export default function register(app, { config }) {
  app.get('/ping', (c) =>
    c.json({
      ok: true,
      accentColor: config.get('accentColor'),
    }),
  );
}
`;

function buildReadme(
  name: string,
  template: PluginScaffoldTemplate,
  displayName: string,
): string {
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
\`@kontourai/station-shared\`: the same function Station runs at install.
Station supplies \`@kontourai/station-sdk\` and React at runtime, so they are
peer dependencies and stay out of \`dist/\`.
`;
  const usage =
    template === 'provider'
      ? `After install, \`GET /api/plugins/${name}/ping\` answers from \`plugin.mjs\`.`
      : 'After install, add the Pane to a Project with **Add pane**.';
  return `# ${displayName}

A Station plugin scaffolded from the \`${template}\` template.

\`plugin.json\` is an [Agent Plugins 1.0](https://agent-plugins.org) manifest.
Station reads its own settings from \`extensions["io.kontourai.station"]\`.
${building}
## Installing

Installing is a person's decision. Open **Plugins → Install plugin**, choose
this folder, review what the plugin asks for, and confirm.

- ${usage}
- Update \`plugin.json\` metadata before sharing the plugin.
`;
}

const GITIGNORE = 'node_modules/\ndist/\n';

/** Builds a scaffold's files. Throws `PluginScaffoldInputError` on bad input. */
export function buildPluginScaffold(
  input: PluginScaffoldInput,
): PluginScaffold {
  const { name } = input;
  if (!isAgentPluginName(name)) {
    throw new PluginScaffoldInputError(
      'invalid-name',
      'Plugin name must be 1-64 lowercase letters, digits, hyphens or periods, starting and ending with a letter or digit',
    );
  }
  const template = input.template ?? DEFAULT_PLUGIN_SCAFFOLD_TEMPLATE;
  if (!isPluginScaffoldTemplate(template)) {
    throw new PluginScaffoldInputError(
      'invalid-template',
      `Unknown plugin template; expected ${PLUGIN_SCAFFOLD_TEMPLATES.join(', ')}`,
    );
  }
  const displayName =
    input.displayName?.trim() || defaultPluginDisplayName(name);
  if (displayName.length > MAX_DISPLAY_NAME_LENGTH) {
    throw new PluginScaffoldInputError(
      'invalid-display-name',
      `Plugin title must be at most ${MAX_DISPLAY_NAME_LENGTH} characters`,
    );
  }
  if (UNSAFE_DISPLAY_NAME.test(displayName)) {
    throw new PluginScaffoldInputError(
      'invalid-display-name',
      'Plugin title must be one line of visible text',
    );
  }

  const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
  const files: PluginScaffoldFile[] = [
    {
      path: 'plugin.json',
      contents: json(
        buildManifest(name, template, displayName, input.dependencies),
      ),
    },
    {
      path: 'package.json',
      contents: json(buildPackageJson(name, template, input.dependencies)),
    },
    { path: 'README.md', contents: buildReadme(name, template, displayName) },
    { path: '.gitignore', contents: GITIGNORE },
  ];
  if (template === 'provider') {
    files.push(
      { path: 'providers/branding.js', contents: PROVIDER_MODULE },
      { path: 'plugin.mjs', contents: SERVER_MODULE },
    );
  } else {
    files.push(
      { path: 'tsconfig.json', contents: json(buildTsConfig()) },
      { path: 'build.ts', contents: BUILD_SCRIPT },
      {
        path: 'src/index.tsx',
        contents: buildEntryPoint(name, template, displayName),
      },
      { path: 'src/pane.css', contents: buildCss(name) },
    );
  }
  if (template === 'full') {
    files.push({
      path: 'agents/assistant/agent.json',
      contents: json(buildAgentDefinition()),
    });
  }
  return { name, template, displayName, files };
}
