import type { ToolOutputReceipt } from '@kontourai/station-contracts/runtime-events';

/** Codex retains its own transcript. Station publishes a bounded tool preview. */
export function projectCodexToolOutput(input: unknown): {
  value: unknown;
  receipt?: ToolOutputReceipt;
} {
  const reasons = new Set<ToolOutputReceipt['reasons'][number]>();
  const seen = new WeakSet<object>();
  let remaining = 24 * 1024;
  let properties = 128;
  let omittedBytesAtLeast = 0;
  const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
  const walk = (value: unknown, depth: number): unknown => {
    if (typeof value === 'string') {
      // Count JSON escaping, not only the source's UTF-8 bytes. Keep the tail
      // (where command failures and exit summaries usually appear).
      const budget = Math.min(8192, remaining);
      let low = 0;
      let high = Math.min(value.length, budget);
      while (low < high) {
        const mid = Math.ceil((low + high) / 2);
        if (bytes(value.slice(value.length - mid)) <= budget) low = mid;
        else high = mid - 1;
      }
      let start = value.length - low;
      if (start > 0 && /[\uDC00-\uDFFF]/u.test(value[start] ?? '')) start++;
      const result = value.slice(start);
      remaining -= bytes(result);
      if (start > 0) {
        reasons.add('bytes');
        omittedBytesAtLeast +=
          Buffer.byteLength(value) - Buffer.byteLength(result);
      }
      return result;
    }
    if (
      value === null ||
      typeof value === 'boolean' ||
      typeof value === 'number'
    ) {
      remaining -= bytes(value);
      return value;
    }
    if (typeof value !== 'object') {
      reasons.add('unsupported');
      return null;
    }
    if (seen.has(value) || depth >= 6) {
      reasons.add(seen.has(value) ? 'cycle' : 'depth');
      return null;
    }
    seen.add(value);
    const result: Record<string, unknown> | unknown[] = Array.isArray(value)
      ? []
      : {};
    remaining -= 2;
    for (const key of Object.keys(value)) {
      if (properties-- <= 0 || remaining < 128) {
        reasons.add(properties < 0 ? 'properties' : 'bytes');
        break;
      }
      const keyBytes = bytes(key) + 2;
      if (keyBytes > remaining - 128) {
        reasons.add('bytes');
        break;
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !('value' in descriptor)) {
        reasons.add('getter');
        continue;
      }
      remaining -= keyBytes;
      const projected = walk(descriptor.value, depth + 1);
      Object.defineProperty(result, key, {
        value: projected,
        enumerable: true,
        configurable: true,
      });
    }
    return result;
  };
  if (input === undefined) return { value: undefined };
  const value = walk(input, 0);
  return {
    value,
    ...(reasons.size > 0
      ? {
          receipt: {
            truncated: true as const,
            reasons: [...reasons],
            retainedBytes: bytes(value),
            omittedBytesAtLeast,
            omittedUpdates: 0,
            strategy: reasons.has('bytes')
              ? ('utf8-tail' as const)
              : ('structural-omission' as const),
            fullOutput: 'unavailable' as const,
          },
        }
      : {}),
  };
}
