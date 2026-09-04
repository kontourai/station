import { randomUUID } from 'node:crypto';
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { isCanonicalPluginId } from '@kontourai/station-contracts/plugin';

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export interface InstalledPluginRoot {
  readonly kind: 'legacy' | 'incarnation';
  readonly packageRoot: string;
  readonly generation: string | null;
  readonly dataRoot: string | null;
  readonly dataScope: string | null;
}

export class PluginIncarnationError extends Error {
  constructor(
    readonly reason:
      | 'unsafe-pointer'
      | 'migration-required'
      | 'data-migration-required',
  ) {
    super(
      reason === 'data-migration-required'
        ? 'Plugin update requires data migration. The current version and its data remain active; no live data was copied or deleted.'
        : reason === 'migration-required'
          ? 'This plugin predates retained generations. Stop its work and migrate it explicitly before update or removal; Station will not rename a possibly live package.'
          : 'Plugin installation pointer is unsafe or changed. Repair the installation before retrying.',
    );
    this.name = 'PluginIncarnationError';
  }
}

function directory(path: string): void {
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink())
    throw new PluginIncarnationError('unsafe-pointer');
}

/** Only the host's exact incarnation layout is a supported directory pointer.
 * Capturing this physical root never grants permission to delete it. */
export function resolveInstalledPluginRoot(
  pluginsDir: string,
  pluginId: string,
): InstalledPluginRoot | null {
  if (!isCanonicalPluginId(pluginId))
    throw new PluginIncarnationError('unsafe-pointer');
  const parent = realpathSync(pluginsDir);
  const alias = join(parent, pluginId);
  let stat: ReturnType<typeof lstatSync>;
  try {
    stat = lstatSync(alias);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  if (!stat.isSymbolicLink()) {
    if (!stat.isDirectory()) throw new PluginIncarnationError('unsafe-pointer');
    return Object.freeze({
      kind: 'legacy',
      packageRoot: alias,
      generation: null,
      dataRoot: null,
      dataScope: null,
    });
  }
  const target = readlinkSync(alias);
  const physical = realpathSync(alias);
  const parts = relative(parent, physical).split(sep);
  if (
    parts.length !== 4 ||
    parts[0] !== '.generations' ||
    parts[1] !== pluginId ||
    !UUID.test(parts[2]!) ||
    parts[3] !== 'package'
  )
    throw new PluginIncarnationError('unsafe-pointer');
  let path = parent;
  for (const part of parts) {
    path = join(path, part);
    directory(path);
  }
  const dataIdentityFile = join(
    parent,
    '.generations',
    pluginId,
    parts[2]!,
    'data-scope',
  );
  const dataIdentityStat = lstatSync(dataIdentityFile);
  if (
    !dataIdentityStat.isFile() ||
    dataIdentityStat.isSymbolicLink() ||
    dataIdentityStat.size !== 36
  )
    throw new PluginIncarnationError('unsafe-pointer');
  const dataScope = readFileSync(dataIdentityFile, 'utf8');
  if (!UUID.test(dataScope)) throw new PluginIncarnationError('unsafe-pointer');
  const dataRoot = join(parent, '.data', pluginId, dataScope);
  for (const path of [
    join(parent, '.data'),
    join(parent, '.data', pluginId),
    dataRoot,
  ])
    directory(path);
  if (readlinkSync(alias) !== target || realpathSync(alias) !== physical)
    throw new PluginIncarnationError('unsafe-pointer');
  return Object.freeze({
    kind: 'incarnation',
    packageRoot: physical,
    generation: parts[2]!,
    dataRoot,
    dataScope,
  });
}

export function pluginIncarnationIsCurrent(
  pluginsDir: string,
  pluginId: string,
  captured: InstalledPluginRoot,
): boolean {
  try {
    const current = resolveInstalledPluginRoot(pluginsDir, pluginId);
    return (
      current?.kind === captured.kind &&
      current.packageRoot === captured.packageRoot &&
      current.generation === captured.generation &&
      current.dataScope === captured.dataScope
    );
  } catch {
    return false;
  }
}

/** Caller owns the existing publication/content lock. No old physical tree is
 * ever renamed, copied, traversed for deletion, or reclaimed here. */
export function preparePluginIncarnation(
  pluginsDir: string,
  pluginId: string,
  source: string,
  dataScope: string,
) {
  const prior = resolveInstalledPluginRoot(pluginsDir, pluginId);
  if (prior?.kind === 'legacy')
    throw new PluginIncarnationError('migration-required');
  const parent = realpathSync(pluginsDir);
  for (const path of [
    join(parent, '.generations'),
    join(parent, '.generations', pluginId),
  ]) {
    if (!existsSync(path)) mkdirSync(path, { mode: 0o700 });
    directory(path);
  }
  const generation = randomUUID();
  const root = join(parent, '.generations', pluginId, generation);
  mkdirSync(root, { mode: 0o700 });
  const packageRoot = join(root, 'package');
  if (!UUID.test(dataScope)) throw new PluginIncarnationError('unsafe-pointer');
  const dataRoot = join(parent, '.data', pluginId, dataScope);
  for (const path of [
    join(parent, '.data'),
    join(parent, '.data', pluginId),
    dataRoot,
  ])
    directory(path);
  writeFileSync(join(root, 'data-scope'), dataScope, {
    mode: 0o600,
    flag: 'wx',
  });
  cpSync(source, packageRoot, { recursive: true, verbatimSymlinks: true });
  const captured: InstalledPluginRoot = Object.freeze({
    kind: 'incarnation',
    packageRoot,
    generation,
    dataRoot,
    dataScope,
  });
  return { prior, captured };
}

/** Replaces only the canonical pointer. Windows junction replacement may
 * require a gap; callers keep admission fenced throughout, and absence fails
 * closed. A failed publication never authorizes deletion of either target. */
export function publishPluginIncarnation(
  pluginsDir: string,
  pluginId: string,
  target: InstalledPluginRoot | null,
): void {
  const parent = realpathSync(pluginsDir);
  const current = resolveInstalledPluginRoot(parent, pluginId);
  if (current?.kind === 'legacy' || (target && target.kind !== 'incarnation'))
    throw new PluginIncarnationError('migration-required');
  const alias = join(parent, pluginId);
  if (!target) {
    if (current) unlinkSync(alias);
    return;
  }
  // Validate the target and every no-follow code/data ancestor before
  // preparing a pointer. The pointer never grants data deletion authority.
  const expected = join(
    parent,
    '.generations',
    pluginId,
    target.generation!,
    'package',
  );
  if (
    resolve(target.packageRoot) !== expected ||
    !UUID.test(target.generation ?? '') ||
    !UUID.test(target.dataScope ?? '') ||
    target.dataRoot !== join(parent, '.data', pluginId, target.dataScope!)
  )
    throw new PluginIncarnationError('unsafe-pointer');
  for (const path of [
    join(parent, '.generations'),
    join(parent, '.generations', pluginId),
    join(parent, '.generations', pluginId, target.generation!),
    expected,
    join(parent, '.data'),
    join(parent, '.data', pluginId),
    target.dataRoot!,
  ])
    directory(path);
  const temporary = join(parent, `.pointer-${randomUUID()}`);
  symlinkSync(
    expected,
    temporary,
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  let failure: unknown;
  try {
    if (process.platform === 'win32' && current) unlinkSync(alias);
    renameSync(temporary, alias);
  } catch (error) {
    failure = error;
  }
  try {
    unlinkSync(temporary);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
      failure = failure
        ? new AggregateError(
            [failure, error],
            'Plugin pointer publication and cleanup failed',
          )
        : error;
  }
  if (failure) throw failure;
}

/** Local data-scope allocation; existing contents are never rewritten or copied. */
export function prepareLocalPluginDataScope(
  pluginsDir: string,
  pluginId: string,
  previous: string | null,
  choice: 'preserve' | 'retain-and-reset',
): string {
  if (
    !isCanonicalPluginId(pluginId) ||
    (previous !== null && !UUID.test(previous))
  )
    throw new PluginIncarnationError('unsafe-pointer');
  const parent = realpathSync(pluginsDir);
  for (const path of [join(parent, '.data'), join(parent, '.data', pluginId)]) {
    if (!existsSync(path)) mkdirSync(path, { mode: 0o700 });
    directory(path);
  }
  if (choice === 'preserve' && previous) {
    directory(join(parent, '.data', pluginId, previous));
    return previous;
  }
  const scope = randomUUID();
  mkdirSync(join(parent, '.data', pluginId, scope), { mode: 0o700 });
  return scope;
}
