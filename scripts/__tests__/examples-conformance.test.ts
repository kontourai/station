import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseWorkspacePaneDescriptor } from '@kontourai/station-sdk/workspace-pane';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CREDENTIAL_GATED,
  checkExample,
  documentedScripts,
  listExamples,
  uncataloguedExamples,
} from '../examples-conformance.mjs';

let sandbox: string | undefined;

afterEach(() => {
  if (sandbox) rmSync(sandbox, { recursive: true, force: true });
  sandbox = undefined;
});

function makeExample(name: string, files: Record<string, string>): string {
  sandbox = mkdtempSync(join(tmpdir(), 'examples-spec-'));
  const dir = join(sandbox, name);
  mkdirSync(dir, { recursive: true });
  for (const [path, contents] of Object.entries(files)) {
    const full = join(dir, path);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, contents);
  }
  return dir;
}

const MINIMAL = {
  'plugin.json': JSON.stringify({ name: 'demo', version: '1.0.0' }),
  'README.md': '# demo',
  'package.json': JSON.stringify({ name: 'demo', scripts: {} }),
};

describe('documentedScripts', () => {
  it('extracts every npm run invocation from a README', () => {
    expect(
      documentedScripts('Run `npm run build` then `npm run test:e2e:product`.'),
    ).toEqual(['build', 'test:e2e:product']);
  });

  it('finds nothing in prose without commands', () => {
    expect(documentedScripts('Just install the plugin.')).toEqual([]);
  });
});

describe('checkExample', () => {
  it('passes a well-formed example', () => {
    expect(checkExample(makeExample('demo', MINIMAL), 'demo')).toEqual([]);
  });

  it('rejects a manifest name that is not a safe path segment', () => {
    // assertSafeRegistrySegment rejects spaces, so a display-style name here
    // makes registry install throw. Three shipped examples had exactly this.
    const dir = makeExample('demo', {
      ...MINIMAL,
      'plugin.json': JSON.stringify({ name: 'Demo Plugin', version: '1.0.0' }),
    });
    expect(checkExample(dir, 'demo')).toContainEqual(
      expect.stringContaining('does not match directory'),
    );
  });

  it('flags a manifest path that points at a missing file', () => {
    const dir = makeExample('demo', {
      ...MINIMAL,
      'plugin.json': JSON.stringify({
        name: 'demo',
        version: '1.0.0',
        entrypoint: './index.tsx',
      }),
    });
    expect(checkExample(dir, 'demo')).toContainEqual(
      expect.stringContaining('entrypoint points at a missing file'),
    );
  });

  it('accepts a manifest path that resolves', () => {
    const dir = makeExample('demo', {
      ...MINIMAL,
      'plugin.json': JSON.stringify({
        name: 'demo',
        version: '1.0.0',
        entrypoint: './src/index.tsx',
      }),
      'src/index.tsx': 'export default () => null;',
    });
    expect(checkExample(dir, 'demo')).toEqual([]);
  });

  it('flags a README documenting a script nothing defines', () => {
    const dir = makeExample('demo', {
      ...MINIMAL,
      'README.md': '# demo\n\nRun `npm run dev` to start.',
    });
    expect(checkExample(dir, 'demo')).toContainEqual(
      expect.stringContaining('npm run dev'),
    );
  });

  it('accepts a README documenting a script the example defines', () => {
    const dir = makeExample('demo', {
      ...MINIMAL,
      'package.json': JSON.stringify({
        name: 'demo',
        scripts: { dev: 'vite' },
      }),
      'README.md': '# demo\n\nRun `npm run dev` to start.',
    });
    expect(checkExample(dir, 'demo')).toEqual([]);
  });

  it('requires the manifest fields PluginManifest declares required', () => {
    const dir = makeExample('demo', {
      ...MINIMAL,
      'plugin.json': JSON.stringify({ name: 'demo' }),
    });
    expect(checkExample(dir, 'demo')).toContainEqual(
      expect.stringContaining('missing required "version"'),
    );
  });

  it('flags an example with no README', () => {
    const dir = makeExample('demo', {
      'plugin.json': JSON.stringify({ name: 'demo', version: '1.0.0' }),
    });
    expect(checkExample(dir, 'demo')).toContain('no README.md');
  });

  it('reports a manifest that does not parse rather than throwing', () => {
    const dir = makeExample('demo', {
      ...MINIMAL,
      'plugin.json': '{ not json',
    });
    expect(checkExample(dir, 'demo')).toContainEqual(
      expect.stringContaining('does not parse'),
    );
  });
});

describe('the repo’s own examples', () => {
  it('catalogs every example for developers', () => {
    expect(uncataloguedExamples()).toEqual([]);
  });

  it('parses the Workspace Pane starter through the public SDK contract', () => {
    const manifest = JSON.parse(
      readFileSync('examples/workspace-pane-starter/plugin.json', 'utf8'),
    );
    const descriptor = parseWorkspacePaneDescriptor(
      manifest.workspacePanes?.[0],
    );

    expect(descriptor).toMatchObject({
      id: 'session-activity',
      renderer: {
        kind: 'mcp-tool-ui',
        ref: 'station-sessions-mcp/sessions_panel',
        approvalPolicy: 'read-only',
      },
      placement: {
        preferredRegion: 'secondary',
        supportedRegions: ['secondary', 'standalone'],
      },
      modes: [{ id: 'project', contextRequirement: { project: true } }],
      provenance: {
        origin: 'plugin',
        pluginId: 'workspace-pane-starter',
        mcpServerId: 'station-sessions-mcp',
      },
    });
    expect(manifest.integrations.required).toEqual(['station-sessions-mcp']);
    expect(manifest.tools.required).toEqual(['sessions_panel']);
  });

  it('every example conforms', () => {
    for (const name of listExamples()) {
      expect(checkExample(join('examples', name), name), name).toEqual([]);
    }
  });

  it('names every credential-gated example, so unproven is never silent', () => {
    // A runtime-unproven example must be declared, not quietly skipped.
    for (const name of CREDENTIAL_GATED.keys()) {
      expect(listExamples()).toContain(name);
    }
  });
});
