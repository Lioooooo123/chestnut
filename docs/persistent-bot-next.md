# Core requirement status and VPS acceptance

The tested control-plane baseline is preserved separately. The current source additionally implements an opt-in experimental persistent-root backend; see [persistent-backend.md](persistent-backend.md).

## Implemented locally, not live-verified

- Stable named rootless container and writable root filesystem per Bot
- Persisted container/base-image identity, verified saved mounts and security policy; no silent replacement of missing OS state
- Per-task Docker exec and session path inside the bot
- Host-controlled whole-bot stop on success/cancel/error/recovery, preserving rootfs
- Rootless and cgroup/resource-control preflight; no host settings changed automatically
- Durable SQLite quarantine plus OS-lock-holder routing of trusted Docker operations; delayed old operations block takeover
- Explicit experimental flag and separate data directory; default read-only profile retained
- Fixed model broker outside the guest; no host credentials/DB/Docker socket mounted

## Still open core gaps

- Actual rootfs persistence, cancellation, crash recovery and namespace behavior have not been tested on Docker here.
- The entire Bot stops at task boundaries. Service configuration can persist, but running background services do not stay alive between tasks.
- Only network none is supported. Maintenance/installation networking is an explicit rejected policy value. Arbitrary apt/git/pip online installation is not implemented; some package operations also need capabilities currently withheld.
- No per-task Git worktree, cumulative model budget or application-managed disk quotas. Both rootless Docker's writable-layer storage and workspace data need operator storage limits.

## Before VPS work

Use the selected authorized execution environment, a dedicated non-root account, Node24, util-linux flock, Rootless Docker, subordinate UID/GID mappings and cgroup v2/systemd with resource controllers. Existing rootful Docker/containerd/Nginx or other workloads must not be altered implicitly. Package installation, account creation, security/network settings and deployment remain separate authorization decisions.

A practical initial build target is roughly 2 vCPU, 4 GB RAM and 10 GB free disk; this is an estimate, not a measured minimum. Check available resources alongside existing workloads first.

## Required live acceptance

1. Create two bots and verify UID0 is namespaced, host root and other bot paths remain inaccessible, and CPU/memory/PID/swap controls are actually enforced.
2. Make a controlled rootfs change in Bot A, finish the task, restart Worker and run another task. Verify state persists only in A and recorded container identity stays unchanged.
3. Cancel during tools; verify complete Bot stop with rootfs retained. Confirm and clearly disclose service interruption.
4. SIGKILL Worker during create/start/exec and kill/pause the lock-holder in a disposable test. Verify old operations cannot race new work, unknown outcomes remain quarantined and no prompt/command is replayed.
5. Remove/replace a disposable Bot container externally and verify automatic replacement is refused.
6. Verify broker socket isolation, cancellation/lease revocation, no general outbound Internet and no credential exposure.
7. Design, authorize and test a governed software-install route separately. Do not claim apt works under network none.
8. Decide the required service-continuity model before enabling long-lived background services; current safe profile stops them at every task boundary.

These remain open; mock and pipe-based tests do not replace live VPS evidence.
