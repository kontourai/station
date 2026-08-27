# GitHub Pages Source

This directory owns Station's hand-authored public product site.

- `index.html` and `styles.css` are the marketing home.
- `public-docs.json` is the exact, individual allowlist of Markdown documents
  published under `/docs/`. It may admit a user guide, contributor guide, or a
  generated reference only when that specific source is named; it never
  publishes a directory recursively.

The public site is a product and end-user projection, not a mirror of the
repository. The topology is deliberately narrow: user-facing guides explain
use, contributor guides route contribution work, and the two admitted generated
references project exact command and product-law authorities. Architecture,
design, strategy, plans, audits, operational records, and every unadmitted
reference remain repository documentation.

Source checks can prove that an admitted document agrees with its checked-in
source or generator. They cannot prove a hosted Pages deployment, a physical
platform result, or a UI interaction: name those claims as **NOT_VERIFIED**
until the relevant host or platform evidence exists. Do not turn that boundary
into static feature-status prose.

Run:

```bash
npm run docs:pages:build
```

The build copies the hand-authored assets, renders only manifest-listed
Markdown, and checks every emitted HTML file for broken or escaping relative
links. It writes disposable output to `dist-pages/`; do not edit that directory
by hand.
