# Runtime management dashboard

The build-free dashboard now provides Environment and Schedules views alongside the existing Tasks and Memory views. It uses same-origin API calls and has no new browser dependencies, external resources or credential storage.

## Environment and operator policy

Environment facts are explicitly sourced from the API registry’s last recorded worker state. A running registry row is not proof of live process health, isolation, networking enforcement or durable service survival. Capability declarations and every environment show **not live-verified** wording.

The policy editor sends `PUT /api/bots/:botId/environment/policy` with the revision on which the operator began editing, exact Debian package names and exact lowercase DNS hosts. Both allowlists default empty. Inputs, server errors, bot names and all other returned strings are rendered through text nodes. Polling cannot silently replace a dirty draft or upgrade its revision. A conflict retains the draft and error; explicit reload discards it and reads the newest revision. Drafts survive a bot switch within this page, but not a page reload.

The capability note distinguishes the runtime container’s direct-network prohibition, outer-worker governed HTTPS fetch, and the separate bridge-network package downloader. The helper is **not** represented as egress-isolated. An allowlist grants future tool permission; it does not install a package or prove a destination reachable.

A service environment’s Stop button opens a second explicit confirmation describing cancellation and service interruption. The accepted request is pending until observed worker state changes. It does not claim completion based on HTTP acceptance. An ambiguous request retries with the same request ID within this page. Switching views or bots dismisses the unsubmitted confirmation. No reconcile/recovery override or implicit restart is exposed.

## Schedules

- One-time input is labeled UTC and converted directly to epoch milliseconds. The controller rejects invalid, impossible or past new dates. A retry of identical previously dispatched details is still permitted after the due time, so server idempotency can return an already accepted schedule.
- Cron uses five fields and an explicit IANA zone. Client checks cover field count and zone validity; the server remains authoritative for full cron semantics and quotas.
- Run timestamps are displayed in the browser’s local zone. The creation zone and display convention are explained next to the form.
- Active schedules can be paused, paused schedules resumed, and deletion requires a second in-page confirmation. Deletion stops future firings; existing tasks and ledger history remain.
- The schedule’s lifecycle and the task’s lifecycle are distinguished. A finished schedule is not presented as a completed task. History reports queued, skipped-overlap and coalesced firings, with task outcomes only when available from the task registry.
- Downtime coalescing, same-schedule overlap skipping, paused cron behavior and DST behavior are explained in the view. The registry and worker-online state are shown separately.
- Requests disable duplicate actions; same-content creation retries keep their request ID. Creation drafts are scoped by bot. Unchanged polling retains schedule action nodes instead of replacing focused controls.

The UI intentionally has no schedule-edit workflow in this version; pause/delete and create a new schedule explicitly when the definition changes.

## Telegram

Readiness uses only the documented safe fields in `GET /api/status` → `channels.telegram`: enabled/configured, mode, bound bot, online/status, last seen, safe last error and delivery-state counts. It never serializes arbitrary configuration. No token input, connection action, test-message send, channel binding change, or external request is made by the dashboard.

The setup notes direct the operator to `docs/telegram-channel.md` for configuring the dedicated outer-host channel process. Configuration, active polling and confirmed delivery remain distinct states.

## Verified in this executor

On 2026-10-12:

- `node --check web/app.js` passed.
- `node --test web/dashboard.test.cjs`: 34 tests passed, zero failures or skips. Nineteen pre-existing controller tests remain passing; fifteen management checks cover policy defaults and conflicts, stop confirmation/retry/pending state, profile restrictions, read failures, cancellation/late-response fences, schedule validation/creation/retries/actions/history, retained drafts, unchanged polling nodes, and read-only token-free Telegram status.
- `git diff --check -- web` passed.

These tests use a minimal deterministic DOM and mocked API with no sockets. They prove controller/request behavior, not visual rendering or live backend integrations.

## Not run and manual acceptance

The subsequent macOS closeout inspected Safari desktop rendering/navigation and sample Bot creation, Environment/default-deny/not-live-verified/disabled-Telegram facts, and Schedules showing finished once tasks and paused `Asia/Shanghai` cron entries. Those schedule records were exercised through a separate loopback API smoke; schedule form submission, all management actions, mobile viewport, screen-reader and cross-browser behavior were not fully reviewed. No real service stop, policy grant, Telegram connection or external model was enabled.

Before relying on the management views, use the normal authorized deployment acceptance workflow to inspect desktop and narrow-screen layouts, keyboard tab order and live announcements; exercise slow responses while changing bots/views; verify policy conflicts from two browser sessions; stop a disposable service environment and inspect its actual processes; test an explicitly approved package/fetch; then run a disposable once/cron schedule. Telegram live delivery needs its own explicitly configured test channel. Confirm real backend state and delivered results before calling any of those live stages passed.
