# Experimental persistent-root backend

This profile adds a persistent writable Linux container root filesystem per Bot. It is opt-in and does not replace the default read-only, per-run backend. It has not been exercised against a live Docker daemon in this development environment.

## What persists, and what stops

- Container identity: `chestnut-bot-<botId>` remains the same across tasks.
- Writable root filesystem: files, configuration, locally written executables and software files survive a normal task completion and container stop/start.
- Workspace: the Bot's existing host-backed `/workspace` remains persistent.
- Pi sessions: `/var/lib/chestnut/sessions/<taskId>/session.jsonl` inside the Bot's writable container layer. The generic adapter's host `sessionPath` is validated for diagnostic compatibility but is not mounted or used for persistent-profile storage.
- Processes: the ENTIRE Bot container is stopped after every task, including successful settlement, cancellation, startup failure and recovery. Service configuration can persist; running services do not remain alive between tasks.
- Rootfs is never deleted by normal disposal or recovery. Missing or replaced recorded container identity is an error requiring investigation, not permission to silently create a replacement.

This is a persistent-root filesystem implementation, not an always-running personal server implementation. There is no live-service continuity claim.

## Enable on a test Linux host

Use a separate data directory from the default profile:

```sh
CHESTNUT_MODE=pi
CHESTNUT_SANDBOX_PROFILE=persistent
CHESTNUT_EXPERIMENTAL_PERSISTENT=1
CHESTNUT_NETWORK_POLICY=none
CHESTNUT_DATA_DIR=/your/dedicated/chestnut-persistent
```

The API and Worker configuration must agree. The storage marker prevents mixing demo, ephemeral Pi and persistent Pi directories. Provider credentials remain only in the outer Worker environment. Use a dedicated unprivileged OS account that owns its rootless Docker daemon and data.

Rebuild the image after this implementation is present:

```sh
npm run pi:build
```

Persistent mode additionally requires image label `org.chestnut.persistent.profile=experimental-v1`. The Pi commit label alone is insufficient, because an earlier image can contain the same upstream commit without the new entrypoints. The existing ephemeral backend remains compatible with its original image format.

## Trust and lifecycle

The outer control plane owns scheduling, lease checks, process fencing, model authorization and Docker control. No Docker socket, database, host credential directory or another Bot's workspace is mounted in the guest.

The persistent backend mounts exactly:

1. `dataRoot/bots/<botId>/workspace` read-write at `/workspace`
2. A dedicated host-owned per-Bot gateway directory read-only at `/run/chestnut`

The gateway directory may contain only per-run Unix sockets. The current task uses `<runId>.sock`; it receives no provider credential. The trusted gateway validates the current run before each upstream request. A previous Bot must be authoritatively stopped under the outer OS lock before a new model socket is published. Cancellation may revoke and remove the current socket before stopping the Bot. A short host-only gateway root avoids Unix socket path limits and is recreated after a host reboot.

A minimal Node keepalive is the container's startup command. Per-task Pi executes through `docker exec` and a credential-free loopback relay. Since the root filesystem is intentionally writable, the guest can change the keepalive, Pi, Node or the relay for later tasks. These binaries are not trusted lifecycle/security components. Their output, an RPC settlement event, a guest cleanup script, or an exec-client exit does not certify that guest processes stopped.

Instead, disposal kills/reaps the trusted Docker exec client, asks the rootless Docker daemon to stop the complete container, and re-inspects `State.Running`, `Paused` and `Restarting`. Success requires a verified stopped container with the same identity. Concurrent cleanup callers share the same attempt and outcome. Failure keeps the environment quarantined.

The Worker must hold the outer per-Bot OS lock for the complete launch/run/cleanup lifetime. Recovery acquires that same lock before mutation or quarantine clearance. The injected Docker command runner must stay under that trusted lock lifetime, including pending operations if the parent process dies. The backend's mandatory `canStart()` callback rejects create/start/exec after cancellation, while `canMutate()` continues to permit owned cleanup. The `canMutate()` fencing callback is checked after asynchronous checks and immediately before lifecycle mutations. Old owners may not stop a newer task's same-name container.

## Reuse checks

Before reusing a saved container, the backend checks trusted Docker metadata rather than its name/labels alone:

