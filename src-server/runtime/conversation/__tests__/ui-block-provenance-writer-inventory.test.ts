/**
 * station#1399 fix round 2, B3 (independent review) — a writer-inventory
 * ratchet for UI-block provenance sanitization, in the shape of this repo's
 * existing pinned-list-plus-discovery-sweep inventory tests (e.g.
 * `src-ui/src/__tests__/authenticated-stream-inventory.test.ts`).
 *
 * The review's own finding was that the ORIGINAL sanitizer suite asserted
 * "single writer" while a second, independent writer
 * (`AttachedSessionFollowService#appendAndPublish`) bypassed it entirely —
 * a claim nothing here checked. This file replaces that unchecked claim
 * with a live one: it re-derives, by grepping the actual source tree, every
 * file that can (1) persist a `CanonicalRuntimeEvent` (`.appendEvent(`/
 * `.appendEventIfAbsent(`), (2) publish one over the live event bus
 * (`eventBus.emit(SERVER_EVENTS.ORCHESTRATION_EVENT`), or (3) serve stored
 * conversation messages to a client (the one chat-history route) — and
 * asserts BOTH that the discovered set matches a PINNED list (so a new
 * writer forces a conscious update here, not a silent addition) AND that
 * every file in that set actually calls the sanitizer.
 *
 * A FUTURE writer that bypasses sanitization fails this test in the most
 * useful way: the discovery sweep finds a file not on the pinned list, and
 * the failure names that exact file.
 *
 * **Micro-round (M1, independent review) — two callsite-soundness gaps this
 * version closes:**
 *
 * 1. **Comment evasion.** A boolean "does this file mention `.appendEvent(`
 *    anywhere" check is satisfied by a call sitting in a COMMENT — this repo
 *    has been burned by exactly that evasion class before (`rename-inventory`
 *    exists for the same reason). {@link stripComments} removes block and
 *    line comments (respecting string/template literals) before any pattern
 *    is matched, so a commented-out or documentation-only mention no longer
 *    counts as coverage.
 * 2. **File-level containment hides a second, unsanitized callsite.** The
 *    original version asked "does this pinned file contain the sanitizer
 *    name ANYWHERE" — true even if a SECOND, bare `.appendEvent(` sits
 *    unsanitized two lines away, because the file-level substring check
 *    can't tell one callsite from another. This version pins an exact
 *    **callsite COUNT** per file ({@link PINNED_WRITER_CALLSITE_COUNTS}) — a
 *    new call site in an already-pinned file changes the count and reds the
 *    test, forcing a human to look at what was added and whether it needs
 *    its own sanitizer call, rather than silently inheriting the file's
 *    existing "it calls the sanitizer somewhere" pass.
 *
 * **Honest scope, stated once rather than implied (M1c):** this is a
 * TEXTUAL guard — a regexp over file contents, run through a comment
 * stripper that is itself a best-effort tokenizer (it does not parse regex
 * literals, so a `.appendEvent(`-shaped substring inside a regex literal
 * would misparse; none exists in this tree today). It cannot see an
 * aliased import (`import { appendEvent as ae } from ...; ae(...)`), a
 * bracket-access call (`eventStore['appendEvent'](...)`), or any other
 * dynamic-dispatch call shape. It is a REVIEW-FORCING TRIPWIRE that makes a
 * new textually-obvious writer impossible to add silently — it is not a
 * proof that no writer can ever bypass sanitization by construction. The
 * actual runtime invariant lives in the sanitizer seams themselves
 * (`safeSanitizeUIBlockEventProvenance` unconditionally overwriting
 * `attestationState`/`provenanceDigest`/`derivedFrom`,
 * `sanitizeConversationMessagesUIBlockProvenance` doing the same at the
 * serve boundary) — this file's job is to keep the LIST of places that must
 * call them from drifting out of review, not to substitute for them.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = process.cwd();
const SRC_SERVER_ROOT = join(REPO_ROOT, 'src-server');

const EXCLUDED_DIR_NAMES = new Set([
  'node_modules',
  '__tests__',
  'dist',
  '.git',
]);

/** Every `.ts` file under `src-server`, excluding tests/build output. */
function walkServerSourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (EXCLUDED_DIR_NAMES.has(entry)) continue;
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      walkServerSourceFiles(full, out);
      continue;
    }
    if (extname(entry) === '.ts' && !entry.endsWith('.test.ts')) {
      out.push(full);
    }
  }
  return out;
}

