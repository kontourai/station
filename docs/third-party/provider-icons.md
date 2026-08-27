# Provider and integration icons

Station renders Claude Code, Codex/OpenAI, Pi, Kiro, OpenCode, Muse Code,
Cursor, Goose, and Qwen Code through a small bundled SVG mark family in
`BrandIcon`. The Claude, Codex, Pi, Kiro, and OpenCode path data is adapted from
T3 Code's `apps/web/src/components/Icons.tsx` at commit
`202e5609ffb294bc0aa86c08ce1d3751de567226`, used under T3 Code's MIT license.

The Cursor and Meta marks come from Simple Icons 16.28.0 at commit
`c956d67dfa7c37ae65206fc0775b0c02d1e695c2` (CC0-1.0); the Simple Icons
metadata points to Cursor's brand page and Meta's published brand guidance.
Muse Code uses Meta's mark because Muse is distributed by Meta and no separate
public Muse mark was found. The Goose icon comes from the official
`block/goose` repository at commit `867a83cfc761f152ba14b900bfe9017688abddd8`
(Apache-2.0). The Qwen Code mark comes from the official
`QwenLM/qwen-code` repository at commit
`a82a11a0a4d8d4f97796ac9f56d276364dd3bd64` (Apache-2.0).

The names and marks remain the property of their respective owners; their use
identifies compatible engines and does not imply endorsement or identical
capabilities.

Installed integrations may set `icon` to a relative raster filename such as
`icon.png`. Station also checks a short local `icon.*`, `favicon.*`, and
`logo.*` list. The server only exposes PNG, JPEG, WebP, and ICO files after
realpath containment, size, extension, and magic-byte validation. It never
downloads, proxies, or renders remote icon URLs; SVG is intentionally rejected.

The output-only `/integrations/:id/icon` route is same-origin, privately cached,
and serves `X-Content-Type-Options: nosniff`. Missing or rejected assets return
no image and the shared renderer deterministically uses a bundled mark or
initials instead.
