/**
 * Verify the dependency tree that Node will actually resolve from every npm
 * workspace. A root-only inventory is insufficient: npm may intentionally
 * retain a different version under a workspace, and copying only the root
 * node_modules leaves a plausible-but-wrong graph behind.
 *
 * This deliberately reads `node_modules/<name>/package.json` by path instead
 * of resolving `<name>/package.json`: packages may export their entry point
 * while blocking package.json through `exports`.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { toPosixPath } from './posix-path.mjs';

const require = createRequire(import.meta.url);

const DEPENDENCY_SECTIONS = Object.freeze([
  ['dependencies', false],
  ['devDependencies', false],
  ['optionalDependencies', true],
]);

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function packagePath(name) {
  if (
    typeof name !== 'string' ||
    !/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/i.test(name)
  )
    throw new Error(`invalid dependency name ${JSON.stringify(name)}`);
  return name.split('/');
}

function isFile(path) {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/**
 * Node looks in a package's node_modules and then each parent. Stop at the
 * checkout root: dependencies from a surrounding unrelated checkout must not
 * make this repository's install look healthy.
 */
export function nearestInstalledManifest({ root, from, name }) {
  const checkout = resolve(root);
  let directory = resolve(from);
  const relativeFromRoot = relative(checkout, directory);
  if (
    relativeFromRoot === '..' ||
    relativeFromRoot.startsWith(`..${sep}`) ||
    (relativeFromRoot === '' && directory !== checkout)
  )
    throw new Error(`workspace ${directory} is outside checkout ${checkout}`);

  while (true) {
    const manifestPath = join(
      directory,
      'node_modules',
      ...packagePath(name),
      'package.json',
    );
    if (existsSync(manifestPath) && isFile(manifestPath)) return manifestPath;
    if (directory === checkout) return undefined;
    const parent = dirname(directory);
    if (parent === directory)
      throw new Error(`cannot walk from workspace ${from} to checkout ${root}`);
    directory = parent;
  }
}

/**
 * Registry ranges are verifiable with node-semver. Other npm protocols have
 * no registry-version contract here: workspace/file/link point at a local
 * target, while git, URLs, and tags need npm's full spec resolver. They are
 * still required to be installed; only range comparison is skipped.
 */
