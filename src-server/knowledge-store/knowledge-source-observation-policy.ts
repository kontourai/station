import {
  KNOWLEDGE_ROOT_IDENTITY_HEADER,
  KNOWLEDGE_ROOT_IDENTITY_MAX_CHARS,
  knowledgeRootIncarnationKey,
} from '@kontourai/station-shared/knowledge-root-identity';
import {
  type CurrentRuntimeRequestPrincipalSecurity,
  getRuntimeAuthenticatedRequestPrincipal,
  isBoundRuntimeLocalOperator,
  isRuntimeRequestPrincipalCurrent,
} from '../security/runtime-request-security.js';
import type { KnowledgeRecordObservationPolicy } from './knowledge-record-observation.js';
import type { KnowledgeStoreRootPersistence } from './knowledge-store-provider.js';

type LocalSourceSecurity = CurrentRuntimeRequestPrincipalSecurity & {
  credentialLocality(credential: string): 'home-possession' | undefined;
};
export function isLocalKnowledgeSourceRequestCurrent(
  authority: unknown,
  security: LocalSourceSecurity,
): authority is Request {
  if (
    !(authority instanceof Request) ||
    !isBoundRuntimeLocalOperator(authority) ||
    !isRuntimeRequestPrincipalCurrent(authority, security)
  )
    return false;
  const principal = getRuntimeAuthenticatedRequestPrincipal(authority);
  return (
    principal?.kind === 'internal' ||
    Boolean(
      principal &&
        security.credentialLocality(principal.credential) === 'home-possession',
    )
  );
}

export function createLocalKnowledgeSourceObservationPolicy(options: {
  stationHome: string;
  persistence: KnowledgeStoreRootPersistence;
  security: LocalSourceSecurity;
}): KnowledgeRecordObservationPolicy {
  return {
    stationHome: options.stationHome,
    authorize(target, authority) {
      if (!isLocalKnowledgeSourceRequestCurrent(authority, options.security))
        return 'restricted';
      // A current credential on some other route is not a source-read capability.
      const path = new URL(authority.url).pathname.match(
        /^\/api\/knowledge\/roots\/([^/]+)\/records\/([^/]+)\/source-observation$/,
      );
      if (
        authority.method !== 'GET' ||
        !path ||
        decodeURIComponent(path[1]) !== target.rootId ||
        decodeURIComponent(path[2]) !== target.recordId
      )
        return 'restricted';
      const expected = authority.headers.get(KNOWLEDGE_ROOT_IDENTITY_HEADER);
      if (!expected || expected.length > KNOWLEDGE_ROOT_IDENTITY_MAX_CHARS)
        return 'restricted';
      // An authenticated local owner may inspect exact records only within a
      // registered personal built-in root. Registry identity is a precondition,
      // never permission; project and plugin roots have no implicit fallback.
      const registry = options.persistence.observeKnowledgeStoreRoots?.();
      if (!registry) return 'unavailable';
      const root = registry.roots.find((entry) => entry.id === target.rootId);
      if (
        root?.scope.kind !== 'personal' ||
        root.adapterId !== 'kit-default-store' ||
        encodeURIComponent(knowledgeRootIncarnationKey(root)) !== expected
      )
        return 'restricted';
      return 'allowed';
    },
  };
}
