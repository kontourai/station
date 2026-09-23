import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PERMISSION_TIERS } from '@kontourai/station-contracts/plugin';
import { WORKSPACE_PANE_REGIONS } from '@kontourai/station-contracts/workspace-pane';
import { describe, expect, test } from 'vitest';
import packageJson from '../../../package.json' with { type: 'json' };
import { parsePluginManifestDocumentWithFormat } from '../../services/plugins/plugin-manifest-loader.js';
import { STATION_DOCS_TOPICS } from '../station-docs-content.js';
import {
  createStationDocsMcpServer,
  findStationDocsTopic,
  STATION_DOCS_VERSION,
  searchStationDocs,
} from '../station-docs-mcp-server.js';

/**
 * archive#1547. Two things are being proven here, and they are different:
 *
 *  1. the docs server serves the shipped content correctly, and
 *  2. the properties that let it be delivered with no security exemption —
 *     bundled-not-fetched content, no live/user state, versioned with Station.
 *
 * The `env`-emptiness guard (AC3) deliberately lives next to the factory that
 * could break it, in
 * `src-server/runtime/agents/__tests__/runtime-default-agent.test.ts`.
 */

type ToolResult = { content: Array<{ type: 'text'; text: string }> };
type RegisteredTool = {
  handler: (...args: any[]) => Promise<ToolResult>;
  description?: string;
};

function registeredTools(): Record<string, RegisteredTool> {
  const server = createStationDocsMcpServer();
  return (
    server as unknown as { _registeredTools: Record<string, RegisteredTool> }
  )._registeredTools;
}

async function callTool(name: string, args: unknown): Promise<any> {
  const tool = registeredTools()[name];
  expect(tool, `tool '${name}' is not registered`).toBeDefined();
  const result = await tool.handler(args, {} as any);
  return JSON.parse(result.content[0].text);
}

const SOURCE_FILES = [
  'station-docs-content.ts',
  'station-docs-mcp-server.ts',
  'station-docs-server.ts',
] as const;

function readSource(file: string): string {
  return readFileSync(
    fileURLToPath(new URL(`../${file}`, import.meta.url)),
    'utf8',
  );
}

/**
 * Sentences that pair an install verb with "plugin(s)" without a negation or
 * a person's-consent marker. Plugin installs need a person to approve a
 * preview, so any sentence that talks about installing plugins must say so or
 * say who cannot.
 */
