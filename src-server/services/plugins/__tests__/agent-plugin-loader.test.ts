import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { connectMCP } from '@kontourai/station-shared/mcp';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { ConfigLoader } from '../../../domain/config-loader.js';
import { SkillService } from '../../agents/skill-service.js';
import {
  AgentPluginLoader,
  type AgentPluginLoadReport,
} from '../agent-plugin-loader.js';

const PLUGIN_SCHEMA =
  'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json';
const MCP_SCHEMA = 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json';
const PLUGIN_ROOT_PLACEHOLDER = '$' + '{PLUGIN_ROOT}';
const PLUGIN_DATA_PLACEHOLDER = '$' + '{PLUGIN_DATA}';
const UNRECOGNIZED_PLACEHOLDER = '$' + '{UNRECOGNIZED}';
const REPOSITORY_ROOT = process.cwd();
const FIXTURE = resolve(
  REPOSITORY_ROOT,
  'src-server/services/plugins/__fixtures__/agent-plugins-example',
);

describe('AgentPluginLoader', () => {
  const scratch: string[] = [];

  function home(): string {
    const value = mkdtempSync(join(tmpdir(), 'station-agent-plugin-'));
    scratch.push(value);
    return value;
  }

  function writeJson(path: string, value: unknown): void {
    mkdirSync(resolve(path, '..'), { recursive: true });
    writeFileSync(path, JSON.stringify(value, null, 2));
  }

  function plugin(
    stationHome: string,
    name = 'acme.tools',
    manifest: Record<string, unknown> = {},
  ): string {
    const root = join(stationHome, 'plugins', name);
    mkdirSync(root, { recursive: true });
    writeJson(join(root, 'plugin.json'), {
      $schema: PLUGIN_SCHEMA,
      name,
      version: '1.2.3',
      ...manifest,
    });
    return root;
  }

  function skill(root: string, directory: string, name = directory): void {
    const skillDir = join(root, 'skills', directory);
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      join(skillDir, 'SKILL.md'),
      `---\nname: ${name}\ndescription: Use this skill for a loader test.\n---\n\n# ${name}\n`,
    );
  }

  afterEach(() => {
    process.chdir(REPOSITORY_ROOT);
    vi.restoreAllMocks();
    for (const path of scratch.splice(0)) {
      rmSync(path, { recursive: true, force: true });
    }
  });

  test('loads the byte-identical official example fixture', () => {
    const stationHome = home();
    const loaded = new AgentPluginLoader({
      projectHomeDir: stationHome,
    }).loadPackage(FIXTURE);

    expect(loaded?.manifest).toMatchObject({
      name: 'agent-plugins-example',
      version: '1.0.0',
    });
    expect(loaded?.skills).toEqual([
      expect.objectContaining({ name: 'migrate-agent-plugin' }),
    ]);
    expect(loaded?.reports).toEqual([]);
  });

  test('uses the specified non-fatal manifest exceptions and validates only Station namespace data', () => {
    const stationHome = home();
    const root = plugin(stationHome, 'acme.tools', {
      futurePortableField: { preservedByAnotherClient: true },
      extensions: 'temporarily malformed',
    });
    skill(root, 'valid');
    mkdirSync(join(root, 'io.kontourai.station'), { recursive: true });
    const reports: AgentPluginLoadReport[] = [];
    const loaded = new AgentPluginLoader({
      projectHomeDir: stationHome,
      report: (report) => reports.push(report),
    }).loadPackage(root);

    expect(loaded?.skills.map((entry) => entry.name)).toEqual(['valid']);
    expect(loaded?.stationExtensionRoot).toBe(
      realpathSync(join(root, 'io.kontourai.station')),
    );
    expect(reports.map((entry) => entry.code)).toEqual([
      'unknown-manifest-field',
      'manifest-invalid',
    ]);

    writeJson(join(root, 'plugin.json'), {
      $schema: PLUGIN_SCHEMA,
      name: 'acme.tools',
      extensions: {
        'com.example.unimplemented': {
          arbitraryNestedShape: ['not', 'validated', 'by', 'Station'],
        },
        'io.kontourai.station': { schemaVersion: 'wrong' },
      },
    });
    const isolated = new AgentPluginLoader({
      projectHomeDir: stationHome,
    }).loadPackage(root);
    expect(isolated?.skills.map((entry) => entry.name)).toEqual(['valid']);
    expect(isolated?.stationExtension).toBeUndefined();
    expect(isolated?.reports).toEqual([
      expect.objectContaining({ code: 'station-extension-invalid' }),
    ]);
  });

  test('rejects a non-object namespace member while retaining the exact reason', () => {
    const stationHome = home();
    const root = plugin(stationHome, 'acme.tools', {
      extensions: { 'other.client': 7 },
    });
    skill(root, 'must-not-load');

    const outcome = new AgentPluginLoader({
      projectHomeDir: stationHome,
    }).loadPackageResult(root);
    expect(outcome).toEqual({
      ok: false,
      reports: [
        expect.objectContaining({
          code: 'manifest-invalid',
          message: "Plugin manifest extension 'other.client' must be an object",
        }),
      ],
    });
  });

  test('resolves and caches vendored schemas independently of cwd in source and packaged layouts', () => {
    const stationHome = home();
    const hostileCwd = home();
    process.chdir(hostileCwd);
    expect(
      new AgentPluginLoader({ projectHomeDir: stationHome }).loadPackage(
        FIXTURE,
      )?.manifest.name,
    ).toBe('agent-plugins-example');

    const release = home();
    const packagedSchemas = join(release, 'schemas', 'agent-plugins');
    cpSync(join(REPOSITORY_ROOT, 'schemas', 'agent-plugins'), packagedSchemas, {
      recursive: true,
    });
    const bundledModule = join(release, 'dist-server', 'command-station.js');
    mkdirSync(resolve(bundledModule, '..'), { recursive: true });
    writeFileSync(bundledModule, '// packaged-like module location\n');
    const schemaModuleUrl = pathToFileURL(bundledModule).href;
    expect(
      new AgentPluginLoader({
        projectHomeDir: stationHome,
        schemaModuleUrl,
      }).loadPackage(FIXTURE)?.manifest.name,
    ).toBe('agent-plugins-example');

    // A second reader at the same packaged schema identity reuses immutable
    // compiled validators instead of reading/compiling on every manifest.
    writeFileSync(
      join(packagedSchemas, '1.0.0', 'plugin.schema.json'),
      'not json',
    );
    expect(
      new AgentPluginLoader({
        projectHomeDir: stationHome,
        schemaModuleUrl,
      }).loadPackage(FIXTURE)?.manifest.name,
    ).toBe('agent-plugins-example');
  });

  test.each([
    [{ name: 'missing-schema' }, /missing or unsupported \$schema/],
    [
      { $schema: 'https://agent-plugins.org/schemas/1.1.0/plugin.schema.json' },
      /missing or unsupported \$schema/,
    ],
    [
      { $schema: PLUGIN_SCHEMA, name: 'constructor' },
      /temporarily unsupported by Station object-key stores/,
    ],
    [
      { $schema: PLUGIN_SCHEMA, layout: {} },
      /retired Station root field 'layout'/,
    ],
    [
      { $schema: PLUGIN_SCHEMA, layouts: [] },
      /retired Station root field 'layouts'/,
    ],
  ])(
    'rejects a fatal manifest before discovering components: %j',
    (manifest, message) => {
      const stationHome = home();
      const root = join(stationHome, 'candidate');
      mkdirSync(root, { recursive: true });
      writeJson(join(root, 'plugin.json'), manifest);
      skill(root, 'must-not-load');

      const reports: AgentPluginLoadReport[] = [];
      expect(
        new AgentPluginLoader({
          projectHomeDir: stationHome,
          report: (report) => reports.push(report),
        }).loadPackage(root),
      ).toBeNull();
      expect(reports).toEqual([
        expect.objectContaining({
          code: 'manifest-invalid',
          message: expect.stringMatching(message),
        }),
      ]);
    },
  );

  test('discovers only valid immediate Agent Skills and preserves local override precedence', async () => {
    const stationHome = home();
    const root = plugin(stationHome);
    skill(root, 'portable');
    skill(root, 'wrong-directory', 'different-name');
    skill(join(root, 'skills', 'container'), 'nested');

    const loader = new AgentPluginLoader({ projectHomeDir: stationHome });
    expect(
      loader.listInstalled()[0]?.skills.map((entry) => entry.name),
    ).toEqual(['portable']);
    expect(loader.listInstalled()[0]?.reports).toEqual([
      expect.objectContaining({ code: 'skill-invalid' }),
    ]);

    skill(stationHome, 'portable');
    writeJson(join(stationHome, 'skills', 'portable', 'skill.json'), {
      name: 'portable',
      source: 'local',
      installedAt: '2026-09-03T00:00:00.000Z',
      path: join(stationHome, 'skills', 'portable'),
      origin: 'user',
    });
    const service = new SkillService(
      new ConfigLoader({ projectHomeDir: stationHome }),
      { info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
      { canonicalSources: () => loader.skillSources() },
    );
    await service.discoverSkills(stationHome);
    const portable = service
      .listSkills()
      .find((entry) => entry.name === 'portable');
    expect(portable).toMatchObject({ origin: 'user' });
    expect(service.listSkills().some((entry) => entry.name === 'nested')).toBe(
      false,
    );
  });

  test.runIf(process.platform !== 'win32')(
    'does not let the SkillService rescan re-admit an escaping SKILL.md symlink',
    async () => {
      const stationHome = home();
      const root = plugin(stationHome);
      skill(root, 'valid');
      const outside = join(stationHome, 'outside-skill');
      mkdirSync(outside, { recursive: true });
      writeFileSync(
        join(outside, 'SKILL.md'),
        '---\nname: escape\ndescription: Must remain outside.\n---\n',
      );
      const escapingSkill = join(root, 'skills', 'escape');
      mkdirSync(escapingSkill, { recursive: true });
      symlinkSync(join(outside, 'SKILL.md'), join(escapingSkill, 'SKILL.md'));

      const loader = new AgentPluginLoader({ projectHomeDir: stationHome });
      expect(
        loader.listInstalled()[0]?.skills.map((entry) => entry.name),
      ).toEqual(['valid']);
      const service = new SkillService(
        new ConfigLoader({ projectHomeDir: stationHome }),
        { info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
        { canonicalSources: () => loader.skillSources() },
      );
      await service.discoverSkills(stationHome);

      expect(service.listSkills().map((entry) => entry.name)).toContain(
        'valid',
      );
      expect(service.listSkills().map((entry) => entry.name)).not.toContain(
        'escape',
      );
    },
  );

  test('isolates MCP top-level, entry, transport, path, URL, and header failures', () => {
    const stationHome = home();
    const root = plugin(stationHome);
    skill(root, 'survives');
    writeJson(join(root, 'mcp.json'), {
      $schema: MCP_SCHEMA,
      mcpServers: {
        local: {
          type: 'stdio',
          command: 'node',
          args: [
            `${PLUGIN_ROOT_PLACEHOLDER}/server.mjs`,
            `${PLUGIN_DATA_PLACEHOLDER}/state.json`,
            UNRECOGNIZED_PLACEHOLDER,
          ],
          env: { CONFIG: `${PLUGIN_ROOT_PLACEHOLDER}/config.json` },
        },
        remote: {
          type: 'streamable-http',
          url: 'https://example.com/mcp',
          headers: { 'X-Tenant': 'public' },
        },
        escapeCommand: { type: 'stdio', command: './../outside' },
        escapeCwd: {
          type: 'stdio',
          command: 'node',
          cwd: `${PLUGIN_DATA_PLACEHOLDER}/../outside`,
        },
        insecure: { type: 'streamable-http', url: 'http://example.com/mcp' },
        duplicateHeaders: {
          type: 'streamable-http',
          url: 'https://example.com/mcp',
          headers: { 'X-Tenant': 'one', 'x-tenant': 'two' },
        },
        unknownField: { type: 'stdio', command: 'node', shell: true },
        legacy: { type: 'sse', url: 'https://example.com/sse' },
      },
    });

    const loaded = new AgentPluginLoader({
      projectHomeDir: stationHome,
    }).loadPackage(root);
    expect(loaded?.skills.map((entry) => entry.name)).toEqual(['survives']);
    expect(loaded?.tools).toHaveLength(2);
    expect(loaded?.tools).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          transport: 'stdio',
          command: 'node',
          cwd: realpathSync(root),
          args: [
            `${realpathSync(root)}/server.mjs`,
            `${realpathSync(loaded!.dataRoot)}/state.json`,
            UNRECOGNIZED_PLACEHOLDER,
          ],
          env: expect.objectContaining({
            PLUGIN_ROOT: realpathSync(root),
            PLUGIN_DATA: realpathSync(loaded!.dataRoot),
            CONFIG: `${realpathSync(root)}/config.json`,
          }),
        }),
        expect.objectContaining({
          transport: 'streamable-http',
          endpoint: 'https://example.com/mcp',
          headers: { 'X-Tenant': 'public' },
        }),
      ]),
    );
    expect(loaded?.reports).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'mcp-server-invalid' }),
        expect.objectContaining({ code: 'mcp-transport-unsupported' }),
      ]),
    );
  });

  test('anchors plugin-relative cwd against the plugin root under a hostile process cwd', () => {
    const stationHome = home();
    const root = plugin(stationHome);
    const work = join(root, 'runtime-work');
    mkdirSync(work, { recursive: true });
    writeJson(join(root, 'mcp.json'), {
      $schema: MCP_SCHEMA,
      mcpServers: {
        local: { type: 'stdio', command: 'node', cwd: './runtime-work' },
      },
    });
    process.chdir(home());

    const loaded = new AgentPluginLoader({
      projectHomeDir: stationHome,
    }).loadPackage(root);

    expect(loaded?.tools).toEqual([
      expect.objectContaining({ cwd: realpathSync(work) }),
    ]);
    expect(loaded?.reports).toEqual([]);
  });

  test('disables MCP only for invalid JSON, top-level shape, or schema mismatch', () => {
    const stationHome = home();
    const root = plugin(stationHome);
    skill(root, 'survives');
    const loader = new AgentPluginLoader({ projectHomeDir: stationHome });

    writeFileSync(join(root, 'mcp.json'), '{');
    expect(loader.loadPackage(root)).toMatchObject({
      skills: [expect.objectContaining({ name: 'survives' })],
      tools: [],
      reports: [expect.objectContaining({ code: 'mcp-invalid' })],
    });

    writeJson(join(root, 'mcp.json'), {
      $schema: 'https://agent-plugins.org/schemas/1.1.0/mcp.schema.json',
      mcpServers: {},
    });
    expect(loader.loadPackage(root)).toMatchObject({
      skills: [expect.objectContaining({ name: 'survives' })],
      tools: [],
      reports: [expect.objectContaining({ code: 'mcp-invalid' })],
    });

    writeJson(join(root, 'mcp.json'), {
      $schema: MCP_SCHEMA,
      mcpServers: {},
      extra: true,
    });
    expect(loader.loadPackage(root)).toMatchObject({
      skills: [expect.objectContaining({ name: 'survives' })],
      tools: [],
      reports: [expect.objectContaining({ code: 'mcp-invalid' })],
    });
  });

  test.runIf(process.platform !== 'win32')(
    'applies the narrow failure boundary to escaping symlinks',
    () => {
      const stationHome = home();
      const root = plugin(stationHome);
      const outside = join(stationHome, 'outside');
      mkdirSync(outside, { recursive: true });
      writeFileSync(
        join(outside, 'SKILL.md'),
        '---\nname: escape\ndescription: Must not load.\n---\n',
      );
      writeFileSync(join(outside, 'outside-bin'), '#!/bin/sh\n');
      mkdirSync(join(root, 'skills'), { recursive: true });
      symlinkSync(outside, join(root, 'skills', 'escape'));
      writeJson(join(root, 'mcp.json'), {
        $schema: MCP_SCHEMA,
        mcpServers: {
          escape: { type: 'stdio', command: './outside-bin' },
          sibling: { type: 'stdio', command: 'node' },
        },
      });
      symlinkSync(join(outside, 'outside-bin'), join(root, 'outside-bin'));

      const loaded = new AgentPluginLoader({
        projectHomeDir: stationHome,
      }).loadPackage(root);
      expect(loaded?.skills).toEqual([]);
      expect(loaded?.tools).toEqual([
        expect.objectContaining({ command: 'node' }),
      ]);
      expect(loaded?.reports).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ code: 'skill-invalid' }),
          expect.objectContaining({ code: 'mcp-server-invalid' }),
        ]),
      );
    },
  );

  test.runIf(process.platform !== 'win32')(
    'rejects a symlinked PLUGIN_DATA ancestor without creating external data',
    () => {
      const stationHome = home();
      const outside = home();
      symlinkSync(outside, join(stationHome, 'agent-plugin-data'), 'dir');
      const root = plugin(stationHome);
      writeJson(join(root, 'mcp.json'), {
        $schema: MCP_SCHEMA,
        mcpServers: { local: { type: 'stdio', command: 'node' } },
      });

      const outcome = new AgentPluginLoader({
        projectHomeDir: stationHome,
      }).loadPackageResult(root);

      expect(outcome).toEqual({
        ok: false,
        reports: [
          expect.objectContaining({
            code: 'component-invalid',
            component: 'PLUGIN_DATA',
            message: expect.stringMatching(/must not be a symbolic link/),
          }),
        ],
      });
      expect(readdirSync(outside)).toEqual([]);
    },
  );

  test('projects live ToolDefs into ConfigLoader without copying snapshots', async () => {
    const stationHome = home();
    const root = plugin(stationHome);
    writeJson(join(root, 'mcp.json'), {
      $schema: MCP_SCHEMA,
      mcpServers: {
        remote: { type: 'streamable-http', url: 'https://one.example/mcp' },
      },
    });
    const source = new AgentPluginLoader({ projectHomeDir: stationHome });
    const config = new ConfigLoader({
      projectHomeDir: stationHome,
      integrationSources: [source],
    });
    const [metadata] = await config.listIntegrations();
    expect(metadata).toMatchObject({
      source: 'agent-plugin:acme.tools',
      transport: 'streamable-http',
    });
    expect((await config.loadIntegration(metadata.id)).endpoint).toBe(
      'https://one.example/mcp',
    );
    expect(existsSync(join(stationHome, 'integrations'))).toBe(false);

    const live = await config.loadIntegration(metadata.id);
    await expect(
      config.saveIntegration(metadata.id, { ...live, enabled: false }),
    ).rejects.toThrow(/supplied by an installed package.*read-only/);
    await expect(
      config.updateIntegration(metadata.id, (current) => ({
        ...current,
        enabled: false,
      })),
    ).rejects.toThrow(/supplied by an installed package.*read-only/);
    expect(existsSync(join(stationHome, 'integrations'))).toBe(false);

    writeJson(join(root, 'mcp.json'), {
      $schema: MCP_SCHEMA,
      mcpServers: {
        remote: { type: 'streamable-http', url: 'https://two.example/mcp' },
      },
    });
    expect((await config.loadIntegration(metadata.id)).endpoint).toBe(
      'https://two.example/mcp',
    );
  });

  test('launches stdio with the projected root, data, cwd, and literal expansion', async () => {
    const stationHome = home();
    const root = plugin(stationHome);
    const nodeModules = join(root, 'node_modules');
    symlinkSync(join(process.cwd(), 'node_modules'), nodeModules, 'dir');
    writeFileSync(
      join(root, 'server.mjs'),
      readFileSync(
        join(
          process.cwd(),
          'packages/shared/src/__tests__/fixtures/mcp-modern-server.mjs',
        ),
      ),
    );
    writeJson(join(root, 'mcp.json'), {
      $schema: MCP_SCHEMA,
      mcpServers: {
        local: {
          type: 'stdio',
          command: 'node',
          args: [`${PLUGIN_ROOT_PLACEHOLDER}/server.mjs`],
          env: {
            STATION_MCP_TEST_RECEIPT: `${PLUGIN_DATA_PLACEHOLDER}/receipt.json`,
            STATION_MCP_TEST_LITERAL: UNRECOGNIZED_PLACEHOLDER,
          },
        },
      },
    });
    const [tool] = new AgentPluginLoader({
      projectHomeDir: stationHome,
    }).loadPackage(root)!.tools;
    const connection = await connectMCP(tool);
    expect(connection.tools.map((entry) => entry.originalName)).toContain(
      'echo',
    );
    await connection.disconnect();
    expect(
      JSON.parse(
        readFileSync(join(tool.env!.PLUGIN_DATA, 'receipt.json'), 'utf8'),
      ),
    ).toEqual({
      cwd: realpathSync(root),
      root: realpathSync(root),
      data: realpathSync(tool.env!.PLUGIN_DATA),
      literal: UNRECOGNIZED_PLACEHOLDER,
    });
  });
});
