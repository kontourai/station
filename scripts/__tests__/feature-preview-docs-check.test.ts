import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { trackTempDirs } from '../../src-server/__test-utils__/temp-dirs.js';
import { spawnSyncBounded } from '../lib/bounded-capture.mjs';

const root = resolve(import.meta.dirname, '../..');
const script = join(root, 'scripts/feature-preview-docs-check.mjs');
const registry =
  'src-server/services/feature-previews/feature-preview-registry.ts';
const makeTempDir = trackTempDirs();

function run(directory: string) {
  const result = spawnSyncBounded(process.execPath, [script, directory], {
    cwd: directory,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 30_000,
  });
  expect(result.error).toBeUndefined();
  expect(result.signal).toBeNull();
  return { status: result.status, output: result.stdout + result.stderr };
}

function fixture(source: string, ids = ['example-preview']) {
  const directory = makeTempDir('station-preview-docs-');
  const write = (path: string, content: string) => {
    mkdirSync(dirname(join(directory, path)), { recursive: true });
    writeFileSync(join(directory, path), content);
  };
  mkdirSync(dirname(join(directory, registry)), { recursive: true });
  copyFileSync(join(root, registry), join(directory, registry));
  write('src-server/consumer.ts', source);
  write(
    'docs/user/settings.md',
    [
      '## Feature previews',
      '',
      '| ID | Name | What turning it on does | Notable cost/risk |',
      '| --- | --- | --- | --- |',
      ...ids.map(
        (id) =>
          `| \`${id}\` | Example | Enables work. | May spend resources. |`,
      ),
      '',
      '## Other settings',
      '| `outside-section` | Other | Other | Other |',
    ].join('\n'),
  );
  return directory;
}

const importRegistry = `import { FeaturePreviewRegistry as Registry } from './services/feature-previews/feature-preview-registry.js';`;
const binding = `${importRegistry}
const featurePreviews = new Registry('/unused', {} as never);
featurePreviews.bind({ id: 'example-preview', label: 'Example', description: 'Example' });`;

describe('feature preview documentation CLI', () => {
  it('checks the actual server bindings against the user table', () => {
    const result = run(root);
    expect(result.status, result.output).toBe(0);
    expect(result.output).toMatch(
      /Feature preview docs match \d+ bound preview/,
    );
  });

  it('follows registry aliases and typed consumers, ignoring unrelated binds and test fixtures', () => {
    const directory = fixture(
      `${importRegistry}
      const renamed = new Registry('/unused', {} as never);
      const alias = renamed;
      alias /* multi-line binding */ .bind({
        description: 'Example', ['id']: "example-preview", label: 'Example',
      } satisfies Parameters<Registry['bind']>[0]);
      function compose(previews: Registry) {
        previews['bind'](({ id: 'second-preview', label: 'Second', description: 'Second' }));
      }
      function unrelated() {}
      unrelated.bind({ id: dynamicValue });
      const other = { bind(value: unknown) {} };
      other.bind({ id: 'unrelated-preview' });
      // renamed.bind({ id: 'comment-preview' });
      const text = "renamed.bind({ id: 'string-preview' })";
    `,
      ['example-preview', 'second-preview'],
    );
    writeFileSync(
      join(directory, 'src-server/example.test.ts'),
      binding.replace('example-preview', 'fixture-preview'),
    );
    const result = run(directory);
    expect(result.status, result.output).toBe(0);
    expect(result.output).toContain('match 2 bound preview(s)');
  });

  it.each([
    { ids: [], message: "Missing preview row 'example-preview'" },
    {
      ids: ['example-preview', 'retired-preview'],
      message: "Stale preview row 'retired-preview'",
    },
  ])('rejects documentation drift: $message', ({ ids, message }) => {
    const result = run(fixture(binding, ids));
    expect(result.status).toBe(1);
    expect(result.output).toContain(message);
    expect(result.output).toContain('docs/user/settings.md');
  });

  it.each([
    {
      definition: `{ label: 'Missing id' }`,
      message: 'id must be exactly one string literal',
    },
    {
      definition: `{ id: dynamicId }`,
      message: 'id must be exactly one string literal',
    },
    { definition: `{ id }`, message: 'id must be exactly one string literal' },
    {
      definition: `{ id: 'one', id: 'two' }`,
      message: 'id must be exactly one string literal',
    },
    {
      definition: `{ ...definition, id: 'example-preview' }`,
      message: 'cannot use spreads',
    },
    {
      definition: `{ id: 'example-preview', [dynamicKey]: 'override' }`,
      message: 'cannot use computed properties',
    },
    { definition: 'definition', message: 'must use an inline object' },
  ])('refuses uninspectable binding $definition', ({ definition, message }) => {
    const source = `${importRegistry}
      function compose(previews: Registry) { previews.bind(${definition}); }`;
    const result = run(fixture(source));
    expect(result.status).toBe(1);
    expect(result.output).toContain('src-server/consumer.ts:');
    expect(result.output).toContain(message);
  });

  it('fails closed on broken source syntax and a missing table', () => {
    const directory = fixture(`${binding}\nconst broken = (`);
    const broken = run(directory);
    expect(broken.status).toBe(1);
    expect(broken.output).toContain('src-server/consumer.ts:');
    expect(broken.output).toContain('Expression expected');
    writeFileSync(join(directory, 'src-server/consumer.ts'), binding);
    writeFileSync(
      join(directory, 'docs/user/settings.md'),
      '## Feature previews\nNo table.\n',
    );
    const missing = run(directory);
    expect(missing.status).toBe(1);
    expect(missing.output).toContain(
      'missing four-column offered previews table',
    );
  });
});
