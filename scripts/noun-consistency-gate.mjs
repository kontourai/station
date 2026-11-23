#!/usr/bin/env node
// Zero-tolerance regression gate for the #190 noun-unification rename
// (prompt/runtime -> Skill/Engine, see docs/glossary.md). Current canon
// (#592, superseding #1349's umbrella): the Connections tab owns the noun —
// user-facing objects are "Model connection" and "Engine"; "provider" is
// brand/service copy and internal kind vocabulary only.
// The Playbooks→Skills merge retired "Playbook" entirely: there is ONE authored
// concept, a Skill, and some skills are runnable as a /command.
// ("Engines" hub section, engine chips) — "External", "ACP", and "Agent app"
// are retired user-facing words (docs/glossary.md,
// docs/design/agent-engine-unification.md §2). Unlike scripts/rename-inventory.mjs (which bans a
// whole substring anywhere in tracked files), "runtime"/"provider"/"prompt"
// are legitimate code identifiers (component/file names, prop names, server
// routes) — banning them file-wide would flag hundreds of correct internal
// identifiers. This gate is deliberately scoped to the three surfaces a user
// or a screen reader can actually observe: JSX attribute values (from a
// fixed allowlist of user-facing attribute names), JSX text nodes, and
// object-literal copy fields (`label:`/`title:`/`description:` … with a
// literal value — review L). It scans every tracked `.tsx` file under
// `src-ui/src` and `packages/sdk/src/components` (same discipline as
// rename-inventory.mjs), plus the non-JSX copy sources listed in
// COPY_SOURCE_FILES, never TypeScript identifiers, type names, import
// specifiers, object/variable names, or CSS class names.
//
// The scope is asserted before anything is scanned (`assertScopeIsHonest`,
// scripts/lib/gate-scope.mjs): under-enumerating and then reporting clean is
// the failure this gate shipped with for months (station#1559, #1543).
//
// Two structural hazards make a naive whole-file `>([^<>{}]*)<` text-node
// scan unsafe on this codebase, so this gate does more work than that:
//
//   1. Comments. `.tsx` files carry `//` and `/* */` comments that can
//      themselves contain tag-shaped text (e.g. a comment mentioning a
//      literal "<meta>" tag, or narrating "a confirm // prompt"). Comments
//      are never user-facing, so this gate strips them (while leaving
//      string/template literals alone) before scanning anything else.
//   2. TypeScript generics and JS expression children. `.tsx` files are
//      full of `useState<Record<string, string>>`-style generics whose
//      angle brackets are not JSX tag boundaries, and of
//      `{cond && (<Tag>...)}`-style expression children whose leading
//      `{cond && (` fragment is code, not text, even though it sits
//      directly between two regex-matched tags. This gate requires a
//      structurally tag-shaped match (name immediately followed by
//      attributes or a bare `>`/`/>` — a shape generics don't have) on
//      both sides of a candidate text run, and it additionally requires
//      the gap between them to be brace-balanced (masking out any
//      complete `{...}` expressions of arbitrary nesting depth first) —
//      an unbalanced or stray-bracketed gap means the two matched tags
//      are not really text-adjacent siblings, and the gap is skipped
//      rather than guessed at. This trades a few missed edge cases for
//      zero false positives, which matters more for a zero-tolerance gate
//      than exhaustive coverage.
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  assertScopeIsHonest,
  describeScope,
  listTrackedFilesUnder,
  UI_SCAN_EXTENSIONS,
  UI_SCAN_ROOTS,
} from './lib/gate-scope.mjs';
import { invokedDirectly } from './lib/module-entry.mjs';

/**
 * The scope this gate reports on. ONE shared constant, imported from the
 * scope lib alongside the ratchet (gate-scope.test.ts pins that neither gate
 * declares its own) — widening or narrowing is a decision made once, there.
 */
export const SCAN_ROOTS = UI_SCAN_ROOTS;
export const SCAN_EXTENSIONS = UI_SCAN_EXTENSIONS;

/**
 * Non-JSX user-facing copy sources (station#1543). The gate's `src-ui/**`
 * scope was correct while all user-facing settings copy lived in components;
 * #1441 moved it into the settings registry, whose `label`/`description`/
 * `placeholder` strings render straight into `PageRow`'s label, description,
 * and `aria-label`. The gate kept reporting clean and meant "clean in the
 * places I still look at."
 *
 * Files listed here are scanned with `scanCopySourceContent` (object-literal
 * fields) instead of the JSX scanners, and they are pinned into the scope
 * assertion so this file's removal from the scope cannot pass silently.
 */
export const COPY_SOURCE_FILES = [
  'packages/contracts/src/settings-registry.ts',
  // The device-scope registry is the same kind of file, read by the same
  // person, and was outside the scope while carrying 27 labels, 27 help
  // sentences and 27 descriptions (epic #2144 slice 2). Its factory has a
  // different name, hence COPY_SOURCE_OPENERS below.
  'packages/contracts/src/device-settings.ts',
];

/**
 * The object-literal factory whose blocks carry a file's user-facing copy.
 * `scanCopySourceContent` reads copy only from inside these blocks, because
 * the same field identifiers appear in each file's own `interface`
 * declaration where they are types, not copy.
 *
 * A file with no entry uses `defineSetting(`. The two openers are disjoint as
 * substrings — `defineDeviceSetting(` does not contain `defineSetting(` — so
 * neither file's blocks can be found by the other's opener, and a file
 * scanned with the wrong one reports zero blocks, which is a hard failure
 * rather than a quiet clean scan.
 */
/**
 * Plain TypeScript modules that hold user-facing words as string literals
 * (row action labels, notice text) rather than JSX. The JSX scanners never
 * read them, so a retired phrase written as `label: 'Settle conversation'`
 * passed the gate. They are scanned for the retired user terms only, in
 * every string and template literal: the older noun families have code
 * senses (`agent`, `prompt`) a literal scan cannot tell from copy.
 */
export const LITERAL_COPY_FILES = [
  'src-ui/src/components/inbox-row/inbox-row-actions.ts',
  'src-ui/src/components/inbox-row/snooze-presets.ts',
  'src-ui/src/components/chat-dock/mobile-activity-groups.ts',
  'src-ui/src/components/chat-dock/useInboxGroups.ts',
];

