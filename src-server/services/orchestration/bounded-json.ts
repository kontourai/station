export interface BoundedJsonLimits {
  maxBytes: number;
  maxDepth: number;
  maxItems: number;
  maxStringCodeUnits: number;
  maxKeyCodeUnits: number;
}

export type BoundedJsonMeasure =
  | { ok: true; bytes: number }
  | {
      ok: false;
      reason: 'shape' | 'cycle' | 'depth' | 'items' | 'string' | 'bytes';
    };

/**
 * Counts the exact UTF-8 bytes JSON.stringify would emit for closed JSON data.
 * It never constructs the JSON string and stops as soon as the remaining byte,
 * depth, item, or cheap code-unit budget cannot admit the next token.
 */
export function measureBoundedJson(
  value: unknown,
  limits: BoundedJsonLimits,
): BoundedJsonMeasure {
  let bytes = 0;
  let items = 0;
  const active = new WeakSet<object>();
  let failure: Exclude<BoundedJsonMeasure, { ok: true }>['reason'] | undefined;
  const add = (count: number): boolean => {
    if (count > limits.maxBytes - bytes) {
      failure = 'bytes';
      return false;
    }
    bytes += count;
    return true;
  };
  const stringBytes = (text: string, key: boolean): boolean => {
    if (
      text.length > (key ? limits.maxKeyCodeUnits : limits.maxStringCodeUnits)
    ) {
      failure = 'string';
      return false;
    }
    if (!add(2)) return false;
    for (let index = 0; index < text.length; index += 1) {
      const unit = text.charCodeAt(index);
      if (unit >= 0xd800 && unit <= 0xdbff) {
        const low = text.charCodeAt(index + 1);
        if (!(low >= 0xdc00 && low <= 0xdfff)) {
          failure = 'string';
          return false;
        }
        index += 1;
        if (!add(4)) return false;
      } else if (unit >= 0xdc00 && unit <= 0xdfff) {
        failure = 'string';
        return false;
      } else if (unit === 0x22 || unit === 0x5c) {
        if (!add(2)) return false;
      } else if (
        unit === 0x08 ||
        unit === 0x09 ||
        unit === 0x0a ||
        unit === 0x0c ||
        unit === 0x0d
      ) {
        if (!add(2)) return false;
      } else if (unit < 0x20) {
        if (!add(6)) return false;
      } else if (unit < 0x80) {
        if (!add(1)) return false;
      } else if (unit < 0x800) {
        if (!add(2)) return false;
      } else if (!add(3)) return false;
    }
    return true;
  };
  const visit = (item: unknown, depth: number): boolean => {
    if (depth > limits.maxDepth) {
      failure = 'depth';
      return false;
    }
    items += 1;
    if (items > limits.maxItems) {
      failure = 'items';
      return false;
    }
    if (item === null) return add(4);
    if (item === true) return add(4);
    if (item === false) return add(5);
    if (typeof item === 'string') return stringBytes(item, false);
    if (typeof item === 'number') {
      if (!Number.isFinite(item)) {
        failure = 'shape';
        return false;
      }
      return add(String(item).length);
    }
    if (typeof item !== 'object') {
      failure = 'shape';
      return false;
    }
    if (active.has(item)) {
      failure = 'cycle';
      return false;
    }
    active.add(item);
    try {
      if (Array.isArray(item)) {
        if (!dataOnlyArray(item) || !add(1)) return false;
        for (let index = 0; index < item.length; index += 1) {
          if (index > 0 && !add(1)) return false;
          if (!visit(item[index], depth + 1)) return false;
        }
        return add(1);
      }
      if (!plainDataObject(item)) {
        failure = 'shape';
        return false;
      }
      if (!add(1)) return false;
      const entries = Object.entries(item);
      for (let index = 0; index < entries.length; index += 1) {
        if (index > 0 && !add(1)) return false;
        const [key, child] = entries[index]!;
        if (!stringBytes(key, true) || !add(1) || !visit(child, depth + 1))
          return false;
      }
      return add(1);
    } finally {
      active.delete(item);
    }
  };
  try {
    return visit(value, 0)
      ? { ok: true, bytes }
      : { ok: false, reason: failure ?? 'shape' };
  } catch {
    return { ok: false, reason: 'shape' };
  }
}

export function plainDataObject(
  value: unknown,
): value is Record<string, unknown> {
  try {
    if (
      value === null ||
      typeof value !== 'object' ||
      Object.getPrototypeOf(value) !== Object.prototype
    )
      return false;
    const keys = Reflect.ownKeys(value);
    if (keys.some((key) => typeof key !== 'string')) return false;
    return Object.values(Object.getOwnPropertyDescriptors(value)).every(
      (descriptor) => 'value' in descriptor && descriptor.enumerable === true,
    );
  } catch {
    return false;
  }
}

function dataOnlyArray(value: unknown[]): boolean {
  try {
    const descriptors = Object.getOwnPropertyDescriptors(value);
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = descriptors[String(index)];
      if (!descriptor || !('value' in descriptor) || !descriptor.enumerable)
        return false;
    }
    return Reflect.ownKeys(value).every(
      (key) =>
        key === 'length' || (typeof key === 'string' && /^\d+$/.test(key)),
    );
  } catch {
    return false;
  }
}
