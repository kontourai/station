/**
 * Every example manifest loads through the reader the install preview uses,
 * and declares only fields the runtime reads (#2401).
 *
 * Two examples declared `clientBundle`, `toolbarActions` and `providerTypes`,
 * which nothing reads, so a toolbar action that could never mount looked
 * like a supported one. The validator itself is lenient on purpose: a legacy
 * manifest's unknown field is ignored, and an Agent Plugins manifest's unknown
 * core field is a warning while an invalid Station extension is disabled
 * rather than refused. Tightening it would break installed third-party
 * plugins, so the strictness lives here, over the examples people copy from.
 */
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PluginManifest } from '@kontourai/station-contracts/plugin';
import {
  type AgentPluginManifestReport,
  parseAgentPluginManifest,
} from '@kontourai/station-shared/agent-plugin-manifest';
import { afterEach, describe, expect, it } from 'vitest';
import { readUntrustedPluginManifestSyncWithFormat } from '../plugin-manifest-bounded-read.js';

const EXAMPLES_DIR = join(process.cwd(), 'examples');

/**
 * Every top-level field a legacy manifest may carry. `satisfies` makes this the
 * exact key set of `PluginManifest`: a field added to the contract fails to
 * compile here until it is listed, and a listed field the contract lacks is an
 * excess property.
 */
const LEGACY_MANIFEST_FIELDS = {
  name: true,
  version: true,
  sdkVersion: true,
  displayName: true,
  description: true,
  entrypoint: true,
  serverModule: true,
  build: true,
  capabilities: true,
  commands: true,
  permissions: true,
  links: true,
  agents: true,
  layout: true,
  layouts: true,
  workspacePanes: true,
  workspacePaneHost: true,
  operationalEventSubscriptions: true,
  providers: true,
  integrations: true,
  tools: true,
  dependencies: true,
  knowledge: true,
  prompts: true,
  skills: true,
  settings: true,
} satisfies Record<keyof PluginManifest, true>;

/**
 * Fields an example still declares although no runtime reads them, each with
 * why it has not been ported yet. An entry is honoured only while the field is
 * present, so a stale one fails.
 */
const UNREAD_FIELDS_ALLOWED = new Map<string, Map<string, string>>([
  [
    'enterprise-layout',
    new Map([
      [
        'env',
        'NOTES_VAULT_PATH has no manifest home yet; porting it to settings changes how the vault path is prompted, which is its own change',
      ],
    ]),
  ],
]);

const fixtureDirs: string[] = [];
afterEach(() => {
  for (const dir of fixtureDirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

/** Writes one manifest to a throwaway directory and returns its path. */
function fixture(document: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), 'example-manifest-'));
  fixtureDirs.push(dir);
  const path = join(dir, 'plugin.json');
  writeFileSync(path, JSON.stringify(document));
  return path;
}

function exampleManifests(): Array<{ name: string; path: string }> {
  return readdirSync(EXAMPLES_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({
      name: entry.name,
      path: join(EXAMPLES_DIR, entry.name, 'plugin.json'),
    }))
    .filter(({ path }) => existsSync(path))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** The fields no runtime reads, for one example's manifest. */
async function unreadFields(name: string, path: string): Promise<string[]> {
  const loaded = readUntrustedPluginManifestSyncWithFormat(path);
  const document = JSON.parse(await readFile(path, 'utf8')) as Record<
    string,
    unknown
  >;
  if (loaded.format === 'agent-plugin-1.0') {
    const reports: AgentPluginManifestReport[] = [];
    parseAgentPluginManifest(document, (report) => reports.push(report));
    const unread = reports
      .filter((report) => report.code === 'unknown-manifest-field')
      .map((report) => report.message);
    // The loader keeps a manifest whose Station extension fails its schema,
    // minus everything the extension declared. An unknown extension field is
    // one way to get there.
    if (loaded.stationExtension?.status !== 'validated') {
      unread.push(
        `Station extension ${loaded.stationExtension?.status ?? 'absent'}: ${loaded.stationExtension?.reason ?? ''}`,
      );
    }
    return unread;
  }
  const allowed = UNREAD_FIELDS_ALLOWED.get(name);
  return Object.keys(document).filter(
    (field) => !(field in LEGACY_MANIFEST_FIELDS) && !allowed?.has(field),
  );
}

describe('example plugin manifests', () => {
  const manifests = exampleManifests();

  // Pinned independently of the directory scan, which cannot notice the two
  // examples #2401 ported disappearing.
  it('covers the examples that declared fields no runtime reads', () => {
    const names = manifests.map(({ name }) => name);
    expect(names).toContain('meeting-transcription');
    expect(names).toContain('nova-sonic-voice');
  });

  it('declares only fields the runtime reads', async () => {
    const problems: string[] = [];
    for (const { name, path } of manifests) {
      for (const field of await unreadFields(name, path))
        problems.push(`${name}: ${field}`);
    }
    expect(problems).toEqual([]);
  });

  it('keeps every unread-field allowance tied to a field still declared', async () => {
    for (const [name, fields] of UNREAD_FIELDS_ALLOWED) {
      const document = JSON.parse(
        await readFile(join(EXAMPLES_DIR, name, 'plugin.json'), 'utf8'),
      ) as Record<string, unknown>;
      for (const field of fields.keys())
        expect(Object.keys(document), `${name}.${field}`).toContain(field);
    }
  });

  it('refuses the fields the two ported examples used to declare', async () => {
    const path = fixture({
      name: 'legacy-toolbar',
      version: '0.1.0',
      clientBundle: 'dist/index.js',
      toolbarActions: [],
      providerTypes: [],
    });
    // The real reader accepts it, which is why the examples check exists.
    expect(readUntrustedPluginManifestSyncWithFormat(path).manifest.name).toBe(
      'legacy-toolbar',
    );
    expect(await unreadFields('legacy-toolbar', path)).toEqual([
      'clientBundle',
      'toolbarActions',
      'providerTypes',
    ]);
  });

  it('refuses an Agent Plugins manifest whose Station extension is disabled', async () => {
    const path = fixture({
      $schema: 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json',
      name: 'extension-toolbar',
      version: '0.1.0',
      extensions: {
        'io.kontourai.station': {
          schemaVersion: '1.0',
          entrypoint: './src/index.ts',
          toolbarActions: [],
        },
      },
    });
    // Installable, but with the whole extension switched off.
    expect(
      readUntrustedPluginManifestSyncWithFormat(path).stationExtension?.status,
    ).toBe('disabled');
    expect(await unreadFields('extension-toolbar', path)).toEqual([
      expect.stringMatching(/^Station extension disabled/),
    ]);
  });
});
