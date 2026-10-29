/** Reject duplicate JSON fields before a management review can select an ambiguous value. */
export function parseOutsideManagementJson(body: string): unknown {
  const parsed: unknown = JSON.parse(body);
  const tokens = body.match(/"(?:\\.|[^"\\])*"|[{}[\]:,]/g) ?? [];
  const stack: (Set<string> | null)[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (token === '{') stack.push(new Set());
    else if (token === '[') stack.push(null);
    else if (token === '}' || token === ']') stack.pop();
    else if (token.startsWith('"') && tokens[i + 1] === ':') {
      const keys = stack.at(-1);
      const key: string = JSON.parse(token);
      if (!keys || keys.has(key)) throw new SyntaxError('Duplicate JSON field');
      keys.add(key);
    }
  }
  return parsed;
}
