# Visual replies

An Agent can publish a chart, table, diagram, collage or mockup as an HTML page
inside its chat. The built-in Station Agent already receives these tools. For
other Agents, configure the `station-control` attachment as described below. The shared registrations
are available through Claude Code, Codex and capable ACP connections. A
connection that cannot carry MCP servers reports that delivery limitation.

Ask the Agent to preview its page, inspect the screenshot, and publish the same
HTML. Preview returns a PNG, the content height at the requested width, and
console messages with stacks. It uses Station's existing Chromium acquisition
and a disposable profile. If Chromium is unavailable, install it through the
Browser workspace; publishing itself does not need Chromium. Preview checks the
browser's effective WebRTC policy before loading authored content. It refuses an
unsupported browser or enterprise override that prevents the restrictive policy,
even when the profile file requests it.

Publishing writes to the conversation and may require engine tool approval.
For example, Codex configured with approval policy `never` can refuse the write;
select a session mode that permits approval. Station does not mislabel the
publishing tool as read-only to avoid that decision.

Pages appear at their tool result, remain outside collapsed tool batches, and
survive reload. They follow light/dark mode, support 50–200% zoom and an expanded
view. Expanding recreates the page and resets unsaved interaction state. Links
require recent interaction with that reply and confirmation before opening
outside Station. Browsers retain transient activation for roughly five seconds;
the request need not come from clicking the link itself.
The Open button waits 500 ms; Cancel mutes further link requests from that reply
until its viewer is remounted.

Scripts run in an opaque sandbox with no Station session or tool bridge.
CSP blocks ordinary network loads. Direct WebRTC constructors are disabled,
but a nested srcdoc frame can obtain a fresh constructor and send ICE UDP
packets in Chromium and WebKit. Published pages are **not network-isolated**:
they can disclose the viewer's IP or information entered into the page. Do not
enter secrets into a visual reply. Headless preview has separate profile-wide RTC routing restrictions and denied DNS/HTTP
egress; that protection does not extend to a viewer's browser. Preparation embeds quoted absolute PNG, JPEG, GIF and WebP paths inside
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
page in it. See the [security and deletion decision](https://github.com/kontourai/station/blob/main/docs/decisions/html-replies.md).

## Which Agents receive the tools

The built-in **Station** Agent receives station-control's full catalog by
default, including visual replies, when its selected engine supports that MCP
passthrough. The runtime default Agent also receives the full catalog. Preview
and render are bounded writes on Station's auto-approved tool list; the engine
or session's approval mode can still refuse them. Preview runs in a disposable
browser with profile-wide RTC routing restrictions and denied DNS/HTTP egress. These controls
are separate from the accepted viewer-side WebRTC limitation above.

Other authored Agents, including direct Claude and Codex Agents, need the
built-in `station-control` MCP server attached. In the Agent's tool settings,
attach it and select `html_preview` and `html_render`. For Claude and Codex,
the equivalent configuration is:

```json
{
  "tools": {
    "mcpServers": ["station-control"],
    "available": ["station-control_html_preview", "station-control_html_render"]
  }
}
```

For an Agent using an **ACP engine**, attach the server without an `available` filter:

```json
{
  "tools": {
    "mcpServers": ["station-control"]
  }
}
```

ACP passthrough exposes the server's full tool catalog. Station refuses
per-tool `available` filters or disabled-tool selections on this path with
`engine-unsupported`; do not copy the Claude/Codex filter into an Agent using an ACP engine.
An ACP engine without MCP passthrough cannot use these tools. Merge server
entries into existing arrays rather than removing other tool servers. Start a
new conversation after saving tool settings. Authored Agents may optionally
configure auto-approval; otherwise approve the calls when the engine asks.
Codex policy `never`, for example, can refuse either call.
