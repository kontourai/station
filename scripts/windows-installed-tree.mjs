import { createHash } from 'node:crypto';
import { lstatSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const [directory, output] = process.argv.slice(2);
const root = resolve(directory);
const records = [];
function visit(path) {
  const info = lstatSync(path);
  if (info.isSymbolicLink())
    throw new Error('Installed payload contains a symbolic link');
  if (info.isDirectory()) {
    for (const entry of readdirSync(path)) visit(join(path, entry));
  } else if (info.isFile()) {
    records.push({
      path: relative(root, path).replaceAll('\\', '/'),
      size: info.size,
      sha256: createHash('sha256').update(readFileSync(path)).digest('hex'),
    });
  } else throw new Error('Installed payload contains a non-file resource');
}
// These are the resources the desktop runtime consumes; NSIS's own temporary
// plugins and uninstaller are deliberately outside the runtime comparison.
for (const name of ['station.exe', 'dist-server', 'node_modules', 'schemas'])
  visit(join(root, name));
records.sort((a, b) => a.path.localeCompare(b.path, 'en'));
writeFileSync(output, `${JSON.stringify(records)}\n`);
console.log(`Verified runtime inventory: ${records.length} files`);
