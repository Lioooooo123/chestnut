# First-host startup and recovery

This is preparation for a new, explicitly authorized Linux host. Nothing here was deployed on a VPS. The service profile remains experimental until the recorded live gates pass. Do not reuse an old host, runtime directory, Docker image identity or channel binding implicitly.

## 1. Prepare and inspect, without provisioning

Use a dedicated ordinary OS user. Node 24+, Git, util-linux flock, local rootless Docker and delegated systemd/cgroup-v2 CPU, memory, swap and PID controls must already be provided by the operator. These scripts do not install or configure them. Only local Unix Docker endpoints are admitted; SSH/TCP Docker contexts are refused. No public port, tunnel or Tailscale setup is needed.

Select an owner-controlled volume with a disk quota for Docker writable layers and application data. An estimate of 2 vCPU, 4 GB RAM and 10 GB free storage is a starting point, not a measured minimum or an enforced quota. The Docker smoke creates two environments with 1 GB limits each. Audit/session growth and cumulative model spending still require operator controls.

From the selected checkout, explicitly install locked application dependencies:

```sh
npm ci --ignore-scripts
npm --prefix vendor/pi ci --ignore-scripts
npm run acceptance:offline
```

The offline entry runs source/link verification, strict TypeScript, the complete guarded suite and a temporary model-less Worker demo. It does not install anything. Linux must run its OS-lock and listener tests; a non-Linux skip is not Linux acceptance. Pi contracts/build are already documented in [pi-source.md](pi-source.md); rebuild when source or dependencies change.

The new preflight reads metadata only. Unlike `doctor`, it creates no data directory, database or container, and does not load `.env`:

```sh
npm run preflight -- --offline
npm run preflight -- --docker --data-dir /home/chestnut/acceptance-new --image chestnut-pi:4270522473e6
```

Replace the example account/path with the actual dedicated account. The data path must not exist; its parent must be canonical, owned by that user and not writable by others. A blocked check stops admission. `readyForDockerAcceptance` only means prerequisites were reported: it is not verification of enforced resources, disks, service continuity or model/channel delivery. The script never pulls or builds an image. An absent image needs a separately explicit `npm run pi:build` after rootless setup.

## 2. Run the repeatable model-less Docker subset

```sh
npm run acceptance:docker
npm run acceptance:docker -- --execute --data-dir /home/chestnut/acceptance-new --image chestnut-pi:4270522473e6
```

The first command only prints a plan, without contacting Docker. The second freezes the inspected immutable image ID, exclusively creates a **new disposable** mode-0700 directory, and uses the actual stable-environment implementation and Linux OS locks. It checks runtime assets, independent Bot roots/workspaces, a container-loopback service surviving a second execution, and whole-Bot stop/restart preserving files but ending the service. It publishes no host ports, installs no packages and uses no model or Telegram credential. Guest command output is not a host integrity certificate.

SIGINT/SIGTERM close execution admission, wait for the bounded operation and enter verified cleanup. SIGKILL/host failure cannot run cleanup; inspect the retained record and Docker state manually. The script stops only its two recorded Bot identities, preserves rootfs and saves `acceptance-evidence.json` with mode 0600. It does not remove containers or data. Any uncertain stop/OS-lock outcome is an operator-review failure, never a success. Repeating requires another new directory; do not erase evidence or lock files to reuse it.

The smoke proves only its reported scope. Actual Worker/runner/broker interaction, Worker SIGKILL recovery against Docker, measured cgroup limits, signed online package staging, live model and Telegram remain required in [service-acceptance.md](service-acceptance.md). Deterministic tests cover their failure semantics but do not replace those live stages.

## 3. Start the application with explicit roles

Use a separate new runtime directory; never use the acceptance directory or change an existing profile in place. Start with empty package/domain allowlists and automatic memory maintenance disabled to avoid background model spend during initial acceptance:

```dotenv
CHESTNUT_MODE=pi
CHESTNUT_SANDBOX_PROFILE=service
CHESTNUT_EXPERIMENTAL_SERVICE=1
CHESTNUT_NETWORK_POLICY=none
CHESTNUT_DATA_DIR=/home/chestnut/chestnut-service-new
CHESTNUT_HOST=127.0.0.1
CHESTNUT_PORT=4310
CHESTNUT_MEMORY_AUTOMATIC=0
CHESTNUT_TELEGRAM_ENABLED=0
```

Store configuration in an owner-readable environment/config file outside source control. Keep secrets out of commands, chat, task prompts, browser storage and logs. Add an authorized outer model grant only when ready for live acceptance. `npm run dev` initializes the schema once, then starts separate API and Worker processes; it strips the provider secret from API and channel children, and Telegram token from API/Worker children. Telegram adds a third process only when explicitly enabled.

