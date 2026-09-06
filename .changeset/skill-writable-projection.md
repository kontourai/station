---
"@kontourai/station-contracts": minor
---

Add `Skill.writable` and `Skill.writeRefusal`, so a reader can tell whether Station will write a skill's own package instead of inferring it. The server already decided this and no read model carried the decision, which left the Skills editor offering a Save that the route answers 409 for. `source` and `origin` were the fields a client had to guess from and answer a different question: a registry install in a writable root is writable, and an install record stating `source: 'local'` says nothing about which root the package sits in. `writeRefusal.reason` is a code (`served-in-place`, `canonical-package`, `outside-writable-root`) so the two refusals a user can act on differently are distinguishable without parsing prose; `writeRefusal.detail` is the server's own sentence about that package. An absent `writable` is not a grant — a reader with no decision must treat the package as read-only.
