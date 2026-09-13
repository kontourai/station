import { lstat, mkdir } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  DEPLOYMENT_AUTHENTICATION_BASE_PATH,
  type DeploymentAuthenticationConfiguration,
  type DeploymentAuthenticationModule,
} from '@kontourai/station-contracts/deployment-authentication';
import { expandTilde } from '../../utils/paths.js';
import { DeploymentAuthenticationService } from './deployment-authentication-service.js';

export function readDeploymentAuthenticationConfiguration(
  environment: Readonly<Record<string, string | undefined>>,
): DeploymentAuthenticationConfiguration | undefined {
  const modulePath = environment.STATION_AUTHENTICATION_MODULE;
  const publicOrigin = environment.STATION_AUTHENTICATION_ORIGIN;
  if (modulePath === undefined && publicOrigin === undefined) return undefined;
  if (!modulePath || !publicOrigin)
    throw new Error(
      'Authentication requires both an operator module and a public origin.',
    );
  return { modulePath, publicOrigin };
}

export interface LoadedDeploymentAuthentication {
  service: DeploymentAuthenticationService;
  publicOrigin: string;
}

function authenticationOrigin(value: string): string {
  const origin = new URL(value);
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(
    origin.hostname,
  );
  if (
    (origin.protocol !== 'https:' &&
      !(origin.protocol === 'http:' && loopback)) ||
    origin.username ||
    origin.password ||
    origin.search ||
    origin.hash ||
    origin.pathname !== '/'
  ) {
    throw new Error(
      'Authentication requires an HTTPS origin, or HTTP loopback for local development.',
    );
  }
  return origin.origin;
}

async function authenticationStateDirectory(
  homeDirectory: string,
): Promise<string> {
  const stateDirectory = join(
    resolve(expandTilde(homeDirectory)),
    'authentication',
  );
  await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
  const state = await lstat(stateDirectory);
  if (!state.isDirectory() || state.isSymbolicLink())
    throw new Error(
      'Authentication storage must be a Station-owned directory.',
    );
  if (
    process.platform !== 'win32' &&
    ((state.mode & 0o077) !== 0 || state.uid !== process.getuid?.())
  ) {
    throw new Error(
      'Authentication storage requires private operator ownership and permissions.',
    );
  }
  return stateDirectory;
}

/** Only explicit process configuration can load deployment code; no request or plugin registry reaches this loader. */
export async function loadDeploymentAuthentication(
  configuration: DeploymentAuthenticationConfiguration | undefined,
  host: { stationId: string; homeDirectory: string },
): Promise<LoadedDeploymentAuthentication | undefined> {
  if (!configuration) return undefined;
  const { modulePath, publicOrigin } = structuredClone(configuration);
  if (!isAbsolute(modulePath))
    throw new Error('Authentication module path must be absolute.');
  const origin = authenticationOrigin(publicOrigin);
  if (!(await lstat(modulePath)).isFile())
    throw new Error('Authentication module must be a regular file.');
  const stateDirectory = await authenticationStateDirectory(host.homeDirectory);
  const loaded: unknown = await import(pathToFileURL(modulePath).href);
  if (
    !loaded ||
    typeof loaded !== 'object' ||
    !('createStationAuthenticationProvider' in loaded) ||
    typeof loaded.createStationAuthenticationProvider !== 'function'
  ) {
    throw new Error(
      'Authentication module does not export the public provider factory.',
    );
  }
  const provider = await (
    loaded as DeploymentAuthenticationModule
  ).createStationAuthenticationProvider(
    Object.freeze({
      stationId: host.stationId,
      publicOrigin: origin,
      basePath: DEPLOYMENT_AUTHENTICATION_BASE_PATH,
      stateDirectory,
    }),
  );
  try {
    return {
      service: new DeploymentAuthenticationService(provider),
      publicOrigin: origin,
    };
  } catch (error) {
    if (provider && typeof provider.close === 'function')
      await provider.close();
    throw error;
  }
}
