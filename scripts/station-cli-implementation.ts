import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describeCliError, runCli } from '../packages/cli/src/cli.js';
import { promptYN } from '../packages/cli/src/commands/platform.js';
import { PeerCredentialStore } from '../src-server/services/peers/peer-credential-store.js';
import { EnvironmentSecurityService } from '../src-server/services/ssh/environment-security-service.js';
import { SshEnvironmentProfileStore } from '../src-server/services/ssh/ssh-environment-profile-store.js';

export async function runStationCliImplementation(): Promise<void> {
  await runCli(process.argv.slice(2), {
    configureProfileCredentialStore: async () => {
      const [{ setProfileCredentialStore }, { createProfileKeyringStore }] =
        await Promise.all([
          import('../packages/cli/src/commands/profile-credentials.js'),
          import('../packages/cli/src/commands/profile-keyring.js'),
        ]);
      setProfileCredentialStore(createProfileKeyringStore());
    },
    createEnvironmentSecurityService: (homeDir) =>
      new EnvironmentSecurityService({ homeDir }),
    // `station doctor --migrate-playbooks`. Server source, so it is injected
    // here rather than imported by the CLI package — the published tarball must
    // not carry `src-server/`.
    runPlaybookSkillMigration: async ({ homeDir, dryRun }) => {
      const { runPlaybookSkillMigrationForHome } = await import(
        '../src-server/services/agents/playbook-skill-migration-cli.js'
      );
      return runPlaybookSkillMigrationForHome(homeDir, dryRun);
    },
    // Triage owns only the client contract. This source-only callback keeps
    // its doctor report out of the published CLI bundle.
    collectTriageDoctorReport: async () => {
      const { collectDoctorReport } = await import(
        '../packages/cli/src/commands/lifecycle-doctor.js'
      );
      return collectDoctorReport();
    },
    sourceRevision: () => {
      const result = spawnSync('git', ['rev-parse', 'HEAD'], {
        cwd: resolve(dirname(fileURLToPath(import.meta.url)), '..'),
        encoding: 'utf8',
        shell: false,
        windowsHide: true,
      });
      const revision = result.status === 0 ? result.stdout.trim() : '';
      return /^[0-9a-f]{40}$/i.test(revision) ? revision : undefined;
    },
    createPeerCredentialStore: (homeDir) => new PeerCredentialStore(homeDir),
    createSshEnvironmentProfileStore: (homeDir) =>
      new SshEnvironmentProfileStore(homeDir),
    confirm: promptYN,
    isInteractive: Boolean(process.stdin.isTTY),
  }).catch((error: unknown) => {
    console.error('Error:', describeCliError(error));
    process.exit(1);
  });
}
