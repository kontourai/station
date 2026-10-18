# Visual replies

An Agent can publish a chart, table, diagram, collage or mockup as an HTML page
inside its chat. Attach the built-in `station-control` server to the Agent and
select `html_preview` and `html_render` in its tools. The shared registrations
are available through Claude Code, Codex and capable ACP connections. A
connection that cannot carry MCP servers reports that delivery limitation.

Ask the Agent to preview its page, inspect the screenshot, and publish the same
HTML. Preview returns a PNG, the content height at the requested width, and
console messages with stacks. It uses Station's existing Chromium acquisition
and a disposable profile. If Chromium is unavailable, install it through the
Browser workspace; publishing itself does not need Chromium.

Publishing writes to the conversation and may require engine tool approval.
For example, Codex configured with approval policy `never` can refuse the write;
select a session mode that permits approval. Station does not mislabel the
publishing tool as read-only to avoid that decision.

Pages appear at their tool result, remain outside collapsed tool batches, and
survive reload. They follow light/dark mode, support 50–200% zoom and an expanded
view. Expanding recreates the page and resets unsaved interaction state. Links
require current user activation and confirmation before opening outside Station.
The Open button waits 500 ms; Cancel mutes further link requests from that reply
until its viewer is remounted.

Scripts run in an opaque sandbox with no Station session or tool bridge.
CSP blocks ordinary network loads. Direct WebRTC constructors are disabled,
but a nested srcdoc frame can obtain a fresh constructor and send ICE UDP
packets in Chromium and WebKit. Published pages are **not network-isolated**:
they can disclose the viewer's IP or information entered into the page. Do not
enter secrets into a visual reply. Headless preview has separate deny-all
browser egress controls; that protection does not extend to a viewer's browser. Preparation embeds quoted absolute PNG, JPEG, GIF and WebP paths inside
the publishing session's workspace, including HTML `src`, CSS `url()` and JS
string literals. Captured bytes survive removal of the source image. SVG,
AVIF, unquoted paths and constructed JS paths are not embedded.

Use `--background`, `--foreground`, `--muted`, `--border`, `--accent`,
`--destructive`, `--success`, `--warning`, `--chart-1` through `--chart-6`,
`--radius`, `--font-sans`, and `--font-mono`. The viewer maps these to the current
Station theme; preview uses a fixed light or dark palette.

Source HTML is limited to 256 KiB, each image to 2 MiB, the expanded HTML to
8 MiB, and distinct images to 32. Height is 100–2000 pixels; preview width is
320–1920 pixels. Preview rejects content taller than 2000 pixels, screenshots
over 8 MiB, or console output over 128 entries or 64 KiB. At most two previews
run at once, with a 15-second render deadline and bounded process cleanup. V8's
heap is capped at 128 MiB; this is not a hard cap on the browser's total RSS.
Over-limit inputs and outputs are rejected rather than shortened.

A conversation can retain at most 32 pages and 32 MiB of serialized page data.
Pages belong to their publishing execution session. Closing or archiving work
retains them. Physical deletion of that session deletes its pages in the same
transaction; deleting every member of a conversation lineage deletes every
page in it. See the [security and deletion decision](../decisions/html-replies.md).

## Enable tools for an Agent

Visual replies are opt-in, including on a fresh installation. Station does not
attach station-control to every Agent by default. Open the Agent's tool settings,
attach the built-in `station-control` MCP server, and select `html_preview` and
`html_render`. Save the Agent and start a new conversation so its engine receives
the updated MCP configuration. Claude Code, Codex and MCP-capable ACP engines
use the same catalog; an ACP engine without MCP passthrough cannot use these tools.

The equivalent Agent configuration is:

```json
{
  "tools": {
    "mcpServers": ["station-control"],
    "available": ["station-control_html_preview", "station-control_html_render"]
  }
}
```

Merge these entries into existing arrays rather than replacing other tools.
Both tools are bounded writes: preview starts Chromium, and render persists a
page. Choose an approval mode that permits those calls, or approve them when the
engine asks. `autoApprove` is optional; it is not required to expose the tools.
For example, Codex policy `never` can refuse either call. Existing conversations
may need restarting to receive changed tool settings.