function relPath(absolute: string): string {
  return relative(REPO_ROOT, absolute).split('\\').join('/');
}

/**
 * Best-effort comment stripper (M1a): a single-pass tokenizer that removes
 * `//...` line comments and `/* ... *\/` block comments while leaving the
 * contents of `'...'`/`"..."`/`` `...` `` string and template literals
 * untouched (so a URL like `'https://example.com'` inside a string is not
 * mistaken for the start of a line comment). Deliberately NOT a full
 * parser: it does not recognize regex literals, so a `/` that opens a
 * regex is read as plain text — safe for this file's purpose (finding
 * `.appendEvent(`-shaped CODE, not comments) as long as no regex literal in
 * the scanned tree contains that exact substring, which none does today.
 */
function stripComments(source: string): string {
  let out = '';
  let i = 0;
  const n = source.length;
  while (i < n) {
    const two = source.slice(i, i + 2);
    if (two === '//') {
      while (i < n && source[i] !== '\n') i++;
      continue;
    }
    if (two === '/*') {
      i += 2;
      while (i < n && source.slice(i, i + 2) !== '*/') i++;
      i += 2;
      continue;
    }
    const c = source[i];
    if (c === '"' || c === "'" || c === '`') {
      const quote = c;
      out += c;
      i++;
      while (i < n && source[i] !== quote) {
        if (source[i] === '\\' && i + 1 < n) {
          out += source[i] + source[i + 1];
          i += 2;
          continue;
        }
        out += source[i];
        i++;
      }
      if (i < n) {
        out += source[i];
        i++;
      }
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/** Reads a file and returns it with comments stripped (M1a). */
function readSourceForScanning(absolutePath: string): string {
  return stripComments(readFileSync(absolutePath, 'utf8'));
}

function filesMatching(pattern: RegExp): string[] {
  const matches: string[] = [];
  for (const file of walkServerSourceFiles(SRC_SERVER_ROOT)) {
    if (pattern.test(readSourceForScanning(file))) matches.push(relPath(file));
  }
  return matches.sort();
}

/** Exact occurrence count of `pattern` in the comment-stripped source. */
function countMatches(absolutePath: string, pattern: RegExp): number {
  const source = readSourceForScanning(absolutePath);
  const global = new RegExp(
    pattern.source,
    `${pattern.flags.replace('g', '')}g`,
  );
  return source.match(global)?.length ?? 0;
}

const APPEND_EVENT_PATTERN = /\.appendEvent(IfAbsent)?\(/;
const EMIT_ORCHESTRATION_EVENT_PATTERN =
  /eventBus\.emit\(SERVER_EVENTS\.ORCHESTRATION_EVENT/;

describe('UI-block provenance — writer/server inventory ratchet (station#1399 fix round 2, B3; M1 micro-round)', () => {
  // Per-file callsite counts (M1b) — the union of every file that appears
  // in either the append or the publish inventory, with its EXACT count of
  // each pattern (0 where the pattern doesn't apply to that file). Changing
  // either number for a pinned file, or adding a new file, reds this test.
  const PINNED_WRITER_CALLSITE_COUNTS: Record<
    string,
    { appendEventCalls: number; emitCalls: number }
  > = {
    'src-server/runtime/bootstrap/runtime-initialize.ts': {
      appendEventCalls: 1,
      emitCalls: 1,
    },
    'src-server/services/orchestration/attached-session-follow-service.ts': {
      appendEventCalls: 1,
      emitCalls: 1,
    },
    'src-server/services/orchestration/conversation-lineage.ts': {
      // appendConversationFork (moved from the service by epic #4024
      // slice 5, #4155) and appendConversationForkIfAbsent, the retry-safe
      // twin. Both route through safeSanitizeUIBlockEventProvenance, which
      // is the property this ratchet exists to hold; the pattern counts
      // `.appendEventIfAbsent(` deliberately, so the second writer is a
      // real inventory change and not a loose match.
      appendEventCalls: 2,
      emitCalls: 0,
    },
    'src-server/services/orchestration/orchestration-service.ts': {
      // publishCanonicalEvent.
      appendEventCalls: 1,
      emitCalls: 1,
    },
    'src-server/services/orchestration/orchestration-session-state.ts': {
      appendEventCalls: 1,
      emitCalls: 0,
    },
  };

  const PINNED_EVENT_APPEND_WRITERS = Object.keys(
    PINNED_WRITER_CALLSITE_COUNTS,
  ).filter((file) => PINNED_WRITER_CALLSITE_COUNTS[file]!.appendEventCalls > 0);
  const PINNED_EVENT_PUBLISH_WRITERS = Object.keys(
    PINNED_WRITER_CALLSITE_COUNTS,
  ).filter((file) => PINNED_WRITER_CALLSITE_COUNTS[file]!.emitCalls > 0);

  it('the discovered set of .appendEvent(/.appendEventIfAbsent( call sites matches the pinned list exactly', () => {
    const discovered = filesMatching(APPEND_EVENT_PATTERN);
    expect(discovered).toEqual([...PINNED_EVENT_APPEND_WRITERS].sort());
  });

  it('the discovered set of eventBus.emit(SERVER_EVENTS.ORCHESTRATION_EVENT sites matches the pinned list exactly', () => {
    const discovered = filesMatching(EMIT_ORCHESTRATION_EVENT_PATTERN);
    expect(discovered).toEqual([...PINNED_EVENT_PUBLISH_WRITERS].sort());
  });

  it.each(Object.entries(PINNED_WRITER_CALLSITE_COUNTS))(
    '%s has exactly its pinned callsite counts (M1b — a new callsite in a pinned file must red, not silently pass)',
    (relativePath, expectedCounts) => {
      const absolute = join(REPO_ROOT, relativePath);
      expect({
        appendEventCalls: countMatches(absolute, APPEND_EVENT_PATTERN),
        emitCalls: countMatches(absolute, EMIT_ORCHESTRATION_EVENT_PATTERN),
      }).toEqual(expectedCounts);
    },
  );

  it.each(PINNED_EVENT_APPEND_WRITERS)(
    '%s calls the safe sanitizer before appending',
    (relativePath) => {
      const source = readSourceForScanning(join(REPO_ROOT, relativePath));
      expect(source).toContain('safeSanitizeUIBlockEventProvenance');
    },
  );

  it.each(PINNED_EVENT_PUBLISH_WRITERS)(
    '%s calls the safe sanitizer before publishing (same file also appears in the append inventory, or the sanitized-in-place variable is emitted)',
    (relativePath) => {
      const source = readSourceForScanning(join(REPO_ROOT, relativePath));
      expect(source).toContain('safeSanitizeUIBlockEventProvenance');
    },
  );

  // (3) The chat-serving route(s) — a message-serving reader is a different
  // KIND of seam (serve-time, not write-time; B2), pinned separately.
  const PINNED_MESSAGE_SERVE_FILES = [
    'src-server/routes/chat/conversations.ts',
  ];

  it('the discovered set of files serving readConversationMessages-style chat history matches the pinned list exactly', () => {
    // Discovery mirrors the shape of the shared read seam itself — a file
    // that reads FileMemoryAdapter.getMessages() AND returns { success:
    // true, data: ... } to a client. Narrower than "calls getMessages"
    // (which also matches internal-only token/usage counters that never
    // render a uiBlock — ensureChatAgentStatsInitialized, /monitoring/stats)
    // — those must stay OFF this list, not silently added to it.
    const discovered = filesMatching(/\.getMessages\(/).filter((file) => {
      const source = readSourceForScanning(join(REPO_ROOT, file));
      return /success:\s*true,\s*\n?\s*data:\s*messages/.test(source);
    });
    expect(discovered).toEqual([...PINNED_MESSAGE_SERVE_FILES].sort());
  });

  it.each(PINNED_MESSAGE_SERVE_FILES)(
    '%s sanitizes served messages via sanitizeConversationMessagesUIBlockProvenance',
    (relativePath) => {
      const source = readSourceForScanning(join(REPO_ROOT, relativePath));
      expect(source).toContain('sanitizeConversationMessagesUIBlockProvenance');
    },
  );
});
