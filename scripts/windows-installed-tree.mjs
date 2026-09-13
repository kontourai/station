import { createHash } from 'node:crypto';
import { lstatSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Inspect bytes without assuming a successful installer copied every file. */
export function inspectWindowsInstalledTree(directory) {
  const root = resolve(directory);
  const records = [];
  const runtimeRoots = [
    'station-nightly.exe',
    'dist-server',
    'node_modules',
    'schemas',
  ];
  function visit(path) {
    const info = lstatSync(path);
    if (info.isSymbolicLink())
      throw new Error('Installed payload contains a symbolic link');
    if (info.isDirectory()) {
      for (const entry of readdirSync(path)) visit(join(path, entry));
    } else if (info.isFile()) {
      const name = relative(root, path).replaceAll('\\', '/');
      if (name === 'uninstall.exe') return;
      records.push({
        path: name,
        size: info.size,
        sha256: createHash('sha256').update(readFileSync(path)).digest('hex'),
      });
    } else throw new Error('Installed payload contains a non-file resource');
  }
  for (const name of [
    'station-nightly.exe',
    'dist-server/command-station.js',
    'dist-server/station-build.json',
  ]) {
    if (!lstatSync(join(root, name)).isFile())
      throw new Error(`Missing runtime file: ${name}`);
  }
  for (const name of ['dist-server', 'node_modules', 'schemas']) {
    if (!lstatSync(join(root, name)).isDirectory())
      throw new Error(`Missing runtime directory: ${name}`);
  }
  visit(root);
  records.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const runtime = records.filter((entry) =>
    runtimeRoots.some(
      (name) => entry.path === name || entry.path.startsWith(`${name}/`),
    ),
  );
  const digest = (value) =>
    createHash('sha256').update(JSON.stringify(value)).digest('hex');
  return {
    records,
    summary: {
      runtimeSha256: digest(runtime),
      fullSha256: digest(records),
      files: records.length,
    },
  };
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const [directory, output] = process.argv.slice(2);
  const { records, summary } = inspectWindowsInstalledTree(directory);
  writeFileSync(output, `${JSON.stringify(records)}\n`);
  writeFileSync(`${output}.summary.json`, `${JSON.stringify(summary)}\n`);
  console.log(`Verified installed inventory: ${summary.files} files`);
}
