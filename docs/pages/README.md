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

Rendered headings have section IDs from their visible text, using the same
heading rules as the learning reader. Repeated headings receive unique numeric
suffixes within each document. Links such as the getting-started guide's
`#install-nightly` resolve to those sections in the generated page. The Pages
link checker validates target files; the renderer tests cover these heading
targets. Neither check proves the hosted site has deployed the current source.

An admitted document may link relatively only to another admitted document;
link anything else by its absolute
`https://github.com/kontourai/station/blob/main/...` URL. `npm run
docs:public:hygiene` renders each admitted document and rejects any other
relative link, so the mistake fails at PR time instead of in the post-merge
Pages build.

The root `corpus.json` mirrors `public-docs.json` for the shared Kontour docs
system, with `README.md` as its landing page (this site's own `index.html` stays
the hand-authored home). Only its `docs-bundle.json` is published here, and its
document URLs are the same `docs/<path>.html` pages this builder writes. The
bundle step fails open: a failed docs-kit build never blocks this site's
publish, and the previous `docs-bundle.json` stays on `gh-pages` (stale, shown
as behind on the hub) until a later build succeeds. The bundle build and advisory
docs gate both pin Corpus source `b8ecf4cd4c6482bb804cdeea617ebe2d9b78ab05`,
the reviewed 0.7 renderer and v2 bundle implementation. Station continues to
publish its own HTML and CSS; updating this pin does not replace that renderer
or install an MCP client.

It also lists the agent-facing manual `docs/reference/station-docs.md` with
`"publish": false`: the bundle carries it, with its relative links made
absolute GitHub URLs and its document URL a GitHub blob link, but docs-kit
renders no page for it and this builder never publishes it. The manifest's
`topics` point into that manual, mirroring the Station Docs MCP topics in
`docs/learn/mcp-topics.json`. Its `exclude` globs keep every other
`docs/**/*.md` unpublished, as here:

- `docs/*.md`: the docs-root index, architecture overview, glossary, privacy
  policy working copy, and two historical design records.
- `docs/adr/**`, `docs/architecture/**`, `docs/conformance/**`,
  `docs/contexts/**`, `docs/decisions/**`, `docs/design/**`,
  `docs/patterns/**`, `docs/plans/**`, `docs/security/**`, `docs/strategy/**`,
  `docs/testing/**`: decisions, design, plans, audits and internal engineering
  records.
- `docs/learn/**`, `docs/pages/**`, `docs/third-party/**`: the learning reader's
  sources, this directory, and third-party notices.
- `docs/guides/!(...)`, `docs/reference/!(...)`: every guide and reference
  except the admitted ones (and the bundle-only manual) named in the
  parentheses.
- `docs/user/workspace-checkpoints.md`: the one unadmitted user guide.

Admitting or withdrawing a document changes both files.
