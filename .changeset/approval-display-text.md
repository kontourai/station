---
'@kontourai/station-shared': minor
---

New `./display-text` subpath: the display form approval surfaces show
untrusted text in. It provides:

- `displayText` (invisible format characters removed, controls turned into
  spaces, one line), `displayLines`, `displayJoinedLines` and
  `displayMultilineText`;
- `boundedJoinedLines` and `boundedDisplayText` (lines kept apart with " ⏎ ",
  "…" on a cut, and "(+N lines)" for lines a cut hides);
- `compactDisplaySource`, `truncateDisplay` and `displayLength` (code points).

Also a new `./display-reveal` subpath, kept apart so an entry bundle that
only needs the display form does not carry it:

- `revealHiddenCharacters`, `revealHiddenCharactersText`,
  `hasHiddenCharacters` and `hiddenCharacterToken`, for raw views that show a
  hidden character as a «U+XXXX» token instead of applying it.

`toolRequestPreview` and `toolRequestDisplayName` now return that display
form:

- Bidi controls, zero-width and other invisible characters are removed, and
  C1 controls become spaces.
- A multi-line value keeps its lines apart with " ⏎ " instead of a space.
- Padding (runs of spaces, blank lines, invisible characters) no longer
  pushes later text past the cut.
- A cut always ends in "…", followed by "(+N lines)" when whole lines are
  hidden.
- Truncation is by code point.
