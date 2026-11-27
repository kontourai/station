import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { JsonManifestRegistryProvider } from '../json-manifest-registry.js';
import { RegistryAppFactsReader } from '../registry-app-facts.js';

const repoRoot = process.cwd();
const temporary = trackTempDirs();
/**
 * The catalogue rows Apps › Discover's tests render. They are what this
 * server lists for the repository's example catalog, so the UI's facet and
 * card tests read real manifests through the real reader, not a hand-written
 * copy. The source location is left out: it is an absolute local path.
 */
const FIXTURE = resolve(
  repoRoot,
  'src-ui/src/views/apps/__tests__/fixtures/example-catalog.json',
);

async function exampleCatalogRows() {
  const provider = new JsonManifestRegistryProvider(
    resolve(repoRoot, 'examples/registry/manifest.json'),
    temporary('discover-fixture-home-'),
  );
  const { items } = await provider.getCatalogSnapshot();
  // The sandboxed tool view example is in no catalog index; its facts come
  // from the same reader the listing uses.
  const sessionActivity = await new RegistryAppFactsReader().read(
    'workspace-pane-starter',
    {
      physical: resolve(repoRoot, 'examples/workspace-pane-starter'),
      location: resolve(repoRoot, 'examples/workspace-pane-starter'),
    },
  );
  const manifest = JSON.parse(
    readFileSync(
      resolve(repoRoot, 'examples/workspace-pane-starter/plugin.json'),
      'utf8',
    ),
  ) as { displayName: string; description: string; version: string };
  return [
    ...items.map(({ source: _source, ...item }) => item),
    {
      id: 'workspace-pane-starter',
      displayName: manifest.displayName,
      description: manifest.description,
      version: manifest.version,
      installed: false,
      app: sessionActivity,
    },
  ];
}

describe('Discover test catalogue', () => {
  it('is what the server lists for the example catalog', async () => {
    const rows = await exampleCatalogRows();
    if (process.env.STATION_WRITE_DISCOVER_FIXTURE === '1')
      writeFileSync(FIXTURE, `${JSON.stringify(rows, null, 2)}\n`);
    expect(JSON.parse(readFileSync(FIXTURE, 'utf8'))).toEqual(rows);
  });
});
