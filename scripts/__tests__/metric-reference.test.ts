// @vitest-environment jsdom
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import ts from 'typescript-api';
import { describe, expect, it } from 'vitest';
import { trackTempDirs } from '../../src-server/__test-utils__/temp-dirs';
import { DOCS_TRUTH_GATE_LANES } from '../docs-truth-gate-aggregate.mjs';
import {
  parseMetricDeclarations,
  renderMetricReference,
} from '../generate-metric-reference.mjs';
import { renderLearningDocument } from '../lib/learning-markdown.mjs';
import { publishMetricReference } from '../lib/metric-reference-output.mjs';

const root = process.cwd();
const script = path.join(root, 'scripts/generate-metric-reference.mjs');
const sourcePath = 'src-server/telemetry/metrics.ts';
const outputPath = 'docs/reference/metrics.md';
const prelude =
  "import { metrics } from '@opentelemetry/api';\nconst meter = metrics.getMeter('station');\n";
const makeTempDir = trackTempDirs();

function runCli(entry: string, fixtureRoot: string, args: string[]) {
  const result = spawnSync(process.execPath, [entry, ...args], {
    cwd: fixtureRoot,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 15_000,
    maxBuffer: 128 * 1024,
  });
  expect(result.error).toBeUndefined();
  expect(result.signal).toBeNull();
  return result;
}

function cli(fixtureRoot: string, ...args: string[]) {
  return runCli(script, fixtureRoot, [`--root=${fixtureRoot}`, ...args]);
}

function defaultCli(fixtureRoot: string, ...args: string[]) {
  return runCli(
    path.join(fixtureRoot, 'scripts/generate-metric-reference.mjs'),
    fixtureRoot,
    args,
  );
}

function cliFixture() {
  const fixtureRoot = makeTempDir('station-metric-owner-');
  for (const directory of [
    'scripts/lib',
    'src-server/telemetry',
    'docs/reference',
  ])
    mkdirSync(path.join(fixtureRoot, directory), { recursive: true });
  for (const file of [
    'scripts/generate-metric-reference.mjs',
    'scripts/lib/module-entry.mjs',
    'scripts/lib/learning-source-reader.mjs',
    'scripts/lib/metric-reference-output.mjs',
  ])
    copyFileSync(path.join(root, file), path.join(fixtureRoot, file));
  symlinkSync(
    path.join(root, 'node_modules'),
    path.join(fixtureRoot, 'node_modules'),
    'junction',
  );
  writeFileSync(
    path.join(fixtureRoot, sourcePath),
    `${prelude}meter.createCounter('station.control');\n`,
  );
  return fixtureRoot;
}

