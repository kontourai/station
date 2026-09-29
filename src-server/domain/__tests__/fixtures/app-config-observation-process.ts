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
// Record which refusal fired: a bare catch would also count the ESPIPE or
// SyntaxError a FIFO read produces once the identity guard stops refusing.
let refusal: string | null = null;
try {
  await observeAppConfigFile(home);
} catch (error) {
  refusal = error instanceof Error ? error.name : String(error);
}
process.stdout.write(
  JSON.stringify({
    swapped,
    refusal,
    originalRetained: readFileSync(backup, 'utf8') === expected,
  }),
);
