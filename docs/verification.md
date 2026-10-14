# Verification report

## Mac Linux VM read-only entry (2026-10-14 UTC)

The user approved starting the existing Colima default profile, which started without manual resource/network/security edits. Actual guest: Ubuntu 24.04.4 ARM64, UID 501, guest-native ext4 home/tmp, util-linux flock present; Node/npm and rootless runtime prerequisites absent. Existing Docker is rootful/cgroupfs. New `mac:preflight` reproduces these blockers without installing, starting or configuring anything. Its three injected-probe contracts pass (stopped/missing VM never SSHs or starts, read-only guest/rootless/pinned ARM64 checks, invalid/unavailable inputs do not echo raw stderr). Docker probes isolate guest context from Mac environment overrides. Final guarded Mac regression: **348 tests, 338 passed, 0 failed, 10 Linux OS-lock skips**, clean TypeScript. This is not a guest test suite, Docker isolation or completed Mac Bot runtime acceptance. Steps and explicit remaining VM preparation are in [mac-linux-vm.md](mac-linux-vm.md).

## Snapshot directory mode repair after 0ef9497

Independent QA reproduced successful publication followed by workspace inventory mismatch for nested 0775 directories under umask 022. Copy now creates writable staging directories, explicitly restores their permissions in post-order after copying files, fsyncs them, and verifies the entire copied inventory before snapshot publication or restore/rollback replacement. Real filesystem regressions exercise nested 0775 and read-only 0555 directories through create, load, protection snapshot and restore; all 16 snapshot tests pass with a synthetic Docker runner. Final guarded macOS check: **345 tests, 335 pass, 0 fail, 10 Linux OS-lock skips**, with clean TypeScript. Existing corrupt snapshots remain rejected; no manifest rewrite or Docker live acceptance is claimed.

## Bot Chromium desktop and stopped file snapshots (2026-10-13 UTC)

On Node v26.5.0 / npm 11.17.0, final guarded `npm run check` passed: **343 tests, 333 passed, 0 failed, 10 explicitly skipped Linux OS-lock tests** (72.5 seconds). Strict TypeScript passed. This includes 48 dashboard controller tests, 14 snapshot tests (actual filesystem/SQLite with a fake Docker runner), four desktop contracts (VM/argv/policy/serialization), computer-broker receipts and API ownership/confirmation checks. Snapshot fault tests inject exceptions at durable phases; they do not kill a real Docker daemon or restore a real container. Two tests execute the actual Worker queue: a model-less snapshot completes, and a dead running owner becomes uncertain without replay. Real Mac Unix/loopback integration and the existing independent Worker/process restart tests also passed.

Reverified all 2,029 pinned Pi source hashes/license and 14 local package links, zero registry substitutes; vendor/workflows remain unchanged. Earlier upstream offline build, 22 selected source contracts and compiled RPC readiness results still apply to the unchanged vendor. No real model, account, package download/install or Telegram call was used.

Safari with a real loopback API but **sample pixels/snapshot metadata and no Worker/Docker** verified Bot/session labeling, explicit restore confirmation, accepted-but-queued wording, disabled competing actions, cross-Bot clearing and persistence of the identical request after API restart/reload. The separate Safari HTML fixture accepted sample typing/clicking and rendered the greeting; this is native-browser fixture interaction, not `environment_computer` or the Bot Chromium backend. The UI fixture and its runtime databases stay outside the repository. This is not a full mobile/accessibility audit.

The existing local Unix Docker daemon was unavailable; no image was built and no rootless container/Chromium sandbox/input/PNG/session continuity/real file restore or SIGKILL recovery was accepted as live-tested. No Docker privilege/sandbox fallback, host installation, security setting change, public listener, new persistent credential, old VPS or Tailscale access, deployment or PR was used. The new [feature guide](desktop-snapshots.md) records exact opt-in, retention/resource limits and required Linux negative/crash checks. Publish by normal fast-forward with `[skip ci]`, and independently verify the remote tree and Actions history.


## Escaped pending-signature repair after 98092da

The large-journal test now escapes pending signatures themselves: 30 signatures over 192k characters survive a 13M-character journal reload alongside all drafts, selections, kinds and Bot draft. Shared signature/entry validation prevents successful saves of entries the reader would discard. UI-event regressions verify task/Steer/follow-up 20k escaped text retains the original request IDs for explicit unchanged retries, with no automatic POST. Full guarded macOS check: **320 tests, 310 pass, 0 fail, 10 Linux OS-lock skips**; 45 controller tests passed, and real loopback process/restart coverage passed. This repair has controller coverage; runtime/vendor/workflows and the earlier live-verification boundaries are unchanged.

## Journal-capacity repair after ecd38e2

