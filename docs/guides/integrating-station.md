# Integrating Station into your company or project

This guide routes teams building with Station to public contracts and reusable
operating instructions. It also records the intended hosted integration path.
**The multi-tenant SaaS path below is a delivery target, not an available
PostgreSQL adapter, cloud deployment recipe, or service-level commitment.**
The [deployment guide](deployment.md) owns supported deployment behavior;
[source and tests](../architecture/module-map.md) own implementation truth.

## Start with one useful integration

Choose a concrete outcome, such as presenting a project's agent work in your
application or adding a tool to a Station workspace. Keep your application's
business rules in your application and use a documented Station boundary.

| Your task | Start here | Evidence to retain |
| --- | --- | --- |
| Call Station from another application | [API reference](../reference/api.md), [SDK reference](../reference/sdk.md), [contracts](../reference/contracts.md) | Exact client/server versions, authenticated request, expected result, and a refused unauthorized request |
| Add a workspace experience or tool | [Build your first plugin](build-your-first-plugin.md), [plugin guide](plugins.md) | Installed example, declared permissions, successful use, revocation, and removal behavior |
| Automate an operator workflow | [CLI reference](../reference/cli.md) | Exact command, exit status, retry behavior, and redacted output |
| Run a private environment | [Deployment](deployment.md), [private-cloud design](../design/private-cloud-environment.md) | Runtime identity, persistence across replacement, and restore evidence for your environment |
| Build or extend Station | [Development](development.md), [example catalog](../../examples/README.md), [testing](testing.md) | Focused executable example and relevant checks |

Use the selected reference's actual authentication and configuration contract.
Do not invent a generic API key or infer supported methods from internal code.
Examples should run with your own project, provider, domain, and credentials;
Kontour infrastructure must not be an undocumented prerequisite. Keep secrets
in the documented secret mechanism, never in examples, images, or screenshots.

## Target: a multi-tenant service on your domain

