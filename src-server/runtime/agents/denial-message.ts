/**
 * archive#3210: the ONE place a user-visible tool-denial reason is composed.
 *
 * Why this module exists rather than a template string at each `deny()` site:
 * every denial message interpolates at least one value Station does not
 * author, and until archive#3210 nothing bounded any of them.
 *
 * - `tool.toolName` is in EVERY denial message (all eight `pre-tool-policy.ts`
 *   sites, both `agent-hooks.ts` templates, and both engine adapters'
 *   tool-gate fallbacks). `normalizeToolName` only camel-cases hyphens and
 *   underscores — it imposes no length limit and no charset restriction, so a
 *   492-character name carrying newlines and backticks survives it byte for
 *   byte. Mainstream providers happen to constrain function names
 *   (`^[a-zA-Z0-9_-]{1,64}$`), but that is an upstream constraint Station
 *   does not own, does not state, and does not verify, and it varies across
 *   the providers reachable here (Bedrock, Ollama, openai-compat).
 * - Two evaluator sites embed genuinely foreign prose: the approval guardian's
 *   `review.reason` is LLM-authored from a prompt that includes the tool's own
 *   MCP-server-supplied description and arguments, and the config-protection
 *   policy's `native` engine returns an external hook process's raw, untruncated
 *   `stderr`/`stdout`.
 *
 * That text is not only rendered to a human — the denial reason is also handed
 * back to the model as the failed tool call's error, so unbounded multi-line
 * foreign prose inside Station's own sentence is a prompt-injection surface in
 * both directions.
 *
 * The composer's guarantee, and the meaning of the
 * `stationComposedReason` marker it stamps on every denial it builds:
 *
 * 1. The sentence itself is Station prose supplied by the call site.
 * 2. The tool name is reduced to a conservative identifier charset and capped,
 *    so it cannot contribute whitespace, markdown, or a quote character.
 * 3. Any foreign fragment is flattened to a single line, stripped of every
 *    Unicode control and format character (so it can neither carry invisible
 *    structure nor REORDER the closing quote past itself), capped, wrapped in
 *    typographic quotes it cannot itself contain, and ATTRIBUTED to the
 *    non-Station source that produced it.
 *
 * That marker — not `policyDenied`, which derives provenance ("the policy
 * evaluator produced this") and drives archive#3091's badge — is what licenses
 * an engine adapter to carry a denial reason to the user verbatim.
 */

import type { ToolCallDenial } from '../types.js';

/**
 * Tool-name cap. 64 is the tightest mainstream provider function-name limit
 * (OpenAI's `^[a-zA-Z0-9_-]{1,64}$`); a name longer than the strictest
 * provider accepts has nothing to gain from being rendered in full, and the
 * cap is Station's own rather than a borrowed assumption about the provider.
 */
export const DENIAL_TOOL_NAME_MAX_LENGTH = 64;

/**
 * Foreign-text cap. Long enough for a real guardian sentence or a hook's
 * `BLOCKED: …` line, short enough that a subprocess cannot fill the
 * transcript (or the model's next prompt) with an unbounded stream.
 */
export const DENIAL_QUOTED_TEXT_MAX_LENGTH = 240;

/** Appended when either cap truncates. */
export const DENIAL_TRUNCATION_MARK = '…';

/**
 * The typographic quotes that delimit an attributed foreign fragment. They are
 * stripped from the fragment itself, so the quoted span's end cannot be forged
 * from inside it.
 */
const QUOTE_OPEN = '“';
const QUOTE_CLOSE = '”';

/**
 * Every run of characters outside a conservative identifier set collapses to a
 * single `?`. An allowlist (rather than a denylist of newlines and markdown
 * characters) is what makes "single-line" a DERIVED property of the result
 * instead of a separate step someone can forget: `\p{Zs}` is not in the set,
 * so no space can survive; `'` is not in it either, so a hostile name cannot
 * close the quotes the composer wraps it in; and `\p{Cf}` is not in it, so the
 * bidi-override vector described on `CONTROL_AND_FORMAT_CHARACTERS` below
 * cannot reach a tool name.
 *
 * The letter/mark/number classes are Unicode-wide rather than `A-Za-z0-9`
 * (archive#3210 LOW-4): this message is the ONLY place the user learns WHICH
 * tool was blocked, and an ASCII-only allowlist rendered a Japanese tool name
 * as `Tool '?' was denied.` — a denial that names nothing is one the user
 * cannot act on. None of the safety properties above depend on the script:
 * they come from the categories the set EXCLUDES, not from the ones it admits.
 *
 * Disclosed residue: `\p{L}` includes modifier letters such as U+02BC MODIFIER
 * LETTER APOSTROPHE, which is visually confusable with the `'` that delimits
 * the name. It cannot terminate that delimiter for any parser, and with
 * `\p{Cf}` stripped there is no reordering vector left, so the rendered span
 * still begins and ends where Station put it.
 */
