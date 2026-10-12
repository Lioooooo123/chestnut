# V1 architecture and recovery

## Processes and trusted boundary

Browser → loopback API → SQLite WAL ← separate Worker → rootless Docker → Pi RPC.

The API serves a small static dashboard and accepts durable requests; it never executes generated commands. The Worker owns scheduling, run leases, command delivery attempts, result classification and cleanup. All SQL state transitions execute under BEGIN IMMEDIATE. The initial heavy-work concurrency is globally one.

Default real mode launches pinned, source-built Pi in a rootless container with no network, read-only root, bounded CPU/memory/PIDs and only the bot workspace, task session directory and current run's model socket mounted. The outer worker's OpenAI key and control DB are not mounted. A container-local loopback relay talks to a private Unix socket; the outer gateway accepts only the configured OpenAI model and fixed Chat Completions endpoint. It checks the SQLite lease and task cancellation state before credential use. There is no arbitrary HTTP proxy.

The image intentionally disables Pi extensions, skills, MCP and context-file discovery so a workspace cannot load additional host capabilities. Pi's built-in tools execute only inside the container. User-controlled task/bot IDs never become unchecked paths or shell arguments. There is no shell interpolation in Docker commands.

The code does not consider a rootless container to be a VM or strong malicious-code boundary. Host filesystem quotas and a dedicated account are still necessary operational controls.

## Durable records

- bots: user-created coordination identities
- tasks: queued request, parent follow-up relationship and result state
- runs: worker identity, unique token, increasing fence number and lease deadline
- commands: messageId, payload, pending/sending/sent_unconfirmed/uncertain/cancelled delivery status
- requests: canonical request payload and original response for idempotent retries
- events: append-only per-task progress and state events
- outbox: transactionally linked, globally ordered notification records, exposed read-only with cursors
- workers: expiring heartbeats, separate from task status
- bot_environments: fixed profile, observed container/base-image IDs and lifecycle state
- environment_locks: exclusive mutation ownership for the bot workspace
- quarantines: uncertain cleanup which prevents all further heavy scheduling
- approvals: reserved schema only; there is no V1 user-facing external-capability approval workflow

The event outbox is not a guarantee of exactly-once external notification delivery. Polling clients may read a record repeatedly and deduplicate by sequence.

## State transitions

queued → running → succeeded / failed / interrupted

queued → cancelled

running → cancelling → cancelled (only after trusted cleanup)

Unknown cleanup, stale lease or lost transport after possible prompt dispatch ends as interrupted, even if some tool effects already occurred. An explicit cancellation maps to cancelled after cleanup succeeds, regardless of the Pi aborted flag. Cleanup failure always remains interrupted plus quarantine.

A successful assistant retry supersedes an earlier model error. An assistant model error after settlement is failed. A lifecycle event alone is insufficient to claim semantic success. Tool failures are retained as progress events; Pi may repair a tool failure in a later turn.

## Message and queue semantics

API acceptance means stored in SQLite. A message UUID is scoped to its bot; reusing it for another payload returns 409. Commands are marked sending before any adapter call. A transport ACK only produces sent_unconfirmed, never “applied.” Pi's correlation ID is not proof of semantic consumption or durable effects. An uncertain send is never retried automatically.

Steer remains in the durable command queue until prompt readiness. Pi applies it at a complete assistant-turn tool-batch boundary; it cannot interrupt an individual running tool. Cancellation has a separate control path so it can preempt a steer waiting for an ACK.

Follow-up creates another task rather than populating Pi's volatile follow-up queue. It waits for a known predecessor result and receives bounded textual context in a new session. Cancelled/interrupted parents reject new follow-ups; existing queued descendants are cancelled. To proceed after an unknown outcome, review effects and submit a fresh task explicitly.

## Launch, cancellation and recovery

1. Claim one queued task atomically with a unique run token, monotonically increasing fence, lease and environment lock.
2. Prepare only fixed UUID-derived paths and a per-run gateway socket. Reject path/symlink crossing and mixed demo/real state directories.
3. Verify rootless daemon and image source label. Create a stopped named container, then attach/start it. A late create from a dead process can leave only a stopped container.
4. Subscribe to RPC, request get_state readiness, re-check the outer lease/cancel fence synchronously, then send one prompt.
5. Renew lease; dispatch durable steering with its own fence. If lease is lost, close the gateway and cancel the adapter.
6. On cancellation request all relevant Pi abort controls and queue clearing. After at most two seconds, stop/reap the Docker attach process and remove the exact labeled container. Verify absence; client exit alone is not evidence of container death.
7. Only after disposal/gateway cleanup is verified publish the final task state and release the mutation lock. Unknown cleanup persists quarantine.
8. Restart marks expired runs interrupted, marks in-flight sends uncertain, cancels dependent queued tasks and retains quarantine. Real mode validates exact bot/task/run labels, removes only owned named containers and confirms absence before unblocking. It never replays the interrupted task or commands.

Fencing is an outer control/capability measure, not a claim that a distributed check and arbitrary external action are atomic. No exactly-once guarantee is offered. Operators must inspect actual effects after interruption.

## Experimental persistent profile

See [persistent-backend.md](persistent-backend.md). One named writable rootless container is reused per Bot; per-task Pi uses Docker exec and internal task session paths. Whole-bot stop is mandatory on every task boundary, preserving the writable filesystem but interrupting all services. Saved container/image IDs and exact Docker security/mount policy are verified. Missing prior identity is quarantined rather than silently recreated.

A trusted host flock holder routes Docker commands and exec attachments; it drains pending lifecycle operations and reaps attachments before releasing ownership even after Worker EOF. Unknown command outcome or abnormal holder death leaves a durable quarantine marker; no automatic takeover occurs. Model socket admission remains bound to current task, lease, cancellation and OS-lock ownership. Startup of mutable guest code counts as a possible effect even before Pi readiness.

## Scope left for later

Persistent bot workspace and an experimental writable per-Bot rootfs lifecycle are implemented; the latter lacks live VPS acceptance. Per-task Git worktrees, continuous background services, governed outbound package installation, quota-backed storage, cumulative model budgets, additional providers, local-auth/reverse-proxy deployment, backup migrations, richer approvals and integration credentials are future work. No unsafe fallback enables them implicitly.
