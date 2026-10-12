/**
 * The bundle entry of the Windows installer core (#2675 slice W).
 * scripts/install-script-generated.mjs bundles this file with esbuild into
 * one CommonJS program and embeds it in install.ps1, which writes it to its
 * private temporary directory and runs `node <core> install`. Required as a
 * module (the golden-vector and install tests do), it only exports.
 */
import { runInstaller } from './run.js';

export { isAbsoluteRoot, windowsInstallRootRefusal } from './install.js';
export { verifyInstallManifest } from './manifest.js';
export { runInstaller } from './run.js';

if (typeof require !== 'undefined' && require.main === module) {
  runInstaller(process.argv.slice(2), process.env, {
    out: (line) => process.stdout.write(`${line}\n`),
    err: (line) => process.stderr.write(`${line}\n`),
  }).then(
    (status) => {
      process.exitCode = status;
    },
    (error: unknown) => {
      process.stderr.write(`Station install failed: ${String(error)}\n`);
      process.exitCode = 1;
    },
  );
}
