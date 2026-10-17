# Visual replies

Publishing HTML pages into a conversation is not available yet. The current
implementation supplies a sandboxed viewer and bounded image preparation for
the upcoming publishing path; no engine has an `html_render` or `html_preview`
tool from this change.

The viewer supports light and dark themes, zoom from 50% to 200%, and an
expanded view. Page scripts run in an isolated frame with no Station session,
tool access or network access. Web links ask for confirmation before opening
outside the page. Expanding recreates the page, so its unsaved interactive
state resets.

For page authors, use the CSS properties `--background`, `--foreground`,
`--muted`, `--border`, `--accent`, `--destructive`, `--success`, `--warning`,
`--chart-1` through `--chart-6`, `--radius`, `--font-sans`, and `--font-mono`.
They follow the host's resolved theme. The chart colors map to existing
Station semantic color tokens.

Preparation embeds quoted absolute PNG, JPEG, GIF and WebP file paths within
the authorized workspace, including HTML `src`, CSS `url()` and JS string
literals. The captured bytes survive removal of the source image. Other path
syntax and image formats are not embedded. Source HTML over 256 KiB, images
over 2 MiB, expanded pages over 8 MiB, or more than 32 distinct images are
rejected. Height must be an integer from 100 to 2000 pixels.

Conversation retention, deletion with the conversation, publishing tools and
preview screenshots are follow-up work. See the
[security decision](../decisions/html-replies.md) for the boundary and its
remaining risks.
