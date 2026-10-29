import { createHash } from 'node:crypto';
import { stationControlRequestAuthority } from '../../security/station-control-request-authority.js';
import { STATION_CONTROL_CALLER_TOKEN_HEADER } from '../../tools/station-control-shared.js';
import {
  resolveStationControlCallerForRequest,
  type StationControlCallerRecordResolver,
} from './station-control-caller.js';

export function createSessionGroupRequestAuthority(
  resolveRecord: StationControlCallerRecordResolver,
  fallbackBinding: (request: Request) => string | undefined,
) {
  const resolve = (request: Request) =>
    resolveStationControlCallerForRequest(request, resolveRecord);
  return {
    sessionGroupBindingForRequest(request: Request) {
      if (stationControlRequestAuthority(request)?.kind !== 'caller')
        return fallbackBinding(request);
      const token = request.headers.get(STATION_CONTROL_CALLER_TOKEN_HEADER);
      if (!token || !resolve(request)) return undefined;
      return createHash('sha256').update(token).digest('base64url');
    },
    bindSessionGroupCallerCurrent(request: Request) {
      const original = resolve(request);
      return () => {
        const current = resolve(request);
        return (
          !!original?.principal &&
          !!current?.principal &&
          original.sessionId === current.sessionId &&
          original.principal.id === current.principal.id &&
          original.assurance === current.assurance &&
          original.localProjectId === current.localProjectId &&
          original.projectIdSource === current.projectIdSource &&
          original.projectSlug === current.projectSlug
        );
      };
    },
  };
}