describe('metric declaration reference', () => {
  it('enumerates all instrument families, including unbound callback registrations', () => {
    const families = [
      'createCounter',
      'createUpDownCounter',
      'createHistogram',
      'createGauge',
      'createObservableCounter',
      'createObservableUpDownCounter',
      'createObservableGauge',
    ];
    const source =
      prelude +
      families
        .map(
          (factory, index) =>
            `export const instrument${index} = meter.${factory}('station.metric${index}', { description: 'Description ${index}', unit: 'ms' });`,
        )
        .join('\n') +
      `
function register() {
  meter.createObservableGauge('station.callback').addCallback(callback);
}
// meter.createCounter('station.comment')
const example = "meter.createCounter('station.string')";
const local = (meter['createCounter']('station.local', {unit: ''}) as Counter);
`;
    const declarations = parseMetricDeclarations(source);
    expect(declarations).toHaveLength(9);
    expect(declarations.slice(0, 7)).toEqual(
      families.map((kind, index) => ({
        name: `station.metric${index}`,
        kind,
        binding: `instrument${index}`,
        declarationExported: true,
        description: `Description ${index}`,
        unit: 'ms',
        container: null,
        line: index + 3,
      })),
    );
    expect(declarations[7]).toMatchObject({
      name: 'station.callback',
      binding: null,
      container: 'register',
      description: null,
      unit: null,
      line: 11,
    });
    expect(declarations[8]).toMatchObject({
      name: 'station.local',
      binding: 'local',
      declarationExported: false,
      description: null,
      unit: '',
    });
  });

  it.each([
    ['meter.createCounter(name)', 'Instrument name must be a string literal'],
    [
      `meter.createCounter(\`station.\${suffix}\`)`,
      'Instrument name must be a string literal',
    ],
    ["meter.createCounter('')", 'Instrument name must not be empty'],
    ["meter.createCounter('x', options)", 'options must be an object literal'],
    [
      "meter.createCounter('x', {description: description})",
      'Instrument description must be a string literal',
    ],
    [
      "meter.createCounter('x', {unit: units})",
      'Instrument unit must be a string literal',
    ],
    [
      "meter.createCounter('x', {...options})",
      'Unsupported instrument metadata',
    ],
    [
      "meter.createCounter('x', {[key]: 'value'})",
      'Unsupported instrument metadata',
    ],
    [
      "meter.createCounter('x', {description})",
      'Unsupported instrument metadata',
    ],
    [
      "meter.createCounter('x', {advice: {}})",
      "Unsupported instrument option 'advice'",
    ],
    [
      "meter.createCounter('x', {unit: 'ms', unit: 's'})",
      "Duplicate instrument option 'unit'",
    ],
    [
      "meter.createCounter('x', {}, extra)",
      'requires a literal name and optional literal options',
    ],
    [
      'meter.createCounter()',
      'requires a literal name and optional literal options',
    ],
    [
      "const create = meter.createCounter; create('x')",
      'Instrument factory references are unsupported',
    ],
    [
      "const other = meter; other.createCounter('x')",
      'aliases are unsupported',
    ],
    [
      "meter.createCounter('valid'); const other = meter; other[factory](dynamicName)",
      'aliases are unsupported',
    ],
    [
      "meter.createCounter('valid'); registerHiddenDeclarations(meter)",
      'escaping references',
    ],
    ["meter[factory]('x')", 'Dynamic meter member access is unsupported'],
    [
      "meter.createFutureInstrument('x')",
      "Unsupported instrument factory 'createFutureInstrument'",
    ],
    [
      "meter.createCounter('x'); meter.createHistogram('x')",
      "Duplicate instrument name 'x'",
    ],
  ])('refuses unsupported or ambiguous declarations: %s', (body, error) => {
    expect(() => parseMetricDeclarations(prelude + body)).toThrow(error);
    expect(() => parseMetricDeclarations(prelude + body)).toThrow(
      `${sourcePath}:3:`,
    );
  });

  it('rejects missing declarations and TypeScript parse errors', () => {
    expect(() => parseMetricDeclarations(prelude)).toThrow(
      'no metric instrument declarations found',
    );
    expect(() => parseMetricDeclarations(`${prelude}const = ;`)).toThrow(
      `${sourcePath}:3:`,
    );
  });

  it('renders declared metadata safely and distinguishes absence from an empty string', () => {
    const output = renderMetricReference(
      prelude +
        `
export const declared = meter.createCounter('station.a', {description: '<tag>|[link]\\nnext', unit: ''});
meter.createGauge('station.b');
`,
    );
    expect(output).toContain('&lt;tag&gt;&#124;\\[link\\]\\\\nnext');
    expect(output).toContain('| "" |');
    expect(output).toContain('| not declared | not declared |');
    expect(output).toContain(`../../${sourcePath}#L4`);
    expect(output).toContain(
      'do **not** establish producers, live collection, correct labels, observed units or billing accuracy',
    );
    expect(output).toContain('../guides/monitoring.md');
  });

  it.each([
    "function register(m) { m['create' + 'Counter']('station.hidden'); } register(metrics.getMeter('station'));",
    "const get = metrics.getMeter.bind(metrics); const hidden = get('station'); hidden['create' + 'Counter']('station.hidden');",
    "const api = metrics; api['get' + 'Meter']('station').createCounter('station.hidden');",
    "const { getMeter } = metrics; getMeter('station')['create' + 'Counter']('station.hidden');",
    "metrics.getMeter('station')['create' + 'Counter']('station.hidden');",
    "const get = metrics['get' + 'Meter'];",
    "const api = await import('@opentelemetry/api');",
    'export { metrics };',
    "export * from './hidden.js';",
    "export { hidden } from './hidden.js';",
    "export * as hidden from './hidden.js';",
  ])('refuses API roots that escape the declaration grammar: %s', (body) => {
    expect(() =>
      parseMetricDeclarations(
        `${prelude}meter.createCounter('station.visible');\n${body}`,
      ),
    ).toThrow(/unsupported|must initialize|may only be used/);
  });

  it.each([
    "import { metrics as other } from '@opentelemetry/api';",
    "import * as api from '@opentelemetry/api';",
    "import { makeMeter } from './hidden.js';",
  ])(
    'refuses other runtime imports rather than silently skipping ownership: %s',
    (statement) => {
      expect(() =>
        parseMetricDeclarations(
          `${statement}\n${prelude}meter.createCounter('station.visible');`,
        ),
      ).toThrow(/Unsupported/);
    },
  );

  it('preserves literal string contents through the actual learning Markdown renderer', () => {
    const description =
      'first\nsecond | <tag> ~~literal~~ \\n "quote" `code` &nbsp;\r\t';
    const output = renderMetricReference(
      `${prelude}meter.createCounter('station.render', {description: ${JSON.stringify(description)}, unit: ''});`,
    );
    const rendered = renderLearningDocument(
      output,
      outputPath,
      new Set([outputPath, 'docs/guides/monitoring.md']),
      'fixture',
      new Set([sourcePath]),
    );
    // Vitest supplies jsdom; keep the scripts compiler's Node-only library scope.
    const browser = globalThis as typeof globalThis & {
      DOMParser: new () => {
        parseFromString(
          html: string,
          type: 'text/html',
        ): {
          querySelectorAll(
            selector: string,
          ): ArrayLike<{ textContent: string | null }>;
          querySelector(selector: string): unknown;
        };
      };
    };
    expect(typeof browser.DOMParser).toBe('function');
    const document = new browser.DOMParser().parseFromString(
      rendered.html,
      'text/html',
    );
    const cells = document.querySelectorAll('tbody tr:first-child td');
    expect(cells).toHaveLength(6);
    expect(cells[3].textContent).toBe(JSON.stringify(description));
    expect(JSON.parse(cells[3].textContent!)).toBe(description);
    expect(cells[4].textContent).toBe('""');
    expect(document.querySelector('del')).toBeNull();
  });

  for (const kind of [
    'input-leaf',
    'input-ancestor',
    'output-leaf',
    'output-ancestor',
  ] as const) {
    // Windows file symlinks need privileges; directory junction cases still run there.
    it.skipIf(process.platform === 'win32' && kind.endsWith('leaf'))(
      `refuses ${kind} symlinks through default CLI paths and preserves existing bytes`,
      () => {
        const fixtureRoot = cliFixture();
        const outside = makeTempDir('station-metric-outside-');
        expect(defaultCli(fixtureRoot).status).toBe(0);
        const sourceFile = path.join(fixtureRoot, sourcePath);
        const artifact = path.join(fixtureRoot, outputPath);
        const sourceBytes = readFileSync(sourceFile);
        const artifactBytes = readFileSync(artifact);
        const input = kind.startsWith('input');
        const leaf = kind.endsWith('leaf');
        const target = input ? sourceFile : artifact;
        const linked = leaf ? target : path.dirname(target);
        const outsideFile = path.join(
          outside,
          `metrics.${input ? 'ts' : 'md'}`,
        );
        const outsideBytes = Buffer.from(
          input
            ? `${prelude}meter.createCounter('station.outside'); // CONTROLLED_OUTSIDE\n`
            : 'CONTROLLED_OUTSIDE\n',
        );
        writeFileSync(outsideFile, outsideBytes);
        renameSync(linked, `${linked}.saved`);
        try {
          symlinkSync(
            leaf ? outsideFile : outside,
            linked,
            leaf ? 'file' : 'junction',
          );
          for (const args of [[], ['--check']]) {
            const result = defaultCli(fixtureRoot, ...args);
            expect(result.status).toBe(1);
            expect(result.stderr).toMatch(
              /symlink|symbolic link|real directory/i,
            );
            expect(readFileSync(outsideFile)).toEqual(outsideBytes);
          }
        } finally {
          unlinkSync(linked);
          renameSync(`${linked}.saved`, linked);
        }
        expect(readFileSync(sourceFile)).toEqual(sourceBytes);
        expect(readFileSync(artifact)).toEqual(artifactBytes);
        expect(defaultCli(fixtureRoot, '--check').status).toBe(0);
      },
    );
  }

  it('rejects malformed source UTF-8 without replacing an artifact and preserves BOM bytes in its hash', () => {
    const fixtureRoot = cliFixture();
    expect(defaultCli(fixtureRoot).status).toBe(0);
    const artifact = path.join(fixtureRoot, outputPath);
    const before = readFileSync(artifact);
    const sourceFile = path.join(fixtureRoot, sourcePath);
    const valid = readFileSync(sourceFile);
    writeFileSync(
      sourceFile,
      Buffer.concat([valid, Buffer.from('// malformed '), Buffer.from([0xff])]),
    );
    for (const args of [[], ['--check']]) {
      const result = defaultCli(fixtureRoot, ...args);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('not valid UTF-8');
      expect(readFileSync(artifact)).toEqual(before);
    }
    writeFileSync(
      sourceFile,
      Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), valid]),
    );
    expect(defaultCli(fixtureRoot).status).toBe(0);
    expect(defaultCli(fixtureRoot, '--check').status).toBe(0);
    expect(readFileSync(artifact, 'utf8')).toContain(
      createHash('sha256').update(readFileSync(sourceFile)).digest('hex'),
    );
  });

  it('allows an explicit root alias while refusing nonportable output coordinates', () => {
    const fixtureRoot = cliFixture();
    const aliasParent = makeTempDir('station-metric-root-alias-');
    const alias = path.join(aliasParent, 'checkout');
    symlinkSync(fixtureRoot, alias, 'junction');
    expect(cli(alias).status).toBe(0);
    expect(cli(alias, '--check').status).toBe(0);
    const before = readFileSync(path.join(fixtureRoot, outputPath));
    for (const coordinate of [
      '../outside.md',
      '/outside.md',
      'docs\\outside.md',
      'C:outside.md',
      'docs/./outside.md',
      'docs//outside.md',
    ]) {
      expect(() =>
        publishMetricReference(fixtureRoot, coordinate, 'replacement'),
      ).toThrow('Unsafe metric reference output');
    }
    expect(readFileSync(path.join(fixtureRoot, outputPath))).toEqual(before);
  });

  it('matches every creation call in the live source and its checked-in reference', () => {
    const source = readFileSync(path.join(root, sourcePath), 'utf8');
    const file = ts.createSourceFile(
      sourcePath,
      source,
      ts.ScriptTarget.Latest,
      true,
    );
    const creationNames: string[] = [];
    function visit(node: ts.Node) {
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text.startsWith('create')
      ) {
        const name = node.arguments[0];
        expect(ts.isStringLiteralLike(name)).toBe(true);
        if (ts.isStringLiteralLike(name)) creationNames.push(name.text);
      }
      ts.forEachChild(node, visit);
    }
    visit(file);
    expect(creationNames.length).toBeGreaterThan(250);
    expect(parseMetricDeclarations(source).map((entry) => entry.name)).toEqual(
      creationNames,
    );
    expect(readFileSync(path.join(root, outputPath), 'utf8')).toBe(
      renderMetricReference(source),
    );
    expect(cli(root, '--check').status).toBe(0);
  });

  it('proves missing, stale, changed-source and invalid-source failures through the CLI', () => {
    const fixtureRoot = makeTempDir('station-metric-reference-');
    const sourceFile = path.join(fixtureRoot, sourcePath);
    const outputFile = path.join(fixtureRoot, outputPath);
    mkdirSync(path.dirname(sourceFile), { recursive: true });
    const baselineSource = `${prelude}export const counter = meter.createCounter('station.test');\n`;
    const missingSource = cli(fixtureRoot, '--check');
    expect(missingSource.status).toBe(1);
    expect(missingSource.stderr).toContain('ENOENT');
    expect(existsSync(outputFile)).toBe(false);
    writeFileSync(sourceFile, baselineSource);
    const missing = cli(fixtureRoot, '--check');
    expect(missing.status).toBe(1);
    expect(missing.stderr).toContain('is missing');
    expect(existsSync(outputFile)).toBe(false);
    expect(cli(fixtureRoot).status).toBe(0);
    const baselineBytes = readFileSync(outputFile);
    expect(cli(fixtureRoot, '--check').status).toBe(0);
    writeFileSync(
      outputFile,
      Buffer.concat([baselineBytes, Buffer.from('stale\n')]),
    );
    const changedBytes = readFileSync(outputFile);
    const stale = cli(fixtureRoot, '--check');
    expect(stale.status).toBe(1);
    expect(stale.stderr).toContain('is stale');
    expect(readFileSync(outputFile)).toEqual(changedBytes);
    expect(cli(fixtureRoot).status).toBe(0);
    expect(readFileSync(outputFile)).toEqual(baselineBytes);
    writeFileSync(
      sourceFile,
      `${baselineSource}meter.createHistogram('station.added', {unit: 's'});\n`,
    );
    expect(cli(fixtureRoot, '--check').status).toBe(1);
    expect(readFileSync(outputFile)).toEqual(baselineBytes);
    expect(cli(fixtureRoot).status).toBe(0);
    expect(cli(fixtureRoot, '--check').status).toBe(0);
    const expandedBytes = readFileSync(outputFile);
    expect(expandedBytes.equals(baselineBytes)).toBe(false);
    for (const invalid of [
      "meter.createCounter('station.test');",
      'meter.createCounter(dynamicName);',
    ]) {
      writeFileSync(sourceFile, baselineSource + invalid);
      const result = cli(fixtureRoot);
      expect(result.status).toBe(1);
      expect(result.stderr).toMatch(
        /Duplicate instrument name|must be a string literal/,
      );
      expect(readFileSync(outputFile)).toEqual(expandedBytes);
    }
  });

  it('runs the generation check and this test in the documentation lane', () => {
    const { scripts } = JSON.parse(
      readFileSync(path.join(root, 'package.json'), 'utf8'),
    );
    expect(scripts['docs:metrics:generate']).toBe(
      'node scripts/generate-metric-reference.mjs',
    );
    expect(scripts['docs:metrics:check']).toBe(
      'node scripts/generate-metric-reference.mjs --check',
    );
    expect(scripts['docs:foundations:test']).toContain(
      'scripts/__tests__/metric-reference.test.ts',
    );
    expect(DOCS_TRUTH_GATE_LANES).toContainEqual({
      id: 'docs:metrics:check',
      script: 'docs:metrics:check',
    });
  });
});
