import { readFileSync } from 'node:fs';

/**
 * `plutil -convert json` for the plist subset Station's launchd writer
 * emits (dict, array, key, string, integer, true/false), so launchd status
 * reads a real rendered plist on every host.
 */
export function plutilJson(plistPath: string): string {
  const text = readFileSync(plistPath, 'utf8');
  type Token = {
    tag: string;
    kind: 'open' | 'close' | 'empty' | 'leaf';
    content: string;
  };
  const tokens: Token[] = [
    ...text.matchAll(
      /<(key|string|integer)>([^<]*)<\/\1>|<(\/?)(dict|array)>|<(dict|array|true|false)\/>/gu,
    ),
  ].map((match) =>
    match[1]
      ? { tag: match[1], kind: 'leaf', content: match[2] }
      : match[4]
        ? { tag: match[4], kind: match[3] ? 'close' : 'open', content: '' }
        : { tag: match[5], kind: 'empty', content: '' },
  );
  const decode = (value: string) =>
    value
      .replaceAll('&lt;', '<')
      .replaceAll('&gt;', '>')
      .replaceAll('&quot;', '"')
      .replaceAll('&apos;', "'")
      .replaceAll('&amp;', '&');
  let index = 0;
  const closes = (tag: string) =>
    tokens[index].kind === 'close' && tokens[index].tag === tag;
  const value = (): unknown => {
    const { tag, kind, content } = tokens[index++];
    if (kind === 'close') throw new Error(`unexpected </${tag}>`);
    if (tag === 'true' || tag === 'false') return tag === 'true';
    if (tag === 'string') return decode(content);
    if (tag === 'integer') return Number(content);
    if (kind === 'empty') return tag === 'dict' ? {} : [];
    if (tag === 'array') {
      const items: unknown[] = [];
      while (!closes('array')) items.push(value());
      index += 1;
      return items;
    }
    if (tag === 'dict') {
      const entries: Record<string, unknown> = {};
      while (!closes('dict')) {
        const key = tokens[index++];
        if (key.tag !== 'key')
          throw new Error(`expected <key>, got <${key.tag}>`);
        entries[decode(key.content)] = value();
      }
      index += 1;
      return entries;
    }
    throw new Error(`unexpected <${tag}>`);
  };
  return JSON.stringify(value());
}