export const COPY_SOURCE_OPENERS = {
  'packages/contracts/src/device-settings.ts': 'defineDeviceSetting(',
};

/**
 * Paths that must be inside the enumerated scope. The tree-walk oracle in
 * `assertScopeIsHonest` is derived from `SCAN_ROOTS`, so narrowing the roots
 * would narrow the oracle with it; this pinned list is the part that cannot be
 * narrowed silently. It carries exactly the files station#1559 and #1543 found
 * outside the scope of a gate that reported clean.
 *
 * Every entry is a literal. The first draft ended with `...COPY_SOURCE_FILES`
 * and fault injection caught it: emptying COPY_SOURCE_FILES also emptied the
 * pin, so the gate went straight back to printing OK over a registry it had
 * stopped scanning — the pin evaporating together with the thing it pins. A
 * pinned inventory derived from the scope it guards pins nothing.
 */
export const PINNED_SCOPE_INVENTORY = [
  'src-ui/src/App.tsx',
  'src-ui/src/main.tsx',
  'packages/contracts/src/settings-registry.ts',
  'packages/contracts/src/device-settings.ts',
  // Review L: this file rendered "{title} Prompts" as JSX text while sitting
  // outside the gate's only root — the pin keeps a future root-narrowing from
  // re-hiding it.
  'packages/sdk/src/components/LayoutHeader.tsx',
];

/**
 * `playbooks?` joined the ban when the Playbooks UI was DELETED rather than
 * renamed: every playbook is a skill, some of which are runnable as a
 * `/command`, so a user-facing "playbook" is now a word for a thing Station
 * does not have. The word survives only as command-palette KEYWORDS (a `.ts`
 * file this gate does not scan, and deliberately so — a reader who learned the
 * old noun must still find the surface that replaced it) and in code comments,
 * which are stripped before scanning.
 *
 * `prompts?` sits OUT of this case-insensitive family: the
 * LLM sense — "a text-only prompt", "the system prompt" — is canonical
 * lowercase prose, and banning it made identical copy fail the moment it
 * moved under a copy key. The PRODUCT noun is the retired surface's own
 * Title-Case name, and that is what RETIRED_PRODUCT_NOUN_PATTERN below bans.
 */
export const BANNED_WORD_PATTERN = /\b(runtimes?|guidance|playbooks?)\b/i;

/**
 * The retired Prompts SURFACE, by its own spelling: capital-P `Prompt`/
 * `Prompts` as a standalone word. Case-SENSITIVE by design, exactly like
 * RETIRED_NOUN_PATTERN — lowercase "prompt"/"prompts" is the LLM sense and
 * passes; a user-facing "Prompts" tab, group or button is the product noun
 * and fails.
 */
export const RETIRED_PRODUCT_NOUN_PATTERN = /\bPrompts?\b/;

/**
 * Station#975 (unification slice 5) D-4: the agent-editor "type select" was
 * the one place "External" survived (docs/glossary.md's "known-remaining"
 * note) — the engine picker retires it. Case-SENSITIVE (unlike
 * BANNED_WORD_PATTERN above) so canonical lowercase prose like "an external
 * engine" or "external agents run on their own engine" (docs/glossary.md's
 * own vocabulary) survives; only the retired Title-Case UI strings and the
 * bare acronym "ACP" trip this pattern.
 */
export const RETIRED_NOUN_PATTERN = /\b(External agents?|Agent apps?|ACP)\b/;

/**
 * User-facing terms retired by the 2026-11 UI copy pass (docs/glossary.md,
 * "User-facing labels"). Each entry is zero-tolerance once active, like the
 * patterns above, and case-insensitive: none of these phrases has a
 * legitimate lowercase sense in UI copy.
 *
 * An entry marked `pending: true` is written and tested but not enforced:
 * the copy lanes that remove the last uses land separately, and enforcing a
 * rule before they merge would fail every unrelated change. To activate one
 * after those merge, delete its `pending` flag. The test pins that every
 * pending entry still catches a violation when enabled, so a flip is a
 * one-line change with a proven rule behind it.
 */
