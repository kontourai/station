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
  TYPECHECK_EXCLUDED,
  TYPECHECK_EXCLUDED_README_NOTE,
  typecheckCoverageProblems,
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

/** A repo root holding `examples/<name>/...` for the coverage gate. */
function makeRepo(files: Record<string, string>): string {
  sandbox = mkdtempSync(join(tmpdir(), 'examples-typecheck-'));
  for (const [path, contents] of Object.entries(files)) {
    const full = join(sandbox, path);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, contents);
  }
  return sandbox;
}

const SRC_TSCONFIG = JSON.stringify({
  compilerOptions: { strict: true, noEmit: true },
  include: ['src/**/*'],
});
const CHECK_DEMO =
  'node scripts/tsc-slot.mjs --noEmit -p examples/demo/tsconfig.json';

describe('typecheckCoverageProblems', () => {
  it('flags an example whose TypeScript no typecheck:examples project compiles', () => {
    // The station#2343 shape: a tsconfig-less example nothing type-checks.
    const root = makeRepo({ 'examples/demo/src/index.tsx': 'export {};' });
    expect(
      typecheckCoverageProblems({
        root,
        typecheckCommand: '',
        excluded: new Map(),
      }),
    ).toEqual([
      expect.stringContaining(
        'examples/demo/src/index.tsx is TypeScript that no typecheck:examples project compiles',
      ),
    ]);
  });

  it('flags a tsconfig the typecheck:examples chain never names', () => {
    const root = makeRepo({
      'examples/demo/tsconfig.json': SRC_TSCONFIG,
      'examples/demo/src/index.tsx': 'export {};',
    });
    expect(
      typecheckCoverageProblems({
        root,
        typecheckCommand: '',
        excluded: new Map(),
      }),
    ).toHaveLength(1);
  });

  it('accepts an example whose project the chain compiles', () => {
    const root = makeRepo({
      'examples/demo/tsconfig.json': SRC_TSCONFIG,
      'examples/demo/src/index.tsx': 'export {};',
      // Compiler output, not an authored source.
      'examples/demo/providers/out.d.ts': 'export {};',
    });
    expect(
      typecheckCoverageProblems({
        root,
        typecheckCommand: CHECK_DEMO,
        excluded: new Map(),
      }),
    ).toEqual([]);
  });

  it('flags a source outside the project include even when the example is covered', () => {
    // The compiler decides membership: server tests beside a src-only include
    // are exactly what a hand-written glob would wave through.
    const root = makeRepo({
      'examples/demo/tsconfig.json': SRC_TSCONFIG,
      'examples/demo/src/index.tsx': 'export {};',
      'examples/demo/server/__tests__/plugin.test.ts': 'export {};',
    });
    expect(
      typecheckCoverageProblems({
        root,
        typecheckCommand: CHECK_DEMO,
        excluded: new Map(),
      }),
    ).toEqual([
      expect.stringContaining('examples/demo/server/__tests__/plugin.test.ts'),
    ]);
  });

  // #2343 review LOW-1: each of these satisfied the gate without a single
  // file being type-checked.
  it('does not count a tsconfig that sets noCheck', () => {
    const root = makeRepo({
      'examples/demo/tsconfig.json': JSON.stringify({
        compilerOptions: { noCheck: true, noEmit: true },
        include: ['src/**/*'],
      }),
      'examples/demo/src/index.tsx': 'export {};',
    });
    expect(
      typecheckCoverageProblems({
        root,
        typecheckCommand: CHECK_DEMO,
        excluded: new Map(),
      }),
    ).toEqual([
      'examples/demo/tsconfig.json is compiled with noCheck, so typecheck:examples does not type-check it',
      expect.stringContaining(
        'examples/demo/src/index.tsx is TypeScript that no typecheck:examples project compiles',
      ),
    ]);
  });

  it('does not count a segment that passes --noCheck', () => {
    const root = makeRepo({
      'examples/demo/tsconfig.json': SRC_TSCONFIG,
      'examples/demo/src/index.tsx': 'export {};',
    });
    expect(
      typecheckCoverageProblems({
        root,
        typecheckCommand: `${CHECK_DEMO} --noCheck`,
        excluded: new Map(),
      }),
    ).toContain(
      'examples/demo/tsconfig.json is compiled with noCheck, so typecheck:examples does not type-check it',
    );
  });

  it('does not count a segment that names a project without compiling it', () => {
    const root = makeRepo({
      'examples/demo/tsconfig.json': SRC_TSCONFIG,
      'examples/demo/src/index.tsx': 'export {};',
    });
    expect(
      typecheckCoverageProblems({
        root,
        typecheckCommand: 'npm run lint && echo -p examples/demo/tsconfig.json',
        excluded: new Map(),
      }),
    ).toEqual([
      expect.stringContaining(
        'examples/demo/src/index.tsx is TypeScript that no typecheck:examples project compiles',
      ),
    ]);
  });

  it('does not count a segment whose failure the chain swallows', () => {
    const root = makeRepo({
      'examples/demo/tsconfig.json': SRC_TSCONFIG,
      'examples/demo/src/index.tsx': 'export {};',
    });
    for (const command of [
      `${CHECK_DEMO} || true`,
      `${CHECK_DEMO} | cat`,
      `${CHECK_DEMO}; true`,
    ]) {
      expect(
        typecheckCoverageProblems({
          root,
          typecheckCommand: command,
          excluded: new Map(),
        }),
        command,
      ).toEqual([
        expect.stringContaining(
          'examples/demo/src/index.tsx is TypeScript that no typecheck:examples project compiles',
        ),
      ]);
    }
  });

  it('flags a covered source that switches checking off with @ts-nocheck', () => {
    const root = makeRepo({
      'examples/demo/tsconfig.json': SRC_TSCONFIG,
      'examples/demo/src/index.tsx':
        '// @ts-nocheck\nexport const n: number = "x";',
      'examples/demo/src/ok.ts':
        "// mentions @ts-nocheck mid-line: 'x // @ts-nocheck'\nexport {};",
    });
    expect(
      typecheckCoverageProblems({
        root,
        typecheckCommand: CHECK_DEMO,
        excluded: new Map(),
      }),
    ).toEqual([
      'examples/demo/src/index.tsx disables type checking with @ts-nocheck',
    ]);
  });

  it('flags a project the chain names that does not exist', () => {
    const root = makeRepo({ 'examples/other/README.md': '# other' });
    expect(
      typecheckCoverageProblems({
        root,
        typecheckCommand: CHECK_DEMO,
        excluded: new Map(),
      }),
    ).toEqual([
      'typecheck:examples names a missing project: examples/demo/tsconfig.json',
    ]);
  });

  it('honours an exclusion only when the README discloses it', () => {
    const excluded = new Map([['demo', 'reference only']]);
    const undisclosed = makeRepo({
      'examples/demo/README.md': '# demo',
      'examples/demo/src/index.tsx': 'export {};',
    });
    expect(
      typecheckCoverageProblems({
        root: undisclosed,
        typecheckCommand: '',
        excluded,
      }),
    ).toEqual([expect.stringContaining('its README does not say')]);
    rmSync(undisclosed, { recursive: true, force: true });

    const disclosed = makeRepo({
      'examples/demo/README.md': `# demo\n\n${TYPECHECK_EXCLUDED_README_NOTE}\n`,
      'examples/demo/src/index.tsx': 'export {};',
    });
    expect(
      typecheckCoverageProblems({
        root: disclosed,
        typecheckCommand: '',
        excluded,
      }),
    ).toEqual([]);
  });

  it('rejects an exclusion that is stale or contradicted by coverage', () => {
    const root = makeRepo({
      'examples/demo/README.md': `# demo\n\n${TYPECHECK_EXCLUDED_README_NOTE}\n`,
      'examples/demo/tsconfig.json': SRC_TSCONFIG,
      'examples/demo/src/index.tsx': 'export {};',
      'examples/plain/README.md': `# plain\n\n${TYPECHECK_EXCLUDED_README_NOTE}\n`,
    });
    expect(
      typecheckCoverageProblems({
        root,
        typecheckCommand: CHECK_DEMO,
        excluded: new Map([
          ['demo', 'x'],
          ['plain', 'x'],
          ['gone', 'x'],
        ]),
      }),
    ).toEqual([
      'demo: listed in TYPECHECK_EXCLUDED but typecheck:examples compiles it',
      'plain: listed in TYPECHECK_EXCLUDED but has no TypeScript sources',
      'TYPECHECK_EXCLUDED names a missing example: gone',
    ]);
  });
});

describe('the repo’s own examples', () => {
  it('type-checks every example TypeScript source, or discloses the exclusion', () => {
    // Reads package.json's real typecheck:examples chain and asks TypeScript
    // which files each named project compiles (station#2343).
    expect(typecheckCoverageProblems()).toEqual([]);
  });

  it('excludes nothing from typecheck:examples today', () => {
    // Every example was brought under the compiler in station#2343. Adding an
    // exclusion is allowed, but should be a visible diff to this pin.
    expect([...TYPECHECK_EXCLUDED.keys()]).toEqual([]);
  });

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
