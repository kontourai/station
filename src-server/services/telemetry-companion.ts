import { execFile } from 'node:child_process';
import type { TelemetryCompanionPrerequisites } from '@kontourai/station-contracts/telemetry-delivery';

function docker(args: string[], endpoint?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'docker',
      endpoint ? ['--host', endpoint, ...args] : args,
      {
        windowsHide: true,
        encoding: 'utf8',
        timeout: 5_000,
        killSignal: 'SIGKILL',
        maxBuffer: 16 * 1024,
        env: endpoint
          ? { ...process.env, DOCKER_CONTEXT: undefined, DOCKER_HOST: endpoint }
          : process.env,
      },
      (error, stdout) => (error ? reject(error) : resolve(stdout.trim())),
    );
  });
}

function localEndpoint(endpoint: string): boolean {
  return endpoint.startsWith('unix://') || endpoint.startsWith('npipe://');
}

/** Reads only the selected local Docker context; never starts or pulls a service. */
export async function readTelemetryCompanionPrerequisites(): Promise<TelemetryCompanionPrerequisites> {
  const unavailable = (
    reason: Extract<
      TelemetryCompanionPrerequisites,
      { kind: 'unavailable' }
    >['reason'],
  ): TelemetryCompanionPrerequisites => ({
    kind: 'unavailable',
    checkedAt: new Date().toISOString(),
    reason,
  });
  if (process.env.DOCKER_HOST && !localEndpoint(process.env.DOCKER_HOST))
    return unavailable('remote-container-context');
  let endpoint: string;
  try {
    endpoint =
      process.env.DOCKER_HOST && !process.env.DOCKER_CONTEXT
        ? process.env.DOCKER_HOST
        : await docker([
            'context',
            'inspect',
            '--format',
            '{{.Endpoints.docker.Host}}',
          ]);
    if (!localEndpoint(endpoint))
      return unavailable('remote-container-context');
  } catch (error) {
    return unavailable(
      error instanceof Error && 'code' in error && error.code === 'ENOENT'
        ? 'container-runtime-missing'
        : 'container-daemon-unavailable',
    );
  }
  let server: unknown;
  try {
    server = JSON.parse(
      await docker(['version', '--format', '{{json .Server}}'], endpoint),
    );
  } catch {
    return unavailable('container-daemon-unavailable');
  }
  if (
    !server ||
    typeof server !== 'object' ||
    !('Os' in server) ||
    server.Os !== 'linux' ||
    !('Arch' in server) ||
    (server.Arch !== 'amd64' && server.Arch !== 'arm64') ||
    !('Version' in server) ||
    typeof server.Version !== 'string' ||
    !/^\d+\.\d+\.\d+[-+.\w]*$/.test(server.Version) ||
    server.Version.length > 64
  )
    return unavailable('container-host-unsupported');
  let composeVersion: string;
  try {
    composeVersion = await docker(['compose', 'version', '--short']);
    const match = /^v?(\d+)\.(\d+)\.(\d+)[-+.\w]*$/.exec(composeVersion);
    if (
      !match ||
      composeVersion.length > 64 ||
      Number(match[1]) < 2 ||
      (Number(match[1]) === 2 && Number(match[2]) < 24)
    )
      return unavailable('compose-unavailable');
  } catch {
    return unavailable('compose-unavailable');
  }
  return {
    kind: 'available',
    checkedAt: new Date().toISOString(),
    containerHost: 'local',
    architecture: server.Arch,
    dockerVersion: server.Version,
    composeVersion,
  };
}
