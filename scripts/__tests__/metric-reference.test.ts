import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { trackTempDirs } from '../../src-server/__test-utils__/temp-dirs';
import { DOCS_TRUTH_GATE_LANES } from '../docs-truth-gate-aggregate.mjs';
import {
  parseMetricDeclarations,
  renderMetricReference,
} from '../generate-metric-reference.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const script = path.join(root, 'scripts/generate-metric-reference.mjs');
const sourcePath = 'src-server/telemetry/metrics.ts';
const outputPath = 'docs/reference/metrics.md';
const prelude = "const meter = metrics.getMeter('station');\n";
const makeTempDir = trackTempDirs();

function cli(fixtureRoot: string, ...args: string[]) {
  const result = spawnSync(
    process.execPath,
    [script, `--root=${fixtureRoot}`, ...args],
    {
      cwd: fixtureRoot,
      encoding: 'utf8',
      windowsHide: true,
      timeout: 15_000,
      maxBuffer: 128 * 1024,
    },
  );
  expect(result.error).toBeUndefined();
  expect(result.signal).toBeNull();
  return result;
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
        line: index + 2,
      })),
    );
    expect(declarations[7]).toMatchObject({
      name: 'station.callback',
      binding: null,
      container: 'register',
      description: null,
      unit: null,
      line: 10,
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
      `${sourcePath}:2:`,
    );
  });

  it('rejects missing declarations and TypeScript parse errors', () => {
    expect(() => parseMetricDeclarations(prelude)).toThrow(
      'no metric instrument declarations found',
    );
    expect(() => parseMetricDeclarations(`${prelude}const = ;`)).toThrow(
      `${sourcePath}:2:`,
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
    expect(output).toContain('&lt;tag&gt;&#124;\\[link\\]<br>next');
    expect(output).toContain('| (empty string) |');
    expect(output).toContain('| not declared | not declared |');
    expect(output).toContain(`../../${sourcePath}#L3`);
    expect(output).toContain(
      'do **not** establish producers, live collection, correct labels, observed units or billing accuracy',
    );
    expect(output).toContain('../guides/monitoring.md');
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
