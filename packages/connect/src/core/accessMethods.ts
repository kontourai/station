import type {
  AccessEndpoint,
  DirectHttpAccessMethod,
  HostTunnelAccessMethod,
  ResolvedHostTunnelAccess,
} from './types';

const SSH_ALIAS = /^[A-Za-z0-9_][A-Za-z0-9._-]*$/;

function hasControlCharacters(value: string): boolean {
  return [...value].some((character) => {
    const code = character.charCodeAt(0);
    return code < 32 || code === 127;
  });
}

function requireSafeId(value: string): string {
  const id = value.trim();
  if (!id || hasControlCharacters(id)) {
    throw new Error(
      'Access method id must be non-empty and contain no control characters',
    );
  }
  return id;
}

export function createDirectHttpAccessMethod(
  endpoint: AccessEndpoint,
): DirectHttpAccessMethod {
  return {
    accessVersion: 1,
    id: `access:direct:${endpoint.id}`,
    kind: 'direct-http',
    endpointId: endpoint.id,
  };
}

export function createHostTunnelAccessMethod(input: {
  id: string;
  hostAlias: string;
  remoteProjectPath: string;
}): HostTunnelAccessMethod {
  const hostAlias = input.hostAlias.trim();
  const remoteProjectPath = input.remoteProjectPath.trim();
  if (!SSH_ALIAS.test(hostAlias)) {
    throw new Error(
      'SSH host alias must contain only letters, numbers, dots, underscores, or hyphens',
    );
  }
  if (
    !remoteProjectPath ||
    hasControlCharacters(remoteProjectPath) ||
    remoteProjectPath.length > 4096
  ) {
    throw new Error(
      'Remote project path must be non-empty, bounded, and contain no line breaks',
    );
  }
  return {
    accessVersion: 1,
    id: requireSafeId(input.id),
    kind: 'host-tunnel',
    adapter: 'ssh',
    hostAlias,
    remoteProjectPath,
  };
}

export function requiresHostAdapter(
  method: DirectHttpAccessMethod | HostTunnelAccessMethod,
): method is HostTunnelAccessMethod {
  return method.kind === 'host-tunnel';
}

function isLoopbackEndpoint(endpoint: AccessEndpoint): boolean {
  try {
    const hostname = new URL(endpoint.url).hostname.toLowerCase();
    return (
      hostname === 'localhost' ||
      hostname === '127.0.0.1' ||
      hostname === '[::1]'
    );
  } catch {
    return false;
  }
}

/**
 * Bind transient host-adapter output back to the stable method identity.
 * The resolved loopback URL is intentionally returned separately so callers
 * cannot accidentally serialize it into the environment profile.
 */
export function bindHostTunnelAccess(
  method: HostTunnelAccessMethod,
  resolved: {
    endpoint: AccessEndpoint;
    hostIdentity: string;
    remoteProjectPath: string;
  },
): ResolvedHostTunnelAccess {
  if (!isLoopbackEndpoint(resolved.endpoint)) {
    throw new Error('Host tunnel endpoint must resolve to loopback');
  }
  const hostIdentity = resolved.hostIdentity.trim();
  if (!hostIdentity || hasControlCharacters(hostIdentity)) {
    throw new Error('Host tunnel identity is missing or invalid');
  }
  if (resolved.remoteProjectPath !== method.remoteProjectPath) {
    throw new Error('Resolved remote project path does not match the profile');
  }
  return {
    accessMethodId: method.id,
    endpoint: resolved.endpoint,
    hostIdentity,
    remoteProjectPath: resolved.remoteProjectPath,
  };
}
