---
"@kontourai/station-contracts": minor
---

Add `Skill.writable` and `Skill.writeRefusal`, so a reader can tell whether Station will write a skill's own package instead of inferring it. The server already decided this and no read model carried the decision, which left the Skills editor offering a Save that the route answers 409 for. `source` and `origin` were the fields a client had to guess from and answer a different question: a registry install in a writable root is writable, and an install record stating `source: 'local'` says nothing about which root the package sits in.

`writeRefusal.reason` is a code — `served-in-place`, `canonical-package`, `outside-writable-root`, `unresolvable-name` — because the remedies genuinely differ and a reader cannot tell them apart from prose: a plugin-served prompt has no registry entry to install, and a name that cannot become a directory name needs a rename. `writeRefusal.detail` is the server's own sentence about WHAT is wrong; it never contains the skill's name (plugin-authored, and every surface showing the refusal shows the name beside it) and never carries an exception message. An absent `writable` is not a grant — a reader with no decision must treat the package as read-only.
