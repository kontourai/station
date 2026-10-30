# Starter integrations and public registries

The bundled marketplace offers a small starting set for research, coding and
document work. These are ordinary MCP integration definitions, not bundled
executables or new Station Browser hosts. Install an entry from **Registry →
Integrations**, then configure and enable it in **Connections** and select it
for the Agent that needs it. Registry installation saves it disabled; installing
a definition does not install a local runtime, connect an account or grant an
Agent access automatically.

The catalog's `1.0.0` versions identify these configuration recipes. They do
not pin the version of a hosted service or a separately installed executable.
Hosted services and their limits can change independently of a Station update.

## Choose an integration

| Integration | Useful for | Setup and data boundary |
| --- | --- | --- |
| [Exa](https://github.com/exa-labs/exa-mcp-server) | Public web research and page retrieval | Hosted, rate-limited anonymous access. Queries and fetched URLs go to Exa. |
| [Context7](https://github.com/upstash/context7) | Current library documentation and code examples | Hosted, rate-limited anonymous access. Queries go to Context7; keep proprietary code and secrets out of them. |
| [Microsoft Learn](https://learn.microsoft.com/en-us/training/support/mcp) | Microsoft/Azure documentation and code samples | Hosted, no account required. Queries go to Microsoft. |
| [Lightpanda](https://github.com/lightpanda-io/browser) | JavaScript page navigation and extraction | Install `lightpanda` on the Station host first. The definition runs `lightpanda mcp` over stdio with upstream telemetry and crash core dumps disabled. |
| [MarkItDown](https://github.com/microsoft/markitdown/tree/main/packages/markitdown-mcp) | Converting documents to Markdown | Install `markitdown-mcp` on the Station host first. The subprocess can read files and network locations available to its OS user. |

The definitions live beside this guide in each entry's `integration.json`.
They are listed in both [default.json](../default.json) and
[manifest.json](../manifest.json). The existing Surface integration remains
available for querying a Veritas trust report.

### Local runtime setup

Install runtimes on the machine running Station, even when viewing Station
from a phone or another computer. Use a reviewed upstream release or build;
these recipes neither acquire nor verify third-party binaries. Make the
executable available on Station's process `PATH`, or edit the integration's
command to its absolute executable path.

For Lightpanda, follow its [installation instructions](https://github.com/lightpanda-io/browser#quick-start).
Upstream publishes macOS and Linux builds; Windows requires WSL, and there is
no native Android/Termux build. A WSL installation requires a corresponding
Windows-to-WSL launch command; the default `lightpanda` command does not cross
that boundary. The browser is AGPL-3.0 licensed; this catalog does not
redistribute its binary. Lightpanda sessions have their own cookies and state.
They do not inherit the shared session, human takeover, graphical screencast
or network controls of Station's [Browser pane](../../../docs/guides/browser-workspace.md).
Its PNG/PDF output is text-only rendering, not evidence of a page's visual layout.

MarkItDown-MCP requires Python 3.10 or later. One explicit, isolated install
with `uv` is:

```sh
uv tool install 'markitdown-mcp==0.0.1a8'
markitdown-mcp --help
```

Follow the upstream guide for supported formats and optional dependencies.
Some formats or optional services need extra setup. File conversion and local
browsing execute with the Station host user's authority; an integration listing
does not sandbox that process. Enable these only for Agents that need that access.

See [Connections](../../../docs/guides/connections.md) for enabling tools and
account setup. An unavailable binary, rate limit or provider refusal is a
setup/failure state, not a completed workflow.

## Use public registries for breadth

The recommended long-term model is a small starter shelf plus externally
maintained discovery. Station should own compatibility, permissions and the
installation experience; upstream registries should own the broad inventory.
The following are integration targets, not source formats this change adds.

- **[Official MCP Registry](https://github.com/modelcontextprotocol/registry/blob/main/docs/reference/api/official-registry-api.md):
  primary target. Its public `/v0.1/servers` API supports search, version
  selection and cursor pagination. Publishers maintain server definitions.
  Namespace verification establishes publication ownership, not successful
  Station operation or a security review.
- **[PulseMCP](https://www.pulsemcp.com/api/docs/v0.1):** compatible subregistry
  format with enriched metadata and provider curation. Its documented API is
  a B2B integration requiring an API key and tenant ID; a public directory
  does not imply anonymous API access. Station would need secret-backed source
  authentication as well as the format adapter.
- **[Docker MCP Catalog](https://docs.docker.com/ai/mcp-catalog-and-toolkit/catalog/):**
  useful optional local-server route through Docker's catalog/gateway. Local
  servers require Docker; this is a runtime integration, not merely another
  JSON feed.
- **[Smithery](https://smithery.ai/docs):** optional provider for discovery and
  managed connections. Its registry and credential gateway need their own
  adapter and provider setup; using the gateway changes who holds credentials
  and mediates calls.

At the source baseline for this change, **Add marketplace** accepts Station
JSON manifests, public GitHub Skill libraries and local Skill directories.
It does not ingest arbitrary marketplace formats. See the
[current source contract](../../../docs/guides/plugins.md#plugin-registry).
The in-flight [MCP subregistry work](https://github.com/kontourai/station/pull/4280)
is the existing implementation lane for the standard MCP format; do not create
a second discovery owner in these recipes. Its bounded feed adapter is not
full-catalog browsing, and package-only server entries are not runnable through it.

Native public discovery should preserve these requirements:

1. Search on demand with bounded pages, cursor pagination and cancellation;
   do not download the entire registry on every marketplace open.
2. Keep source identity, namespace, version, endpoint, freshness and provenance
   visible. Equal display names must remain distinct. A live search for
   `context7` returned the upstream server alongside third-party alternatives.
3. Distinguish **discoverable**, **needs setup**, **unsupported** and actual
   executed compatibility. A registry record or tool list is not a successful
   tool call. A stale cached record cannot authorize a new install.
4. Review local package execution separately from remote endpoint setup. Do
   not automatically execute a command supplied by an external registry.
5. Retain each person's account ownership, existing tool permissions and
   explicit enablement. Neither ranking nor registry badges grant authority.

## Competitor patterns and the wider shortlist

Research checked on 2026-10-29:

- [Claude connectors](https://support.claude.com/en/articles/11176164-use-connectors-to-extend-claude-s-capabilities)
  present use cases, read/write capabilities and account connection. Its
  [plugin catalog](https://github.com/anthropics/claude-plugins-official)
  combines integrations with task guidance. Station can use that packaging
  pattern without treating Claude's marketplace format as a Station manifest.
- [Cursor plugins](https://cursor.com/docs/plugins) combine Skills and MCP
  servers and support Agent Plugins. Portable package compatibility does not
  imply compatibility with every marketplace index or client extension.
- [Copilot connectors](https://code.visualstudio.com/docs/agent-customization/copilot-connectors)
  emphasize connecting services without local server setup. The useful product
  lesson is a short path from discovery through sign-in to a real task.

For mixed users, the wider shortlist is Linear and Atlassian for planning;
Notion for team knowledge; GitHub and Sentry for engineering; Slack, Drive,
calendar and email for everyday work; and Figma for design. Prefer upstream
servers, per-person account connection and a small set of workflow Skills over
copying an exhaustive vendor list into Station. Linear, Notion, Atlassian,
GitHub and Gmail already have dispositions in the in-flight subregistry lane.
Other candidates need endpoint, authentication and actual workflow verification
before being advertised as ready. Slack's official server, for example,
[does not support dynamic client registration](https://docs.slack.dev/ai/slack-mcp-server/).

## Qualification receipt

On 2026-10-29, the installed MCP SDK initialized and listed tools from Exa
3.5.0, Context7 4.4.3, Microsoft Learn 1.0.0 and Firecrawl 3.36.0. Exa's public
web search, Context7's React library lookup and Microsoft Learn's documentation
search each returned non-error content without credentials. These were direct
provider probes, not installed Station Agent or browser UI acceptance.

Firecrawl listed its tools but its `firecrawl_scrape` call refused anonymous
access: “Anonymous keyless access is unavailable for this request.” It is
excluded from this starter batch despite upstream documenting a keyless tier.
Do not erase this refusal or describe it as a successful extraction. Its
account-connected path remains unverified here.

Lightpanda and MarkItDown runtime journeys, signed-in services, Windows/WSL,
native shells, hosted releases and installed Agent journeys remain
**NOT_VERIFIED**. Local catalog/schema and distribution checks establish
configuration integrity only; they cannot qualify those journeys.
