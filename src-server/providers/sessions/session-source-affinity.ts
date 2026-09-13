import type {
  ProviderSessionContinuationBoundary,
  ProviderSessionSourceAffinity,
} from '@kontourai/station-contracts/provider';

/** Source codecs own the meaning and opacity of the reference. */
export function isSessionSourceAffinity(
  value: unknown,
): value is ProviderSessionSourceAffinity {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  try {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return false;
    const keys = Reflect.ownKeys(value);
    if (keys.length !== 2 || !keys.includes('kind') || !keys.includes('ref'))
      return false;
    const kind = Object.getOwnPropertyDescriptor(value, 'kind');
    const ref = Object.getOwnPropertyDescriptor(value, 'ref');
    return Boolean(
      kind &&
        'value' in kind &&
        typeof kind.value === 'string' &&
        /^[a-zA-Z][a-zA-Z0-9._/-]{0,63}$/.test(kind.value) &&
        ref &&
        'value' in ref &&
        typeof ref.value === 'string' &&
        ref.value.length > 0 &&
        ref.value === ref.value.trim() &&
        Buffer.byteLength(ref.value, 'utf8') <= 512 &&
        ![...ref.value].some((character) => {
          const code = character.charCodeAt(0);
          return code <= 0x1f || (code >= 0x7f && code <= 0x9f);
        }),
    );
  } catch {
    return false;
  }
}

export function snapshotSessionSourceAffinity(
  value: ProviderSessionSourceAffinity,
): ProviderSessionSourceAffinity {
  return Object.freeze({ kind: value.kind, ref: value.ref });
}

export function isSessionContinuationBoundary(
  value: unknown,
): value is ProviderSessionContinuationBoundary {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  try {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return false;
    const keys = Reflect.ownKeys(value);
    if (
      keys.length !== 3 ||
      !keys.includes('kind') ||
      !keys.includes('providerTurnId') ||
      !keys.includes('observedEventId')
    )
      return false;
    const fields = Object.getOwnPropertyDescriptors(value);
    if (Object.values(fields).some((field) => !('value' in field)))
      return false;
    return (
      fields.kind?.value === 'completed-turn' &&
      [fields.providerTurnId?.value, fields.observedEventId?.value].every(
        (id) =>
          typeof id === 'string' &&
          id.length > 0 &&
          Buffer.byteLength(id, 'utf8') <= 512,
      )
    );
  } catch {
    return false;
  }
}
