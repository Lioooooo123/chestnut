# Governed Debian package staging

`src/environments/packages.ts` implements a bounded package path for the service environment. This is code plus synthetic verification, not a real-host installation certification. The implementation does not change stable-container networking, add mounts, run host `apt`/`dpkg`, download through the host, or execute a package on the host.

## Authority and integration contract

The host calls `installGovernedPackages(options, currentLock.runner)` with:

- The recorded stable container and immutable image IDs, bot/run/request IDs and canonical host data root.
- A nonempty operator-controlled `allowedPackages` list. The model supplies only `requestedPackages`; it cannot write or expand the policy. Every downloaded dependency must also be allowlisted. Names are Debian names only; version expressions, architecture qualifiers, URIs, paths and apt options are rejected.
- Current lock and execution-grant checks, a synchronous `onBeforeImport` callback that durably records a pending operation before the first stable mutation, and a quarantine callback. Every Docker operation is fenced before and after awaiting it. Cleanup needs ownership but remains permitted after task cancellation.

The caller must serialize the package operation against all other environment operations, track request receipts, and never replay an uncertain request automatically. A `PackageInstallQuarantineError` requires the caller to stop/quarantine the stable environment and preserve the recovery hold. The host clears the pending-operation marker only after this function returns successfully, including verified downloader cleanup. A crash after that marker is written requires containment/review rather than assuming no installation occurred. A partially failed `dpkg` run is not rolled back, retried or assumed harmless. The function cannot extend its own execution grant or clear an outer lock quarantine.

The successful result describes imported artifacts and the install wrapper's reported completion. **Installation status is a guest report, not a new host integrity certificate for a writable guest.** Docker isolation/identity is independently checked by the host, and archive bytes are independently SHA256-checked on the host.

## Two separate boundaries

1. A new one-shot downloader runs from the stable environment's exact recorded image ID. Image inspection requires Linux amd64/arm64 and the pinned Pi-source label; inside the fresh image the fixed program checks Debian/bookworm and the matching dpkg architecture. It uses Docker's `bridge` network explicitly, with no mounts at all: no bot workspace/rootfs, credentials, task/session files, broker sockets or Docker socket. The command clears the inherited image environment with `env -i`; allowed image environment keys are also checked. No host environment values are supplied to the guest.
2. The downloader runs only fixed apt update/plan/download commands, fixed `gpgv` verification, hashing and manifest/file staging. It never installs a package. The existing stable environment remains rootless, `network=none`, with only its workspace mount. Only after authenticated artifacts pass host validation are they copied into that offline environment, where `dpkg` may run arbitrary package maintainer scripts under the existing guest confinement.

Both containers use `cap-drop=ALL` plus exactly `CHOWN,DAC_OVERRIDE,FOWNER,FSETID,SETGID,SETUID,NET_BIND_SERVICE`, default Docker seccomp/AppArmor policy, `no-new-privileges`, private IPC/cgroup namespaces, and verified CPU/memory/PID limits. No privileged mode, host PID/network namespace, `SYS_ADMIN`, devices or unapproved security options are permitted. There is no Docker network-connect/disconnect command or fallback network policy.

## Repository and content checks

The downloader's apt configuration is created by the fixed program and disables image configuration parts/main, avoiding inherited apt hooks and sources. Its only sources are:

- `https://deb.debian.org/debian`: `bookworm`, `bookworm-updates`, component `main`
- `https://deb.debian.org/debian-security`: `bookworm-security`, component `main`
- Fixed image keyring: `/usr/share/keyrings/debian-archive-keyring.gpg`

APT is configured to reject unauthenticated/insecure/downgraded repositories, require validity/date checks, disable redirects/retries and use bounded timeouts. After update, the program explicitly verifies all three expected `InRelease` files with `gpgv` and requires their expected codenames. Package indices are validated by APT against that authenticated release metadata. The plan's package name/version/architecture/source/size must match a unique authenticated apt-cache record with SHA256. It does not trust `--print-uris`'s legacy MD5 field as an integrity check.

The selected archive stream is signed and suite-fixed, **not version-frozen**. Repository updates can change package versions between requests. The recorded runtime image ID fixes the initial image/keyring for a bot; replacing it silently is refused.

Limits are 16 requested names, 64 downloaded artifacts, 128 MiB total archive bytes, a 64 KiB host manifest, 256 distinct operator allowlist entries, strict filename/architecture grammar and fixed per-operation deadlines. Archive size/count policy is checked before downloading and again against actual files and the host manifest. APT metadata lives only in the disposable container; it is not copied to the host or mounted into the stable environment. These archive limits are not a general Docker writable-layer disk quota.

## Host staging and cleanup

