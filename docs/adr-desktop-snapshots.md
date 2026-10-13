# ADR: Bot-local Chromium desktop and stopped file snapshots

Status: implemented experimentally; Linux live acceptance pending (2026-10-13).

The service profile already owns one stable rootless, network-none environment per Bot and serializes mutation through an OS lock. Users need a visible browser shared with their Agent, and recoverable installed files/configuration without changing that ownership boundary.

Use Xvfb + Openbox + sandboxed UID-1000 Chromium in that stable container, with a bounded tmpfs managed profile. Input comes through the existing private, task-scoped, idempotent broker; screen viewing is same-origin PNG polling with a Bot/session fence. The first network policy allows only an offline fixture and sandbox diagnostic page. Browser sandbox failure is a gate, never a privilege fallback. No host display, VNC/CDP endpoint or browser credential flow is introduced.

Store snapshot/restore requests in a durable operation ledger. Stop writers under the existing OS lock, commit/export rootfs, separately copy bounded regular workspace files, and publish a checksum manifest. Restore publishes a protection version before staged replacement; retain old container/workspace and use narrow explicit identity replacement. Uncertain operations block admission until an explicit verified recovery. Store migrations are additive. There is no arbitrary archive import or automatic deletion.

This favors visible, recoverable files over process continuity: snapshot and restore stop services, exclude tmpfs login and RAM, and do not checkpoint running processes. PNG polling has latency; desktop startup/package/image compatibility and real crash recovery require Linux checks. Snapshot resource caps reduce accidental growth but do not replace host disk quotas. See [configuration, recovery and gates](desktop-snapshots.md).
