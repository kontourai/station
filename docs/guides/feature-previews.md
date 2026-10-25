# Ship a feature preview

New user-facing capabilities that are not yet hardened must ship behind a
Feature Preview, **off by default**. This keeps the core application usable
while operators choose whether to try unfinished behavior. Before implementation,
name the preview owner, its entry points, costs, disabled behavior, and the
evidence needed to promote it. Existing hardened behavior does not need a new
preview merely because its implementation changes.

## Choose the scope

| Mechanism | Use it for | Choice and authority |
| --- | --- | --- |
| Station-wide Feature Preview | A new capability with server behavior, shared state, providers, resource use, or background work | Settings → Advanced → Feature previews. The choice affects everyone on this Station and persists in `<home>/config/feature-previews.json`. |
| Device developer preview | Developer-only UI experiments that need no new Station-wide authority or side effects | Settings → Advanced → Developer tools reveals independent device preview switches. Both Developer tools and the individual switch must be on; the individual choice is saved on this device. |

Device previews do not gate server operations or replace authorization. A
Station-wide preview also does not grant permissions: ordinary authentication,
authorization, approval, and resource limits still apply. See the
[user settings guide](../user/settings.md#feature-previews) for the offered
previews and the separate Developer tools controls.

## Bind the real consumer

The [registry](../../src-server/services/feature-previews/feature-preview-registry.ts)
owns persisted choices and the runtime's offered catalog. Bind **once per
feature during runtime composition**, and pass the returned selector to all
consumers. Use a stable, quoted kebab-case `id` in an inline object, a short
user-facing `label`, and a `description` explaining the effect and any cost.
Omit `defaultEnabled` (the registry defaults to off), or set it to `false`.
Do not make binding conditional on the enabled choice: the operator must be
able to discover an offered preview before enabling it.

```ts
const preview = featurePreviews.bind({
  id: 'example-capability',
  label: 'Example capability',
  description: 'Try the new capability. Running it can spend provider credits.',
});

// At the operation's actual consuming branch:
return preview.select({
  enabled: () => performOperation(),
  disabled: () => refusePreviewOperation(),
});
```

Read the selector at each consuming branch; do not cache an enabled boolean
at boot, read the JSON file directly, or use catalog membership as permission.
Each selection reads the current persisted choice. Unreadable preview state
selects the disabled branch; catalog reads report the storage failure. Without
a live binding, a remembered choice cannot make a preview offered.

The registry accepts a repeated identical definition, but throws if the same
ID is bound with a conflicting definition. Its current comparison uses the
serialized definition, so property order also matters. Reuse the one selector
instead of duplicating definitions. Do not rename an ID to change its label:
the ID owns the persisted operator choice.

The existing composition example is
[`bindFleetConsumerProbesPreview` and `fleetProbes`](../../src-server/runtime/bootstrap/station-runtime.ts).
Its disabled branch skips optional probe work and continues ordinary routing.

## Gate every entry point

Inventory every path that can reach the feature, including direct callers that
bypass the UI. Complete the applicable items before shipping:

- **HTTP routes:** select before feature work, including reads, streams,
  uploads, and mutations. An off preview must return the typed refusal below,
  without allocating resources or writing feature state. Retain the ordinary
  access guards; a preview is not an authorization check.
- **Station Control MCP tools:** gate tool advertisement/registration where
  appropriate and select again in the handler. A cached tool list or direct
  call must not bypass the switch. Return a tool error (`isError: true` at the
  MCP boundary) containing the refusal code, preview ID, and Settings path.
  See [Station Control's shared tool boundary](../../src-server/tools/station-control-shared.ts).
- **CLI commands:** preserve the server's refusal and a nonzero exit status.
  Show Settings → Advanced → Feature previews and the preview name. A CLI
  switch, stale help listing, or device preference must not enable it.
- **UI destinations:** set `previewFlag` to the same ID in the
  [destination registry](../../src-ui/src/app-shell/destination-registry.ts).
  [`useSurfaceVisibilityFlags`](../../src-ui/src/hooks/useSurfaceVisibilityFlags.ts)
  combines enabled server previews with Developer tools visibility and hides
  gated destinations while preview data loads or fails. Also gate direct
  navigation, actions, and mounted feature components; hiding a sidebar item
  alone does not prevent a direct URL or request.
- **Providers and registrations:** gate factories, command/search entries,
  subscriptions, pane contributions, tool registrations, and startup side
  effects as well as the destination. Long-lived registrations must either
  reconcile changes or select again before each operation; explain which
  behavior the feature implements.
- **Background jobs and schedulers:** gate scheduling and the actual execution
  branch. A job queued while enabled must recheck before work begins. Document
  whether disabling cancels in-flight work or prevents the next operation,
  how subscriptions stop, and how persisted jobs recover after restart. The
  registry does not cancel work or unregister anything automatically.

For optional augmentation of an existing operation (such as fleet probing),
the disabled branch may continue the existing core behavior with the preview
work omitted. Document and test that fallback explicitly. A direct request
for the preview-only capability receives a refusal rather than empty success.

### Disabled HTTP refusal

Use **404** with Station's `success: false` / string `error` envelope, plus
the discriminant `code: 'feature_preview_disabled'`, `previewId`, and
`settingsPath`. The existing
[disabled S3 capability route](../../src-server/routes/projects/project-s3-source-routes.ts)
uses 404 and this envelope when its capability is off; the
[preview update route](../../src-server/routes/system/feature-previews.ts)
also uses 404 for an ID that is not offered. The discriminant distinguishes an
off offered preview from an unknown route or a not-offered update.

This is the convention for **new preview-only routes**; the current fleet
consumer does not expose such a route. Construct the response from authored
metadata rather than forwarding a caught exception's message:

```ts
type PreviewDisabled = {
  success: false;
  error: string;
  code: 'feature_preview_disabled';
  previewId: string;
  settingsPath: '/settings?view=feature-previews&highlight=feature-previews';
};

const refusal: PreviewDisabled = {
  success: false,
  error: 'Enable Example capability in Settings → Advanced → Feature previews.',
  code: 'feature_preview_disabled',
  previewId: 'example-capability',
  settingsPath: '/settings?view=feature-previews&highlight=feature-previews',
};
return c.json(refusal, 404);
```

Keep one response mapping at the owning route boundary. Extract a route helper
when multiple real route consumers need it; there is no shared helper today.
MCP and CLI should preserve these refusal details through their own transport
contracts rather than fabricate HTTP responses.

## Verify and document

- Exercise enabled and disabled paths through each real route, tool, command,
  provider, UI entry point, or job seam the feature adds. A registry-only unit
  test cannot prove caller gating. Assert the refusal and absence of feature
  side effects while off, and the intended operation while on.
- Test a choice change after composition, unavailable state, direct entry,
  and restart/queued work where applicable. Include ordinary permission
  refusals while enabled. Keep provider/device proof distinct from fixtures.
- Add one row to the **Feature previews** table in
  [`docs/user/settings.md`](../user/settings.md#feature-previews): ID, user-facing
  name, what turning it on does, and notable cost/risk. Runtime binding remains
  the authority for whether this Station offers it; the table covers bindings
  present in server source, including conditional composition.
- Run `npm run docs:feature-previews:check`. It resolves registry `.bind()` calls
  across non-test `src-server` TypeScript source, including typed/renamed
  receivers, and requires an inline string literal ID. Comments, source strings,
  and unrelated binds do not count. Spreads and indirect definition objects
  fail rather than hide IDs. The check rejects both missing and stale rows;
  `ci:fast` and `docs:truth:gate` run it. Its CLI rejection tests live in
  [`scripts/__tests__/feature-preview-docs-check.test.ts`](../../scripts/__tests__/feature-preview-docs-check.test.ts).
  This proves catalog/documentation consistency, not that feature entry points
  obey their selectors.
- Follow [documentation review and freshness](documentation-review-ledger.md)
  and record the checks actually executed, the feature's limits, and the
  promotion evidence still needed.

## Promote or remove

Promote only after the feature's owner reviews the relevant correctness,
authorization, recovery, resource costs, usability, and platform/provider
evidence. Enabling it for one operator or passing fixture tests does not make
it hardened. Promotion makes the feature ordinary supported behavior: remove
the bind, selector plumbing, disabled branches, preview-only registrations and
`previewFlag`; retain ordinary access checks. Move the usage and cost guidance
into its canonical user guide and remove the offered-preview row. Revisit
tests for the supported behavior and run the sync check and documentation review.

Removal deletes the bind, all consumers/entry points, and the table row, and
updates incoming docs links. Explain handling of persisted feature data and
queued work. Removing the binding hides the preview even if an old saved
choice remains; do not reuse its ID for a different capability.
