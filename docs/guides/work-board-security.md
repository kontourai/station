# Work Board security boundary

Work Board is a first-party Workspace Pane, not an alternate Home model. It
may receive the Home role only through Station's explicit role and grant
machinery. The built-in Home remains the recovery floor and cannot be removed.
Installing Work Board never selects it as Home.

The Pane runs through the same builtin renderer isolation as other first-party
Pane renderers. A renderer failure renders the host's truthful fallback rather
than selecting another Home, retrying in a loop, or loading a plugin renderer.

The Board persists identity-only work references plus layout metadata. Its
read seam accepts only references already pinned on the personal Board and
asks their owner for a bounded current projection. It is not a discovery API,
does not create a cross-product query authority, and never copies receipt,
verdict, title, or status authority into Board storage.