The saved chat journal could exceed its old 2,000,000-character restore threshold and be silently discarded on reload. Read/write capacity is now consistent, and storage failure warns even for an unsent draft. Two actual-UI-function regressions cover supported large/escaped journals and quota failure preserving the last saved journal and in-tab IDs. The guarded macOS full check passed **319 tests: 309 passed, 0 failed, 10 Linux OS-lock skips**; all 44 controller tests passed. Real loopback restart tests also passed. This small repair has controller coverage; the Safari evidence below is from `ecd38e2`. Vendor/runtime/workflows remain unchanged.

## Latest local task-chat MVP after 3263d6c

See [MVP acceptance](mvp-acceptance.md) for reproducible first use, reload/retry semantics and detailed evidence. The guarded macOS check passed **317 tests: 307 passed, 0 failed, 10 explicit Linux OS-lock skips**. The new real loopback test exercised separate CLI API/Worker processes, durable creation/task/command receipts, Steer, follow-up, cancellation and stop/restart. Safari actual controls and same-tab drafts/history were checked; 320/390px read-only WebKit frames were inspected. Strict TypeScript, model-less Worker smoke, all 2029 pinned Pi files/license and 14 local links passed. Lost browser acknowledgments are mocked-controller coverage; Docker, Linux root services and live models/channels remain unverified. Earlier sections are historical results.

## Offline deployment preparation after 864cd37

The remote baseline was rechecked unchanged at `864cd37cbe0ef883398bd3a21c5aa142a3eedc9f`; existing user commits and the earlier checkout were preserved. Added a read-only host preflight, a guarded reusable offline acceptance entry, an opt-in model-less Linux/Docker entry and [startup/recovery runbook](deployment-runbook.md). Default Docker entry prints a plan without contacting Docker; execution refuses existing data, remote daemon routes and unsuitable rootless/resource/image prerequisites. It freezes the inspected immutable image, scopes cleanup to its own new Bot identities, retains rootfs/evidence and treats uncertain cleanup as failure.

On this Mac, the guarded offline entry passed source/link checks, the full application suite and the model-less Worker demo. The final full check reported **305 tests: 295 passed, 0 failed, 10 explicit Linux OS-lock skips**. Four new deployment tests cover read-only behavior, preservation of existing data, canonical/private path admission, local daemon/provenance checks with a synthetic transport and no-execute defaults. These are not a live Docker result. Pi source and dependency pins were unchanged; no repeated upstream build was needed.

Safari rendered the actual dashboard assets against read-only loopback sample data in 390px and 320px frames. Environment facts, long warnings, single-column management cards, schedule fields and times were inspected. WebKit's small native select was corrected to a 44px styled native select; the larger control and native popup were verified after reload. Mobile management buttons also have 44px minimum touch height. No policy, schedule, model or Telegram mutation was sent through the preview. This is phone-width WebKit inspection, not an actual iPhone/Android, soft-keyboard or full accessibility pass.

The real Docker entry was **not executed**: Linux/rootless Docker acceptance, measured quotas, real Worker/Docker crash recovery, signed online packages, model inference and Telegram still require the new authorized VPS and appropriate explicit grants. No old VPS/Tailscale connection, host installation, public exposure, new credentials or security settings change was made. Publication uses a normal fast-forward with `[skip ci]`, preserving the existing workflow.

## Latest macOS Memoh-inspired milestone acceptance (2026-10-12 UTC)

Baseline `4abf16f4c6a75eb03f248e4d427b08b455fb9ec4` was fetched into an isolated worktree; the earlier local checkout and user commits were preserved. The Library patch's original SHA-256 was verified, then the two supplied version-1 corrections were applied without overlapping the full patch.

On Node v26.5.0 / npm 11.17.0, the default guarded `npm run check` passed: **301 tests, 291 passed, 0 failed, 10 explicitly skipped Linux util-linux flock tests**. All Unix-listener cases ran on this Mac, including private gateway sockets, memory broker, Pi memory extension and the synthetic ChatGPT Worker integration. These use local fixtures, not real provider credentials or Docker. The one Mac fixture correction places that Worker's real broker in a short canonical temporary directory; production socket/path limits remain unchanged.

Locked root/Pi installation, all 2,029 Pi source hashes and retained license, 14 local package links, immutable catalog hydration, complete Pi offline build, 22 selected source contracts (34 unrelated agent-loop tests filtered out), guarded compiled RPC smoke, strict TypeScript and independent model-less Worker demo passed. Source and lockfiles in `vendor/pi` were unchanged.