const UNSAFE_TOOL_NAME_RUN = /[^\p{L}\p{M}\p{N}_.:\-/]+/gu;

/**
 * Characters Unicode itself classifies as controls (`Cc`) or format
 * characters (`Cf`). `Cc` is the C0/C1 range, including every newline form;
 * `Cf` is the invisible class — bidi overrides and isolates
 * (U+202A–U+202E, U+2066–U+2069), the zero-width and joiner characters
 * (U+200B–U+200F), SOFT HYPHEN, WORD JOINER, the BOM, and the tag
 * characters.
 *
 * This used to be the C0/C1 range alone: a set that reads as "the control
 * characters" while covering only half of the class that matters here. U+202E
 * RIGHT-TO-LEFT OVERRIDE, U+200B ZERO WIDTH SPACE and U+00AD SOFT HYPHEN all
 * passed through untouched (archive#3210 MED-2). The quoted fragment is
 * painted into a `<pre>` (`ToolCallDisplay.tsx`), so an RLO inside it reorders
 * the closing ” under the bidi algorithm: attacker text then DISPLAYS
 * outside the visible quotation, reading as the continuation of Station's own
 * sentence. Stripping the quote characters from the fragment stops it being
 * closed; it does not stop it being moved.
 *
 * The two Unicode categories are the derivation. The characters named above
 * are illustrations of what they contain, not the rule — a format character
 * added by a future Unicode version is covered without an edit here.
 *
 * Cost, stated rather than hidden: a legitimate ZWJ emoji sequence or a
 * Persian/Hindi ZWNJ inside a hook's message loses its joiner and renders as
 * its separate parts. A quoted denial fragment is the wrong place to trade a
 * display invariant for that.
 */
const CONTROL_AND_FORMAT_CHARACTERS = /[\p{Cc}\p{Cf}]+/gu;

/**
 * Truncate by CODE POINT rather than by UTF-16 code unit.
 * `String.prototype.slice` cuts between the halves of a surrogate pair, and
 * the lone surrogate left behind renders as U+FFFD — Station corrupting the
 * last character of the text it is quoting, at exactly the boundary where a
 * reader is least able to tell whether the mojibake came from Station or from
 * the source (archive#3210 LOW-3). Both caps below are therefore stated in
 * code points; for the ASCII names and messages that dominate in practice the
 * two units are the same number.
 */
function capCodePoints(value: string, maxCodePoints: number): string {
  const points = [...value];
  if (points.length <= maxCodePoints) return value;
  return `${points.slice(0, maxCodePoints).join('')}${DENIAL_TRUNCATION_MARK}`;
}

/**
 * The non-Station sources a denial may quote. A closed union, not a `string`:
 * the attribution names WHO spoke, so it must never itself be foreign text.
 */
export type QuotedDenialSource = 'approval guardian' | 'config-protection hook';

export interface QuotedDenialText {
  source: QuotedDenialSource;
  /** Foreign, unbounded. Flattened, capped, and quoted before it is rendered. */
  text: string;
}

export interface DenialReasonInput {
  /** Untrusted. Sanitized here, never interpolated by the caller. */
  toolName: string;
  /**
   * Station-authored prose completing the sentence `Tool '<name>' …`. It must
   * not interpolate any value Station does not author; that is what `quoted`
   * is for.
   */
  predicate: string;
  quoted?: QuotedDenialText;
}

/**
 * Render an untrusted tool name for inclusion in user-visible denial prose.
 * A normal tool name (`read_file`, `mcp__filesystem__write_file`,
 * `station-control_list_agents`) passes through unchanged.
 */
export function toolNameForDenialMessage(toolName: string): string {
  const safe = toolName.replace(UNSAFE_TOOL_NAME_RUN, '?');
  if (safe.length === 0) return '?';
  return capCodePoints(safe, DENIAL_TOOL_NAME_MAX_LENGTH);
}