export const RETIRED_USER_TERMS = Object.freeze([
  { term: 'AI app', use: 'engine', pattern: /\bAI apps?\b/i, pending: true },
  {
    term: 'device hub',
    use: 'device helper',
    pattern: /\bdevice hubs?\b/i,
    pending: true,
  },
  {
    term: 'Station owner',
    use: 'Station operator',
    pattern: /\bStation owners?\b/i,
    pending: true,
  },
  {
    term: 'built-in assistant',
    use: "Station's engine or the Station agent",
    pattern: /\bbuilt-in assistants?\b/i,
    pending: true,
  },
  {
    term: 'default assistant',
    use: "Station's engine or the Station agent",
    pattern: /\bdefault assistants?\b/i,
    pending: true,
  },
  {
    term: 'credential entry',
    use: 'account',
    pattern: /\bcredential entr(?:y|ies)\b/i,
    pending: true,
  },
  // Retired by the first-release design (docs/design/first-release.md, "Words
  // that change"; epic #5386). Each stays pending until the slice that
  // removes its last uses lands and deletes the flag. Only distinctive
  // phrases are listed: single words the design also retires (Connections,
  // Plugins, Registry, Layout, Profile, Basis, Settle, Dismiss, Hide, Revoke,
  // READY, Integration, MCP server) keep legitimate uses this
  // case-insensitive mechanism cannot tell apart.
  // Customize and Station areas (first-release-customize.md,
  // first-release-station.md, first-release-first-run.md).
  {
    term: 'model connection',
    use: 'provider',
    pattern: /\bmodel connections?\b/i,
    pending: true,
  },
  // Also matches the network sense ("connect through a proxy"); the slice
  // that enables it decides each such use.
  {
    term: 'Connect through',
    use: 'Runs through',
    pattern: /\bconnect through\b/i,
    pending: true,
  },
  {
    term: 'Pair a device',
    use: 'Connect a device',
    pattern: /\bpair (?:a |this |another |your )?(?:device|phone)s?\b/i,
    pending: true,
  },
  // Projects area (first-release-projects.md).
  {
    term: 'Workspace view',
    use: 'view',
    pattern: /\bworkspace views?\b/i,
    pending: true,
  },
  {
    term: 'Starter layout',
    use: 'view',
    pattern: /\bstarter layouts?\b/i,
    pending: true,
  },
  {
    term: 'Files and connections',
    use: 'Files',
    pattern: /\bfiles (?:&|&amp;|and) connections\b/i,
    pending: true,
  },
  // Chat area (first-release-chat.md).
  {
    term: 'Conversation stats',
    use: 'Usage',
    pattern: /\bconversation stat(?:s|istics)\b/i,
    pending: true,
  },
  {
    term: 'Chat inventory',
    use: 'Work',
    pattern: /\bchat inventory\b/i,
    pending: true,
  },
  {
    term: 'Chat settings',
    use: 'Setup',
    pattern: /\bchat settings\b/i,
    pending: true,
  },
  {
    term: 'Fork from here',
    use: 'New chat from here',
    pattern: /\bfork from here\b/i,
    pending: true,
  },
  {
    term: 'Branch from this answer',
    use: 'New chat from here',
    pattern: /\bbranch from this answer\b/i,
    pending: true,
  },
  {
    term: 'New chat from this message',
    use: 'New chat from here',
    pattern: /\bnew chat from this message\b/i,
    pending: true,
  },
  {
    term: 'Rewind conversation',
    use: 'Rewind chat to here',
    pattern: /\brewind conversation\b/i,
    pending: true,
  },
  {
    term: 'Restore workspace',
    use: 'Restore files to here',
    pattern: /\brestore workspace\b/i,
    pending: true,
  },
  {
    term: 'Reset agent context',
    use: 'Start fresh context',
    pattern: /\breset agent context\b/i,
    pending: true,
  },
  // Inbox (first-release-automations-inbox.md, automations-inbox-13): one
  // verb, Mark done, and Reopen undoes it; one snooze list with Wake now.
  // Enforced: the inbox slice removed their last uses.
  {
    term: 'Settle conversation',
    use: 'Mark done',
    pattern: /\bsettle conversations?\b/i,
  },
  {
    term: 'Dismiss from inbox',
    use: 'Mark done',
    pattern: /\bdismiss from (?:the )?inbox\b/i,
  },
  {
    term: 'Hide from inbox',
    use: 'Mark done',
    pattern: /\bhide from (?:the )?inbox\b/i,
  },
  {
    term: 'Restore to inbox',
    use: 'Reopen',
    pattern: /\brestore to (?:the )?inbox\b/i,
  },
  {
    term: 'Discard unsent draft',
    use: 'Discard draft',
    pattern: /\bdiscard unsent drafts?\b/i,
  },
  {
    term: 'Unsnooze',
    use: 'Wake now',
    pattern: /\bunsnooz(?:e|ed|ing)\b/i,
  },
  // The dock's list reads Chats; Inbox becomes the attention page's word.
  // Only phrases that can name nothing but the dock list are listed: "Search
  // inbox" or "Refresh inbox" could be the page's own once it is the Inbox.
  {
    term: 'Show inbox',
    use: 'Show chats',
    pattern: /\b(?:show|hide) inbox\b/i,
  },
  {
    term: 'Inbox chats',
    use: 'Chats',
    pattern: /\binbox chats\b/i,
  },
]);

/** The retired user-facing terms the gate enforces today. */
export const ACTIVE_RETIRED_USER_TERMS = Object.freeze(
  RETIRED_USER_TERMS.filter((entry) => !entry.pending),
);

/**
 * Every stale-noun pattern, global, for one scan: the fixed families above
 * plus the given retired user terms. Each is a fresh RegExp so exec loops
 * never share `lastIndex`.
 */
function staleNounPatterns(retiredTerms) {
  return [
    new RegExp(BANNED_WORD_PATTERN.source, 'gi'),
    new RegExp(RETIRED_NOUN_PATTERN.source, 'g'),
    new RegExp(RETIRED_PRODUCT_NOUN_PATTERN.source, 'g'),
    ...retiredTerms.map(({ pattern }) => new RegExp(pattern.source, 'gi')),
  ];
}

/** Whether one piece of copy carries any stale noun. */
function hasStaleNoun(text, retiredTerms) {
  return staleNounPatterns(retiredTerms).some((pattern) => pattern.test(text));
}

const ATTR_NAMES = [
  'label',
  'title',
  'subtitle',
  'placeholder',
  'aria-label',
  'alt',
  'emptyTitle',
  'emptyDescription',
  'listEmptyTitle',
  'listEmptyDescription',
  'searchPlaceholder',
  'confirmLabel',
  'addLabel',
  'manageLabel',
  'description',
];

const ATTR_NAME_GROUP = ATTR_NAMES.join('|');

// `label="No runtime connections"` — plain double-quoted JSX attribute value.
const ATTR_STRING_PATTERN = new RegExp(
  `(?:${ATTR_NAME_GROUP})\\s*=\\s*"([^"]*)"`,
  'g',
);

// `subtitle={\`Check readiness and test your ${x}\`}` — template-literal form,
// used for dynamic attribute values.
const ATTR_TEMPLATE_PATTERN = new RegExp(
  `(?:${ATTR_NAME_GROUP})\\s*=\\s*\\{\`([^\`]*)\`\\}`,
  'g',
);

// `title={'runtime'}` / `title={"runtime"}` — a plain string literal wrapped
// in a JSX expression container, used when a prop's type expects an
// expression rather than accepting a bare string attribute. Two capture
// groups (single-quoted, double-quoted); exactly one is populated per match.
const ATTR_EXPR_STRING_PATTERN = new RegExp(
  `(?:${ATTR_NAME_GROUP})\\s*=\\s*\\{\\s*(?:'((?:[^'\\\\]|\\\\.)*)'|"((?:[^"\\\\]|\\\\.)*)")\\s*\\}`,
  'g',
);

