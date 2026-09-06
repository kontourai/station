import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadPublicDocs } from './build-github-pages.mjs';

const ABSOLUTE_DEVELOPER_PATH =
  /(?:^|[\s`"'(])(?:\/(?:Users|home|private(?:\/(?:tmp|var))?|tmp|var|opt|Volumes)(?=\/|\b)|[A-Za-z]:[\\/]|\\\\[^\\/\s]+[\\/][^\\/\s]+)/gim;
// Match complete DNS labels: settings.local.json is not a .local host.
const PRIVATE_HOSTNAME =
  /\b(?:localhost|[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:internal|corp|local|lan|home\.arpa)(?![a-z0-9-]|\.[a-z0-9-])|(?:[a-z0-9-]+\.)?ts\.net|brian-media|desktop-win)\b/gi;
const PRIVATE_IP =
  /(?:\b(?:127(?:\.\d{1,3}){3}|10(?:\.\d{1,3}){3}|100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])(?:\.\d{1,3}){2}|192\.168(?:\.\d{1,3}){2}|169\.254(?:\.\d{1,3}){2}|172\.(?:1[6-9]|2\d|3[0-1])(?:\.\d{1,3}){2})\b|(?:^|[^\da-f])(?:::1|(?:fc|fd)[\da-f:]+|fe[89ab][\da-f]*:[\da-f:]*)(?=$|[^\da-f]))/gi;
const INTERNAL_OPERATION =
  /\b(?:src-(?:server|ui)\/|scripts\/|config\/|node_modules|\.kontourai|dist-pages)\b/g;
const SOURCE_PROVENANCE = /\b(?:derived|adapted|inspired)\s+(?:from|by)\b/gi;

export const MARKETING_FILES = Object.freeze([
  'README.md',
  'docs/pages/index.html',
]);

// Marketing explains Station in Station's own terms. Integration guides,
// protocol references, compatibility notes, and required attribution may name
// third parties when the name is part of the technical truth.
const MARKETING_EXTERNAL_BRAND =
  /\b(?:Anthropic|Bedrock|Claude(?: Code)?|Codex|Copilot|Cursor|Kiro|Ollama|OpenAI|OpenCode|T3 Code|Windsurf|Zed)\b/gi;

// The privacy subset also backs scripts/repo-docs-hygiene.mjs, which sweeps
// EVERY tracked doc rather than the public manifest's nine — these patterns
// found nothing outside the manifest for months because nothing pointed them
// there. Personal mailboxes are a repo-wide concern only: public-projection
// docs never carry contact addresses at all.
export const PRIVACY_PATTERNS = Object.freeze([
  ['absolute-developer-path', ABSOLUTE_DEVELOPER_PATH],
  ['private-hostname', PRIVATE_HOSTNAME],
  ['private-ip', PRIVATE_IP],
  [
    'personal-mailbox',
    /\b[a-z0-9._%+-]+@(?:gmail|googlemail|outlook|hotmail|yahoo|icloud|proton|protonmail)\.com\b/gi,
  ],
]);

function allowed(file, code, value, line) {
  if (
    code === 'private-hostname' &&
    file === 'user/getting-started.md' &&
    /^localhost$/i.test(value)
  )
    return true;
  return (
    (code === 'internal-operation' &&
      file === 'reference/contributor-commands.md' &&
      value === 'scripts/') ||
    (code === 'source-provenance' &&
      file === 'reference/product-laws.md' &&
      line ===
        '| `station.lifecycle-completion.gate-derived` | A Flow run advances only when its gate evaluates matching evidence; completion is derived from that gate outcome rather than asserted by the caller. | `Flow run service` | `FlowRunService.evaluate` | `passes the gate and advances when claim evidence matches` | `routes back on failed evidence with attempt budget` | station#1555 |')
  );
}

/**
 * @param {{ source: string }[]} documents
 * @param {(file: string, encoding: BufferEncoding) => string} [read]
 */
export function publicDocsHygieneFindings(
  documents,
  read = (file, encoding) => readFileSync(file, encoding),
) {
  const patterns = [
    ['absolute-developer-path', ABSOLUTE_DEVELOPER_PATH],
    ['private-hostname', PRIVATE_HOSTNAME],
    ['private-ip', PRIVATE_IP],
    ['internal-operation', INTERNAL_OPERATION],
    ['source-provenance', SOURCE_PROVENANCE],
  ];
  const findings = [];
  for (const { source } of documents) {
    const text = read(`docs/${source}`, 'utf8');
    for (const [code, pattern] of patterns) {
      pattern.lastIndex = 0;
      for (const match of text.matchAll(pattern)) {
        const lineNumber = text.slice(0, match.index).split('\n').length;
        const line = text.split('\n')[lineNumber - 1];
        if (allowed(source, code, match[0], line)) continue;
        findings.push(`${source}:${lineNumber} ${code}: ${match[0]}`);
      }
    }
  }
  return findings;
}

/**
 * @param {readonly string[]} [files]
 * @param {(file: string, encoding: BufferEncoding) => string} [read]
 */
export function marketingHygieneFindings(
  files = MARKETING_FILES,
  read = (file, encoding) => readFileSync(file, encoding),
) {
  const findings = [];
  for (const file of files) {
    const source = read(file, 'utf8');
    MARKETING_EXTERNAL_BRAND.lastIndex = 0;
    for (const match of source.matchAll(MARKETING_EXTERNAL_BRAND)) {
      const lineNumber = source.slice(0, match.index).split('\n').length;
      findings.push(
        `${file}:${lineNumber} marketing-external-brand: ${match[0]}`,
      );
    }
  }
  return findings;
}

export async function runPublicDocsHygiene() {
  const documents = await loadPublicDocs();
  const findings = [
    ...publicDocsHygieneFindings(documents),
    ...marketingHygieneFindings(),
  ];
  if (findings.length === 0) {
    console.log(
      `Public documentation hygiene passed for ${documents.length} admitted documents and ${MARKETING_FILES.length} marketing surfaces.`,
    );
    return 0;
  }
  console.error(
    `Public documentation hygiene failed:\n${findings.map((finding) => `- ${finding}`).join('\n')}`,
  );
  return 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1])
  process.exitCode = await runPublicDocsHygiene();