Safari desktop rendering and navigation were inspected for sample Bot creation, Environment facts/default deny policy/not-live-verified wording, disabled Telegram readiness and Schedules. A separate loopback API smoke verified identical-create idempotency, a real once fire/ledger/task reaching `succeeded`, and an `Asia/Shanghai` cron sample being durably paused. Safari showed the resulting finished schedules/completed tasks and paused cron zone. This did not verify every management interaction, mobile layout or cross-browser accessibility.

The default external-network guard and secret-style environment filtering stayed enabled. The UI demo additionally disabled automatic memory maintenance and Telegram. No live model, OAuth account, Telegram message, package download/install, rootless Docker, Linux OS lock, VPS access or deployment was used. The user's existing `.github/workflows` were preserved unchanged; publication uses `[skip ci]` and independently checks remote refs/tree and Actions status.

## Earlier cloud Memoh-inspired verification (2026-10-12 UTC)

The new changes are described in [memoh-milestone-report.md](memoh-milestone-report.md), with the required live gate in [service-acceptance.md](service-acceptance.md). This section supersedes old aggregate counts and feature-status statements below; older sections are retained as historical evidence only.

Latest default check: 301 reported tests, 296 pass, 4 Unix-listener EPERM failures, 1 explicit listener skip. It is not a full pass. Explicitly socket-free selection: 298 pass, 0 fail, 1 skip, with four named listener cases excluded (Node counts two empty files). Typecheck, actual complete pinned Pi offline build, 2,029 source hashes, 14 local links, 22 selected Pi contracts, compiled RPC startup/get_state/shutdown and independent Worker model-less demo pass. Real Docker, service continuity, Debian download/install, live model/Telegram and browser visual stages remain not run.

The default test runner now blocks external Node network calls and removes ambient secret-style variables. An old mocked persistent-Worker fixture's unintended real-maintenance-fetch path was corrected before the final safe test run. The gateway remains a thin credential/lifetime boundary; no real provider credentials, intentional live-model acceptance, or deployment were used. The initial fixture had an unintended external-request path; the corrected suite blocks it.


Date: 2026-10-12. The cloud build below used Node v24.19.0. The macOS closeout used Node v26.5.0 and npm 11.17.0; its results and changes are recorded separately.

## macOS closeout

- Downloaded archive SHA-256 matched `eb1c10f62d516d3c87c9d999c1278410d9c68ceaf62c3a6ca1cd300d5e6c9a69`. Archive members were checked for absolute paths, traversal and unsafe link/device entries before extraction into a new directory.
- Installed both locked dependency trees with lifecycle scripts disabled. Upstream npm reported its existing `autoevals` package-manager engine warning and deprecation notices; no dependency versions or lockfiles were changed.
- `npm run check`: 101 tests, 91 passed, 0 failed, 10 explicitly skipped Linux OS-lock tests. macOS has no util-linux flock or Linux `/proc/self/fd`; these tests remain enabled on Linux. No live Linux lock verification is claimed.
- Real private Unix-socket creation, mode checks and idempotent cleanup passed on this Mac outside the execution sandbox. Container socket mounts and relay interoperability remain untested.
- `npm run build` strict TypeScript check and `npm run demo` succeeded. The separate Worker/SQLite demo completed a task, steering receipt and queued follow-up without model calls, tools or Docker.
- Reverified all 2,029 pinned upstream file hashes and retained MIT LICENSE, immutable model catalog, and 14 local Pi workspace links. The 18 selected coding-agent tests plus 4 selected agent-loop tests passed; 34 unrelated agent-loop tests were excluded by the selection. Full upstream `build:offline` and compiled RPC get_state/startup/shutdown smoke passed without model calls.
- Safari desktop check used a loopback-only demo and sample data: empty state, Worker connectivity, create Bot, submit task, running state and final result were inspected. This is a basic desktop check, not a mobile/cross-browser audit or live AI acceptance.
- Source screening found no runtime databases, credential files or high-confidence private-key/token patterns in the archive. Runtime demo data is outside the Git repository. This is a scoped screening, not a guarantee that every possible secret format is detectable.
- Used only the existing `Lioooooo123` GitHub authentication; repository write access was confirmed and the repository refs were empty before initial publication. No VPS access, deployment, new credentials, host software installation or Docker security changes were performed.
- No root `.github/workflows` are included. The initial commit uses `[skip ci]`; remote refs, committed tree and Actions history are checked after push.

### Changes from the supplied archive

- `scripts/test.mjs` and the root test script select a canonical system temporary base before test fixtures are created. macOS `/var` and `/tmp` aliases no longer cause fixture failures; production symlink checks remain intact.
- `scripts/demo.mjs` resolves its own newly created temporary directory before configuring storage.
- `tests/environment-lock.test.ts` explicitly skips its Linux-only tests on other platforms; no fake flock implementation was substituted.
- `tests/persistent-worker.test.ts` places its fully mocked gateway directory under its canonical fixture root. It exercises Worker transitions without claiming Linux transport coverage.
- README, this report and the dashboard verification note reflect the actual client implementation and local results. Upstream Pi source, dependency pins and production security policy were not changed.

