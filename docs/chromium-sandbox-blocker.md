# Chromium sandbox: measured blocker and approval proposal

Status (2026-10-14): browser startup failed; screenshot/click/type acceptance has not passed. No security profile was relaxed. The API/Worker at Mac `http://127.0.0.1:4316` are real Pi/service control processes with tested Rootless Docker operations, but no real model account is connected. This is not the FakeAdapter demo and is not a working AI conversation yet.

The rebuilt ARM64 image includes Debian `chromium-sandbox`. A fixed root-owned `/tmp/.X11-unix` directory is initialized in the Bot tmpfs; browser/Xvfb remain UID 1000 and run from `/tmp`, without reading the private workspace. Docker 29 inspection normalizes capabilities to `CAP_*` and keeps tmpfs in `HostConfig.Tmpfs`; the verifier now accepts these equivalent representations while rejecting extra capabilities/mounts or changed tmpfs flags/limits.

## Observed on the unmodified security policy

The isolated namespace probe measured browser UID 1000, zero effective capabilities, `NoNewPrivs: 1`, `Seccomp: 2`, AppArmor label `rootlesskit (unconfined)`, `unprivileged_userns_clone=1`, and `apparmor_restrict_unprivileged_userns=1`. The installed sandbox helper has mode 4755. `unshare --user`, `--user --map-root-user`, `--pid --fork`, and `--net` all returned EPERM.

Chromium stderr reports that its setuid sandbox is not running as root and cites `PR_SET_NO_NEW_PRIVS`; its zygote cannot enter a new namespace. This confirms the setuid fallback conflict and failed namespace operations. It does not uniquely prove which filter rejected every syscall: seccomp and the Ubuntu/AppArmor userns policy remain candidates. No strace, global sysctl change or AppArmor disabling was used. The probe also read actual container cgroups: `cpu.max=100000 100000`, `memory.max=1073741824`, `memory.swap.max=0`, `pids.max=128`.

[Docker's default seccomp documentation](https://docs.docker.com/engine/security/seccomp/) explains its namespace restrictions. [Playwright's official Docker guide](https://playwright.dev/docs/docker) describes a separate browser user and a Docker-default profile extended for `clone`, `setns`, and `unshare` to keep Chromium sandbox enabled. Its unrelated host IPC/SYS_ADMIN suggestions are not part of this proposal.

## Exact next approval scope (not executed)

Approve **one new, disposable acceptance container** in the existing rootless VM, using `chestnut-pi-desktop-mac-v3:4270522473e6`, with no model or real website/account. Apply an audited, version-pinned Docker-default seccomp JSON extended only for the browser namespace calls `clone/setns/unshare`, using a per-container `--security-opt seccomp=<guest-private-profile.json>`. Keep `no-new-privileges`, UID 1000 for the browser, the existing capability whitelist, network none, private IPC/PID/cgroup namespaces, 1 GiB/1 CPU/128 PID bounds and no published ports. Do not retag/replace existing Bot containers or change API/Worker/global Docker defaults.

The profile relaxes namespace syscall restrictions for every process in that single test container, including a Bot-root process if one is present. This increases Linux kernel attack surface. It is not a blanket seccomp disable, but it still needs explicit approval. The first test would prove namespace creation and inspect `chrome://sandbox/` before attempting screenshot/input. If AppArmor still denies it, stop and report the exact denial; do not additionally relax AppArmor/sysctls without another approved scope. This proposal is a documented candidate, not a demonstrated sufficient fix or mathematical minimum.

Safer operational alternatives are to continue the validated file/snapshot/control features without starting desktop, or later design a separate restricted browser container so its namespace allowance does not apply to the Bot-root environment. Neither alternative is claimed implemented as a transparent drop-in switch for existing desktop-enabled containers. A browser sandbox bypass, privileged container, SYS_ADMIN addition or removal of no-new-privileges is not proposed.
