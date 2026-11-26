type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

function refuse(): never {
  throw new Error('bounded_provider_json_refused');
}

/** Bounded JSON parser also refuses duplicate keys, prototype keys and nonfinite
 * numbers, so canonicalization cannot conceal unsupported fields. */
export function parseBoundedProviderJson(
  text: unknown,
  maxBytes: number,
): unknown {
  if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > maxBytes)
    refuse();
  let at = 0;
  let nodes = 0;
  const whitespace = () => {
    while (/[\t\n\r ]/u.test(text[at] ?? '\0')) at++;
  };
  const string = (): string => {
    const start = at++;
    let escaped = false;
    while (at < text.length) {
      const char = text[at++];
      if (!escaped && char === '"') {
        try {
          return JSON.parse(text.slice(start, at)) as string;
        } catch {
          refuse();
        }
      }
      if (!escaped && char === '\\') escaped = true;
      else escaped = false;
    }
    return refuse();
  };
  const value = (depth: number): Json => {
    if (depth > 16 || ++nodes > 20000) refuse();
    whitespace();
    const char = text[at];
    if (char === '"') return string();
    if (char === '{') {
      at++;
      const result: Record<string, Json> = Object.create(null);
      whitespace();
      if (text[at] === '}') {
        at++;
        return result;
      }
      for (;;) {
        whitespace();
        if (text[at] !== '"') refuse();
        const key = string();
        if (
          ['__proto__', 'prototype', 'constructor'].includes(key) ||
          Object.hasOwn(result, key)
        )
          refuse();
        whitespace();
        if (text[at++] !== ':') refuse();
        result[key] = value(depth + 1);
        whitespace();
        const end = text[at++];
        if (end === '}') return result;
        if (end !== ',') refuse();
      }
    }
    if (char === '[') {
      at++;
      const result: Json[] = [];
      whitespace();
      if (text[at] === ']') {
        at++;
        return result;
      }
      for (;;) {
        result.push(value(depth + 1));
        whitespace();
        const end = text[at++];
        if (end === ']') return result;
        if (end !== ',') refuse();
      }
    }
    for (const [literal, result] of [
      ['true', true],
      ['false', false],
      ['null', null],
    ] as const) {
      if (text.startsWith(literal, at)) {
        at += literal.length;
        return result;
      }
    }
    const token = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/u.exec(
      text.slice(at),
    );
    if (!token) refuse();
    at += token[0].length;
    const result = Number(token[0]);
    if (!Number.isFinite(result)) refuse();
    return result;
  };
  const result = value(0);
  whitespace();
  if (at !== text.length) refuse();
  return result;
}
