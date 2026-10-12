# Memoh-inspired milestone delivery

Date: 2026-10-12 UTC. Baseline: `4abf16f4c6a75eb03f248e4d427b08b455fb9ec4`. Cloud preparation branch: `feat/memoh-personal-runtime`. This deliverable is source plus test evidence, not a deployment or a claim of complete Memoh parity.

macOS closeout subsequently passed the full guarded application suite: 301 tests, 291 passed, zero failures and ten explicit Linux OS-lock skips. The actual Unix listener integrations ran. All pinned Pi verification/build/contracts, compiled RPC smoke and the independent model-less demo passed. Safari inspected the management views against sample data; a loopback schedule smoke reached a completed task and verified an idempotent once admission and paused IANA cron. See the latest section of `verification.md`; the following cloud results remain historical. Real Docker/service/package/model/Telegram acceptance is still not run.

## Implemented end-to-end code paths

1. **Pi/gateway and identity correctness.** Actual pinned Pi parsing/conversion now round-trips assistant `commentary`/`final_answer` and encrypted reasoning into the next request. The thin outer gateway requests encrypted reasoning even for reasoning-off Responses turns, and keeps only the supported credential/model boundary. OAuth grants bind the account/model generation; refresh within that generation is permitted, while logout/relogin/model changes revoke old task context. Foreground and maintenance providers share this fence.
2. **Memory reliability.** Entry IDs are separate from request receipts; creation collisions cannot overwrite user-corrected automatic entries. Replays recheck current Bot/project access before returning content. Oversized task/steer sources share a bounded maintenance allowance, advance the cursor, and leave later tasks processable. Empty/suppressed batches do not consume a provider-call budget; actual failed calls do.
3. **Telegram coordinator.** Dedicated long-poll process, exact owner/private-chat/Bot binding, durable update deduplication and offsets, task/command admission, status while busy, steering/cancel/follow-up, progress/final delivery ledger, rate-limit backoff and explicit uncertain-send handling. Token only enters this outer channel process. No live account was connected and no message sent.
4. **Schedules.** Dashboard/API → SQLite once or five-field cron/IANA-zone schedule → atomic fire/task/event transaction → Worker-independent timer → existing task queue. Includes idempotent creation, pause/resume/delete, fire history, concurrency/restart deduplication, missed-run coalescing, overlap skips and documented DST gap/fold behavior.
5. **Service environment.** Opt-in stable writable rootless Bot environment plus isolated disposable Pi runner; six brokered environment tools, exact extension readiness, private runner scratch and per-run grants. Successful settled tasks can keep services running. Cancellation, uncertain command outcomes, failed cleanup and crash recovery stop the stable environment while preserving rootfs. OS-lock fencing and trusted Docker verification cover both runner and stable lifecycle.
6. **Governed packages and network.** Default-deny operator allowlists; fixed no-mount downloader uses apt/InRelease/gpgv and authenticated SHA256 metadata, followed by host staging checks and offline Bot dpkg. Downloader explicitly uses bridge, distinct from network-none Bot services. Import intent and containment/review state are durable; ownership-scoped orphan cleanup handles recovery. Governed GET-only HTTPS fetch validates and pins public DNS, refuses redirects/private addresses, and bounds duration/output.
7. **Management UI/API.** Environment status/policies/idempotent stop, schedule creation/actions/history and token-free Telegram readiness. Repeated clicks, revision conflicts, stale Bot navigation, interrupted reads and delayed creation replies have deterministic controller coverage. The UI exposes experimental/not-live-verified status.

## Independent review and corrected findings

A separate reviewer examined lifecycle, tool ownership, brokers, network and recovery. Findings were corrected and regression-tested: builtin-tool fallback, broker receipt memory limits, uncertain command settlement, cleanup after resource-controller loss/image retag, sticky cleanup failures, runner lifecycle under the same lock, stale stop replay/ownership races, DNS deadline and encoded-output bounds, IPv6 representation normalization, and crash-persistent package review intent. The reviewer reported no remaining blocking finding in the reviewed scope. This is not a security certification.