/**
 * Flatten and cap a foreign fragment. Returns `''` when nothing survives, so
 * the caller renders no empty quotation.
 */
export function boundQuotedDenialText(text: string): string {
  const flattened = text
    .replace(CONTROL_AND_FORMAT_CHARACTERS, ' ')
    .replaceAll(QUOTE_OPEN, '"')
    .replaceAll(QUOTE_CLOSE, '"')
    .replace(/\s+/g, ' ')
    .trim();
  return capCodePoints(flattened, DENIAL_QUOTED_TEXT_MAX_LENGTH);
}

/**
 * Compose the user-visible reason for one denial.
 *
 * The tool name is interpolated in exactly one place in the codebase — here —
 * so a new `deny()` site inherits the bound without having to remember it: the
 * signature takes the name separately and the call site supplies only prose.
 */
export function denialReason(input: DenialReasonInput): string {
  const sentence = `Tool '${toolNameForDenialMessage(input.toolName)}' ${input.predicate}`;
  if (!input.quoted) return sentence;
  // Accepted residue (archive#3210 MED-2, secondary): the fragment may itself
  // contain the words of an attribution sentence and a `"`, so it can read as
  // a nested, fake attribution. That is left alone deliberately. The outer
  // attribution LEADS — a reader meets "Quoted from the <source> (not
  // Station's wording):" before any of the fragment — and the fragment cannot
  // produce a `”`, so the one typographic quote that closes the span is
  // always the last character Station wrote. Defending further would mean
  // Station policing a lexicon inside text it is explicitly presenting as not
  // its own, and a guardian has legitimate cause to quote a hook. The
  // structural claims are the ones worth enforcing, and they hold.
  const bounded = boundQuotedDenialText(input.quoted.text);
  if (bounded.length === 0) return sentence;
  // Attribution first, then the quotation: a reader (or a model) that stops
  // early still learns the words are not Station's.
  return `${sentence} Quoted from the ${input.quoted.source} (not Station's wording): ${QUOTE_OPEN}${bounded}${QUOTE_CLOSE}`;
}

export interface StationDenialInput extends DenialReasonInput {
  /**
   * archive#3091 provenance: set only where the staged pre-tool policy
   * evaluator produced the denial. It drives the client's policy-denied badge
   * and is deliberately NOT what licenses verbatim rendering.
   */
  policyDenied?: boolean;
}

/**
 * Build a `ToolCallDenial` whose reason this module composed.
 *
 * `stationComposedReason` is stamped on a `ToolCallDenial` here and nowhere
 * else, so a denial that reaches an engine adapter through the hook contract
 * without coming through this composer stays redacted.
 *
 * What that is NOT (archive#3210 review, MED-3): a construction-level
 * guarantee that no other text can ever wear the marker. Two limits, stated
 * rather than glossed:
 *
 * - `@voltagent/core`'s `buildToolErrorResult` copies EVERY own-enumerable
 *   property of a thrown error onto the tool's resolved output — that
 *   own-property channel is precisely how the marker survives to the adapter
 *   (see `voltagent-adapter.ts`). So an in-process tool that throws
 *   `Object.assign(new Error(text), { stationComposedReason: true })` has its
 *   own `text` rendered verbatim. A REMOTE MCP server cannot: its error
 *   crosses the protocol as `{ code, data }` and is reconstructed on this
 *   side, so it has no way to set an own property on the thrown object. The
 *   practical surface is therefore in-process tool code, which already runs
 *   inside Station's own process.
 * - "One composer" is true of the denials that flow through
 *   `pre-tool-policy.ts`, `agent-hooks.ts`, and the two engine tool gates. It
 *   is NOT true of every denial reason in the tree: `claude-adapter.ts`'s
 *   policy timeout / policy-preparation failures and `acp-adapter.ts`'s
 *   policy-preparation failure each build a reason inline (interpolating a
 *   caught `error.message`), and those go to the Claude Code SDK's own
 *   permission contract, which performs no marker check at all. They are
 *   outside this module's reach, not covered by it.
 */
export function stationDenial(input: StationDenialInput): ToolCallDenial {
  return {
    allowed: false,
    reason: denialReason(input),
    stationComposedReason: true,
    ...(input.policyDenied ? { policyDenied: true as const } : {}),
  };
}
