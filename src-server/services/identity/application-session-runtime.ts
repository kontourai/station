import { join } from 'node:path';
import type { PairedDevice } from '@kontourai/station-contracts/environment-security';
import { openPrivateSqlite } from '../../utils/private-sqlite.js';
import { ApplicationSessionService } from './application-session-service.js';
import type { LoadedDeploymentAuthentication } from './deployment-authentication-loader.js';

export function createApplicationSessionRuntime(
  home: string,
  stationId: string,
  authentication: LoadedDeploymentAuthentication,
  identifyDevice: (credential: string) => PairedDevice | null,
) {
  if (!authentication.service.sessionReferenceCapabilities().verify)
    return undefined;
  const db = openPrivateSqlite(
    join(home, 'authentication', 'application-sessions.sqlite'),
    'Application sessions',
  );
  try {
    const service = new ApplicationSessionService(
      db,
      authentication.service,
      stationId,
      authentication.publicOrigin,
      identifyDevice,
      authentication.allowedBrowserOrigins,
    );
    authentication.service.installContinuationResolver(service);
    return service;
  } catch (error) {
    db.close();
    throw error;
  }
}
