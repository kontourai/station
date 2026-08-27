# Private runner partition

This is an operations plan for any GitHub Actions fleet where short feedback
must remain available while long jobs share one physical host. It deliberately
does not modify a host from a repository checkout.

GitHub Actions treats `runs-on` labels as required set membership, not a
priority queue: a runner can accept a job whenever it has every requested
label. A shared broad label therefore lets a heavyweight job claim a feedback
listener before that job reaches its own resource lease.

## Label contract

On the Windows runner host, configure two independent Linux runner listeners:

| Listener purpose | Required custom labels | Must not carry |
| --- | --- | --- |
| Fast feedback | `fast-feedback` | `kontour-linux`, `heavy-host`, `docker`, `playwright`, `android-kvm` |
| Heavy host work | `kontour-linux`, `heavy-host`, plus its real capabilities such as `docker`, `playwright`, and `android-kvm` | `fast-feedback` |

Both listeners retain GitHub's default `self-hosted`, `Linux`, and `X64`
labels. Keep the existing native Windows listener and its `kontour-windows` /
`native` routing unchanged.

Station routes only `ci.yml`'s `fast-checks` job to `fast-feedback`. Every
other Linux workflow job that reserves `physical-host-capacity` (including a
reusable workflow caller) requests `heavy-host`. The lease is still required:
the two listeners may run a 4-unit fast lane and a 6-unit heavy lane together,
but never work that exceeds the host's 10-unit budget.

## Safe rollout

1. Drain or disable the affected Linux listeners before changing their labels;
   do not relabel a listener while it runs a job.
2. Register or reconfigure exactly one fast listener and one heavy listener
   with the contract above, then verify their labels in GitHub's runner list.
3. Merge the workflow routing only after both listeners are online. Dispatch
   `CI` and a representative heavy workflow; confirm `fast-checks` is assigned
   to the fast listener and the heavy job to the heavy listener.
4. Keep the physical-host capacity action enabled and inspect its lease output.
   Label partition prevents listener starvation; it does not replace resource
   accounting for CPU, Docker, browsers, KVM, or disk.

For another repository, add both labels to that repository's workflow-label
allowlist and a deterministic policy test. Do not merely document the labels:
assert that the fast lane has `fast-feedback` and no shared heavy label, that
every other persistent Linux job has an exclusive routing label, and that each
capacity-leased Linux job has `heavy-host` and no fast label. Reusable workflow
callers must pass a literal JSON label array; dynamic expressions make routing
uninspectable and must fail closed.