// `label: 'No runtime connections'` — a copy field of an OBJECT literal.
// Review L: user-facing copy also travels as object-literal fields (a card
// array's `title`/`description`, a status strip's `label`, a `spec={{ title:
// ... }}` prop), and the JSX-only scanners never read those — the gate
// reported clean over copy users could see. The KEY list is ATTR_NAMES (the
// same user-facing field vocabulary the attribute scanners pin), and the
// value must be a plain string or template literal, so identifiers, ternaries
// and function calls are never mis-read as copy. One capture group: the whole
// literal including its quotes.
const OBJECT_COPY_FIELD_PATTERN = new RegExp(
  `\\b(?:${ATTR_NAME_GROUP})\\s*:\\s*('(?:[^'\\\\]|\\\\.)*'|"(?:[^"\\\\]|\\\\.)*"|\`[^\`]*\`)`,
  'g',
);

// A single JSX attribute: `name`, or `name="..."` / `name='...'` /
// `name={...}` (the `{...}` value tolerates up to two levels of nested
// braces, which covers the vast majority of this codebase's inline object
// literals and event handlers). Used only to find the *shape* of a real
// tag, not to extract attribute values (that's ATTR_STRING/TEMPLATE above).
const ATTR_EXPR_VALUE = '\\{(?:[^{}]|\\{(?:[^{}]|\\{[^{}]*\\})*\\})*\\}';
const ATTR_VALUE = `(?:"[^"]*"|'[^']*'|${ATTR_EXPR_VALUE})`;
const SINGLE_ATTR = `\\s+[A-Za-z_$][\\w-]*(?:\\s*=\\s*${ATTR_VALUE})?`;

// A structurally-complete JSX tag: open (`<div ...>`), close (`</div>`), or
// self-closing (`<Foo ... />`). Requires the tag name to start with a
// letter and be immediately followed by attributes or the closing `>`/`/>`
// — a shape TypeScript generics like `<string>`/`<Record<...>>` don't
// reliably have once nested (`<Record<string, string>>` fails to match
// because the inner `<string` isn't followed by attributes or `>`).
const TAG_PATTERN = new RegExp(
  `<\\/?[A-Za-z][\\w.]*(?:${SINGLE_ATTR})*\\s*\\/?>`,
  'g',
);

// React Context provider components (`<MyContextProvider>`, `<Ctx.Provider>`)
// are structurally never user-facing text. Kept as an explicit, documented
// exclusion per the gate's design doc even though the tag-aware scan above
// already can't capture a tag *name* as if it were text.
const PROVIDER_COMPONENT_PATTERN =
  /<[A-Za-z][\w.]*Provider\b|\bContext\.Provider\b/;

function lineNumberAt(content, index) {
  let line = 1;
  for (let i = 0; i < index; i++) {
    if (content[i] === '\n') line++;
  }
  return line;
}

function normalizeSnippet(snippet) {
  return snippet.replace(/\s+/g, ' ').trim();
}

/**
 * Strips `//` line comments and `/* *\/` block comments from source text,
 * replacing their content with spaces (preserving newlines, so line numbers
 * computed against the result still line up with the original file).
 * String and template literals are copied through verbatim (respecting
 * backslash escapes) so a `//` inside a URL string is never mistaken for a
 * comment, and so JSX attribute-value scanning downstream still works.
 */
