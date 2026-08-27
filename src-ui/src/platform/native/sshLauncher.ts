import { redactSecrets } from '@kontourai/station-shared/redaction';
import { invokeTauri } from './tauriInvoke';

function safeInvoke<T>(
  command: string,
  args: Record<string, unknown>,
): Promise<T> {
  return invokeTauri<T>(command, args).catch((cause) => {
    throw new Error(
      redactSecrets(cause instanceof Error ? cause.message : String(cause)),
    );
  });
}

export type SshLaunchPhase =
  | 'probing'
  | 'cloning'
  | 'installing'
  | 'starting'
  | 'ready'
  | 'failed';

export interface SshProbeResult {
  nodeVersion: string;
  nodeRequirement: string;
}

export interface SshLaunchStatus {
  launchId: string;
  phase: SshLaunchPhase;
  reused: boolean;
  identityVerified: boolean;
  expectedSha: string;
  localUrl?: string;
  pairingOffer?: string;
  error?: string;
}

export const sshLauncher = {
  probe: (target: string) =>
    safeInvoke<SshProbeResult>('ssh_env_probe', { target }),
  launch: (request: {
    target: string;
    sha: string;
    localPort: number;
    remotePort: number;
  }) => safeInvoke<string>('ssh_launch_start', { request }),
  status: (launchId: string) =>
    safeInvoke<SshLaunchStatus>('ssh_launch_status', { launchId }),
  cancel: (launchId: string) =>
    safeInvoke<void>('ssh_launch_cancel', { launchId }),
  markIdentityVerified: (launchId: string) =>
    safeInvoke<void>('ssh_launch_mark_identity_verified', { launchId }),
};
