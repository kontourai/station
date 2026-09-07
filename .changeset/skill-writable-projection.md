---
"@kontourai/station-contracts": minor
---

Add `Skill.writable` and `Skill.writeRefusal`, so a reader can tell whether Station will write a skill's own package instead of inferring it. The server already decided this and no read model carried the decision, which left the Skills editor offering a Save that the route answers 409 for. `source` and `origin` were the fields a client had to guess from and answer a different question: a registry install in a writable root is writable, and an install record stating `source: 'local'` says nothing about which root the package sits in.

`writeRefusal.reason` is a code — `served-in-place`, `canonical-package`, `outside-writable-root`, `unresolvable-name` — because the remedies genuinely differ and a reader cannot tell them apart from prose: a plugin-served prompt has no registry entry to install, and a name that cannot become a directory name needs a rename.

`writeRefusal.detail` is Station's own sentence about WHAT is wrong, and it contains no author-controlled text at all: not the skill's name, not its path, not an exception message. Where the package sits travels separately in `writeRefusal.packageDirectory`. That split is the point rather than a detail of phrasing — every segment of the path is author-controlled, a plugin names its own directories, and text spliced into Station's sentence is read as Station speaking. Surfaces must render `packageDirectory` as its own element, labelled as a path, and never inside `detail`.

The rule holds for this refusal, not yet for every message about a refused write: the write path's own failure message still interpolates the name and two paths and is surfaced verbatim, which is pre-existing and tracked in #1681. An absent `writable` is not a grant — a reader with no decision must treat the package as read-only.