export function classifyDependencySpec(spec) {
  if (typeof spec !== 'string' || !spec.trim())
    return { kind: 'invalid', reason: 'empty dependency specification' };
  // The lifecycle bootstrap imports this module before `npm ci` has restored
  // node_modules. Require the normal package only when verification actually
  // runs, after that inert install has finished.
  const semver = require('semver');
  if (semver.validRange(spec, { loose: true }))
    return { kind: 'registry-range', range: spec };
  if (/^(?:workspace:|file:|link:)/.test(spec))
    return { kind: 'local-protocol', reason: 'local npm protocol' };
  const alias =
    /^npm:((?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*)(?:@(.*))?$/i.exec(
      spec,
    );
  if (alias)
    return {
      kind: 'npm-alias',
      targetName: alias[1],
      targetSpec: alias[2] || undefined,
    };
  if (/^(?:git\+|git:|github:|gitlab:|bitbucket:|https?:|ssh:)/.test(spec))
    return { kind: 'remote-protocol', reason: 'non-registry npm protocol' };
  if (/^[a-zA-Z][a-zA-Z0-9._-]*$/.test(spec))
    return { kind: 'tag', reason: 'registry tag has no semver range' };
  return {
    kind: 'invalid',
    reason: `unsupported dependency specification ${JSON.stringify(spec)}`,
  };
}

export function declaredDependencies(manifest) {
  const result = new Map();
  for (const [section, optional] of DEPENDENCY_SECTIONS) {
    const dependencies = manifest?.[section];
    if (dependencies === undefined) continue;
    if (!isRecord(dependencies))
      throw new Error(
        `${manifest?.name ?? '<workspace>'} has invalid ${section}`,
      );
    // npm gives optionalDependencies precedence over dependencies. Preserve
    // that rule rather than declaring an optional package mandatory here.
    for (const [name, spec] of Object.entries(dependencies))
      result.set(name, { name, spec, optional, section });
  }
  return [...result.values()].sort((left, right) =>
    left.name.localeCompare(right.name),
  );
}

export function workspaceManifestPaths(root, rootManifest = undefined) {
  const manifest = rootManifest ?? readJson(join(root, 'package.json'));
  const workspaceConfig = manifest.workspaces;
  const workspaces = Array.isArray(workspaceConfig)
    ? workspaceConfig
    : workspaceConfig?.packages;
  if (!Array.isArray(workspaces))
    throw new Error(
      'root package.json workspaces must be an array or { packages: array }',
    );
  if (
    workspaces.some(
      (workspace) => typeof workspace !== 'string' || /[*?[\]]/.test(workspace),
    )
  )
    throw new Error(
      'workspace dependency satisfaction does not support glob workspace paths',
    );
  return [
    join(root, 'package.json'),
    ...workspaces.map((workspace) => join(root, workspace, 'package.json')),
  ];
}

export function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

/**
 * @param {{ root: string; manifests?: string[] }} options
 */
export function findWorkspaceDependencyProblems({
  root,
  manifests = workspaceManifestPaths(root),
}) {
  const semver = require('semver');
  const checkout = resolve(root);
  const findings = [];
  for (const manifestPath of manifests) {
    const manifest = readJson(manifestPath);
    // Repo-relative identity: appears verbatim in findings that tests and
    // operators compare, so it must not carry a platform separator (#1093).
    const workspace =
      toPosixPath(relative(checkout, dirname(manifestPath))) || 'root';
    for (const dependency of declaredDependencies(manifest)) {
      const installedPath = nearestInstalledManifest({
        root: checkout,
        from: dirname(manifestPath),
        name: dependency.name,
      });
      if (!installedPath) {
        if (dependency.optional) continue;
        findings.push(
          `${workspace} → ${dependency.name}: missing (declared ${dependency.spec})`,
        );
        continue;
      }
      const installed = readJson(installedPath);
      const specification = classifyDependencySpec(dependency.spec);
      if (specification.kind === 'invalid') {
        findings.push(
          `${workspace} → ${dependency.name}: ${specification.reason}`,
        );
        continue;
      }
      const expectedName =
        specification.kind === 'npm-alias'
          ? specification.targetName
          : dependency.name;
      if (
        installed.name !== expectedName ||
        typeof installed.version !== 'string'
      ) {
        findings.push(
          `${workspace} → ${dependency.name}: invalid installed manifest at ${toPosixPath(relative(checkout, installedPath))}`,
        );
        continue;
      }
      if (
        specification.kind === 'registry-range' &&
        !semver.satisfies(installed.version, specification.range, {
          loose: true,
        })
      )
        findings.push(
          `${workspace} → ${dependency.name}: installed ${installed.version} at ${toPosixPath(relative(checkout, installedPath))} does not satisfy declared ${dependency.spec}`,
        );
      if (
        specification.kind === 'npm-alias' &&
        specification.targetSpec &&
        semver.validRange(specification.targetSpec, { loose: true }) &&
        !semver.satisfies(installed.version, specification.targetSpec, {
          loose: true,
        })
      )
        findings.push(
          `${workspace} → ${dependency.name}: installed ${installed.version} at ${toPosixPath(relative(checkout, installedPath))} does not satisfy aliased ${specification.targetName}@${specification.targetSpec}`,
        );
    }
  }
  return findings.sort();
}

export function assertWorkspaceDependencySatisfaction(options) {
  const findings = findWorkspaceDependencyProblems(options);
  if (findings.length)
    throw new Error(
      `workspace dependency satisfaction failed:\n${findings.map((finding) => `- ${finding}`).join('\n')}`,
    );
}
