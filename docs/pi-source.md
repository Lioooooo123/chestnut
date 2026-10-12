# Pi source integration and sandbox

## Exact inputs

- Repository: https://github.com/earendil-works/pi
- Commit: `4270522473e677ddba7b093caa0064a3df51d459`
- Complete official archive: https://codeload.github.com/earendil-works/pi/tar.gz/4270522473e677ddba7b093caa0064a3df51d459
- Archive SHA-256: `5482b14cc3b0c0d8cb20c7d42c384fae2af1538b52e3a69aa75db9cd181b9788`
- `vendor/pi/` contains all 2,029 archive files, including MIT LICENSE and upstream tests. No upstream source files are patched.
- `vendor/pi-source-manifest.json` records every source file hash. `node scripts/pi-verify-source.mjs` verifies completeness.
- The source-pinned catalog (`vendor/pi/nix/model-catalog.json`) is mirrored at `vendor/pi-model-catalog.json`, SHA-256 `439c53478c84ed27a58f8b54e1c3bd45810e5a969515b4e3666a3898d51ee22f`.
- Its official immutable URL is https://pi.dev/api/models/revisions/sha256-439c53478c84ed27a58f8b54e1c3bd45810e5a969515b4e3666a3898d51ee22f?types=chat,image,classifier . This is data, not replacement Pi code.

## Reproduce locally

Requires Node >=24 for Chestnut and rootless Docker for real execution. Dependency downloads use the lockfile. No dependency lifecycle scripts are enabled.

```sh
npm ci --ignore-scripts
npm --prefix vendor/pi ci --ignore-scripts
node scripts/pi-verify-source.mjs
node scripts/pi-hydrate.mjs
node scripts/pi-check-resolutions.mjs
npm --prefix vendor/pi run build:offline
bash scripts/pi-contract.sh
node scripts/pi-runtime-smoke.mjs
bash scripts/pi-build.sh
```

The image is built from `COPY vendor/pi`, followed by the upstream offline build; source changes therefore reach the runtime only after an image rebuild. It runs the resulting `packages/coding-agent/dist/bundle/rpc-entry.js`. There is no `npx pi`, globally installed binary, registry Pi dependency, or host-shell execution fallback. `pi-check-resolutions.mjs` checks the lockfile and filesystem workspace links. Other external dependencies remain upstream-pinned registry packages; this includes the unrelated Gondolin example dependency.

A normal development edit to vendored source makes checksum verification fail intentionally. Review that diff and deliberately regenerate the manifest with `node scripts/pi-verify-source.mjs --record`, then rebuild and rerun source contracts. Update the declared provenance when moving to another upstream commit.

## RPC semantics

`PiRpcAdapter.start()` receives `WorkerInput`, subscribes before sending, waits for a `get_state` readiness ACK, invokes the synchronous lease-fencing hook, and remains pending through prompt ACKs, `agent_end`, retries and queued follow-ups. It resolves only on `agent_settled`. Settlement is an idle/lifecycle fact; the outer worker separately classifies final `stopReason`, error events and aborted status. A prompt `disposition: handled` is rejected explicitly because no agent run need start.

`steer(messageId, text)` uses the message ID as RPC correlation ID. A successful ACK means accepted/queued or handled, never proof that the content influenced a model response. Upstream steering is injected after the current full tool-call batch, not between arbitrary tools. Core tools may run in parallel by default. Missing/failed transport ACKs become uncertain and are never automatically replayed. The adapter rejects duplicate IDs even after an ACK.

Cancellation closes steering ingress, requests `abort`, `abort_bash`, `abort_retry` and `clear_queue`, allows at most two seconds for these ACKs, then kills/reaps the attach client, forcibly removes the whole container and verifies absence. Creation is separate from starting: a late `docker create` can only leave a stopped container. `clear_queue` alone does not cover in-flight input transforms. A failed cleanup remains retryable and must keep the bot quarantined. Startup stale cleanup verifies daemon rootless mode and exact bot/task/run labels before removing an owned container.

## Rootless boundary

A real run fails closed unless `docker info` reports the rootless security option and the configured image carries the expected pinned commit label. The fixed argv sets network `none`, read-only root filesystem, all capabilities dropped, no-new-privileges, CPU/memory/PID limits and an ephemeral `/tmp`. Docker's default seccomp profile remains active. No privileged mode, host networking, Docker socket, credential files or database are mounted.

Only these paths are mounted:

- `dataRoot/bots/<botId>/workspace` as writable `/workspace`
- `dataRoot/sessions/<taskId>` as writable `/session`
- A dedicated trusted gateway directory read-only as `/run/chestnut`

Canonical path and symlink checks precede every launch. One bot has one persistent workspace; its sequential tasks use separate Pi session files. This is per-bot workspace isolation, not per-task filesystem separation or a high-assurance VM boundary. Rootless UID 0 maps to the unprivileged daemon user's host UID, allowing that user's workspace and mode-0600 gateway socket access; it is not host root. Run API/worker and rootless Docker under the same dedicated OS account.

## Credential-free model transport

The host owns the provider credential and an HTTP gateway on a mode-0600 Unix socket named `model.sock`. The container receives the socket, never the credential. Its loopback relay listens only on `127.0.0.1:4011` and supports only `POST /v1/chat/completions`. Pi uses a generated custom-provider config with a dummy key and that local endpoint. General Internet access remains disabled. The gateway is an intentionally granted model capability: code in the sandbox can consume the allowed model, subject to host gateway request limits. Do not treat a sandbox task as a trusted API client, or store secrets in its workspace/session.

Pi extensions, MCP, skills, prompt-template discovery, themes and local context-file discovery are disabled. Only built-in agent tools run inside the rootless container.

## Verification status

Verified in this build environment:

- Complete source and immutable catalog hashes
- Clean dependency installation without lifecycle scripts
- Full upstream `build:offline` (including the actual bundled RPC entrypoint), plus a tools-disabled, credential-free, offline `get_state` startup/shutdown smoke of that compiled entrypoint
- Source-specific tests against actual vendored Pi: authoritative prompt dispositions, queue clearing, settlement after retry/follow-up, idle waiting, JSONL handling, full-batch steering and parallel tool behavior
- Chestnut adapter tests separately using a fake transport; deterministic FakeAdapter has no tools, shell or network
- Sandbox argv, rootless rejection and command/mount injection checks

Not executed here: rootless Docker image build, live container isolation, real provider inference, or process-kill verification on a Docker daemon. This environment has no Docker/Podman. These are deployment checks, not silently simulated passes. Real mode remains unavailable until a rootless daemon and built image are present.

## Resource-control admission

Both real launch profiles require Docker to report cgroup v2 with the systemd driver and enabled memory, swap, PID and CPU-quota controls. This is stricter than merely checking rootless mode: [Docker documents that rootless resource flags can otherwise be ignored](https://docs.docker.com/engine/security/rootless/tips/#limiting-resources). Missing capability reports block launch; cleanup still only requires verified rootless ownership so an unsupported host can stop an existing container. No host cgroup/systemd settings are changed automatically. Actual quota enforcement still needs live host verification.
