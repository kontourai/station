# Contributing to Station

Use the route that best protects people and keeps a proposed change useful.
The [repository contribution guide](https://github.com/kontourai/station/blob/main/CONTRIBUTING.md)
owns the current development and verification instructions.

## Choose the right route

| Need | Route |
| --- | --- |
| Report a defect or regression | Open a [bug report](https://github.com/kontourai/station/issues/new/choose) with the user impact, release/build identity, platform, frequency, recent change, redacted diagnostic, and nearest related issue. |
| Propose an improvement | Open a [feature request](https://github.com/kontourai/station/issues/new/choose) that explains the problem, workaround, core-versus-extension boundary, non-goals, and alternatives. |
| Discuss a broad or uncertain idea | Use the [issue chooser](https://github.com/kontourai/station/issues/new/choose). For a discussion/architecture proposal, use the feature form and state the decision needed before implementation. |
| Get help using Station | Use [Kontour support](https://kontourai.io/support/). |
| Report a suspected vulnerability | Use a private [Security Advisory](https://github.com/kontourai/station/security/advisories/new), never a public issue. |

## Keep reports safe and useful

Do not put secrets, access tokens, private URLs, customer data, or unredacted
logs in public reports. Use a redacted diagnostic ID or the smallest redacted
excerpt that explains the problem.

If you submit a pull request, explain the user outcome, the related issue and
closure condition, the evidence you obtained, anything `NOT_VERIFIED`, the
risk and rollback plan, and what you personally inspected. If AI tools helped,
identify the tools and material areas, then personally inspect the submitted
change; do not disclose prompts or private context.

## External forks

External-fork contribution execution is **NOT_VERIFIED**. This guide does not
claim that a fork check or hosted execution path is available or safe.

## Issue lifecycle handoff

Open an issue with the template that best matches the work. The reporter receives a clear handoff label: new and reopened issues begin at `needs:maintainer`; when a maintainer needs more information, they deliberately change that to `needs:reporter`.

Reply with the information that moves the issue forward—such as reproduction steps, environment details, or a decision. A substantive reply moves the handoff back to `needs:maintainer`. Reactions, acknowledgements, quoted text, and hidden comments intentionally do not change it.

Priority, delivery stage, assignment, claims, and closure are separate from this conversation handoff. See the repository [issue lifecycle reference](https://github.com/kontourai/station/blob/main/docs/reference/issue-lifecycle.md) for the exact automation contract.
