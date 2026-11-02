import { lstatSync, readFileSync } from 'node:fs';
import { isBuiltin } from 'node:module';
import ts from 'typescript-api';
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
        (name.startsWith('@kontourai/agent-runtime/') &&
          name !== '@kontourai/agent-runtime/internal') ||
        (name.startsWith('.') &&
          resolveRelative(file, name).startsWith(`${root}/`));
      return internal ? [`${file}:${ref.line} ${name}`] : [];
    });
  });
}
/** Raw native tool bodies must remain inside the journal execution port. */
export function durableToolBoundaryFindings(files, readText) {
  return files.flatMap((file) => {
    if (
      !/src-server\/runtime\/frameworks\/(voltagent-adapter|strands-tool-loader)\.ts$/.test(
        file,
      )
    )
      return [];
    const source = ts.createSourceFile(
      file,
      readText(file),
      ts.ScriptTarget.Latest,
      true,
    );
    const findings = [];
    const unwrap = (node) =>
      ts.isNonNullExpression(node) || ts.isParenthesizedExpression(node)
        ? unwrap(node.expression)
        : node;
    const bindings = [];
    const collect = (node) => {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name))
        bindings.push({
          name: node.name.text,
          scope: node.parent.parent.parent,
          initializer: node.initializer,
        });
      ts.forEachChild(node, collect);
    };
    collect(source);
    const toolAlias = (name, at) => {
      for (let scope = at.parent; scope; scope = scope.parent) {
        const binding = bindings.find(
          (value) => value.scope === scope && value.name === name,
        );
        if (!binding) continue;
        const initializer = binding.initializer && unwrap(binding.initializer);
        return (
          !!initializer &&
          ts.isPropertyAccessExpression(initializer) &&
          initializer.name.text === 'execute'
        );
      }
      return false;
    };
    const visit = (node) => {
      if (ts.isCallExpression(node)) {
        const target = unwrap(node.expression);
        const raw =
          (ts.isPropertyAccessExpression(target) &&
            target.name.text === 'execute') ||
          (ts.isIdentifier(target) && toolAlias(target.text, node)) ||
          (target.getText(source) === 'Reflect.apply' &&
            node.arguments[0] &&
            toolAlias(node.arguments[0].getText(source), node));
        if (raw) {
          let parent = node.parent;
          while (
            parent &&
            !(
              ts.isCallExpression(parent) &&
              parent.expression.getText(source) === 'executeDurableTool'
            )
          )
            parent = parent.parent;
          if (!parent)
            findings.push(
              `${file}:${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1} unjournaled native tool body`,
            );
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
    return findings;
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
    ...durableToolBoundaryFindings(stationFiles, (f) =>
      readFileSync(f, 'utf8'),
    ),
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
