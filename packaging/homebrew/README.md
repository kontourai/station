# Homebrew cask

`scripts/ecosystem-manifest.mjs cask` renders the versioned `station` cask
from a verified signed ecosystem manifest. The template is deliberately not a
tap: checking it into this private repository neither reserves a Homebrew name
nor writes to a public package manager.

The owner-gated release workflow validates the rendered cask and stops before
the external tap push. Enabling public distribution requires a separately
protected tap credential and the production manifest signing key; neither is
available to ordinary release jobs.
