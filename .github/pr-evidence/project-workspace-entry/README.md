# Project workspace pane entry evidence

Retention: source-pinned browser evidence for #1786 G3 and #4130. Retain with the pull request.

The Chromium fixture created a real Git Project, applied the built-in Coding
layout and reloaded while IndexedDB still held the preceding empty layout list.
The 390px control at `1fcdc74b092e` disabled the mount refresh. The server
returned the saved Coding layout while the Project showed an empty list.
Opening Diff produced the [Add Layout picker](before-390.png). With the source
restored at the same commit, one activation opened the
[real changed file](after-390.png). The restored case also passed at 1440px.

The [legacy plugin bookmark](plugin-legacy-pane-390.png) opened at 390px in
the installed plugin browser run at `498e87099158`. The fixture uses a
normally named plugin and layout, and the canonical occurrence came from the
Project catalog. The broader layout parity criteria remain tracked in #2995.
