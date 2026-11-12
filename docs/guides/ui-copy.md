# Writing UI copy

How Station's user-visible text should read, and the gates that keep it that
way. The visual and voice standard is "Voice & Writing" in
[`@kontourai/ui` DESIGN.md](https://github.com/kontourai/ui/blob/main/DESIGN.md);
the nouns are in the [glossary's user-facing labels](../glossary.md#user-facing-labels).
This guide covers the patterns Station's own copy drifted into and how to
avoid them.

Most of the problem is not hype. It is copy that narrates the system instead
of telling the user what happened.

## Rules

1. **Outcome first, in the user's nouns, plus at most one next action.** An
   error says what happened, the impact if that isn't obvious, and what to do.
   Keep it to one or two sentences, about 160 characters at most.
   - Bad: "The preview expired or its authority changed. Review a new preview."
   - Good: "This preview expired. Open a new one."
2. **No internal vocabulary.** Protocol words such as authority, admitted,
   binding (except key bindings), projection, receipt, reconcile, converge,
   durable, re-anchor, legacy, interim, canonical, seam, lease, custody,
   enrolled and "terminal state" belong in code and design docs. Issue numbers
   (`station#1234`) never belong in UI copy. "Provenance" is fine as a label
   inside an inspector, not in body copy.
   - Bad: "Next engine context re-anchored from durable history"
   - Good: "The next reply picks up from the saved chat"
3. **No defensive negations as body copy.** Say what is true. Shorten a caveat
   that is load-bearing for trust or safety; move detail into a Details
   disclosure or the inspector.
   - Bad: "Missing values are not zero." "No other answer was substituted."
   - Good: "Some values are unavailable."
4. **Don't repeat what's on screen.** Drop subtitles that restate the title or
   list the controls below them, hints that restate a toggle's label, `title`
   tooltips equal to the visible text, paragraph-length `aria-label`s, and a
   second button for the same action. For an icon-only button use
   `IconButton`: its tooltip comes from its accessible name, so don't repeat
   that name in `title`.
   - Bad: `<button title="Save">Save</button>`
   - Good: `<button>Save</button>`
5. **Sentence case** for buttons, headings, toast eyebrows and labels ("Chat
   settings", not "Chat Settings"). Use `…`, not `...`. Write settings paths
   with `›` ("Settings › Privacy").
6. **No filler or hype:** "Let's", "just", "simply", "please", exclamation
   marks, taglines as headings, "not X, it's Y", "not just" and em-dash
   punchlines. Prefer a full stop to an em-dash aside.
   - Bad: "Nobody is watching it — which is exactly when evidence matters."
   - Good: "A scheduled job records the same evidence as work you start."
7. **Don't anthropomorphize system behavior.** A label for reported model
   reasoning ("Thinking…") is fine.

### Keep load-bearing copy

Trim it; never delete its meaning. That covers billing warnings, privacy and
usage-sharing disclosures, security refusals (full access, key revocation),
data-loss and destructive-action confirmations, the boundary that review
findings neither approve nor block a gate, and uncertainty that changes what
the user should do ("This may already have run. Check before retrying.").
DESIGN.md says not to hide uncertainty for visual cleanliness: state it
plainly.

## Gates

Each ratchet counts findings per file and per finding kind, and fails only when
a count grows or a new file has findings. A shrinking count passes and prints a
hint to tighten the baseline. All of them run in `npm run gate:ui-contracts`
and the pre-push static gates.

| Gate | Fails when a file gains |
| --- | --- |
| `npm run ui-copy-length:ratchet` ([script](../../scripts/ui-copy-length.mjs)) | copy over 140 characters or over two sentences |
| `npm run ui-copy-style:ratchet` ([script](../../scripts/ui-copy-style.mjs)) | internal vocabulary (`jargon:<word>`), an issue reference, filler or `!`, "not just", `...`, emoji, an em-dash aside, or a `title` that repeats the element's own visible text (`title-dup`) |
| `npm run ui-css-slop:ratchet` ([script](../../scripts/ui-css-slop.mjs)) | a gradient, backdrop blur, infinite animation, literal `z-index` other than -1, 0 or 1, or a hex color outside a custom-property definition or a legacy-token `var()` fallback, which `lint:component-style` already counts (masks are exempt from the gradient and hex kinds) |
| `npm run lint:component-style` ([script](../../scripts/component-style-hygiene.mjs)) | a reference to a pre-`--k-*` token (`legacy-token`), among its other kinds |
| `npm run noun-consistency:gate` ([script](../../scripts/noun-consistency-gate.mjs)) | zero tolerance: a retired noun in UI copy |

`ui-copy-length` and `ui-copy-style` read the same copy from the TypeScript
AST: JSX text, copy-bearing attributes and properties, and other string
literals by where they are used. `ui-copy-style` also reads single-word copy in
those copy slots, and accessible names (`aria-label` and `alt`, an `ariaLabel`
prop, and `ariaLabel` or `'aria-label'` object properties), because a screen
reader speaks them. Comments, identifiers, class names, `code`/`pre`/`kbd`
text, log calls and test files are not copy. Known gap: a single-word string
outside those slots, such as `const label = 'Legacy'`, is not read, because
there it is usually an identifier.
`ui-css-slop` skips the token sheet, font faces and generated theme CSS.

The noun gate's `RETIRED_USER_TERMS` lists "AI app", "device hub", "Station
owner", "built-in assistant", "default assistant" and "credential entry". An
entry marked `pending` is tested but not yet enforced; deleting the flag
enforces it.

### Fixing a failure

Rewrite the copy or the CSS. Don't regenerate a baseline to absorb new
findings, and don't move copy into a constant or a different attribute to hide
it: other attributes and multi-word constants are read too. Regenerate a baseline (`node scripts/<gate>.mjs
--update`) only to record shrinkage, or for an exception a reviewer accepted
with a reason in the pull request, such as a loading spinner that must loop.