The downloader must be inspected as stopped with exit code zero and no OOM event before export. Individual known files are copied with `docker cp`, never an arbitrary guest directory/archive extraction chosen by a model. Host staging is a newly created 0700 directory below the canonical, host-owned `package-staging` directory. Its private `operation.json` records recovery identities before create.

The manifest and each archive must be non-symlink, single-link, owner-matching regular files with bounded sizes. Paths must be canonical and contain no symlink components. The host rejects unexpected manifest keys, names, versions, architectures, count/byte overflow and dependencies outside policy, and checks every archive's SHA256 before import and again immediately before its copy. The host does not parse `.deb` members, invoke package tools, or execute maintainer scripts. The guest import wrapper rechecks hashes before running `dpkg`.

Normal cleanup uses trusted Docker inspect, stop if needed, remove, and a final list proving that the unique downloader name is absent. The stable root filesystem is never deleted. Local staging is removed on verified non-quarantined completion. Timeouts, failed/uncertain Docker transport, partial installation, lost ownership or unverified downloader cleanup retain quarantine and staging. There is no automatic retry. If the host worker dies, finally cleanup cannot be promised. `cleanupPackageDownloaders({botId, runId, expectedImageId, canMutate}, runner)` supports recovery under the same current bot lock. It queries exact profile/bot/run labels, inspects each original operation identity, reconstructs the fixed script/argv from strictly validated request/policy data, verifies the immutable image and isolation, then stops/removes and proves absence. It refuses ambiguous identity, owner labels, image, policy or command instead of touching an unrelated container. Retained operation records and the pending-import marker still require the caller’s reconciliation/review flow; successful downloader cleanup does not clear a partial-install review requirement. A poisoned lock holder remains a manual reconciliation case. Never remove a lock file to force takeover.

## Verification performed

`node --test tests/environment-packages.test.ts` uses temporary files, a synthetic Docker command runner, and an in-memory execution of the actual fixed downloader program. It makes no network connection, invokes no daemon, performs no installation and executes no package bytes. It covers:

- Empty/expanded policy, argument grammar, dependency closure, artifact identity, architecture and bounds
- Exact no-mount downloader isolation, allowed capabilities and fixed argv/environment
- Host digest verification and rejection of symlink/corrupt artifacts before import
- Stable image/network/path mismatch before downloader creation
- Current-grant cancellation, stale-owner refusal, authoritative cleanup, no timeout replay and required quarantine
- Durable pre-import callback ordering/failure and orphan recovery with wrong-owner/image/argv refusal
- Explicit InRelease signature checks, authenticated SHA256 matching and rejection of synthetic signature/content errors

TypeScript compilation is also required. These checks do not establish that a real image has all tools/certificates, that current Debian metadata resolves within limits, that rootless Docker enforces the profile on a target machine, or that any package's maintainer scripts succeed there.

## Required real-host acceptance (not run)

Run only after explicit operator authorization on a disposable test bot and a supported rootless Docker host. Do not use production credentials or production data.

1. Build/inspect the pinned bookworm image and record its immutable image ID, architecture, keyring, CA certificates, `apt-get`, `apt-cache`, `gpgv`, `dpkg`, `env` and Node availability. Verify rootless user namespace and cgroup enforcement. Start the service environment and capture trusted Docker inspection showing network none and only its test workspace mount.
2. Provide a reviewed operator allowlist for one small package and its actual newly downloaded dependency closure. Confirm an absent/insufficient allowlist is rejected before any import. Install once and capture the three verified InRelease checks, manifest/version/architecture/size/SHA256 evidence and exact downloader inspection while it runs. This requires genuine repository access; synthetic tests are not a substitute.
3. Verify installed files and a harmless version query in the stable guest. Capture stable Docker inspection again and show no network changes, no broker/session/credential mounts, no host package execution, and no surviving downloader after authoritative cleanup.
4. Stop/restart the same stable container and confirm the installed package/rootfs state persists. Run a later model task through the separate disposable runner, checking its broker access does not become a stable-environment mount.
5. In separate fresh test bots, exercise an unapproved package/dependency, invalid signature/source test fixture, oversized artifact fixture, timeout, cancellation, partial maintainer-script failure, lost worker and Docker-transport failure. Verify no automatic retry, persistent quarantine where required, retained diagnostic staging, and refusal of concurrent/new work until an operator reconciles container/process state.
6. Confirm package scripts cannot reach the public network, host control socket, sibling bot workspace, task/model/session data or broker; confirm they do not obtain `SYS_ADMIN`/privileged mode. Use host evidence for boundaries rather than treating guest output as proof.

Record exact commands, immutable image/container IDs, redacted inspections, test package versions and hashes, timings and outcomes. Until these authorized checks run, real-host package acceptance remains explicitly **not run**.
