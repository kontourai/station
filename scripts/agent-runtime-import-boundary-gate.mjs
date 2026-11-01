import { lstatSync, readFileSync } from 'node:fs';
import { isBuiltin } from 'node:module';
import { execFileSyncBounded } from './lib/bounded-capture.mjs';
import { invokedDirectly } from './lib/module-entry.mjs';
import {
  moduleReferences,
  packageNameOf,
  resolveRelative,
} from './monument-import-boundary-gate.mjs';

const root = 'packages/agent-runtime';
const approved = new Set([
  '@kontourai/monument',
  '@ai-sdk/provider',
  '@ai-sdk/provider-utils',
  '@voltagent/core',
  '@strands-agents/sdk',
  'zod',
  'ai',
]);
const forbidden = /^@kontourai\/station(?:-|$)/;
export function runtimeImportFindings(files, readText) {
  const manifest = JSON.parse(readText(`${root}/package.json`));
  const findings = [];
  const declared = new Set();
  for (const field of [
    'dependencies',
    'peerDependencies',
    'optionalDependencies',
    'devDependencies',
  ])
    for (const [name, version] of Object.entries(manifest[field] ?? {})) {
      if (
        !approved.has(name) ||
        forbidden.test(name) ||
        !/^\d+\.\d+\.\d+$/.test(version)
      )
        findings.push(`${field}.${name}`);
      else declared.add(name);
    }
  for (const file of files) {
    if (!/\.[cm]?[jt]sx?$/.test(file)) continue;
    for (const ref of moduleReferences(file, readText(file))) {
      const name = ref.specifier;
      const test = file.includes('/__tests__/');
      if (name?.startsWith('.')) {
        const path = resolveRelative(file, name);
        if (
          !path.startsWith(`${root}/`) ||
          /[%\\?#]|(^|\/)node_modules\//.test(name)
        )
          findings.push(`${file}:${ref.line} ${name}`);
      } else if (
        typeof name !== 'string' ||
        ref.how === 'module-loader' ||
        forbidden.test(name) ||
        !(
          declared.has(packageNameOf(name)) ||
          (test && name === 'vitest') ||
          (name.startsWith('node:') &&
            isBuiltin(name) &&
            (!['module', 'vm', 'child_process', 'worker_threads'].includes(
              name.slice(5),
            ) ||
              (test && name === 'node:child_process')))
        )
      )
        findings.push(`${file}:${ref.line} ${name}`);
    }
  }
  return findings;
}
export function stationRuntimeImportFindings(files, readText) {
  return files.flatMap((file) => {
    if (!/\.[cm]?[jt]sx?$/.test(file)) return [];
    return moduleReferences(file, readText(file)).flatMap((ref) => {
      const name = ref.specifier;
      if (typeof name !== 'string') return [];
      const internal =
        name.startsWith('@kontourai/agent-runtime/') ||
        (name.startsWith('.') &&
          resolveRelative(file, name).startsWith(`${root}/`));
      return internal ? [`${file}:${ref.line} ${name}`] : [];
    });
  });
}
export function checkRuntimeImports() {
  const files = execFileSyncBounded(
    'git',
    [
      'ls-files',
      '--cached',
      '--others',
      '--exclude-standard',
      '--',
      root,
      'src-server',
    ],
    { encoding: 'utf8', windowsHide: true },
  )
    .trim()
    .split('\n');
  if (!files.some((f) => f.endsWith('.ts')))
    throw new Error('Runtime boundary found no source');
  const runtimeFiles = files.filter((f) => f.startsWith(`${root}/`));
  const stationFiles = files.filter((f) => f.startsWith('src-server/'));
  const links = runtimeFiles.filter((f) => lstatSync(f).isSymbolicLink());
  const findings = [
    ...links,
    ...runtimeImportFindings(runtimeFiles, (f) => readFileSync(f, 'utf8')),
    ...stationRuntimeImportFindings(stationFiles, (f) =>
      readFileSync(f, 'utf8'),
    ),
  ];
  if (findings.length)
    throw new Error(`Runtime import boundary:\n${findings.join('\n')}`);
}
if (invokedDirectly(import.meta.url)) {
  checkRuntimeImports();
  console.log('Agent runtime import boundary passed.');
}
