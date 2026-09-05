# Move a Station setup to the cloud

> Status: staged implementation under [#495](https://github.com/kontourai/station/issues/495)
> and [#580](https://github.com/kontourai/station/issues/580). The initial slice
> implements a read-only setup preview and AWS template preparation. It does
> not provision an account, copy setup, enroll credentials, move execution,
> or provide a one-click UI. Those are required follow-through, not completed
> features. The existing private-cloud design remains a single-host baseline.

## Outcome and boundaries

The intended user journey is “Leave your agents running”: preview the move,
prepare a verified target, transfer supported setup, enroll credentials, and
continue eligible work after the source relinquishes execution ownership.
The first AWS environment should be one small EC2 instance with persistent
storage, rather than requiring a shared SaaS stack to test the journey.

Setup portability, credential enrollment, and execution continuation are
separate capabilities. A copied home, journal, or conversation identifier
cannot mint target authority. Unknown or unsupported provider behavior remains
unavailable. Server-only relay/WeakMap capabilities are never serialized.
Plugin artifacts, installation generations, data scopes, and execution custody
remain owned by the plugin lifecycle; live plugin data cannot be assumed quiet.

## Initial interface

The [CLI reference](../reference/cli.md#cloud--cloud-move-preparation) owns commands.
`@kontourai/station-contracts/cloud-move` owns the public preview projection;
`@kontourai/station-shared/cloud-move` composes the inventory and selected
provider. The CLI is a thin caller. Future API/UI callers must reuse these
semantics and add their own authenticated source-selection boundary.

The preview reads bounded selected Agent/Project metadata and reports plugin
inventory as unverified pending its lifecycle owner. Storage directories and
compatibility links are not classified as active plugin installations. It does not read credential stores, external engine
homes, plugin journals, workspace bytes, or session databases. It is a
non-atomic observation; selected configuration bytes may contain sensitive
fields, which are not projected. It provides no capture-consistency or compatibility
proof. A valid preview always reports transfer and resume unavailable until
their corresponding operations are implemented. Exit zero means the preview
ran, not that a move is ready.

Provider composition is explicit. The AWS EC2 adapter validates preview target
inputs and renders an environment template. Other adapters must implement the
same narrow preparation contract; registering one does not grant access to
credentials or execution. Configuration cannot bypass the source and target
ownership requirements. CloudFormation completion is not application readiness.

## AWS development template

Preparation requires an explicit region, instance type, digest-pinned public
Linux/x86 Station image, and new output file. The operator supplies the existing
VPC and Internet-routed subnet when deploying. The selected region is a preview
input; the deployment command must explicitly use that region. Image existence,
architecture, release provenance, and account permissions remain target checks.
The example digest in documentation is a placeholder, never a usable release.

The template uses Amazon Linux 2023 from the regional SSM AMI parameter, one EC2
instance, and an encrypted gp3 root/data volume. It gives the instance only the
AWS-managed SSM instance role and permits no inbound security-group traffic.
The host downloads Docker and the selected image over outbound networking.
IMDSv2 is required with hop limit one; the container receives no AWS credentials,
Docker socket, or host home directory. Access uses authenticated SSM forwarding
to host-loopback port 3000. Set `LocalUiPort` to an available client port and
open `http://127.0.0.1` on that port; the template configures this exact allowed
origin. Station authentication is still required.

The root/data volume survives stop/start and is retained after termination.
A replacement instance does not adopt that volume automatically. Retained volumes
continue billing and require explicit ownership-aware recovery/removal. T3 uses
Standard credits to avoid unbounded surplus-credit billing; sustained load can
throttle. The 1-GiB `t3.micro` memory budget is not qualified for Station plus
agent tools. Inspect bootstrap logs and actual container health before using
the environment; template validation does not prove boot or runtime readiness.

## Remaining implementation sequence

1. Validate the generated template and boot in an explicitly selected AWS test
   account/region/budget. Prove private access, image identity, persistence, cost
   visibility, and recovery. Retain portable evidence without credentials.
2. Add consistent setup packaging and target application. Reuse the existing
   home maintenance and backup primitives where their contracts apply, and the
   guidance export for its narrower documented scope. Never upload an entire
   home as a shortcut to portable authority. Include workspace mapping,
   uncommitted bytes, plugin reinstall, and unsupported-item reports.
3. Add provider-specific credential enrollment. Transfer only explicitly
   portable material through an authenticated encrypted mechanism; OS-keychain,
   device-bound, and unsupported engine credentials require sign-in. Never
   include credential payloads in ordinary export documents or templates.
4. Add the UI to the same operation contract: preview, cost/compatibility review,
   target preparation, setup transfer, sign-in, verification, and continuation.
   The first authorized setup may need decisions; a repeat move can be simpler.
5. Implement durable ownership transfer and supported session continuation.
   Source admission must be fenced before target execution is accepted. A
   partition or uncertain acknowledgement retains a named recovery state,
   rather than permitting two owners. Fresh target grants and workspace
   ownership are mandatory; failed transfer must not destroy the source.
6. Prove retry, interruption, source/target restart, credential refusal,
   revocation, plugin lifecycle races, and move-back. Measure real continuation
   with a supported agent before advertising unattended running work.

An account/region/budget decision and real AWS evidence remain outstanding.
The initial preview/template slice must not close #495 or claim live migration.

## External-team delivery

Document prerequisites, exact public contracts, supported versions, configuration,
expected outputs, costs, rollback, backup/restore, and unavailable paths alongside
each implemented slice. Keep provider-specific setup replaceable and use generic
accounts, paths, and domains. The managed offering earns value through reliable
provisioning and operation; public integration instructions remain useful to a
company running Station in its own account.