## Earlier cloud verification

## Passed

- Root package dependency installation with scripts disabled and lockfile retained.
- TypeScript strict no-emit build for application and tests.
- Complete pinned upstream source: all 2,029 source-file hashes and MIT license retained.
- Immutable upstream model catalog hash verified and official hydration/check completed. The mutable live models.dev request returned proxy 403; it was not bypassed. The documented immutable catalog was used instead.
- Full upstream `npm run build:offline`, producing the actual Pi RPC bundle.
- Local dependency check: 14 Pi workspace links, zero registry replacements for Pi packages.
- Actual Pi source tests: 18 coding-agent session/RPC regressions plus 4 selected agent-loop tool batch/parallel execution tests passed. Other upstream tests were not part of this focused source-contract run.
- Actual compiled RPC readiness/get_state smoke with no prompt, tools disabled, sanitized environment and no model key. This proves bundle startup/readiness only, not model inference or sandbox isolation.
- Chestnut aggregate suite: see final count below. Includes actual Node HTTP parser over in-memory streams, SQLite WAL, separate adapter unit tests, state/worker tests and dependency-free dashboard-controller tests.
- Experimental persistent backend: socket-free Docker lifecycle mocks cover stable writable-root identity, exact reuse policy, cancellation admission, filesystem-preserving stop, missing/replaced identity, resource refusal, stale ownership and cleanup failure. These are not actual rootfs/process tests.
- Host OS-lock runner: 10 real subprocess/flock tests with a local fake Docker fixture cover owner SIGKILL, delayed commands, attachment reaping, holder SIGKILL, poison and durable takeover quarantine. These do not certify real daemon-side operations. A rapid-contention listener-order race was found during repeated aggregate verification and fixed; 12 consecutive focused runs (1,536 contender acquisitions) subsequently passed.
- Persistent Worker tests cover pretransport cleanup, immutable identity, unknown mutable-startup outcome and verified whole-bot stop before model capability publication.
- `npm run demo`: separate real Worker process and SQLite file completed initial task, steering receipt and queued follow-up in model-less mode. No HTTP listener, browser, model call or agent shell was used.

## Final aggregate

Run `npm run check` to reproduce. The test suite explicitly identifies a Unix-listener integration skip when the host denies binding. Vendored-source import tests also explain how to install upstream dependencies if they are absent in a fresh extraction.

Final aggregate: 101 tests, 100 passed, 0 failed, 1 explicitly skipped Unix-socket integration test. Test output is not a claim that the unexecuted stages below passed.

## Not run / blocked

- Real Unix-socket listener permissions, gateway relay↔container transport and socket mount interoperability: this executor returns `listen EPERM`, including an approved elevated retry. One Unix integration test is explicitly skipped. HTTP behavior was tested with paired in-memory streams; no alternate network route was used to evade the restriction.
- Live API listener and browser-to-API flow: not accepted as verified in this executor. API parser/handler tests are socket-free.
- Real desktop/mobile browser rendering and visual review: Chromium could not create a process socket; no visual pass is claimed. Dashboard logic has a separate mocked-DOM controller suite.
- Rootless Docker image build, rootless container launch, live seccomp/mount/namespace/resource isolation, Docker process-kill/removal behavior and image model relay: neither Docker nor Podman is installed. Argv/policy/cleanup coordination tests are not a live isolation test.
- Live OpenAI inference: no model credential supplied, no paid model call made.
- Writable persistent OS lifecycle is implemented experimentally but not live-verified. Continuous background services, arbitrary online software installation, per-task Git worktrees, quota storage and general outbound Internet remain unimplemented. Every persistent task currently stops the whole Bot, retaining its files but interrupting services.
- At the earlier cloud-build stage, remote push, PR, deployment or publication was not attempted. GitHub push was subsequently authorized for the macOS closeout; VPS deployment remains outside this task.

## Before a real deployment

Use a dedicated Linux account, util-linux flock, cgroup v2/systemd with delegated resource controllers, private short data directory and quota-backed storage for both Docker writable layers and workspace data. Install Rootless Docker, build the pinned image, configure the outer worker model credential, then run a disposable task through the UI. Verify (1) API remains loopback-only, (2) model gateway works with network none, (3) bot paths cannot cross, (4) cancellation removes ephemeral run containers or stops persistent Bot containers without deleting their rootfs, (5) SIGKILL/restart interrupts without replay and quarantine cleanup precedes another task, and (6) disk and model budgets meet your requirements. These are explicit deployment acceptance checks, not already-completed validations.
