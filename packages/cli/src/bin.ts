/**
 * Entry point for the published `station` executable.
 *
 * This is the bundle's esbuild entry (`packages/cli/esbuild.config.mjs`); the
 * `#!/usr/bin/env node` shebang is written by the build's banner, not by this
 * file, so the source stays a plain module that `tsc` and the test suite can
 * read.
 *
 * The contributor path is deliberately different: the repo-root `./station`
 * launcher runs `scripts/station-cli.ts`, which additionally injects
 * `EnvironmentSecurityService` from `src-server/`. That source must not ship
 * in the tarball. The package uses client-side existing-home admission for
 * selected local operations; distribution.ts keeps mutations requiring the
 * injected service behind the checkout launcher.
 */

import { describeCliError, runCli } from './cli.js';
import { promptYN } from './commands/platform.js';

await runCli(process.argv.slice(2), {
  configureProfileCredentialStore: async () => {
    const [{ setProfileCredentialStore }, { createProfileKeyringStore }] =
      await Promise.all([
        import('./commands/profile-credentials.js'),
        import('./commands/profile-keyring.js'),
      ]);
    setProfileCredentialStore(createProfileKeyringStore());
  },
  confirm: promptYN,
  isInteractive: Boolean(process.stdin.isTTY),
}).catch((error: unknown) => {
  console.error('Error:', describeCliError(error));
  // Defense in depth, mirroring `scripts/station-cli.ts`: an explicit
  // `process.exit(1)` guarantees the CLI terminates even if a command path
  // left a stray timer or handle behind.
  process.exit(1);
});
