import { createHash, timingSafeEqual } from 'node:crypto';
import {
  OutsideOAuthRefusal,
  type RegistrationMetadata,
  recordSchemas,
} from './oauth-records.js';

export function safeLabel(value: string): string {
  return value
    .replace(
      /[\p{Cc}\p{Cf}\p{Default_Ignorable_Code_Point}\u2028\u2029\u2800]/gu,
      '',
    )
    .trim();
}
export function nameLabel(value: string): string {
  const label = safeLabel(value);
  return /[\p{L}\p{N}]/u.test(label) ? label : '(unnamed)';
}

export function secretHash(domain: string, value: string): string {
  return createHash('sha256')
    .update(`station.outside-agent.${domain}.v1\0`)
    .update(value)
    .digest('hex');
}
export function equalHash(left: string, right: string): boolean {
  const a = Buffer.from(left, 'hex');
  const b = Buffer.from(right, 'hex');
  return a.length === 32 && b.length === 32 && timingSafeEqual(a, b);
}
export function pkceChallenge(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}
export function metadataDigest(metadata: RegistrationMetadata): string {
  return secretHash('registration', JSON.stringify(metadata));
}
export function selectedScopeDigest(scope: RecordsScope): string {
  return JSON.stringify(scope);
}
type RecordsScope = { kind: 'project'; projectId: string } | { kind: 'global' };

function parsedRedirect(uri: string): URL {
  if (
    Buffer.byteLength(uri) > 2048 ||
    /[\s\p{Cc}]|%(?![\da-f]{2})/iu.test(uri) ||
    uri.includes('#')
  )
    throw new OutsideOAuthRefusal('invalid_request');
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    throw new OutsideOAuthRefusal('invalid_request');
  }
  if (
    url.username ||
    url.password ||
    !['http:', 'https:'].includes(url.protocol) ||
    /%|\\/.test(url.host) ||
    uri.includes('\\')
  )
    throw new OutsideOAuthRefusal('invalid_request');
  // Reject alternative serialized authorities, including numeric-IP aliases.
  const authority = uri.match(
    /^https?:\/\/([^/?:#]+|\[[^\]]+\])(?::[0-9]+)?(?:[/?]|$)/,
  )?.[0];
  const rawHost = uri.match(
    /^https?:\/\/(\[[^\]]+\]|[^/:?#]+)(?::[0-9]+)?(?:[/?]|$)/,
  )?.[1];
  if (!authority || rawHost !== url.hostname)
    throw new OutsideOAuthRefusal('invalid_request');
  return url;
}
export function redirectPermitted(
  uri: string,
  applicationType: 'native' | 'web',
  origins: readonly string[],
): boolean {
  const url = parsedRedirect(uri);
  if (url.protocol === 'http:')
    return (
      applicationType === 'native' &&
      ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname)
    );
  return origins.includes(url.origin);
}
export function matchesRedirect(actual: string, registered: string): boolean {
  if (actual === registered) return true;
  const a = parsedRedirect(actual);
  const b = parsedRedirect(registered);
  if (
    a.protocol !== 'http:' ||
    b.protocol !== a.protocol ||
    !['127.0.0.1', '[::1]'].includes(a.hostname) ||
    a.hostname !== b.hostname
  )
    return false;
  // Change only the literal authority port; preserve every other URI byte.
  return (
    actual.replace(/^(http:\/\/(?:127\.0\.0\.1|\[::1\]))(?::\d+)?/, '$1') ===
    registered.replace(/^(http:\/\/(?:127\.0\.0\.1|\[::1\]))(?::\d+)?/, '$1')
  );
}
export function acceptedMetadata(
  input: unknown,
  origins: readonly string[],
): RegistrationMetadata {
  if (
    Buffer.byteLength(JSON.stringify(input) ?? '') > 16 * 1024 ||
    !input ||
    typeof input !== 'object' ||
    Array.isArray(input)
  )
    throw new OutsideOAuthRefusal('invalid_request');
  const raw = input as Record<string, unknown>;
  const accepted: Record<string, unknown> = {};
  for (const key of Object.keys(recordSchemas.client.shape.metadata.shape)) {
    if (Object.hasOwn(raw, key)) accepted[key] = raw[key];
  }
  const result = recordSchemas.client.shape.metadata.safeParse({
    application_type: 'web',
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
    ...accepted,
  });
  if (!result.success) throw new OutsideOAuthRefusal('invalid_request');
  const metadata = result.data;
  for (const key of [
    'client_uri',
    'logo_uri',
    'policy_uri',
    'tos_uri',
  ] as const)
    if (metadata[key] && Buffer.byteLength(metadata[key]) > 2048)
      throw new OutsideOAuthRefusal('invalid_request');
  if (
    metadata.scope
      ?.split(' ')
      .some(
        (s) => !['station-control:read', 'station-control:full'].includes(s),
      )
  )
    throw new OutsideOAuthRefusal('invalid_scope');
  if (
    !metadata.grant_types.includes('authorization_code') ||
    metadata.response_types.length !== 1 ||
    new Set(metadata.redirect_uris).size !== metadata.redirect_uris.length ||
    metadata.redirect_uris.some(
      (uri) => !redirectPermitted(uri, metadata.application_type, origins),
    )
  )
    throw new OutsideOAuthRefusal('invalid_request');
  return metadata;
}
