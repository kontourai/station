# Private GCP development environment

This is an operator-run development recipe for one owner and one persistent
Compute Engine VM. It is not a multi-tenant service, a Marketplace product, or
a completed cloud-move workflow. The shared cloud preview supports the
`gcp-compute` profile; automatic GCP template generation and setup transfer
remain unavailable. See [cloud move](../../docs/design/cloud-move.md).

## Prerequisites and budget

Use a dedicated project in your organization, linked to your billing account.
Authenticate with `gcloud auth login`; select the account explicitly in commands
rather than changing a shared default configuration. You need permission to
create the project/network/VM, enable APIs, and connect using IAP and OS Login.
Keep cloud credentials on the operator's machine. The VM below has no attached
service account or OAuth scopes.

The initial profile is `e2-micro` in `us-central1-a` with a 30-GB `pd-standard`
boot/data disk. It has about 1 GiB of RAM; the bootstrap adds a 2-GiB swap file.
Swap is prepared in a private temporary file and published only after its
signature validates. Active swap is not reformatted, and unknown existing final
files are preserved for inspection. A power loss or uncatchable interruption can
leave an unreferenced `swapfile.preparing.*` file; it is never automatically
enrolled. Review and remove only identified inactive staging files if reclaiming
that space. Swap is an emergency capacity buffer, not equivalent to RAM or proof that agent
workloads fit. Measure readiness, memory pressure, and latency before selecting
this profile for real work; resize to `e2-small` or larger if evidence requires it.

Set a project-scoped monthly budget (the development target is $25) and review
actual billing. Budget notifications do not stop spending. Google's
[free-tier allowances](https://docs.cloud.google.com/free/docs/free-cloud-features)
may cover qualifying compute/disk use but are shared across the billing account.
Public IPv4, snapshots, transfer, and model calls have separate costs. Persistent
disks remain billable when the VM stops or is deleted with disk retention.

## Provision the isolated host

Set your own values; no Kontour account is required:

```sh
STATION_GCP_PROJECT=your-development-project
STATION_GCP_ACCOUNT=you@example.com
STATION_GCP_REGION=us-central1
STATION_GCP_ZONE=us-central1-a
STATION_GCP_VM=station-dev-1
```

Enable `compute.googleapis.com`, `iap.googleapis.com`, and `iam.googleapis.com`
in that project. Link billing and configure the budget through your organization's
normal process before launching compute. Create a custom network rather than
using an existing network with broad inbound rules:

```sh
gcloud compute networks create station-dev --subnet-mode=custom \
  --project="$STATION_GCP_PROJECT" --account="$STATION_GCP_ACCOUNT"
gcloud compute networks subnets create station-dev-us-central1 \
  --network=station-dev --region="$STATION_GCP_REGION" --range=10.42.0.0/24 \
  --project="$STATION_GCP_PROJECT" --account="$STATION_GCP_ACCOUNT"
gcloud compute firewall-rules create station-dev-iap-ssh \
  --network=station-dev --direction=INGRESS --action=ALLOW --rules=tcp:22 \
  --source-ranges=35.235.240.0/20 --target-tags=station-dev \
  --project="$STATION_GCP_PROJECT" --account="$STATION_GCP_ACCOUNT"
gcloud compute instances create "$STATION_GCP_VM" \
  --zone="$STATION_GCP_ZONE" --machine-type=e2-micro \
  --image-family=debian-12 --image-project=debian-cloud \
  --boot-disk-size=30GB --boot-disk-type=pd-standard --no-boot-disk-auto-delete \
  --network=station-dev --subnet=station-dev-us-central1 --tags=station-dev \
  --no-service-account --no-scopes \
  --metadata=enable-oslogin=TRUE,block-project-ssh-keys=TRUE \
  --metadata-from-file=startup-script=deploy/gcp-dev/bootstrap.sh \
  --shielded-secure-boot --shielded-vtpm --shielded-integrity-monitoring \
  --labels=app=station,environment=development \
  --project="$STATION_GCP_PROJECT" --account="$STATION_GCP_ACCOUNT"
```

Run from the repository root. Choose another CIDR and names where required;
inspect existing resources before rerunning creation commands. The public IP
supplies outbound package access without a NAT gateway; inbound SSH is restricted
to IAP's range and Station ports have no inbound firewall rule. IAM authorization
is still required for [IAP/OS Login](https://docs.cloud.google.com/compute/docs/oslogin/set-up-oslogin).

Inspect `google-startup-scripts.service` and Docker through `gcloud compute ssh`
with `--tunnel-through-iap`. Resource creation does not prove bootstrap completion.
Use an operator-owned SSH key; never copy it or a Google refresh token into the VM.

## Enroll a prebuilt image

Build for `linux/amd64` in CI or on a capable build machine, not on the micro VM.
Use a verified digest-pinned image if its registry is accessible. Otherwise,
transfer an explicitly selected local image archive using `gcloud compute scp
--tunnel-through-iap`, compare its SHA-256 at both ends, then run `docker load`.
Verify the loaded image ID and Station source identity before starting it. A
local validation build is not a published or signed release merely because it
has a version label. Do not put registry credentials or secrets in the archive.

The bootstrap prepares these persistent directories:

- `/var/lib/station/home` mounted at `/data/station`;
- `/var/lib/station/workspace` mounted at `/workspace`.

Both are private and owned by UID/GID 1000, matching the Station image. Keep
Docker's restart policy, bounded local logs, 30-second stop grace, and
`no-new-privileges` from the repository's Compose profile. Bind only
`127.0.0.1:3000:3000`. Set `ALLOWED_ORIGINS` to the exact browser-visible forwarded
origin, for example `http://127.0.0.1:23000`. This is a fresh home; transferring a
source home or agent credentials is a separate, currently unavailable operation.

## Connect and verify

Forward an available local port through authenticated IAP SSH:

```sh
gcloud compute ssh "$STATION_GCP_VM" --tunnel-through-iap \
  --zone="$STATION_GCP_ZONE" --project="$STATION_GCP_PROJECT" \
  --account="$STATION_GCP_ACCOUNT" -- \
  -N -L 127.0.0.1:23000:127.0.0.1:3000 -o ExitOnForwardFailure=yes
```

Open `http://127.0.0.1:23000` and use the supported Station authentication flow.
An IAP tunnel alone is not a Station API credential. Preserve the distinction
between browser bootstrap, local-grant, and operator credentials documented in
the [CLI reference](../../docs/reference/cli.md#scripted--non-interactive-use).

Before calling the environment usable, verify:

1. Image architecture and exact source identity, container health, and authenticated API access.
2. Git operations, writable workspace files, and the real PTY handshake.
3. Container recreation with the same project, files, Git state, and authentication.
4. VM stop/start with the same retained disk and expected recovery.
5. Actual memory/swap usage, absence of OOM events, and response latency.

No check above proves a provider login migrated or an active agent resumed.

## Recovery and cleanup

Stop writers before taking an offline home backup; include workspace and
uncommitted Git state separately. Store encrypted backups off the VM and test
restoring to an isolated target. Retained disks are not backups.

Stopping the VM preserves the disk but ends live processes. Deleting the VM with
`--no-boot-disk-auto-delete` leaves a separately billable disk; list and identify
that disk before any later removal. A replacement instance does not automatically
inherit execution authority. Use explicit recovery and source fencing rather
than attaching the same writable home to competing runtimes. Remove only the
network/firewall/budget/project resources owned by the completed experiment.
