import { execFile } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { trackTempDirs } from '../../src-server/__test-utils__/temp-dirs.js';
import { stageDesktopServerRuntime } from '../lib/desktop-server-runtime.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const makeTempDir = trackTempDirs();
const execFileAsync = promisify(execFile);

function writeFixturePackage(
  path: string,
  manifest: Record<string, unknown>,
  files: Record<string, string> = {},
) {
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, 'package.json'), JSON.stringify(manifest));
  for (const [file, content] of Object.entries(files)) {
    mkdirSync(dirname(join(path, file)), { recursive: true });
    writeFileSync(join(path, file), content);
  }
}

describe('desktop runtime pruning', () => {
  it('keeps installed stable and incubating semantic conventions identical through Node import and require', async () => {
    const output = join(makeTempDir('station-runtime-semconv-'), 'release');
    stageDesktopServerRuntime({
      projectRoot: repoRoot,
      outputRoot: output,
      packages: ['@opentelemetry/semantic-conventions'],
    });
    const probe = await execFileAsync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `import { createRequire } from 'node:module';
import * as stable from '@opentelemetry/semantic-conventions';
import * as incubating from '@opentelemetry/semantic-conventions/incubating';
const require = createRequire(import.meta.url);
console.log(JSON.stringify({
  service: stable.ATTR_SERVICE_NAME,
  model: incubating.ATTR_GEN_AI_REQUEST_MODEL,
  stableIdentity: stable.default === require('@opentelemetry/semantic-conventions'),
  incubatingIdentity: incubating.default === require('@opentelemetry/semantic-conventions/incubating'),
}));`,
      ],
      { cwd: output, windowsHide: true, timeout: 10_000 },
    );
    expect(JSON.parse(probe.stdout)).toEqual({
      service: 'service.name',
      model: 'gen_ai.request.model',
      stableIdentity: true,
      incubatingIdentity: true,
    });
    const staged = join(
      output,
      'node_modules/@opentelemetry/semantic-conventions',
    );
    expect(existsSync(join(staged, 'build/src/index.js'))).toBe(true);
    expect(existsSync(join(staged, 'build/src/index-incubating.js'))).toBe(
      true,
    );
    expect(readFileSync(join(staged, 'LICENSE'), 'utf8')).toContain(
      'Apache License',
    );
    expect(existsSync(join(staged, 'build/esm'))).toBe(false);
    expect(existsSync(join(staged, 'build/esnext'))).toBe(false);
  });

  it('scopes semantic-convention distribution pruning to the reviewed package', () => {
    const project = makeTempDir('station-runtime-semconv-scope-');
    const names = [
      '@opentelemetry/semantic-conventions',
      'other-semantic-conventions',
    ];
    for (const name of names) {
      writeFixturePackage(
        join(project, 'node_modules', name),
        {
          name,
          version: '1.0.0',
          main: 'build/src/index.js',
          exports: {
            '.': {
              module: './build/esm/index.js',
              default: './build/src/index.js',
            },
            './incubating': {
              esnext: './build/esnext/index-incubating.js',
              default: './build/src/index-incubating.js',
            },
          },
        },
        {
          'build/src/index.js': 'node implementation',
          'build/src/index-incubating.js': 'node incubating implementation',
          'build/esm/index.js': 'bundler implementation',
          'build/esnext/index-incubating.js': 'esnext implementation',
          LICENSE: 'license',
        },
      );
    }
    const output = join(project, 'release');
    stageDesktopServerRuntime({
      projectRoot: project,
      outputRoot: output,
      packages: names,
    });
    for (const name of names) {
      const staged = join(output, 'node_modules', name);
      expect(existsSync(join(staged, 'build/src/index.js'))).toBe(true);
      expect(existsSync(join(staged, 'build/src/index-incubating.js'))).toBe(
        true,
      );
      expect(existsSync(join(staged, 'LICENSE'))).toBe(true);
      const retained = name === 'other-semantic-conventions';
      expect(existsSync(join(staged, 'build/esm'))).toBe(retained);
      expect(existsSync(join(staged, 'build/esnext'))).toBe(retained);
    }
  });

  it.each(['import', 'require', 'node', 'module-sync', 'default'])(
    'retains semantic-convention variants when %s selects a new Node entry',
    async (condition) => {
      const project = makeTempDir('station-runtime-semconv-condition-');
      writeFixturePackage(
        join(project, 'node_modules/@opentelemetry/semantic-conventions'),
        {
          name: '@opentelemetry/semantic-conventions',
          version: '2.0.0',
          main: 'build/src/index.js',
          exports: {
            '.': {
              [condition]: './build/esm/index.js',
              ...(condition === 'default'
                ? {}
                : { default: './build/src/index.js' }),
            },
            './incubating': { default: './build/src/index-incubating.js' },
          },
        },
        {
          'build/src/index.js': "exports.runtime = 'node-cjs';",
          'build/src/index-incubating.js':
            "exports.runtime = 'incubating-cjs';",
          'build/esm/package.json': '{"type":"module"}',
          'build/esm/index.js': "export const runtime = 'node-esm';",
          'build/esnext/index.js': 'future variant',
          LICENSE: 'license',
        },
      );
      const output = join(project, 'release');
      stageDesktopServerRuntime({
        projectRoot: project,
        outputRoot: output,
        packages: ['@opentelemetry/semantic-conventions'],
      });
      const staged = join(
        output,
        'node_modules/@opentelemetry/semantic-conventions',
      );
      expect(existsSync(join(staged, 'build/esm/index.js'))).toBe(true);
      expect(existsSync(join(staged, 'build/esnext/index.js'))).toBe(true);
      if (condition === 'import' || condition === 'default') {
        const probe = await execFileAsync(
          process.execPath,
          [
            '--input-type=module',
            '-e',
            "import { runtime } from '@opentelemetry/semantic-conventions'; console.log(runtime);",
          ],
          { cwd: output, windowsHide: true, timeout: 10_000 },
        );
        expect(probe.stdout.trim()).toBe('node-esm');
      }
    },
  );

  it('keeps the installed OTLP Node serializers usable through import and require', async () => {
    const output = join(makeTempDir('station-runtime-otlp-'), 'release');
    stageDesktopServerRuntime({
      projectRoot: repoRoot,
      outputRoot: output,
      packages: ['@opentelemetry/otlp-transformer'],
    });
    const probe = await execFileAsync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `import { createRequire } from 'node:module';
import { JsonTraceSerializer, ProtobufTraceSerializer } from '@opentelemetry/otlp-transformer';
const require = createRequire(import.meta.url);
const span = {
  name: 'staged-runtime-span', kind: 0,
  spanContext: () => ({traceId: '0123456789abcdef0123456789abcdef', spanId: '0123456789abcdef', traceFlags: 1}),
  resource: {attributes: {'service.name': 'staged-runtime'}},
  instrumentationScope: {name: 'staging-probe'},
  startTime: [1, 0], endTime: [2, 0], duration: [1, 0], ended: true, status: {code: 0},
  attributes: {probe: true}, events: [], links: [],
  droppedAttributesCount: 0, droppedEventsCount: 0, droppedLinksCount: 0,
};
const request = JSON.parse(new TextDecoder().decode(JsonTraceSerializer.serializeRequest([span])));
console.log(JSON.stringify({
  name: request.resourceSpans[0].scopeSpans[0].spans[0].name,
  protobufHasData: ProtobufTraceSerializer.serializeRequest([span]).length > 0,
  sharedIdentity: JsonTraceSerializer === require('@opentelemetry/otlp-transformer').JsonTraceSerializer,
}));`,
      ],
      { cwd: output, windowsHide: true, timeout: 10_000 },
    );
    expect(JSON.parse(probe.stdout)).toEqual({
      name: 'staged-runtime-span',
      protobufHasData: true,
      sharedIdentity: true,
    });
    const transformer = join(
      output,
      'node_modules/@opentelemetry/otlp-transformer',
    );
    expect(existsSync(join(transformer, 'build/src/index.js'))).toBe(true);
    expect(readFileSync(join(transformer, 'LICENSE'), 'utf8')).toContain(
      'Apache License',
    );
    expect(existsSync(join(transformer, 'build/esm'))).toBe(false);
    expect(existsSync(join(transformer, 'build/esnext'))).toBe(false);
  });

  it('scopes alternate OTLP distribution removal to that package', () => {
    const project = makeTempDir('station-runtime-otlp-scope-');
    for (const name of ['@opentelemetry/otlp-transformer', 'other-telemetry']) {
      writeFixturePackage(
        join(project, 'node_modules', name),
        { name, version: '1.0.0' },
        {
          'build/src/index.js': 'node implementation',
          'build/esm/index.js': 'module implementation',
          'build/esnext/index.js': 'esnext implementation',
          LICENSE: 'license',
        },
      );
    }
    const output = join(project, 'release');
    stageDesktopServerRuntime({
      projectRoot: project,
      outputRoot: output,
      packages: ['@opentelemetry/otlp-transformer', 'other-telemetry'],
    });
    for (const name of ['@opentelemetry/otlp-transformer', 'other-telemetry']) {
      expect(
        existsSync(join(output, 'node_modules', name, 'build/src/index.js')),
      ).toBe(true);
      expect(existsSync(join(output, 'node_modules', name, 'LICENSE'))).toBe(
        true,
      );
    }
    expect(
      existsSync(
        join(output, 'node_modules/other-telemetry/build/esm/index.js'),
      ),
    ).toBe(true);
    expect(
      existsSync(
        join(output, 'node_modules/other-telemetry/build/esnext/index.js'),
      ),
    ).toBe(true);
  });

  it('stages the installed RxJS Node exports without browser builds or TypeScript sources', async () => {
    const output = join(makeTempDir('station-runtime-rxjs-'), 'release');
    stageDesktopServerRuntime({
      projectRoot: repoRoot,
      outputRoot: output,
      packages: ['rxjs'],
    });
    const probe = await execFileAsync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `import { createRequire } from 'node:module';
import { of, lastValueFrom } from 'rxjs';
import { map, toArray } from 'rxjs/operators';
const require = createRequire(import.meta.url);
const { TestScheduler } = require('rxjs/testing');
const { Observable } = require('rxjs/internal/Observable');
const scheduler = new TestScheduler((actual, expected) => {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error('marbles differ');
});
scheduler.run(({cold, expectObservable}) => {
  expectObservable(cold('-a|', {a: 3}).pipe(map(x => x * 2))).toBe('-b|', {b: 6});
});
console.log(JSON.stringify({values: await lastValueFrom(of(1, 2, 3).pipe(map(x => x * 2), toArray())), sharedIdentity: Observable === require('rxjs').Observable}));`,
      ],
      { cwd: output, windowsHide: true, timeout: 10_000 },
    );
    expect(JSON.parse(probe.stdout)).toEqual({
      values: [2, 4, 6],
      sharedIdentity: true,
    });
    const rxjs = join(output, 'node_modules/rxjs');
    expect(readFileSync(join(rxjs, 'LICENSE.txt'), 'utf8')).toContain(
      'Apache License',
    );
    for (const omitted of ['src', 'dist/esm', 'dist/esm5', 'dist/bundles'])
      expect(existsSync(join(rxjs, omitted))).toBe(false);
  });

  it.each([
    ['win32', 'x64'],
    ['linux', 'x64'],
    ['linux', 'arm64'],
    ['darwin', 'arm64'],
  ] as const)(
    'keeps every %s node-pty architecture (%s staging) and excludes other operating systems',
    (platform, arch) => {
      const root = makeTempDir('station-runtime-pty-');
      const project = join(root, 'project');
      const files: Record<string, string> = {
        'lib/utils.js': 'module.exports = {};',
        'build/Release/pty.node': 'source build',
        LICENSE: 'MIT',
      };
      for (const prebuild of [
        'darwin-arm64',
        'darwin-x64',
        'linux-arm64',
        'linux-x64',
        'win32-arm64',
        'win32-x64',
      ]) {
        files[`prebuilds/${prebuild}/pty.node`] = prebuild;
      }
      writeFixturePackage(
        join(project, 'node_modules/node-pty'),
        { name: 'node-pty', version: '1.1.0' },
        files,
      );
      // A different package with the same layout is not node-pty's to prune.
      writeFixturePackage(
        join(project, 'node_modules/other-native'),
        { name: 'other-native', version: '1.0.0' },
        { 'prebuilds/darwin-x64/addon.node': 'other' },
      );
      const output = join(root, `release-${platform}-${arch}`);
      stageDesktopServerRuntime({
        projectRoot: project,
        outputRoot: output,
        packages: ['node-pty', 'other-native'],
        platform,
        arch,
      });
      const pty = join(output, 'node_modules/node-pty');
      const kept = readdirSync(join(pty, 'prebuilds')).sort();
      expect(kept).toEqual([`${platform}-arm64`, `${platform}-x64`]);
      for (const prebuild of kept)
        expect(
          readFileSync(join(pty, 'prebuilds', prebuild, 'pty.node'), 'utf8'),
        ).toBe(prebuild);
      expect(existsSync(join(pty, 'build/Release/pty.node'))).toBe(true);
      expect(existsSync(join(pty, 'lib/utils.js'))).toBe(true);
      expect(existsSync(join(pty, 'LICENSE'))).toBe(true);
      expect(
        existsSync(
          join(
            output,
            'node_modules/other-native/prebuilds/darwin-x64/addon.node',
          ),
        ),
      ).toBe(true);
    },
  );
});
