import { stationControlRequestAuthority } from '../../security/station-control-request-authority.js';
import { INTERNAL_TENANT_HEADER } from '../../utils/internal-api-token.js';
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
      const caller = resolve(request);
      if (
        caller?.assurance !== 'bound' ||
        caller.principal?.source !== 'session-owner'
      )
        return undefined;
      return JSON.stringify([
        'station-control-session/v1',
        request.headers.get(INTERNAL_TENANT_HEADER),
        caller.sessionId,
        caller.principal.id,
      ]);
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
