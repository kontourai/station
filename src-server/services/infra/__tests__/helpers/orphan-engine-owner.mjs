/**
 * archive#1863 — SIGKILL-test fixture.
 *
 * This is the "owner" process that the test SIGKILLs. It spawns a detached
 * engine child (which itself spawns a grandchild, mirroring `kiro-cli` →
 * `kiro-cli-chat`), writes the grandchild pid to a file, and then idles until
 * it is killed. It does NOT run any cleanup: the whole point is that the
 * engine + grandchild survive this process being SIGKILLed.
 *
 * Plain `.mjs` on purpose: the test needs a real, independently-killable
 * process, and importing the TS source here would require tsx in a subprocess.
 * The test records the registry entry itself (using the real
 * `recordOwnedProcess`) once this fixture reports the engine pid, so the
 * registry format is never duplicated here.
 *
 * Args: <grandchildFilePath>
 * Env: none required.
 */
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const gcFile = process.argv[2];
if (!gcFile) {
  process.stderr.write('orphan-engine-owner: missing grandchildFilePath arg\n');
  process.exit(2);
}

// The engine: spawns a long-lived grandchild and reports its pid via stdout,
// then idles forever. It deliberately ignores SIGTERM so the sweep's SIGKILL
// is what actually reaps it (mirroring a realistic engine that may install
// signal handlers).
const engineScript = `
const { spawn } = require('node:child_process');
process.on('SIGTERM', () => {});
const gc = spawn(process.execPath, ['-e', 'setInterval(() => {}, 86400000)'], { stdio: 'ignore' });
process.stdout.write(String(gc.pid));
setInterval(() => {}, 86400000);
`;

const engine = spawn(process.execPath, ['-e', engineScript], {
  stdio: ['ignore', 'pipe', 'inherit'],
  detached: true,
});

engine.stdout.once('data', (chunk) => {
  const grandchildPid = Number(chunk.toString().trim());
  try {
    writeFileSync(gcFile, String(grandchildPid), { mode: 0o600 });
  } catch (error) {
    process.stderr.write(
      `orphan-engine-owner: failed to write gc file: ${error}\n`,
    );
  }
  // Report engine pid (this fixture's detached child) + ready signal. The
  // grandchild pid is read back from the gc file by the test.
  process.stdout.write(`ENGINE_PID=${engine.pid}\nREADY\n`);
});

// Keep this owner process alive until it is SIGKILLed by the test.
setInterval(() => {}, 86400000);
