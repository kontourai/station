# Station Examples

These examples are developer-facing fixtures, not marketing demos. Each one
names the contract it exercises and the verification boundary it can actually
prove.

## Start Here

| Example | Focus |
| --- | --- |
| [Headless Agent](headless-agent/README.md) | Agent execution and observation without a Pane or plug-in manifest |
| [Portable Author Kit](portable-author-kit/README.md) | Agent Plugins Skill plus Station Agent; no package dependencies |
| [Visual Skill Experience](visual-skill-experience/README.md) | Portable Skill with validated visual definition and canonical Session integration |
| [Rich Skill Experience](rich-skill-experience/README.md) | Isolated self-rendering pane with source-bound questions and stage preparation |
| [Matt Pocock engineering collection (Station-curated)](matt-pocock-engineering/README.md) | Pinned attributed interview, specification and ticket workflows; model/tool/publication prerequisites remain explicit |
| [Independent onboarding review](visual-project-inspection/README.md) | Original declarative project inspection through the public contract, without a core allowlist |
| [Getting Started Starter](getting-started-starter/README.md) | Registry-installed first extension |
| [Coding Starter](coding-starter/README.md) | Coding-oriented starter layout |
| [Minimal Workspace](minimal-layout/README.md) | Small Workspace Pane and SDK basics |
| [Demo Layout](demo-layout/README.md) | Local layout installation and registry fixture |
| [Documentation Snippets](docs-snippets/README.md) | Compile-checked copies of guide code blocks; not a plugin |

## Workspace And Review

| Example | Focus |
| --- | --- |
| [Workspace Pane Starter](workspace-pane-starter/README.md) | Portable data-only Pane backed by a sandboxed MCP App |
| [Enterprise Layout](enterprise-layout/README.md) | Multi-provider layout, dependencies, knowledge, and command skills |
| [Builder Delivery Viewer](builder-delivery-viewer/README.md) | Builder delivery artifacts through a server module |
| [Survey Review Workbench](survey-review-workbench/README.md) | Review workflow and trusted server module |
| [Fieldwork Review](fieldwork-review/README.md) | Project-confined Fieldwork review application |

## Knowledge And Data

| Example | Focus |
| --- | --- |
| [Knowledge Docs Starter](knowledge-docs-starter/README.md) | Knowledge namespace starter |
| [Knowledge Library](knowledge-library/README.md) | Knowledge browsing, freshness, and root selection |
| [Repository Knowledge Graph](repository-knowledge-graph/README.md) | Derived code/documentation provenance exported and checked through Knowledge Kit record APIs |
| [Meeting Notes](meeting-notes/README.md) | Capture, compile, graph, and provenance views |

## Providers And Server Extensions

| Example | Focus |
| --- | --- |
| [Shared Providers](shared-providers/README.md) | Provider-only plugin, settings, and dependency composition |
| [Custom Branding](custom-branding/README.md) | Branding provider and runtime overrides |
| [Smart Routing](smart-routing/README.md) | Request-scoped server route and routing rules |

## MCP And Agent Surfaces

| Example | Focus |
| --- | --- |
| [MCP UI Demo](mcp-ui-demo/README.md) | Sandboxed MCP App resource |
| [Station Sessions MCP](station-sessions-mcp/README.md) | Read-only session panel over MCP UI |
| [Self-Configuring Agent](self-configuring-agent/README.md) | Agent-authored configuration pattern |
| [Example Registry](registry/README.md) | Reproducible local registry manifest |

## Voice

| Example | Focus |
| --- | --- |
| [ElevenLabs Voice](elevenlabs-voice/README.md) | Legacy voice protocol under repair; injected realtime adapter |
| [OpenAI-Compatible Realtime Voice](openai-realtime-voice/README.md) | Realtime-compatible voice Provider |
| [Nova Sonic Voice](nova-sonic-voice/README.md) | Preview provider with an unimplemented relay |
| [Meeting Transcription](meeting-transcription/README.md) | Speech-to-text plugin boundary |

## Verification

Run the complete static and buildable example contract:

```bash
npm run examples:conformance -- --build
npm run typecheck:examples
```

`examples:conformance` validates every manifest path and documented npm script,
then builds every example that declares a build. Example unit tests run in the
normal test corpus. Credential-gated live-provider examples are reported as
`NOT PROVEN AT RUNTIME`; a successful static build does not prove an external
service or credential path.

`typecheck:examples` compiles every example that ships TypeScript, including
its tests. `examples:conformance` fails when an example's TypeScript is outside
every project that script names. The only way to opt out is an entry in
`TYPECHECK_EXCLUDED` in `scripts/examples-conformance.mjs`, together with a
README note that marks the example as unmaintained reference code. No example
is excluded today.

## Coverage Still Needed

The next useful examples are not more layout variations:

- A client-CLI journey from Project and Task creation through Session evidence
  and receipt inspection, aligned with [public CLI and docs work](https://github.com/kontourai/station/issues/384).
- An `operationalEventSubscriptions` server-module example that demonstrates
  bounded retry and projection authority.
- Cross-client qualification of the existing [Portable Author Kit](portable-author-kit/README.md).
  Its manifest and Skill are checked locally; a build is not proof of another
  client's consumption or a published package.
- Credentialed voice and transcription smoke remain environment-owned evidence,
  not repository-only examples.
