import { readFileSync } from 'node:fs';
import path from 'node:path';
import { loadPublicDocs, renderMarkdown } from './build-github-pages.mjs';
import { invokedDirectly } from './lib/module-entry.mjs';

const ABSOLUTE_DEVELOPER_PATH =
  /(?:^|[\s`"'(])(?:\/(?:Users|home|private(?:\/(?:tmp|var))?|tmp|var|opt|Volumes)(?=\/|\b)|[A-Za-z]:[\\/]|\\\\[^\\/\s]+[\\/][^\\/\s]+)/gim;
// Match complete DNS labels: settings.local.json is not a .local host.
// A private media server's name is rejected however its two words are
// joined, in any case: hyphen (the hostname), whitespace (the display form),
// underscore, dot, en dash, URL-encoded space or hyphen, or nothing at all
// (camelCase identifiers). It sits outside the word boundaries so an env var
// or identifier that embeds it (`X_<name>_URL`, `use<Name>Host`) still
// matches. Public text calls it "home media", which this pattern does not
// match.
const PRIVATE_HOSTNAME =
  /\b(?:localhost|[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:internal|corp|local|lan|home\.arpa)(?![a-z0-9-]|\.[a-z0-9-])|(?:[a-z0-9-]+\.)?ts\.net|desktop-win)\b|brian(?:[-_.\s\u2013]|%20|%2d)*media/gi;
// IPv6 branches require the literal's shape — a hex first group and a colon —
// not a prefix: `(?:fc|fd)[\da-f:]+` matched every colon-free hex run starting
// fc/fd, which is ~1 in 128 git SHAs (the deploy ledger's `fd2c04e…`).
// The link-local branch carried the colon requirement but no bound on its
// first group, so a short SHA leading a commit subject (`fe8abc1: fix ...`)
// read as link-local. That group is exactly fe80-febf: four hex digits.
const PRIVATE_IP =
  /(?:\b(?:127(?:\.\d{1,3}){3}|10(?:\.\d{1,3}){3}|100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])(?:\.\d{1,3}){2}|192\.168(?:\.\d{1,3}){2}|169\.254(?:\.\d{1,3}){2}|172\.(?:1[6-9]|2\d|3[0-1])(?:\.\d{1,3}){2})\b|(?:^|[^\da-f])(?:::1|(?:fc|fd)[\da-f]{2}:[\da-f:]*|fe[89ab][\da-f]:[\da-f:]*)(?=$|[^\da-f]))/gi;
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
  /\b(?:Anthropic|Bedrock|Claude(?: Code)?|Codex|Copilot|Cursor|Kiro|Ollama|OpenAI|OpenCode|Windsurf|Zed)\b/gi;

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

const RENDERED_HREF = /\shref="([^"]+)"/g;
// The renderer replaces any href it cannot prove safe with `#`; on a link
// that did not ask for `#`, that ships a dead link no target check can see.
const DEAD_RENDERED_LINK = /<a href="#">([^<]*)<\/a>/g;
const NON_RELATIVE_HREF = /^(?:[a-z][a-z\d+.-]*:|\/\/|#)/i;

// Pages publishes only the manifest's documents, so a relative link from one
// of them to any other repository file renders as a 404. Links are read from
// the real Pages renderer rather than re-parsed here, so fenced code and the
// .md -> .html rewrite match what ships. Link a non-public document by its
// absolute GitHub URL instead. Until this rule, only the post-merge Pages
// build (check-generated-pages-links.mjs) saw these, after they landed.
/**
 * @param {{ source: string }[]} documents
 * @param {(file: string, encoding: BufferEncoding) => string} [read]
 */
export function publicProjectionLinkFindings(
  documents,
  read = (file, encoding) => readFileSync(file, encoding),
) {
  const published = new Set(
    documents.map(({ source }) => source.replace(/\.md$/, '.html')),
  );
  const findings = [];
  for (const { source } of documents) {
    const text = read(`docs/${source}`, 'utf8');
    const html = renderMarkdown(text);
    for (const [, label] of html.matchAll(DEAD_RENDERED_LINK)) {
      if (text.includes(`[${label}](#)`)) continue;
      findings.push(`${source} dead-link: [${label}] renders as href="#"`);
    }
    for (const match of html.matchAll(RENDERED_HREF)) {
      const href = match[1].replaceAll('&amp;', '&');
      if (NON_RELATIVE_HREF.test(href)) continue;
      // A root-absolute href leaves the Pages project path, so no admitted
      // document can satisfy it.
      const target = href.startsWith('/')
        ? href
        : path.posix.normalize(
            path.posix.join(
              path.posix.dirname(source),
              decodeURIComponent(href.split(/[?#]/, 1)[0]),
            ),
          );
      if (published.has(target)) continue;
      const markdownHref = href.replace(/\.html(?=[?#]|$)/, '.md');
      const index = text.indexOf(`](${markdownHref}`);
      const location =
        index === -1
          ? source
          : `${source}:${text.slice(0, index).split('\n').length}`;
      findings.push(
        `${location} non-public-link: ${markdownHref} (not admitted to Pages; use its absolute GitHub URL)`,
      );
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

/**
 * @param {{
 *   documents?: { source: string }[],
 *   read?: (file: string, encoding: BufferEncoding) => string,
 * }} [input]
 */
export async function runPublicDocsHygiene({
  documents: injectedDocuments,
  read = (file, encoding) => readFileSync(file, encoding),
} = {}) {
  const documents = injectedDocuments ?? (await loadPublicDocs());
  const findings = [
    ...publicDocsHygieneFindings(documents, read),
    ...publicProjectionLinkFindings(documents, read),
    ...marketingHygieneFindings(MARKETING_FILES, read),
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

if (invokedDirectly(import.meta.url))
  process.exitCode = await runPublicDocsHygiene();
