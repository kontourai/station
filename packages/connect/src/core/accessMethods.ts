import type {
  AccessEndpoint,
  DirectHttpAccessMethod,
  HostTunnelAccessMethod,
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