export function stripComments(source) {
  let out = '';
  let i = 0;
  const n = source.length;
  while (i < n) {
    const two = source.slice(i, i + 2);
    if (two === '//') {
      while (i < n && source[i] !== '\n') {
        out += ' ';
        i++;
      }
      continue;
    }
    if (two === '/*') {
      out += '  ';
      i += 2;
      while (i < n && source.slice(i, i + 2) !== '*/') {
        out += source[i] === '\n' ? '\n' : ' ';
        i++;
      }
      if (i < n) {
        out += '  ';
        i += 2;
      }
      continue;
    }
    const ch = source[i];
    if (ch === '"' || ch === "'" || ch === '`') {
      out += ch;
      i++;
      while (i < n) {
        if (source[i] === '\\' && i + 1 < n) {
          out += source[i] + source[i + 1];
          i += 2;
          continue;
        }
        out += source[i];
        if (source[i] === ch) {
          i++;
          break;
        }
        i++;
      }
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

/**
 * Finds the index of the `}` that closes the `{` at `text[openIndex]`,
 * tracking nested-brace depth. String/template literals are skipped over
 * wholesale (their contents never affect the depth count, exactly like a
 * real JS tokenizer would treat them as a single token) so a `}` inside a
 * string (e.g. `fn('a}b')`) or a `${...}` inside a template literal never
 * desyncs the count. Returns -1 if the expression never closes (the region
 * runs off the end of `text`).
 */
function findMatchingBrace(text, openIndex) {
  let depth = 0;
  let i = openIndex;
  const n = text.length;
  while (i < n) {
    const ch = text[i];
    if (ch === '"' || ch === "'" || ch === '`') {
      const quote = ch;
      i++;
      while (i < n) {
        if (text[i] === '\\' && i + 1 < n) {
          i += 2;
          continue;
        }
        if (text[i] === quote) {
          i++;
          break;
        }
        i++;
      }
      continue;
    }
    if (ch === '{') {
      depth++;
      i++;
      continue;
    }
    if (ch === '}') {
      depth--;
      i++;
      if (depth === 0) return i - 1;
      continue;
    }
    i++;
  }
  return -1;
}

const BARE_SINGLE_QUOTE_LITERAL = /^'(?:[^'\\]|\\.)*'$/;
const BARE_DOUBLE_QUOTE_LITERAL = /^"(?:[^"\\]|\\.)*"$/;
const BARE_TEMPLATE_LITERAL = /^`(?:[^`\\]|\\.)*`$/;

/**
 * Masks a simple (non-template) string literal's delimiting quotes and
 * backslash-escapes to spaces, but leaves the literal's actual text content
 * untouched — the opposite of the old all-or-nothing masking, used when a
 * `{...}` JSX-expression child turns out to be *nothing but* this one
 * string literal (i.e. genuine user-facing text, not code).
 */
function maskSimpleStringLiteral(literalText) {
  const chars = literalText.split('');
  const last = chars.length - 1;
  chars[0] = literalText[0] === '\n' ? '\n' : ' ';
  if (last > 0) chars[last] = literalText[last] === '\n' ? '\n' : ' ';
  let i = 1;
  while (i < last) {
    if (literalText[i] === '\\' && i + 1 < last) {
      chars[i] = ' ';
      chars[i + 1] = literalText[i + 1] === '\n' ? '\n' : ' ';
      i += 2;
      continue;
    }
    i++;
  }
  return chars.join('');
}

/**
 * Masks a bare template literal (backticks + any `${...}` interpolations)
 * so the literal *text* stays visible for scanning but every `${...}`
 * interpolation — genuine code, e.g. `${runtimeCount}` — is blanked out,
 * exactly mirroring how the JSX-attribute template pattern already treats
 * `subtitle={\`... ${x} ...\`}`.
 */
function maskTemplateLiteral(literalText) {
  const chars = literalText.split('');
  const last = chars.length - 1;
  chars[0] = literalText[0] === '\n' ? '\n' : ' ';
  if (last > 0) chars[last] = literalText[last] === '\n' ? '\n' : ' ';
  let i = 1;
  while (i < last) {
    if (literalText[i] === '\\' && i + 1 < last) {
      chars[i] = ' ';
      chars[i + 1] = literalText[i + 1] === '\n' ? '\n' : ' ';
      i += 2;
      continue;
    }
    if (literalText[i] === '$' && literalText[i + 1] === '{') {
      const closeIdx = findMatchingBrace(literalText, i + 1);
      const end = closeIdx === -1 ? last : closeIdx + 1;
      for (let k = i; k < end; k++) {
        chars[k] = literalText[k] === '\n' ? '\n' : ' ';
      }
      i = end;
      continue;
    }
    i++;
  }
  return chars.join('');
}

/**
 * If `trimmed` is *nothing but* a single string or template literal (no
 * surrounding code — e.g. `'No runtime connections'` or
 * `` `No ${x} runtimes` ``, as opposed to `fn('a}b')` or `cond ? 'a' : 'b'`),
 * returns the literal masked so its text content stays scannable (template
 * interpolations still masked). Returns null for anything else, signalling
 * "this is a real code expression, mask it opaquely."
 */
function maskBareLiteral(trimmed) {
  if (
    BARE_SINGLE_QUOTE_LITERAL.test(trimmed) ||
    BARE_DOUBLE_QUOTE_LITERAL.test(trimmed)
  ) {
    return maskSimpleStringLiteral(trimmed);
  }
  if (BARE_TEMPLATE_LITERAL.test(trimmed)) {
    return maskTemplateLiteral(trimmed);
  }
  return null;
}

/**
 * Masks every character inside `{...}` JS-expression regions (arbitrary
 * nesting depth, string-literal aware so a brace inside a string doesn't
 * desync the depth count) with a space, leaving depth-0 ("real JSX
 * children") characters untouched — with one exception: a `{...}` region
 * whose *entire* content (ignoring surrounding whitespace) is a single bare
 * string or template literal (e.g. `{'No runtime connections'}` or
 * `` {`No ${x} runtimes`} `` as a JSX child, the idiomatic React form for
 * dynamic/interpolated copy) is genuine user-facing text, not code — its
 * literal text is kept scannable (template `${...}` interpolations are
 * still masked, since those are code). Any other expression shape
 * (`{someRuntimeVar}`, `{fn('a}b')}`, `{cond && (<A/>)}`, etc.) is masked
 * opaquely exactly as before. Reports `unbalanced: true` if the region ends
 * with an open expression, or starts already "inside" one (a stray `}` at
 * depth 0) — both signal that the two tags bounding this gap are not real
 * text-adjacent siblings (e.g. `{cond && (<A/>` — the gap after `<A/>`'s
 * close continues an expression that started earlier), so the gap must not
 * be treated as text.
 */
export function maskExpressions(text) {
  const chars = text.split('');
  let unbalanced = false;
  let i = 0;
  const n = text.length;
  while (i < n) {
    const ch = text[i];
    if (ch === '}') {
      unbalanced = true;
      i++;
      continue;
    }
    if (ch !== '{') {
      i++;
      continue;
    }
    const spanStart = i;
    const closeIdx = findMatchingBrace(text, spanStart);
    if (closeIdx === -1) {
      unbalanced = true;
      for (let k = spanStart; k < n; k++) {
        chars[k] = text[k] === '\n' ? '\n' : ' ';
      }
      break;
    }
    const spanEnd = closeIdx + 1; // exclusive, one past the closing '}'
    const inner = text.slice(spanStart + 1, closeIdx);
    const trimStartLen = inner.length - inner.trimStart().length;
    const trimEndLen = inner.length - inner.trimEnd().length;
    const trimmed = inner.slice(trimStartLen, inner.length - trimEndLen);
    const literalMasked = trimmed ? maskBareLiteral(trimmed) : null;

    chars[spanStart] = text[spanStart] === '\n' ? '\n' : ' ';
    chars[closeIdx] = text[closeIdx] === '\n' ? '\n' : ' ';
    if (literalMasked !== null) {
      const innerStart = spanStart + 1;
      for (let k = 0; k < trimmed.length; k++) {
        chars[innerStart + trimStartLen + k] = literalMasked[k];
      }
      // Leading/trailing whitespace within `inner` is left as the original
      // (whitespace) character — harmless, never matches a banned word.
    } else {
      for (let k = spanStart + 1; k < closeIdx; k++) {
        chars[k] = text[k] === '\n' ? '\n' : ' ';
      }
    }
    i = spanEnd;
  }
  return { masked: chars.join(''), unbalanced };
}

/**
 * Scans the plain-text run between two structurally-real, text-adjacent
 * JSX tags for banned words. Returns findings anchored at the absolute
 * file line of each match, with a readable single-line snippet taken from
 * the original (un-masked) text.
 */
/** Every match of `pattern` (forced global) against `text`, in order. */
function allMatches(text, pattern) {
  const out = [];
  let match;
  // biome-ignore lint/suspicious/noAssignInExpressions: idiomatic RegExp.exec loop
  while ((match = pattern.exec(text)) !== null) {
    out.push(match);
    if (match[0].length === 0) pattern.lastIndex++;
  }
  return out;
}

function scanChildrenBetweenTags(
  file,
  content,
  betweenStart,
  betweenEnd,
  retiredTerms,
) {
  const between = content.slice(betweenStart, betweenEnd);
  const { masked, unbalanced } = maskExpressions(between);
  if (unbalanced) return [];
  // A stray `<`/`>` surviving the mask means this gap still contains
  // something our tag/expression parsing didn't fully account for —
  // refuse to guess, treat as not-real-text rather than risk a false
  // positive.
  if (/[<>]/.test(masked)) return [];

  const findings = [];
  // Case-insensitive BANNED_WORD_PATTERN and the case-sensitive
  // RETIRED_*_PATTERN families can't share one flags-set regex, so each gets
  // its own exec loop; matches are merged and sorted so findings still surface
  // in file order.
  const matches = staleNounPatterns(retiredTerms)
    .flatMap((pattern) => allMatches(masked, pattern))
    .sort((a, b) => a.index - b.index);
  for (const match of matches) {
    const lineStart = between.lastIndexOf('\n', match.index) + 1;
    let lineEnd = between.indexOf('\n', match.index);
    if (lineEnd === -1) lineEnd = between.length;
    const normalized = normalizeSnippet(between.slice(lineStart, lineEnd));
    if (!normalized) continue;
    findings.push({
      file,
      line: lineNumberAt(content, betweenStart + match.index),
      snippet: normalized,
    });
  }
  return findings;
}

/**
 * The text of a string/template literal with its delimiters removed. A
 * template's `${...}` interpolations are code, not copy, and are blanked
 * before scanning (the words on either side of one still read as text).
 */
function objectCopyLiteralText(literal) {
  const inner = literal.slice(1, -1);
  if (literal[0] === '`') {
    return inner.replace(/\$\{[^}]*\}/g, ' ');
  }
  return inner;
}

