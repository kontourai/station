# Provider and integration icons

Station renders Claude Code, Codex/OpenAI, Pi, Kiro, OpenCode, Muse Code,
Cursor, Goose, and Qwen Code through a small bundled SVG mark family in
`BrandIcon`. The Claude, Codex, Pi, Kiro, and OpenCode path data is taken from
each provider's own published asset, retrieved 2026-09-25:

| Mark | Source | SHA-256 of the retrieved file |
| --- | --- | --- |
| Claude | `https://claude.ai/favicon.svg` (Anthropic) | `b150888bc7257af83e3b85d3c2be4294f88986026f8168f6c12fc1fde6697350` |
| Codex | `https://developers.openai.com/favicon.svg` (OpenAI; the blossom path only, without its disc) | `8e1b976ba47e927ac2928303fd5362fcadfefd68743506510596f107df676e58` |
| Pi | `https://pi.dev/favicon.svg` (drawn inverse on a Station tile) | `d266b2c1d2c7bf169ca30d438963b176fba16fea6263b9ac30c8302f34ad7ce7` |
| Kiro | `https://kiro.dev/icon.svg` | `774cbc1c7ecec8c935a6091595583d7a92fc8289d6f1db3f071c0f50c61c369f` |
| OpenCode | `packages/identity/mark.svg` in the official `anomalyco/opencode` repository at commit `1251a870cb384543c150c4a72fb101b55eec971b` (the same file `https://opencode.ai/favicon.svg` serves; background square dropped) | `e29bbe33380ad1c1ada9134b52f229d30e9776d60481512c9d81f2bb6f37def9` |

Station takes only the path geometry; fills come from `BrandIcon.css`.

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