- Recorded container ID and base image ID
- Pinned Pi source and persistent-profile image labels
- Bot/profile/schema labels, startup argv and guest UID
- Exact mount sources, targets, read/write state and propagation
- Network `none`, no privileged mode, no additional capabilities/devices/host namespaces/port publishing
- All capabilities dropped, no-new-privileges, default seccomp behavior, init enabled
- CPU, memory and PID limits; no automatic restart or automatic container removal
- Only the expected base-image environment variable names

A previously provisioned ID that is missing or replaced cannot be automatically adopted. An entirely unprovisioned Bot can create its first container. Image changes are not an automatic writable-rootfs migration mechanism.

## Network and installation boundary

Only `networkPolicy: none` is implemented. `maintenance` is a deliberately rejected interface value until governed package-installation networking and authorization have been designed and tested. There is no bridge/host-network fallback.

Do not claim that arbitrary `apt`, `git clone`, `pip` or online software installation works. Network is disabled and all capabilities remain dropped; some package-maintenance operations also need capabilities that this profile does not grant. Files written using currently available tools persist. That does not establish that package installation, system services, init systems or external service ports have been verified.

Persistent state increases the blast radius within one Bot: tasks can alter later tasks' files and runtime binaries. Task separation is a scheduling/session boundary, not a security boundary inside the same Bot. Rootless containers share a kernel and are not a high-assurance hostile multi-tenant boundary. CPU/memory/PID are bounded, but writable layers and workspace data currently have no application-managed disk quota. Use a dedicated, quota-limited test host/storage volume.

## Verification completed locally

`tests/persistent-backend.test.ts` uses an injected trusted Docker runner and real temporary directories. One designated regular file is reported as a socket by an explicit filesystem test dependency; no Unix listener or external network connection is created. A separate native-default test proves that a regular file is rejected by real production filesystem validation. No environment variable can disable production path checks.

Covered by policy/lifecycle tests:

- Safe writable-root creation argv with only two permitted mounts
- Start/exec/whole-bot-stop sequencing and concurrent cleanup
- Rootfs/container identity retained after normal disposal and reuse
- Rejection of changed image/security/mount/credential configuration
- Rejection of stale cleanup ownership before a newer run can be stopped
- Quarantine-relevant stop failure and still-running observations
- Refusal to recreate a missing recorded container or adopt a replacement
- Symlink and unexpected gateway-file rejection

These are mock-policy and lifecycle tests. They do not prove Docker isolation or filesystem/service behavior on a real daemon.

## Still required on a VPS/test host

1. Build the new image under a verified rootless daemon.
2. Run a real task that writes outside `/workspace`; complete it, verify the container is stopped, and verify the file in the next task.
3. Start a harmless background service during a task; confirm whole-bot stop kills it, while its configuration persists.
4. Verify no cross-Bot workspace/rootfs/network/socket access and no host credential or control-plane visibility.
5. Kill and pause the Worker at launch, exec and cleanup boundaries; verify the outer lock, lease fencing, quarantine and recovery prevent overlap and replay.
6. Exercise actual Unix socket model relay, authorization revocation, model streaming and cancellation.
7. Verify disk growth limits operationally; installation-network policy remains an explicit later requirement.

Live Docker/Podman, container rootfs/process persistence, real provider inference, and live Unix socket tests were not available here. The profile remains experimental until those checks pass.

## Resource-control admission

Both real launch profiles require Docker to report cgroup v2 with the systemd driver and enabled memory, swap, PID and CPU-quota controls. This is stricter than merely checking rootless mode: [Docker documents that rootless resource flags can otherwise be ignored](https://docs.docker.com/engine/security/rootless/tips/#limiting-resources). Missing capability reports block launch; cleanup still only requires verified rootless ownership so an unsupported host can stop an existing container. No host cgroup/systemd settings are changed automatically. Actual quota enforcement still needs live host verification.

## Quarantine operations

The trusted flock holder records a synced ownership marker while operations are active. A timeout, abnormal command exit/transport, oversized control output or unexpected holder death prevents automatic takeover. The marker and OS lock may intentionally outlive a failed Worker. Errors identify the marker and holder PID for an operator; they are not instructions for the guest.

Before manual reconciliation, stop submitting work and inspect the recorded Bot identity, rootless daemon state, pending host Docker clients and lock holder. Confirm no old lifecycle operation can still arrive and the exact Bot is stopped before clearing a stale marker. If that cannot be established, keep quarantine. Never unlink the `.lock` inode as a shortcut; a new inode can create two independent owners. This V1 has no automatic operator-recovery or destructive environment-reset endpoint.
