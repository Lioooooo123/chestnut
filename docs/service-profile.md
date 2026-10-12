# Experimental service profile

This is an opt-in implementation milestone. It has deterministic policy, lifecycle, broker, package-pipeline and Worker regression tests; it has **not** passed real rootless Docker/model/service acceptance in this execution environment. Use a new disposable data directory and complete `service-acceptance.md` before relying on it.

## Three profiles

- `ephemeral` (default): per-task read-only Pi container, persistent Bot workspace, task-end removal.
- `persistent` (older experiment): one writable Bot container with Pi inside it; whole-container stop at every task boundary. Files survive, processes do not.
- `service` (new experiment): a stable writable Bot environment and a separate disposable Pi runner. A successful task can leave services running; cancellation, errors, command uncertainty and worker recovery stop the entire stable environment while preserving files.

Enable explicitly, using the same dedicated ordinary Linux account for API/Worker/rootless Docker:

```sh
CHESTNUT_MODE=pi
CHESTNUT_SANDBOX_PROFILE=service
CHESTNUT_EXPERIMENTAL_SERVICE=1
CHESTNUT_NETWORK_POLICY=none
CHESTNUT_DATA_DIR=/home/you/chestnut-service
```

Rebuild the pinned image after these source changes. Existing recorded image/container identities are never silently replaced or migrated. A missing saved environment is an error requiring explicit reconciliation. `flock`, delegated cgroup v2/systemd resource controllers and rootless Docker are required. A cgroup launch-preflight failure must not prevent stopping an already-owned environment.

## Model and service lifetimes are separate

The stable environment has one mount: its own `/workspace`. It has no model/memory/environment broker socket, session directory, host home, provider credentials, Docker socket, host PID namespace or sibling workspace. It has `network=none`, private IPC/cgroup namespace, no-new-privileges and bounded CPU/memory/PID/swap. Its namespaced root gets only CHOWN, DAC_OVERRIDE, FOWNER, FSETID, SETGID, SETUID and NET_BIND_SERVICE. SYS_ADMIN, privileged mode, host network and raw host-root execution remain forbidden.

Pi SOURCE still runs in a disposable read-only, network-none container. Its `/workspace` is a private 64 MiB tmpfs; task session files and per-run brokers are separate from the stable environment. Built-in tools and implicit project context/extensions are disabled. The only enabled execution tools are `environment_bash`, `environment_read`, `environment_write`, `environment_edit`, `environment_packages`, and `environment_fetch`, plus explicit memory tools when enabled. Unique names prevent builtin fallback. A startup manifest checks exact extension ownership; the host refuses prompt dispatch until environment-tool readiness arrives.

All six environment tools call one private per-run host broker. The broker binds the Bot/Run, rechecks the present lease, serializes operations, bounds requests/results/receipt memory, detects conflicting request IDs, and never replays an uncertain operation. Shell/filesystem commands execute through fixed Docker argv in the stable environment. The host never runs a task's shell command. Guest output is untrusted tool output, not proof of host cleanup or guest integrity.

Old stable processes cannot inherit a later task's model grant because the model socket is never mounted there. Both the disposable runner and stable-environment lifecycle use the same external OS-lock command holder. The holder retains quarantine on uncertain Docker operations. Reaping an attach client alone is not cleanup proof; trusted Docker inspection/removal is required.

## Completion, cancellation and services

Keep-running requires all of: authoritative Pi settlement, no error/abort/lease loss, healthy and drained environment broker, confirmed disposable-runner removal, and successful closure of all brokers. A failed cleanup cannot be overwritten by another successful cleanup. Uncertain commands mark the task interrupted and cancel dependent follow-ups even if the model produces a confident final answer.

Cancellation closes admission immediately; cleanup may wait for the current bounded command/package step to settle before whole-environment stop. It is not an immediate rollback.

For simple background services, run them with output redirected and explicit PID/log files. A normal successful task may leave them running. They are intentionally stopped on cancellation, failure, uncertain operations and worker-crash recovery. Service restart supervision, boot autostart, port publication and systemd are not included. The profile does not promise service availability through Docker/host restarts. Services may bind container loopback ports for subsequent Bot commands; no public/listening host ports are published.

Dashboard **Environment → Stop** closes the current task and queues a trusted whole-environment stop. The stop is durable and idempotent, including old request retries. New explicit tasks or future schedules can start the environment again; stop is not a permanent Bot pause. Status is an observed control-plane state, not a continuous service health probe.

## Packages and governed network

Policy defaults deny all packages and hosts. The local operator edits exact allowlists in the Environment tab/API, using compare-and-swap revision checks. Tasks cannot edit this policy.

- `environment_packages` uses real apt planning/download in a one-shot trusted downloader, host digest checks, then offline dpkg inside the stable Bot. Every downloaded dependency needs approval in the allowlist. The downloader explicitly uses Docker bridge with **no Bot/user-data or credential mounts**. Fixed signed Debian sources do not turn bridge into a firewall; do not describe it as isolated egress. Details: `governed-packages.md`.
- `environment_fetch` is a host-side GET-only HTTPS fetch to an exact allowed DNS host. IP literals, credentials, non-443 ports, redirects, local/private/metadata/reserved addresses are rejected. DNS results are validated then pinned for TLS, and resolution plus request have a 15-second overall deadline. Upstream reads stop above 128 KiB; returned body is explicitly truncated at 12,000 bytes to bound encoded tool output. No cookies, bearer headers, general proxy, socket connection, upload or arbitrary service egress is provided.
- Direct `apt`, `curl`, `git` or `pip` network commands in the stable shell still have network none. Use the governed tools within their explicit scope. There is no silent bridge fallback for Bot services.

Package import intent is stored durably before the first stable mutation. A worker crash, partial import/install, uncertain transport or unresolved marker requires containment plus operator review. Recovery cleans ownership-matched downloaders, stops the stable environment, and retains the review hold. Inspect rootfs/package state first. Only then POST `/api/bots/:botId/environment/reconcile` with `confirmed:true`, the exact quarantined `runId`, and the recorded `containerId`; the Worker still verifies cleanup before release. This confirmation is not a rollback.

## Current limits

Same-owner personal Bots are the threat model, not hostile multi-tenant code. Rootless containers and no-new-privileges are not a VM boundary. Writable guest code can lie about tool/install results. Host resource/ownership/mount checks are separate from guest reports. Filesystem/disk quotas still require operator-managed volumes; unbounded audit/session storage and task-level cumulative model spending need operator controls. Keep sensitive host directories out of mounts.