function unqualifiedPluginInstallClaims(text: string): string[] {
  const installsPlugin = (sentence: string) =>
    /\binstall(s|ing|ed)?\b/i.test(sentence) && /\bplugins?\b/i.test(sentence);
  const qualified = (sentence: string) =>
    /\b(not|cannot|can['’]t|no agent|must not|a person|approv\w*|consent\w*)\b/i.test(
      sentence,
    );
  return text
    .split(/(?<=[.!?])\s+|\n+/)
    .filter((sentence) => installsPlugin(sentence) && !qualified(sentence));
}

describe('station-docs content', () => {
  test('every topic is complete and its id is a stable kebab-case key', () => {
    expect(STATION_DOCS_TOPICS.length).toBeGreaterThanOrEqual(8);
    for (const topic of STATION_DOCS_TOPICS) {
      expect(topic.id).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
      expect(topic.title.trim().length).toBeGreaterThan(0);
      expect(topic.summary.trim().length).toBeGreaterThan(0);
      expect(topic.body.trim().length).toBeGreaterThan(80);
      expect(topic.tags.length).toBeGreaterThan(0);
    }
    const ids = STATION_DOCS_TOPICS.map((topic) => topic.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test('the shipped set covers the surfaces a user actually asks about', () => {
    const ids = new Set(STATION_DOCS_TOPICS.map((topic) => topic.id));
    for (const required of [
      'station-overview',
      'station-docs',
      'projects',
      'agents-and-engines',
      'connections',
      'builtin-assistant',
      'trust-and-receipts',
      'tool-servers',
      'vocabulary',
    ]) {
      expect(ids.has(required), `missing topic '${required}'`).toBe(true);
    }
  });

  test('the station-docs topic states the capability split honestly (AC6)', () => {
    const topic = findStationDocsTopic('station-docs');
    expect(topic).toBeDefined();
    const body = topic?.body ?? '';
    // An engine may be given these docs and still be unable to operate
    // Station. If this topic ever stops saying so, an engine reading it will
    // answer about Station as if it could act on it.
    expect(body).toContain('station-control');
    expect(body.toLowerCase()).toContain('cannot');
    expect(body.toLowerCase()).toMatch(/explain/);
  });

  test('no topic claims an agent can install plugins, and the install topics name where a person approves one', () => {
    // station-control's install_plugin refuses with operator-approval-required
    // (station-control-platform-tools.ts). Docs claiming the default agent
    // installs plugins send an engine to promise an action it cannot take.
    for (const topic of STATION_DOCS_TOPICS) {
      const text = [topic.title, topic.summary, topic.body].join('\n');
      expect(unqualifiedPluginInstallClaims(text), topic.id).toEqual([]);
    }
    for (const id of ['station-docs', 'builtin-assistant']) {
      const body = findStationDocsTopic(id)?.body ?? '';
      expect(body, id).toContain('station plugin install');
      expect(body, id).toContain('Plugins page');
    }
  });

  test('the plugin-install guard catches claims phrased other ways', () => {
    expect(
      unqualifiedPluginInstallClaims(
        'The assistant can create agents and install a plugin for you.',
      ),
    ).toHaveLength(1);
    expect(
      unqualifiedPluginInstallClaims('The default agent installs plugins.'),
    ).toHaveLength(1);
    expect(
      unqualifiedPluginInstallClaims(
        'It cannot install a plugin. A person must approve the preview.',
      ),
    ).toEqual([]);
  });

  test('no topic claims to describe the reader’s own Station', () => {
    // A content-level check on the same boundary the tool descriptions state:
    // shipped prose must never present itself as live state.
    for (const topic of STATION_DOCS_TOPICS) {
      expect(topic.body.toLowerCase()).not.toMatch(
        /your (agents|runs|jobs|sessions) (are|is) currently/,
      );
    }
  });
});

/**
 * #2323 S1. The plugin-authoring topic is what an agent on an installed
 * Station reads instead of a source checkout, so it has to stay true as the
 * SDK and the manifest loader move. Each test below binds a claim in the
 * prose to the code that decides it.
 */
describe('station-docs plugin-authoring topic', () => {
  const topic = () => {
    const found = findStationDocsTopic('plugin-authoring');
    expect(found, 'plugin-authoring topic is missing').toBeDefined();
    return found!;
  };
  const paragraphs = () => topic().body.split('\n\n');
  /**
   * An install or set-up verb and a plugin (or "it for them/you/the person")
   * in one clause, whatever the subject. Subject-agnostic on purpose: rather
   * than guess which subjects are agents, every match must be pinned below.
   * Known limit: a pronoun that refers to a plugin across sentences ("Write
   * the plugin. Then install it.") is not caught.
   */
  const install =
    /\b(?:install(?:s|ing|ed|ation)?|set(?:s|ting)?\s+up)\b[^.;:\n]*?\b(?:plugins?|it\s+for\s+(?:them|you|the\s+person))\b/i;

  /** The paragraph that starts with `heading`, as written in the body. */
  const paragraph = (heading: string) => {
    const match = paragraphs().find((block) => block.startsWith(heading));
    expect(match, `no paragraph starting '${heading}'`).toBeDefined();
    return match!;
  };

  /** A line inside `block` starting with `prefix`. */
  const line = (block: string, prefix: string) => {
    const match = block.split('\n').find((entry) => entry.startsWith(prefix));
    expect(match, `no line starting '${prefix}'`).toBeDefined();
    return match!;
  };

  const quoted = (text: string) =>
    [...text.matchAll(/"([^"]+)"/g)].map((match) => match[1]!);

  const exampleManifests = () =>
    paragraphs()
      .filter((block) => block.startsWith('A complete minimal manifest'))
      .map((block) => JSON.parse(block.slice(block.indexOf('\n{') + 1)));

  const load = (manifest: unknown) =>
    parsePluginManifestDocumentWithFormat(
      JSON.stringify(manifest),
      '/docs/plugin.json',
    );

  /** The plugin-component example with one pane field replaced. */
  const withPane = (patch: Record<string, unknown>) => {
    const [example] = exampleManifests();
    const copy = JSON.parse(JSON.stringify(example));
    Object.assign(
      copy.extensions['io.kontourai.station'].workspacePanes[0],
      patch,
    );
    return load(copy);
  };

  test('every SDK hook the topic names is a real export of @kontourai/station-sdk', async () => {
    const named = [
      ...new Set(topic().body.match(/\buse[A-Z][A-Za-z]+\b/g) ?? []),
    ];
    // The curated set the topic exists to teach, required IN the SDK HOOKS
    // paragraph itself: a hook also mentioned elsewhere (useSendToChat in
    // COMMON MISTAKES) must not keep this green after its table line is
    // deleted.
    const table = [
      ...new Set(
        paragraph('SDK HOOKS A PANE CAN USE').match(/\buse[A-Z][A-Za-z]+\b/g) ??
          [],
      ),
    ];
    expect(table).toEqual(
      expect.arrayContaining([
        'useAgents',
        'useIntegrationsQuery',
        'useOrchestrationSessionsQuery',
        'useSendToChat',
        'useLaunchChat',
        'useNavigation',
        'useToast',
      ]),
    );
    // A non-literal specifier keeps the SDK's React sources out of the
    // server-tests `tsc` program (no JSX there); vitest still loads the real
    // public barrel at runtime.
    const sdkSpecifier: string = '@kontourai/station-sdk';
    const sdk = (await import(sdkSpecifier)) as Record<string, unknown>;
    const missing = named.filter((hook) => typeof sdk[hook] !== 'function');
    expect(
      missing,
      'the plugin-authoring topic names hooks the SDK does not export',
    ).toEqual([]);
  }, 60_000);

  test('there is one example manifest per documented renderer kind, and each loads with its pane intact', () => {
    const documentedKinds = [
      ...paragraph('RENDERER KINDS').matchAll(/Use "([a-z-]+)"/g),
    ].map((match) => match[1]!);
    expect(documentedKinds.sort()).toEqual(['mcp-tool-ui', 'plugin-component']);

    const examples = exampleManifests();
    const covered: string[] = [];
    for (const example of examples) {
      const { manifest, format, stationExtension } = load(example);
      expect(format, example.name).toBe('agent-plugin-1.0');
      // `disabled` would mean Station drops every pane the example declares
      // while still reporting a successful load.
      expect(stationExtension, example.name).toEqual({ status: 'validated' });
      expect(manifest.workspacePanes, example.name).toHaveLength(1);
      covered.push(manifest.workspacePanes![0]!.renderer.kind);
    }
    expect(covered.sort()).toEqual(documentedKinds);
  });

  test('the mcp-tool-ui example requires the integration its renderer ref names', () => {
    const example = exampleManifests().find(
      (candidate) =>
        candidate.extensions['io.kontourai.station'].workspacePanes[0].renderer
          .kind === 'mcp-tool-ui',
    );
    expect(example).toBeDefined();
    const station = example.extensions['io.kontourai.station'];
    const [serverId] = station.workspacePanes[0].renderer.ref.split('/');
    expect(station.integrations.required).toContain(serverId);
    expect(station.workspacePanes[0].provenance.mcpServerId).toBe(serverId);
  });

  test('the plugin-component example declares the entrypoint and renderer name its code exports', () => {
    const [example] = exampleManifests();
    const { manifest } = load(example);
    expect(manifest.entrypoint).toBe('./src/index.tsx');
    expect(manifest.workspacePanes?.[0]?.renderer).toEqual({
      kind: 'plugin-component',
      name: 'my-pulse-workspace',
    });
    expect(paragraph('THE ENTRYPOINT AND THE COMPONENTS EXPORT')).toContain(
      'export const components = { "my-pulse-workspace": MyPulse };',
    );
  });

  test('the permission list is exactly Station’s permission vocabulary, in the right tiers', () => {
    const block = paragraph('PERMISSIONS.');
    for (const tier of ['passive', 'active', 'trusted'] as const) {
      const documented = quoted(line(block, `- ${tier} `)).sort();
      const actual = Object.entries(PERMISSION_TIERS)
        .filter(([, value]) => value === tier)
        .map(([permission]) => permission)
        .sort();
      expect(documented, `${tier} permissions`).toEqual(actual);
    }
  });

  test('the documented regions are exactly the contract’s regions', () => {
    const regions = line(
      paragraph('WORKSPACE PANE FIELDS'),
      '- placement.supportedRegions',
    ).split('.')[1]!;
    expect(quoted(regions).sort()).toEqual([...WORKSPACE_PANE_REGIONS].sort());
  });

  test('every documented lifecycle stage and context key is accepted by the loader', () => {
    const fields = paragraph('WORKSPACE PANE FIELDS');
    const stages = quoted(line(fields, '- lifecycle.stage'));
    expect(stages.length).toBeGreaterThan(0);
    for (const stage of stages) {
      expect(
        withPane({ lifecycle: { stage } }).stationExtension,
        stage,
      ).toEqual({ status: 'validated' });
    }
    // The control: the substitution really reaches the parser.
    expect(
      withPane({ lifecycle: { stage: 'beta' } }).stationExtension?.status,
    ).toBe('disabled');

    const modes = line(fields, '- modes');
    const keys = quoted(
      modes.slice(modes.indexOf('these keys'), modes.indexOf('"default"')),
    );
    expect(keys).toEqual(
      expect.arrayContaining(['project', 'task', 'session']),
    );
    for (const key of keys) {
      const { manifest, stationExtension } = withPane({
        modes: [{ id: 'default', contextRequirement: { [key]: true } }],
      });
      expect(stationExtension, key).toEqual({ status: 'validated' });
      // Unknown keys are dropped rather than refused, so presence in the
      // parsed mode is the proof the loader knows the key.
      expect(
        manifest.workspacePanes?.[0]?.modes[0]?.contextRequirement,
        key,
      ).toEqual({ [key]: true });
    }
  });

  test('it says agents must not install, and names the validate tool and the person’s paths', () => {
    const body = topic().body;
    expect(body).toContain('validate_plugin');
    expect(body).toMatch(/agents must not install plugins/i);
    expect(body).toContain('Plugins → Install plugin');
    expect(body).toContain('station plugin install');
    expect(body).toContain('--yes');
    // Validation is a subset of the preview; the prose must not say otherwise.
    expect(body).not.toMatch(/same checks/i);
    expect(body).toContain('dependencies-not-checked');
    // The #2321 mistake: the hook returns the function itself.
    expect(body).toContain('const sendToChat = useSendToChat(');
    expect(body).not.toMatch(
      /const \{ sendToChat \} = useSendToChat\((?!\.\.\.)/,
    );
  });

  test('every sentence pairing install with plugin is one a person approved, word for word', () => {
    // An explicit allow-list, not a heuristic. Any sentence that pairs
    // install/installs/installing/installed/installation with plugin(s) in
    // the same clause, whatever sits between them ("install your plugin"),
    // must appear below verbatim. A new or reworded one fails until someone
    // adds it on purpose, which is the review this guard exists to force: a
    // docs line saying an agent installs plugins is exactly the claim
    // station-control refuses.
    const PERMITTED = [
      [
        'station-docs',
        'Installing a plugin is not among them: a person approves every install (see the `plugin-authoring` topic).',
      ],
      [
        'builtin-assistant',
        'It does not install plugins: `install_plugin` refuses, because a person approves every install, on a preview, in the Plugins view or the `station` CLI.',
      ],
      [
        'skills',
        'Skills are installed and browsed from the registry alongside agents, tool servers, and plugins.',
      ],
      [
        'plugins',
        'The registry is the unified place to browse and install agents, skills, integrations, and plugins, with an install lifecycle that includes updates and removal.',
      ],
      [
        'plugin-authoring',
        'Station builds the bundle itself when the plugin is installed, so a plugin ships source, not a `dist/` folder.',
      ],
      [
        'plugin-authoring',
        'Pane ids and renderer ids are opaque strings, but they are global across every installed plugin: follow the `pane:plugin%3A<plugin-name>:<group>:<name>` and `renderer:plugin%3A<plugin-name>:<renderer kind>:<name>` pattern above so yours cannot collide, write the parts you choose in lowercase, and give every pane its own `id` and its own `rendererId`.',
      ],
      [
        'plugin-authoring',
        'For local typechecking, `npm install @kontourai/station-sdk react @types/react typescript` in the plugin folder is enough.',
      ],
      [
        'plugin-authoring',
        'Agents must not install plugins, and `install_plugin` refuses.',
      ],
      [
        'plugin-authoring',
        'A person installs from Plugins → Install plugin, entering the folder path or git URL, or runs `station plugin install <path-or-url>` in a terminal.',
      ],
    ];
    const found = STATION_DOCS_TOPICS.flatMap((entry) =>
      entry.body
        .split(/(?<=[.!?])\s+|\n+/)
        .filter((sentence) => install.test(sentence))
        .map((sentence) => [entry.id, sentence]),
    );
    expect(found).toEqual(PERMITTED);
  });

  test('the install guard catches the phrasings the allow-list exists for', () => {
    for (const claim of [
      'The assistant installs plugins for a person.',
      'It can install plugins, not just list them.',
      'Ask the agent to install your plugin.',
      'The agent installed the new plugin.',
      'The assistant sets up plugins for you.',
      'Write it, then install it for them.',
      'Setting up your plugin is automatic.',
    ]) {
      expect(install.test(claim), claim).toBe(true);
    }
  });
});

describe('station-docs lookup and search', () => {
  test('findStationDocsTopic resolves a known id and is honest about an unknown one', () => {
    expect(findStationDocsTopic('projects')?.id).toBe('projects');
    expect(findStationDocsTopic('  PROJECTS  ')?.id).toBe('projects');
    expect(findStationDocsTopic('what-is-running-right-now')).toBeUndefined();
  });

  test('search matches tags and body text, and bounds its result count', () => {
    const gateHits = searchStationDocs('evidence');
    expect(gateHits.length).toBeGreaterThan(0);
    expect(gateHits.map((hit) => hit.id)).toContain('trust-and-receipts');

    const tagHit = searchStationDocs('cron');
    expect(tagHit.map((hit) => hit.id)).toContain('scheduled-jobs');

    expect(searchStationDocs('station', 2).length).toBeLessThanOrEqual(2);
    expect(searchStationDocs('   ')).toEqual([]);
    expect(searchStationDocs('a-string-that-appears-in-no-topic')).toEqual([]);
  });
});

describe('station-docs MCP server', () => {
  test('registers exactly the three read-only documentation tools', () => {
    expect(Object.keys(registeredTools()).sort()).toEqual([
      'get_station_docs_topic',
      'list_station_docs_topics',
      'search_station_docs',
    ]);
  });

  test('every tool description says it returns shipped documentation, not live state', () => {
    for (const [name, tool] of Object.entries(registeredTools())) {
      const description = tool.description ?? '';
      expect(
        description,
        `tool '${name}' must say it returns SHIPPED DOCUMENTATION`,
      ).toContain('SHIPPED DOCUMENTATION');
      expect(
        description.toLowerCase(),
        `tool '${name}' must say it is never live state`,
      ).toContain('never live state');
    }
  });

  test('list returns every topic as a summary, with the shipped-source envelope', () => {
    // Bodies are intentionally absent from the list result: listing is for
    // choosing a topic, not for dumping the whole manual into a context.
    return callTool('list_station_docs_topics', {}).then((payload) => {
      expect(payload.kind).toBe('shipped-documentation');
      expect(payload.stationVersion).toBe(packageJson.version);
      expect(payload.note.toLowerCase()).toContain('not live state');
      expect(payload.topics).toHaveLength(STATION_DOCS_TOPICS.length);
      expect(payload.topics[0].body).toBeUndefined();
    });
  });

  test('get returns the full topic, and names the real ids when asked for a bad one', async () => {
    const found = await callTool('get_station_docs_topic', {
      id: 'station-overview',
    });
    expect(found.topic.id).toBe('station-overview');
    expect(found.topic.body.length).toBeGreaterThan(0);

    const missing = await callTool('get_station_docs_topic', {
      id: 'my-current-agents',
    });
    expect(missing.topic).toBeUndefined();
    expect(missing.error).toContain('my-current-agents');
    expect(missing.availableTopicIds).toContain('station-overview');
  });

  test('search returns hits with the query echoed back', async () => {
    const payload = await callTool('search_station_docs', {
      query: 'engine',
    });
    expect(payload.query).toBe('engine');
    expect(payload.results.length).toBeGreaterThan(0);
    expect(payload.kind).toBe('shipped-documentation');
  });
});

describe('station-docs structural properties (AC2)', () => {
  test('the docs are versioned with Station itself', () => {
    expect(STATION_DOCS_VERSION).toBe(packageJson.version);
    // The exported constant is the contract; `_serverInfo` is what an MCP
    // client actually reads on initialize, so assert the version a client
    // sees — not only the constant this module happens to export.
    const server = createStationDocsMcpServer() as unknown as {
      server: { _serverInfo: { name: string; version: string } };
    };
    expect(server.server._serverInfo).toEqual({
      name: 'station-docs',
      version: packageJson.version,
    });
  });

  test('GUARD: the docs modules cannot fetch, read the disk, or spawn anything at runtime', () => {
    // "Content is bundled and versioned with Station — never fetched at
    // runtime" has to be structural, not a convention. If this fails, the
    // docs server has gained a way to reach outside its own bundle, and the
    // credential-free / no-live-state claim it makes to every engine is no
    // longer true by construction.
    const forbidden = [
      'node:fs',
      'node:http',
      'node:https',
      'node:net',
      'node:dgram',
      'node:child_process',
      'fetch(',
      'XMLHttpRequest',
      'readFileSync',
      'readFile(',
      'execFile',
      'spawn(',
    ];
    for (const file of SOURCE_FILES) {
      const source = readSource(file);
      for (const token of forbidden) {
        expect(
          source.includes(token),
          `${file} must not reference '${token}' — station-docs serves only content compiled into its own bundle.`,
        ).toBe(false);
      }
    }
  });

  test('GUARD: the docs modules import nothing that could reach Station’s API', () => {
    // The tightest form of the property above: an allowlist, so importing
    // `station-control-shared.js` (which owns the API client and the internal
    // token) fails here rather than being caught by a token scan someone can
    // route around.
    const allowed = new Set([
      '@modelcontextprotocol/server',
      '@modelcontextprotocol/server/stdio',
      'zod',
      '../../package.json',
      './station-docs-content.js',
      './station-docs-mcp-server.js',
    ]);
    for (const file of SOURCE_FILES) {
      const source = readSource(file);
      const specifiers = [...source.matchAll(/from\s+'([^']+)'/g)].map(
        (match) => match[1],
      );
      for (const specifier of specifiers) {
        expect(
          allowed.has(specifier),
          `${file} imports '${specifier}', which is not on the station-docs allowlist. The docs server must stay unable to reach Station's API, filesystem, or network.`,
        ).toBe(true);
      }
    }
  });
});