## Verification against final source

- Root strict TypeScript check passed.
- Default `npm run check`: 301 reported tests, 296 passed, 4 failed solely because this executor returns Unix `listen EPERM`, 1 explicitly skipped listener integration. The four blocked tests are gateway mount sockets, memory broker socket, Pi memory extension socket, and Worker ChatGPT-to-memory-socket integration. **The default full suite did not pass in this environment.**
- Explicit socket-free run excluding those four named listener tests: Node reported 298 passed, 0 failed and 1 skipped. Node includes two otherwise-empty test files in that count. This command is not a substitute for Linux listener acceptance.
- Actual pinned Pi: all 2,029 source hashes and license verified; immutable catalog hydrated and verified; 14 local workspace package links, zero registry Pi replacements.
- Complete actual Pi `build:offline` passed, producing the compiled RPC bundle. An initial build attempt exposed omitted package-scoped dependencies in the local reused dependency tree; restoring the lock-matching scoped OpenAI 7.19.0 package corrected it without changing source or lockfiles.
- Selected Pi source contracts: 18 coding-agent plus 4 agent-loop tests passed; 34 unrelated agent-loop tests were excluded by the selection.
- Compiled Pi RPC get_state/startup/clean shutdown smoke passed with no prompt, tool, model request or network.
- Independent Worker/SQLite model-less demo passed: initial task, steering receipt and queued follow-up succeeded.
- Dashboard controller: 34 tests passed; JS syntax and structural HTML checks passed. No browser visual pass was performed.
- Source diff whitespace check passed. Remote main was rechecked and still matched the baseline; no push/PR/deployment occurred.

### Test-network correction

During aggregate verification, the old persistent-Worker fixture was found to leave automatic memory enabled in Pi mode with a fake API key. That could invoke the real default maintenance transport. The test attempt was stopped after a safety-review block. The fixture now explicitly disables automatic memory, and the default test runner removes ambient secret-style variables and preloads a guard denying external fetch/http/https/net connections. Node child processes inherit the guard via `NODE_OPTIONS`; the compiled smoke explicitly preloads it too. The corrected no-external-network suite was then run. No external-network exception, real credential or live-provider test was enabled.

## Not run / required before operational completion

Real rootless Docker image/runtime isolation, live Unix mounts/relay in containers, actual service continuity, signed repository downloads and package installation, live ChatGPT/model inference, live Telegram interaction, browser visual/mobile acceptance and deployment are not run. This cloud executor has no Docker/Podman/provider/channel credentials and denies listeners. See `service-acceptance.md` for the exact authorized host gate.

## Remaining product scope

This milestone does not add multi-tenant accounts/RBAC, all chat channels, marketplace/MCP catalog, GUI desktop, service boot supervision/port publication, per-task Git worktrees, automatic storage quotas, cumulative per-task model spending limits or general arbitrary Internet access. Existing same-owner/rootless limits remain explicit. The user's persistent-root/package/service goal is only operationally complete after the live gate passes; mock tests do not establish that outcome.

## Reproduce

```sh
npm ci --ignore-scripts
npm --prefix vendor/pi ci --ignore-scripts
npm run pi:verify
node scripts/pi-hydrate.mjs
npm --prefix vendor/pi run build:offline
npm run pi:contracts
node scripts/pi-runtime-smoke.mjs
npm run check
npm run demo
```

Restricted-executor diagnostic only, leaving all default integration tests unchanged:

```sh
NODE_OPTIONS="--import=$PWD/scripts/test-no-network.mjs" node --test --test-concurrency=1 --test-skip-pattern='ephemeral mount accepts actual model and memory sockets|the private Unix broker accepts bounded tool requests|platform Pi tools save through the real Unix broker|real Worker uses ChatGPT Responses credentials' tests/*.test.ts web/dashboard.test.cjs
```
