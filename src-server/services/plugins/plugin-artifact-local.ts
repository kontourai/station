import {
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import {
  basename,
  dirname,
  isAbsolute,
  join,
  posix,
  relative,
  resolve,
  sep,
} from 'node:path';
import { computePluginContentDigest } from './plugin-content-integrity.js';
import type {
  PluginArtifactEntry,
  PreparedPluginArtifact,
} from './plugin-installation-service.js';

function forbiddenWindowsCharacters(value: string): boolean {
  for (const character of value)
    if ((character.codePointAt(0) ?? 0) < 32 || '<>:"|?*'.includes(character))
      return true;
  return false;
}
const localSources = new WeakMap<PreparedPluginArtifact, string>();
export function captureLocalPluginArtifact(
  path: string,
): PreparedPluginArtifact {
  const root = realpathSync(path);
  const digest = computePluginContentDigest(dirname(root), basename(root));
  if (!digest) throw new Error('Prepared plugin artifact is unavailable');
  async function* read(
    directory: string,
    relative: string,
  ): AsyncIterable<PluginArtifactEntry> {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort(
      (a, b) => a.name.localeCompare(b.name),
    )) {
      if (!relative && entry.name === '.git') continue;
      const item = relative ? `${relative}/${entry.name}` : entry.name;
      const source = join(directory, entry.name);
      if (entry.isSymbolicLink())
        yield { path: item, kind: 'symlink', target: readlinkSync(source) };
      else if (entry.isDirectory()) {
        yield { path: item, kind: 'directory' };
        yield* read(source, item);
      } else if (entry.isFile())
        yield {
          path: item,
          kind: 'file',
          bytes: readFileSync(source),
          executable: (lstatSync(source).mode & 0o111) !== 0,
        };
      else
        throw new Error(
          'Prepared plugin artifact contains an unsupported entry',
        );
    }
  }
  const artifact: PreparedPluginArtifact = Object.freeze({
    digest,
    readEntries: () => read(root, ''),
  });
  localSources.set(artifact, root);
  return artifact;
}
export function localPluginArtifactSource(
  artifact: PreparedPluginArtifact,
): string | undefined {
  return localSources.get(artifact);
}

/** Transport adapters can stage the same content capability. They must verify
 * the existing content digest before treating these bytes as prepared. */
export async function materializePluginArtifact(
  artifact: PreparedPluginArtifact,
  destination: string,
): Promise<void> {
  const root = realpathSync(destination);
  if (readdirSync(root).length)
    throw new Error('Artifact destination must be empty');
  const seen = new Set<string>();
  const windowsSpellings = new Map<string, string>();
  const links: Array<{ path: string; target: string }> = [];
  let bytes = 0;
  for await (const entry of artifact.readEntries()) {
    if (
      !entry.path ||
      entry.path.includes('\\') ||
      entry.path.includes('\0') ||
      posix.isAbsolute(entry.path) ||
      posix.normalize(entry.path) !== entry.path ||
      entry.path
        .split('/')
        .some((part) => part === '..' || part === '.' || !part) ||
      seen.has(entry.path)
    )
      throw new Error('Artifact entry path is invalid');
    seen.add(entry.path);
    if (seen.size > 100000) throw new Error('Artifact entry limit exceeded');
    let parent = root;
    const segments = entry.path.split('/');
    if (process.platform === 'win32') {
      let prefix = '';
      for (const segment of segments) {
        if (
          forbiddenWindowsCharacters(segment) ||
          /[. ]$/.test(segment) ||
          /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(segment)
        )
          throw new Error(
            'Artifact uses an unsupported Windows entry spelling',
          );
        prefix = prefix ? `${prefix}/${segment}` : segment;
        const folded = prefix.toUpperCase();
        const existing = windowsSpellings.get(folded);
        if (existing !== undefined && existing !== prefix)
          throw new Error(
            'Artifact has a Windows case-colliding entry spelling',
          );
        windowsSpellings.set(folded, prefix);
      }
    }
    for (const part of segments.slice(0, -1)) {
      parent = join(parent, part);
      try {
        mkdirSync(parent, { mode: 0o700 });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
      const stat = lstatSync(parent);
      if (!stat.isDirectory() || stat.isSymbolicLink())
        throw new Error('Artifact parent is unsafe');
    }
    const target = join(parent, segments.at(-1)!);
    if (entry.kind === 'directory') {
      try {
        mkdirSync(target, { mode: 0o700 });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
      const stat = lstatSync(target);
      if (!stat.isDirectory() || stat.isSymbolicLink())
        throw new Error('Artifact directory is unsafe');
    } else if (entry.kind === 'file') {
      bytes += entry.bytes.byteLength;
      if (bytes > 512 * 1024 * 1024)
        throw new Error('Artifact byte limit exceeded');
      writeFileSync(target, entry.bytes, {
        flag: 'wx',
        mode: entry.executable ? 0o700 : 0o600,
      });
    } else {
      if (
        process.platform === 'win32' &&
        (isAbsolute(entry.target) ||
          entry.target
            .split(/[\\/]/)
            .some(
              (part) =>
                part !== '.' &&
                part !== '..' &&
                (forbiddenWindowsCharacters(part) ||
                  /[. ]$/.test(part) ||
                  /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)),
            ))
      )
        throw new Error(
          'Artifact uses an unsupported Windows symlink spelling',
        );
      const linkTarget = resolve(dirname(target), entry.target);
      const location = relative(root, linkTarget);
      if (
        location === '..' ||
        location.startsWith(`..${sep}`) ||
        isAbsolute(location)
      )
        throw new Error(
          'Artifact symlink target is outside the materialization',
        );
      links.push({ path: target, target: entry.target });
    }
  }
  // Create links last: an entry can never write through a package-supplied link.
  for (const link of links) symlinkSync(link.target, link.path);
  // Hashing intentionally hashes link text without following it. Containment
  // is separate, including chains; this transport adapter refuses dangling or
  // cyclic links rather than claiming that an unresolved target is contained.
  for (const link of links) {
    const resolved = realpathSync.native(link.path);
    const location = relative(root, resolved);
    if (
      location === '..' ||
      location.startsWith(`..${sep}`) ||
      isAbsolute(location)
    )
      throw new Error('Artifact symlink chain escapes the materialization');
  }
  if (
    computePluginContentDigest(dirname(root), basename(root)) !==
    artifact.digest
  )
    throw new Error('Artifact content does not match its verified digest');
}