A company hosting multiple customers needs tenant and member authorization in
its data stores and execution system, in addition to authenticated ingress.
Serving the current container at a public hostname does not establish those
boundaries. The [multi-tenant program](https://github.com/kontourai/station/issues/580)
owns this work; inspect its current implementation evidence before enabling a
surface. Closed backlog records can represent consolidation rather than delivery.

The intended separation is:

| Boundary | Hosted target | Local or self-hosted role |
| --- | --- | --- |
| Transactional application state | PostgreSQL repositories with explicit tenant/member scope, atomic claims, and recoverable transitions | Preserve SQLite implementations where their deployment assumptions apply |
| Artifact storage | Object-storage adapter with authorized access, checksums, bounded transfers, retention, and deletion | Local artifact storage implementing the same observable contract |
| Active repositories and execution | Isolated execution environments with scoped filesystem volumes, credentials, and resource budgets | Local workspace execution within its documented authority |
| Public access | Your domain, HTTPS, identity integration, membership, and authorization | Private ingress and pairing according to the deployment guide |

These are separate responsibilities. A filesystem abstraction must preserve the
semantics Git and execution tools require; an object store is an artifact
boundary. A database adapter must preserve transaction, ownership, retry, and
corruption behavior, rather than expose a generic collection of CRUD methods.
Do not give customer code the application database credential or unrestricted
access to other workspaces. Public requests cannot supply trusted tenant identity
merely by choosing a header, path, or resource identifier.

Before advertising a hosted capability, exercise two independent tenants through
its real API, background processing, storage, streams, and execution boundaries.
Include colliding resource IDs, revoked membership, retries, restart, and cleanup.
Unavailable surfaces remain explicit. Restore a representative environment into
a clean deployment, including uncommitted repository files and required secret
references, and measure recovery time and recoverable data loss.

## First cloud target: AWS

AWS is the selected first cloud target. Start with one small EC2 instance for a
persistent private development environment, using the existing local storage
contracts. The larger service mapping below is an evolution target, not a
prerequisite for testing, a provisioned deployment, or a claim that Station
already supports these adapters.

### Grow from a persistent development environment

1. **Private development:** one EC2 instance, prebuilt Station image, and
   persistent EBS storage for the home and repositories. Use authenticated
   private access, preserve the data volume on replacement, and test backup and
   restore. Start with SQLite and files; RDS, a load balancer, and a NAT gateway
   are not mandatory components of this private single-host profile.
2. **Resize when measured:** test a small instance and increase memory/CPU when
   workload evidence calls for it. Build images in CI rather than compiling
   the repository on a memory-constrained runtime host.
3. **Scale independent work:** introduce separately owned execution workers and
   scale their capacity. An Auto Scaling group is not permission to run competing
   writers against one Station home. Replacement must drain/fence the old owner
   and recover the exact workspace. Persistent EBS volumes are AZ-bound; cross-AZ
   recovery requires a tested restore or replication procedure.
4. **Shared hosted service:** add tenant-safe repositories, managed PostgreSQL,
   object storage, and independent API capacity when the multi-tenant workload
   justifies them. ECS can use EC2 or Fargate; Fargate is an operational option,
   not the definition of scalability or a required final destination.

The private development profile is not a public multi-tenant launch. Use its
real workload and recovery measurements to select later stages.

### Evolution target

| Boundary | Initial AWS direction | Replacement contract |
| --- | --- | --- |
| Web/API compute | ECS on Fargate behind HTTPS ingress | Container lifecycle, readiness, draining, and reconnect behavior |
| Application database | RDS for PostgreSQL | Tenant-scoped repositories, transactions, migrations, and recovery |
| Artifacts | S3 | Authorized streaming, integrity, retention, and deletion |
| Execution and workspaces | Select Fargate or EC2 after workload validation | Admission, isolation, durable ownership, filesystem behavior, restart, and cleanup |
| Identity and secrets | Choose an identity provider and AWS secret/key services during deployment design | Principal/membership resolution and scoped secret access |
| Commercial integration | AWS Marketplace as a prospective purchase channel | Account mapping, entitlements, usage reporting, and subscription lifecycle |

Providers are selected through explicit, validated configuration at their owning
composition boundary. Unsupported combinations fail clearly. Tenant grants and
core domain rules remain consistent across providers. Replacing a provider can
require migration, draining, or restart; pluggability does not imply arbitrary
hot-swapping or letting untrusted plugins choose infrastructure credentials.
Build one tested implementation per boundary first and document the contract
before claiming another provider is compatible.

Execution must be evaluated separately from web hosting. Verify required tools,
process isolation, networking, filesystem performance, and replacement behavior
before choosing its compute profile. AWS supports multiple
[ECS storage options](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/using_data_volumes.html);
[EBS lifecycle rules](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/ebs-volumes.html)
vary with service and standalone-task deployment. Do not assume a task-attached
volume survives replacement or that shared storage provides tenant isolation.

The first reusable AWS deployment should document resources, IAM permissions,
network boundaries, configuration, cost drivers, deployment, upgrades, rollback,
and tested recovery. Use customer-owned domains and account inputs. Distinguish
our hosted account from a customer's account in any bring-your-own-cloud profile.
Other clouds remain future adapter work until their own deployment and contract
checks pass.

AWS Marketplace is a separate integration and launch milestone. Select the
product and billing model before implementing its required APIs. Follow AWS's
[current SaaS onboarding](https://docs.aws.amazon.com/marketplace/latest/userguide/saas-product-customer-setup.html)
and [product guidelines](https://docs.aws.amazon.com/marketplace/latest/userguide/saas-guidelines.html),
including customer-account deployment documentation where applicable. Keep
Marketplace customer/account mapping separate from Station tenant membership;
a purchase alone must not grant access to another tenant's data. Test purchase,
entitlement changes, usage reporting where required, cancellation, and recovery
from duplicated or delayed notifications. Partner status, listing approval,
pricing, and marketplace availability are not established by this design.

### Marketplace can start with an EC2 product

A customer-account deployment can be delivered as an AMI, optionally with a
CloudFormation template. AWS supports
[AMI-based CloudFormation delivery](https://docs.aws.amazon.com/marketplace/latest/userguide/cloudformation.html)
without requiring Fargate. A future seller-hosted service can use the separate
SaaS product model. Choose the delivery and billing model for the offering;
a later compute migration does not automatically convert a listing between
product types. An AMI/template must contain no developer credentials or customer
state and must document resources, permissions, upgrades, backup, and removal.
Marketplace approval and commercial integration remain separate work.

## Cost target and sizing assumptions

Planning estimate, checked 2026-09-05: use US East (N. Virginia), USD, 730 hours
per month, on-demand pricing, modest traffic, and no promotional credits or
long-term commitments. These are budgeting envelopes, not a measured Station
capacity result, AWS quote, or customer subscription price.

For the first private development profile, a Linux `t3.micro` at $0.0104/hour
is about $7.59 per 730-hour month. Illustrative 30-GB gp3 storage at $0.08/GB-month
adds $2.40; one public IPv4 at $0.005/hour adds $3.65 if used. That is about
$14/month before snapshots, transfer, CPU-credit charges, and other services.
Budget roughly $15–25/month for this experiment, not as a production promise.
The instance has only 1 GiB RAM, so its ability to run Station plus development
tools is unverified. A `t3.small` doubles memory to 2 GiB; its $0.0209/hour
compute rate puts the same illustrative base near $21/month before extras.
See [T3 specifications/pricing](https://aws.amazon.com/ec2/instance-types/t3/)
and [EBS pricing](https://aws.amazon.com/ebs/pricing/). T3 CPU-credit mode must be
explicit: sustained burst usage can incur Unlimited charges or Standard-mode
throttling. Stopping compute does not stop persistent storage charges.

The following larger shared-service allowance applies to the later hosted
profile, not the initial EC2 development experiment:

| Shared service cost | Small hosted pilot monthly allowance |
| --- | --- |
| Web/API compute, roughly 1 vCPU and 2 GiB continuously | $35–45 |
| Small single-AZ PostgreSQL database and initial storage | $30–60 |
| Load balancer, low traffic, and public IPv4 allowance | $25–40 |
| Modest artifacts, logs, secrets, DNS, and backup overhead | $10–30 |
| Combined baseline, before execution and model usage | $100–175; reserve approximately $200 for planning |

A redundant web tier and multi-AZ database justify a separate roughly $300–600
planning envelope, depending on sizing and network design. Neither envelope is
a capacity commitment or includes sustained heavy traffic. Validate the actual
resource list in the AWS calculator before provisioning. Sources:
[Fargate pricing](https://aws.amazon.com/fargate/pricing/),
[RDS PostgreSQL pricing](https://aws.amazon.com/rds/postgresql/pricing/),
[load-balancer pricing](https://aws.amazon.com/elasticloadbalancing/pricing/),
[VPC pricing](https://aws.amazon.com/vpc/pricing/), and
[S3 pricing](https://aws.amazon.com/s3/pricing/).

Execution is a separate usage budget. At the published Linux/x86 Fargate
N. Virginia example rates, a 2-vCPU/4-GiB task is approximately $0.099 per
running hour: about $2 for 20 hours or $72 for 730 hours, before persistent
workspace storage, network, logs, and model calls. Startup and idle time count.
This resource size is an illustration, not a validated agent-workload minimum.

Keep the shared service independent of the number of registered tenants. Start
isolated workers on demand, bound concurrency, and stop idle workers only after
preserving workspace state and respecting active execution ownership. Separate
model-provider spending from platform and execution allowances; make per-tenant
usage and limits visible. Bring-your-own provider credentials can shift model
billing to the customer but do not remove execution costs or credential controls.

Do not deploy a permanent compute stack per basic-tier tenant, add Kubernetes or
extra databases without a workload need, or accept an unbounded log/artifact
retention default. Evaluate networking explicitly: one $0.045/hour NAT gateway
adds $32.85 per 730-hour month before processing and address charges. Gateway
endpoints, task networking, and private connectivity have different costs and
security properties; choose a reviewed design rather than removing isolation to
save money. Budget alarms notify; application admission limits must enforce
execution and provider budgets. Marketplace fees, tax, payment processing,
engineering/support labor, and development/staging environments are outside the
infrastructure estimates above.

## The integration material every shipped slice needs

Publish the following alongside each adapter, deployment option, or integration:

1. A short end-to-end guide for an external team, with prerequisites, supported
   versions, configuration ownership, and expected outputs.
2. A runnable example or deployment template using generic domains and paths,
   with no dependency on a maintainer's machine or account.
3. Contract documentation for authentication, tenant scope, errors, limits,
   retries, compatibility, and migration behavior.
4. Operational instructions for upgrades, rollback, backup/restore, retention,
   deletion, and troubleshooting, as relevant to that slice.
5. Executable evidence for the advertised behavior, including its failure and
   isolation cases. State the environment tested and any unverified steps.

Use the existing [documentation maintenance workflow](documentation.md) and
[example catalog](../../examples/README.md). Update the topic owner in the same
change as the behavior. Link to live implementation work for missing steps;
do not turn a proposal into a copy-and-paste production recipe.

## Self-operated and managed offerings

The product direction is a reusable integration that teams can understand and
operate, with a managed offering that removes ongoing operational work.
Document the public contracts and the self-operated path clearly. Provider-specific
examples may add convenience while identifying every external prerequisite.

The managed offering should earn its price through demonstrated value such as
provisioning, maintained integrations, upgrades, execution capacity, recovery,
monitoring, and support. These are candidate service responsibilities, not a list
of included features or promised service levels. Publish availability, limits,
pricing, and support terms only when the corresponding offering is actually ready.
Licensing and commercial rights remain governed by the repository's license and
applicable service terms; this guide does not change them.

Measure the distinction with external-team outcomes: time to first successful
integration, repeatability from a clean environment, upgrade effort, restore
results, and operator time. A maintained example and tested compatibility are
more useful than an integration claim that depends on private setup knowledge.
