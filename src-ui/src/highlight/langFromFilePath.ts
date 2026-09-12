/**
 * File extension → Shiki language id.
 *
 * This lived in `SyntaxHighlighterContext`, which is reachable from the entry
 * chunk. Its only readers are the file-preview pane and the coding layout's
 * content viewer, neither of which a first paint mounts, so thirty-odd
 * extension strings were being downloaded by every user to answer a question
 * nobody had asked yet.
 */
const EXT_LANG: Record<string, string> = {
  ts: 'typescript',
  tsx: 'tsx',
  js: 'javascript',
  jsx: 'jsx',
  mjs: 'javascript',
  cjs: 'javascript',
  py: 'python',
  rs: 'rust',
  go: 'go',
  java: 'java',
  json: 'json',
  yaml: 'yaml',
  yml: 'yaml',
  toml: 'toml',
  html: 'html',
  htm: 'html',
  css: 'css',
  scss: 'scss',
  md: 'markdown',
  mdx: 'markdown',
  sql: 'sql',
  sh: 'bash',
  bash: 'bash',
  zsh: 'bash',
  xml: 'xml',
  svg: 'xml',
  dockerfile: 'dockerfile',
  graphql: 'graphql',
  gql: 'graphql',
  vue: 'vue',
  svelte: 'svelte',
};

export function langFromFilePath(path: string): string | undefined {
  const ext = path.split('.').pop()?.toLowerCase() ?? '';
  // Handle "Dockerfile" with no extension
  if (path.toLowerCase().endsWith('dockerfile')) return 'dockerfile';
  return EXT_LANG[ext];
}