/**
 * Scans object-literal copy fields (`label:`/`title:`/`description:` … with a
 * literal value) for banned words — the third user-facing surface, added with
 * review L. Runs over the SAME enumerated file set as the JSX scanners, so
 * the gate never has a layer whose scope diverges from another's.
 */
export function scanObjectLiteralCopy(
  file,
  rawContent,
  retiredTerms = ACTIVE_RETIRED_USER_TERMS,
) {
  const content = stripComments(rawContent);
  const findings = [];
  OBJECT_COPY_FIELD_PATTERN.lastIndex = 0;
  let match;
  // biome-ignore lint/suspicious/noAssignInExpressions: idiomatic RegExp.exec loop
  while ((match = OBJECT_COPY_FIELD_PATTERN.exec(content)) !== null) {
    const normalized = normalizeSnippet(
      objectCopyLiteralText(match[1]).replace(/\\(['"`\\])/g, '$1'),
    );
    if (!normalized) continue;
    if (!hasStaleNoun(normalized, retiredTerms)) continue;
    findings.push({
      file,
      line: lineNumberAt(content, match.index),
      snippet: normalized,
    });
  }
  return findings;
}

/**
 * Scans a single file's full text for banned words on the three user-facing
 * surfaces (JSX attribute values, JSX text nodes, object-literal copy
 * fields). Returns an array of findings: { file, line, snippet }.
 */
// A string or template literal on one line, or a template across lines.
const STRING_LITERAL_PATTERN =
  /'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`/g;

/**
 * Every string and template literal in `rawContent` that carries a retired
 * user term. Template interpolations are blanked first, so `${title}` cannot
 * hide or fake a phrase. Only the retired user terms are checked; see
 * `LITERAL_COPY_FILES`.
 */
export function scanStringLiterals(file, rawContent, retiredTerms) {
  const content = stripComments(rawContent);
  const findings = [];
  if (retiredTerms.length === 0) return findings;
  for (const match of content.matchAll(STRING_LITERAL_PATTERN)) {
    const literal = match[0].startsWith('`')
      ? maskTemplateLiteral(match[0])
      : match[0].slice(1, -1);
    const normalized = normalizeSnippet(literal);
    if (
      !retiredTerms.some(({ pattern }) =>
        new RegExp(pattern.source, 'i').test(normalized),
      )
    )
      continue;
    findings.push({
      file,
      line: lineNumberAt(content, match.index),
      snippet: normalized,
    });
  }
  return findings;
}

export function scanFileContent(
  file,
  rawContent,
  retiredTerms = ACTIVE_RETIRED_USER_TERMS,
) {
  const content = stripComments(rawContent);
  const findings = [];
  findings.push(...scanObjectLiteralCopy(file, content, retiredTerms));
  // Notice text, labels in object literals and `{'…'}` children: any string
  // literal in a scanned component, for the retired user terms. A literal
  // the attribute scanners already reported is not reported twice.
  const literals = scanStringLiterals(file, rawContent, retiredTerms);

  function collectAttr(pattern) {
    pattern.lastIndex = 0;
    let match;
    // biome-ignore lint/suspicious/noAssignInExpressions: idiomatic RegExp.exec loop
    while ((match = pattern.exec(content)) !== null) {
      // Multiple capture groups appear on patterns with a single-quoted /
      // double-quoted alternation (e.g. ATTR_EXPR_STRING_PATTERN); exactly
      // one is populated per match.
      const captured =
        match.slice(1).find((group) => group !== undefined) ?? '';
      const normalized = normalizeSnippet(captured);
      if (!normalized) continue;
      if (!hasStaleNoun(normalized, retiredTerms)) continue;
      if (PROVIDER_COMPONENT_PATTERN.test(match[0])) continue;
      findings.push({
        file,
        line: lineNumberAt(content, match.index),
        snippet: normalized,
      });
    }
  }

  collectAttr(ATTR_STRING_PATTERN);
  collectAttr(ATTR_TEMPLATE_PATTERN);
  collectAttr(ATTR_EXPR_STRING_PATTERN);

  // Tag-aware text-node scan: walk every structurally-complete JSX tag in
  // file order, and for each non-self-closing tag, test the plain-text
  // content up to the next recognized tag.
  TAG_PATTERN.lastIndex = 0;
  const tags = [];
  let tagMatch;
  // biome-ignore lint/suspicious/noAssignInExpressions: idiomatic RegExp.exec loop
  while ((tagMatch = TAG_PATTERN.exec(content)) !== null) {
    tags.push({
      start: tagMatch.index,
      end: tagMatch.index + tagMatch[0].length,
      text: tagMatch[0],
    });
  }

  for (let i = 0; i < tags.length - 1; i++) {
    const current = tags[i];
    const next = tags[i + 1];
    if (current.end >= next.start) continue;
    findings.push(
      ...scanChildrenBetweenTags(
        file,
        content,
        current.end,
        next.start,
        retiredTerms,
      ),
    );
  }

  const reported = new Set(findings.map(allowlistKey));
  for (const finding of literals)
    if (!reported.has(allowlistKey(finding))) findings.push(finding);
  return findings;
}

/**
 * The user-facing string fields of a `SettingDefinition`
 * (`packages/contracts/src/settings-registry.ts`, and the same four fields on
 * `DeviceSettingDefinition` in `packages/contracts/src/device-settings.ts`):
 * `label`, `help` and
 * `description` are required, `placeholder` optional. `label` and
 * `description` reach the screen through `views/settings/registry-row.tsx` —
 * `label` as both the row label and the control's `aria-label`. `help` is
 * copy of the same kind, written for the same reader (epic #2144 slice 2),
 * and is scanned from the day it is declared rather than from the day a
 * surface first renders it: copy that escapes the gate until a consumer
 * appears is copy nobody governs while it is being written. Keep this list in
 * step with that interface; `scanCopySourceContent` fails closed on any field
 * here whose value it cannot read, so a shape it does not understand reds the
 * gate instead of vanishing from the scan.
 */
const COPY_FIELD_NAMES = ['label', 'help', 'description', 'placeholder'];

/**
 * The scanner reads copy out of `defineSetting({ ... })` blocks rather than
 * scanning the whole file, because the same identifiers appear in this file's
 * `interface SettingDefinition` declaration (`label: string;`) where they are
 * types, not copy. Zero blocks is a hard failure, not a clean scan.
 */
const COPY_SOURCE_BLOCK_OPENER = 'defineSetting(';

/** The opener a registered copy source is scanned with. */
export function copySourceOpener(file) {
  return COPY_SOURCE_OPENERS[file] ?? COPY_SOURCE_BLOCK_OPENER;
}

const COPY_FIELD_KEY_PATTERN = new RegExp(
  `\\b(?:${COPY_FIELD_NAMES.join('|')})\\s*:\\s*`,
  'g',
);

// A single string literal (single-quoted, double-quoted, or a backtick
// template), anchored immediately after a copy field's `:`. Exactly one
// capture group is populated per match.
const COPY_FIELD_VALUE_SOURCE =
  '\'((?:[^\'\\\\]|\\\\.)*)\'|"((?:[^"\\\\]|\\\\.)*)"|`([^`]*)`';

/**
 * Scans a non-JSX copy source (station#1543) for banned words in the
 * user-facing string fields of its `defineSetting({ ... })` blocks.
 *
 * Returns `{ findings, unscannable }`. `unscannable` names any copy field
 * whose value is not a plain string literal — a concatenation, a ternary, an
 * imported constant. Those are reported as failures rather than skipped: a
 * scanner that silently drops the shapes it does not understand is the same
 * defect this whole change exists to close.
 */
export function scanCopySourceContent(
  file,
  rawContent,
  opener = copySourceOpener(file),
  retiredTerms = ACTIVE_RETIRED_USER_TERMS,
) {
  const content = stripComments(rawContent);
  const findings = [];
  const unscannable = [];
  let blocks = 0;

  let searchFrom = 0;
  for (;;) {
    const openerIndex = content.indexOf(opener, searchFrom);
    if (openerIndex === -1) break;
    const braceIndex = content.indexOf('{', openerIndex + opener.length);
    const closeIndex =
      braceIndex === -1 ? -1 : findMatchingBrace(content, braceIndex);
    if (braceIndex === -1 || closeIndex === -1) {
      unscannable.push({
        file,
        line: lineNumberAt(content, openerIndex),
        snippet: `${opener} block never closes — cannot scan its copy`,
      });
      searchFrom = openerIndex + opener.length;
      continue;
    }
    blocks++;

    const block = content.slice(braceIndex, closeIndex + 1);
    COPY_FIELD_KEY_PATTERN.lastIndex = 0;
    let keyMatch;
    // biome-ignore lint/suspicious/noAssignInExpressions: idiomatic RegExp.exec loop
    while ((keyMatch = COPY_FIELD_KEY_PATTERN.exec(block)) !== null) {
      const valueStart = keyMatch.index + keyMatch[0].length;
      const valuePattern = new RegExp(COPY_FIELD_VALUE_SOURCE, 'y');
      valuePattern.lastIndex = valueStart;
      const valueMatch = valuePattern.exec(block);
      const line = lineNumberAt(content, braceIndex + keyMatch.index);
      if (!valueMatch) {
        unscannable.push({
          file,
          line,
          snippet: normalizeSnippet(
            block.slice(keyMatch.index, keyMatch.index + 80),
          ),
        });
        continue;
      }
      const captured =
        valueMatch.slice(1).find((group) => group !== undefined) ?? '';
      const normalized = normalizeSnippet(captured);
      if (!normalized) continue;
      if (!hasStaleNoun(normalized, retiredTerms)) continue;
      findings.push({ file, line, snippet: normalized });
    }

    searchFrom = closeIndex + 1;
  }

  if (blocks === 0) {
    unscannable.push({
      file,
      line: 1,
      snippet:
        `no ${opener}...) blocks found — this file is registered as a ` +
        'user-facing copy source but the scanner read no copy from it',
    });
  }

  return { findings, unscannable };
}

export function listTrackedTsxFiles() {
  return SCAN_ROOTS.flatMap((root) =>
    listTrackedFilesUnder(root, SCAN_EXTENSIONS),
  );
}

function allowlistKey(entry) {
  return `${entry.file}:${entry.line}:${entry.snippet}`;
}

/**
 * Runs the full gate: scans every provided file, partitions findings into
 * "allowlisted" and "un-allowlisted", and detects stale allowlist entries
 * (entries that no longer match any current finding).
 *
 * `files` are scanned as JSX; `copySourceFiles` are scanned as object-literal
 * copy sources (station#1543). `unscannable` carries copy the second scanner
 * could not read — never silently dropped.
 */
export function runGate({
  files,
  readFile,
  allowlist,
  copySourceFiles = [],
  literalCopyFiles = [],
  retiredTerms = ACTIVE_RETIRED_USER_TERMS,
}) {
  const scanned = [];
  for (const file of files) {
    const content = readFile(file);
    scanned.push(...scanFileContent(file, content, retiredTerms));
  }
  for (const file of literalCopyFiles)
    scanned.push(...scanStringLiterals(file, readFile(file), retiredTerms));
  // One finding per place: a label can match both a JSX scanner and the
  // literal scan.
  const seen = new Set();
  const findings = scanned.filter((finding) => {
    const key = allowlistKey(finding);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  const unscannable = [];
  for (const file of copySourceFiles) {
    const result = scanCopySourceContent(
      file,
      readFile(file),
      copySourceOpener(file),
      retiredTerms,
    );
    findings.push(...result.findings);
    unscannable.push(...result.unscannable);
  }

  const findingKeys = new Set(findings.map(allowlistKey));
  const allowlistKeys = new Set(allowlist.map(allowlistKey));

  const unallowlisted = findings.filter(
    (finding) => !allowlistKeys.has(allowlistKey(finding)),
  );
  const staleEntries = allowlist.filter(
    (entry) => !findingKeys.has(allowlistKey(entry)),
  );

  return { findings, unallowlisted, staleEntries, unscannable };
}

function main() {
  const scriptDir = fileURLToPath(new URL('.', import.meta.url));
  const allowlistPath = `${scriptDir}noun-consistency-allowlist.json`;
  const allowlist = JSON.parse(readFileSync(allowlistPath, 'utf8'));

  const files = listTrackedTsxFiles();

  // Fail closed BEFORE scanning: a gate that under-enumerates its scope and
  // then reports clean is worse than a gate that does not run (station#1559).
  assertScopeIsHonest({
    gate: 'noun-consistency gate',
    roots: SCAN_ROOTS,
    extensions: SCAN_EXTENSIONS,
    pinned: PINNED_SCOPE_INVENTORY,
    files: [...files, ...COPY_SOURCE_FILES],
  });
  // A listed literal source that no longer exists is a scope that shrank.
  for (const file of LITERAL_COPY_FILES)
    if (!existsSync(file))
      throw new Error(
        `noun-consistency gate: literal copy source ${file} is missing; update LITERAL_COPY_FILES.`,
      );

  const { unallowlisted, staleEntries, unscannable } = runGate({
    files,
    readFile: (file) => readFileSync(file, 'utf8'),
    allowlist,
    copySourceFiles: COPY_SOURCE_FILES,
    literalCopyFiles: LITERAL_COPY_FILES,
  });

  console.log(
    'Noun-consistency gate (prompt/playbook/runtime -> Skill/Engine; the Connections tab owns the noun).\n',
  );

  let failed = false;

  if (unscannable.length > 0) {
    failed = true;
    console.error(
      `FAIL: ${unscannable.length} user-facing copy field(s) this gate could not read:\n`,
    );
    for (const entry of unscannable) {
      console.error(`  ${entry.file}:${entry.line}: ${entry.snippet}`);
    }
    console.error(
      "\nThe scanner reads plain string literals out of each copy source's own" +
        '\nfactory blocks (COPY_SOURCE_OPENERS). Copy it cannot read is reported' +
        '\ninstead of skipped — express the string as a literal, register the' +
        '\nright opener, or teach scanCopySourceContent the new shape.',
    );
  }

  if (unallowlisted.length > 0) {
    failed = true;
    console.error(
      `FAIL: ${unallowlisted.length} un-allowlisted stale-noun match(es) found:\n`,
    );
    for (const finding of unallowlisted) {
      console.error(`  ${finding.file}:${finding.line}: ${finding.snippet}`);
    }
    for (const { term, use } of ACTIVE_RETIRED_USER_TERMS)
      console.error(`  "${term}" is retired; say "${use}".`);
    console.error(
      '\nUse the current vocabulary (Skill, Command, Model, Engine) instead, or add a' +
        '\nreasoned scripts/noun-consistency-allowlist.json entry if this is a' +
        '\ngenuinely different concept (see scripts/noun-consistency-gate.mjs header).',
    );
  }

  if (staleEntries.length > 0) {
    failed = true;
    console.error(
      `\nFAIL: ${staleEntries.length} allowlist entry(ies) no longer match any finding (stale):\n`,
    );
    for (const entry of staleEntries) {
      console.error(`  ${entry.file}:${entry.line}: ${entry.snippet}`);
    }
    console.error(
      '\nRemove the stale entry(ies) from scripts/noun-consistency-allowlist.json.',
    );
  }

  if (!failed) {
    // The scope named here is the scope that was walked, rendered from the
    // enumerated file list rather than from a pathspec string (station#1559:
    // the old line named `src-ui/src/**/*.tsx` while the enumeration had
    // silently skipped App.tsx and main.tsx).
    const scope = describeScope({
      roots: SCAN_ROOTS,
      extensions: SCAN_EXTENSIONS,
      files,
      extraFiles: [...COPY_SOURCE_FILES, ...LITERAL_COPY_FILES],
    });
    const allowlistNote =
      allowlist.length === 0
        ? 'no allowlist entries'
        : `${allowlist.length} allowlist entries, all still live`;
    console.log(
      `OK: no un-allowlisted stale-noun matches. Scanned ${scope} — ` +
        `${files.length + COPY_SOURCE_FILES.length + LITERAL_COPY_FILES.length} files total, ` +
        `${allowlistNote}.`,
    );
    process.exit(0);
  }

  process.exit(1);
}

if (invokedDirectly(import.meta.url)) {
  main();
}
