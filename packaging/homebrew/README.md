# Homebrew cask

The [manifest tool](../../scripts/ecosystem-manifest.mjs) verifies a signed
schema-v1 ecosystem manifest containing a macOS artifact and writes a versioned
`station` cask. From the checkout root, using an already-obtained manifest:

```sh
node scripts/ecosystem-manifest.mjs cask \
  --manifest /path/to/manifest.json \
  --output /path/to/station.rb
```

Verification normally uses [pinned signing keys](../../config/release-manifest-keys.json).
An explicit `--public-key` is a fixture/dry-run override, not the normal release
trust policy. Schema-v2 portable-only manifests cannot produce a cask.

This directory also keeps a [template](./Casks/station.rb.template) for review;
the CLI renders from its own implementation. The
[packaging tests](../../scripts/__tests__/ecosystem-manifest.test.ts) exercise
that renderer and signature refusals. Rendering does not reserve a Homebrew
name, create a tap, publish a cask or install an app.

The [packaging workflow](../../.github/workflows/ecosystem-packaging.yml) runs
validation/dry-run steps. Its dispatch publish switch reaches a separate
[boundary script](../../scripts/ecosystem-publish-boundary.sh): publishing is
inert by default; enabling it requires both explicit manifest and tap publish
commands. The script runs those commands but does not itself prove human
approval, protected-environment configuration or credential isolation. Live tap
publication and signing-key custody require separate owner verification.
