# Settings provenance and personal Knowledge scope

Retention: source-pinned visual evidence for #2191 and #2192. Retain with the PR review history.

Chromium rendered the real Settings view and command palette on an isolated
Station. The test supplied controlled default and environment provenance in
the configuration response. The search result was selected in the real
palette and opened the Knowledge row.

The 1440px light controls in `before/` show the regressions with the original
badge and catalog sources restored from `a3055991b298` on the tested branch.
The test then failed the badge and scope assertions as expected.

The `after/` captures show 390px and 1440px in light and dark at `4ec99d3ec46d`.
The 390px light operator-environment capture is from `1ff6fab5a0d7`, which
rendered the same environment badge before the palette copy was shortened.
