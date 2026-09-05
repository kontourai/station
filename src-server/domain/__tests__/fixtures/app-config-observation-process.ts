import { execFileSync } from 'node:child_process';
import { readFileSync, renameSync } from 'node:fs';
import fsPromises from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';

const home = process.argv[2]!;
const path = join(home, 'config', 'app.json'),
  backup = join(home, 'config', 'app.before');
const expected = readFileSync(path, 'utf8');
const originalOpen = fsPromises.open;
let swapped = false;
fsPromises.open = async (...args: Parameters<typeof fsPromises.open>) => {
  if (String(args[0]) === path && !swapped) {
    swapped = true;
    renameSync(path, backup);
    execFileSync('mkfifo', [path], { windowsHide: true });
  }
  return originalOpen(...args);
};
syncBuiltinESMExports();
const { observeAppConfigFile } = await import('../../config-loader-app.js');
let refused = false;
try {
  await observeAppConfigFile(home);
} catch {
  refused = true;
}
process.stdout.write(
  JSON.stringify({
    swapped,
    refused,
    originalRetained: readFileSync(backup, 'utf8') === expected,
  }),
);