For independently supervised roles, load nonsecret runtime settings into each process and inject secrets only into their intended role. Use `node src/cli.ts api`, `node src/cli.ts worker`, and later `node src/cli.ts channel`; these direct forms do not automatically read the repository `.env`. Do not share a secret-bearing `.env` with every role. The API coordinates durable tasks while Worker is busy; it never runs task shell commands. The channel submits through the same SQLite task/command ledger.

Keep the API loopback-only. A later authorized access method must preserve that boundary. No automatic public listener, HTTPS proxy, boot service, login, channel enrollment or host security change is provided. After acceptance, the operator can separately decide process supervision, backups and resource budgets.

## 4. Package and channel acceptance are separate

- Approve exact Debian packages **including dependency closure** before using `environment_packages`. Capture signed metadata and hashes. The download-only helper has bridge networking but no Bot data or credential mounts; it is not an egress firewall. Stable Bot networking stays none. Host apt/dpkg is never part of this flow. See [governed-packages.md](governed-packages.md).
- Keep Telegram disabled until an explicit test token, verified numeric owner/private-chat IDs and existing Bot UUID are configured only in the channel process. Confirm incoming task and outgoing receipt/result in both Telegram and SQLite. Unknown senders/groups must do nothing. An uncertain outgoing send must stay uncertain, not be resent. See [telegram-channel.md](telegram-channel.md).
- Test steer, follow-up queue and cancel while a real tool is running; steering ACK is not proof of influence, cancellation is not rollback. Test an active Worker crash, lease expiry, quarantine and a new explicit task after review. Separately restart an idle Worker and observe service continuity. Queue admission and service health are distinct facts.

## 5. Recovery and backups

| Observation | Response |
| --- | --- |
| Interrupted task / lost tool transport | Preserve task/events/rootfs. Inspect actual effects; submit a new task explicitly. Never replay the original automatically. |
| Worker restart | Existing recovery fences stale leases and verifies ownership/cleanup before new work. Confirm actual Docker state; a healthy registry row is not live process proof. |
| Missing/replaced recorded container or image | Leave quarantine. Do not recreate, retag, migrate or edit the database to conceal the mismatch. Decide on restoration/new Bot explicitly after reviewing evidence. |
| Retained OS-lock holder or poisoned marker | Keep the lock and marker. Identify the exact owner PID, outstanding Docker operation and immutable container IDs. Do not kill unrelated processes, delete lock files or claim cleanup from client exit. Manual reconciliation needs an explicit operator decision after actual daemon state is known. |
| Pending/contained package mutation | Stop the stable environment, inspect dpkg/rootfs and retained package records. After review, use the documented reconcile request with `confirmed:true`, exact quarantined run ID and current immutable container ID; Worker still verifies stop before release. This does not undo package scripts. |
| Dirty memory Git repository | Preserve user edits; inspect and resolve deliberately. Do not reset/clean or blindly rerun maintenance. |
| Telegram failed/uncertain delivery | Retain the ledger; ask for status explicitly rather than re-sending an ambiguous message. Changing owner/chat/Bot binding requires a separate data directory. |

Before a backup/upgrade, stop new ingress and gracefully stop the role processes; record exact application commit and immutable image/container identities. SQLite uses WAL: do not copy only the live `.sqlite` file. Take an offline consistent copy of the entire control state (including memory Git and private OAuth/channel state), workspaces and sessions, plus a separately consistent Docker rootfs snapshot. Restrict backup access as tightly as the originals. Container export alone does not include mounted workspaces or a consistent database. Restore all parts together into an explicitly reviewed destination; do not point a fresh control database at old containers and assume ownership will match.

There is no automatic destructive recovery helper or automatic schema downgrade. Keep the prior source and consistent snapshot before an upgrade; if a downgrade is required, stop ingress/processes and restore that matching snapshot after review. Never overwrite current state as a retry shortcut.

## VPS-ready remaining gate

1. Read-only host preflight, then the explicit model-less Docker subset above.
2. Real Pi/model/broker roundtrip for two Bots; inspect namespaces/mounts and measure resource enforcement.
3. Reviewed signed package install and cross-task service continuity; verify failures stop the environment while preserving files.
4. Active/idle Worker restart, steer/follow-up/cancel and quarantine/reconciliation; once/cron after restart.
5. Explicit private Telegram owner test and delivery ledger, followed by actual mobile device/keyboard/accessibility review.

Save exact commands, timings, scoped results and redacted evidence for each. Completion of preparation is not completion of these live gates.
