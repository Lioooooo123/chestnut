# Durable Bot schedules

Schedules are explicit user settings in the control plane. Creating a schedule is not a model tool, and a task prompt cannot grant itself permission to create or change one. Scheduled tasks use the existing task queue, worker concurrency limit, sandbox and approval boundaries. Enqueueing is not proof that a task started, succeeded, or produced an exactly-once external effect.

## Supported schedules

- `once`: an absolute epoch-millisecond `runAt` in the future. The UI must resolve a user's intended local time before submission; `timeZone` is display metadata for a once schedule. Defaults to `UTC`.
- `cron`: exactly five fields, `minute hour day-of-month month day-of-week`, and an explicit valid IANA time zone such as `Asia/Shanghai`, `America/New_York` or `UTC`.
- Numeric values, comma lists, ascending ranges, `*` and steps are accepted. Months are 1–12; weekday 0 or 7 means Sunday. Names, seconds, `@daily`, `L`, `W`, `#`, random jitter and shell commands are unsupported.
- The day-of-month and weekday fields use OR when both are restricted. A literal `*` makes that field unrestricted; a step such as `*/2` is a restriction. Month always applies.
- The task prompt follows the existing 1–32,000 character limit; name is 1–80 characters. Cron is at most 128 characters. Nonnegative Unix timestamps through year 9990 are accepted.
- Invalid/impossible expressions are rejected before saving. Searching the next occurrence is bounded to eight years, including a February 29 schedule over a non-leap century. The implementation jumps over civil days and tests allowed wall times, not every missed minute.

The runtime uses Node's bundled ICU/IANA time-zone database. Updating Node can update future civil-time interpretations. Persisted `nextRunAt` remains the next planned instant until a fire, edit or resume recomputes it.

## Explicit time and overlap policy

| Situation | Behavior |
| --- | --- |
| Normal run | Store the UTC instant in `nextRunAt`, enqueue at or after it. Cron precision is one minute; worker wake cadence adds normal dispatch delay. |
| Worker downtime / late tick | Coalesce all overdue cron occurrences into at most **one** task for the earliest outstanding instant. The fire records `scheduledAt`, actual `observedAt`, and `coalesced=true` when further occurrences were discarded. Advance directly to the next instant after the observation time. |
| Prior task queued/running/cancelling | Record `skipped_overlap` and advance. Never queue a second outstanding task from that same schedule. No retry of the skipped occurrence. Separate schedules may each have one outstanding task. |
| Failed, cancelled or interrupted prior task | Terminal task permits the next normally scheduled occurrence. The prior task itself is never replayed. Existing quarantines still control whether workers can start any new task. |
| DST spring gap | Skip nonexistent local minutes entirely. For example, New York 02:30 is absent on the spring transition date. |
| DST fall fold | A repeated local minute fires only at its **first** UTC instant. At the fall transition an every-minute cron skips the repeated hour; it resumes at the next new wall-clock minute. Includes half-hour transitions. |
| Paused cron | No fire, no next-run timestamp. Resume computes the next occurrence strictly after resume time, discarding the paused interval. |
| Paused once | Resume retains its original absolute run time. Explicitly resuming an overdue once makes it eligible on the next tick. |
| Pause/delete after admission | Stops future schedule fires. Already queued/running tasks are unchanged; cancel them using the normal task control if desired. |
| Completed once / deleted schedule | Cannot resume or edit it into an implicit re-run. Create a new schedule explicitly. |

A schedule's display state is `active`, `paused`, `completed` or `deleted`; task progress remains on the referenced task. `lastTaskId` preserves the most recently admitted task when a later occurrence is skipped. Deletion is a soft deletion: it hides the schedule from normal lists but retains its fire audit and tasks. It is not an erasure of prior prompts/results.

## Durability and limits

SQLite owns `schedules`, `schedule_fires` and optional creation-request replay records. Each fire has a unique `(scheduleId, scheduledAt)` key and a stable private UUID-shaped task request ID derived from that pair.

Within one `BEGIN IMMEDIATE` transaction, the scheduler re-reads the schedule, checks for an existing fire and outstanding task, admits the new task through the same Store idempotency primitive, writes events/outbox and the fire record, and advances `nextRunAt`. A failed transaction rolls all of these back. A restart after commit observes the advanced cursor and the durable ledger. Independent scheduler processes sharing the SQLite file cannot admit the same fire twice. This guarantees unique queue admission, not exactly-once model/tool side effects.

`Store.submitInTransaction` is an internal trusted control-plane helper. It refuses to run unless SQLite already has an active transaction. Normal task callers continue to use `Store.submit`.

Limits are 100 active-or-paused schedules per Bot, 1,000 across the database, and 100 due schedules processed per tick. Due schedules are oldest-first. A schedule generates at most one task per tick and never has more than one outstanding task. Lists return active/paused entries first, up to 1,000 total; fire history returns the latest 100 records. Completed/deleted schedules and older audit rows remain in SQLite; this first version does not promise bounded lifetime database storage or automatic retention cleanup.

## Integration interface

`new Scheduler(store)` initializes the schema. Methods accept Bot IDs and enforce Bot ownership:

- `create(botId, input, now?)`, where input is `{name,prompt,kind:'once',runAt,timeZone?}` or `{name,prompt,kind:'cron',cron,timeZone}`. Optional UUID `requestId` makes retries idempotent; reuse with different content returns 409. Replaying creation returns current schedule state.
- `get(botId,id)`, `list(botId)`, `history(botId,id)`.
- `update(botId,id,input,now?)` replaces a still-active/paused schedule definition and recomputes its next occurrence. Paused schedules remain paused. Existing tasks retain their original prompt.
- `pause(botId,id,now?)`, `resume(botId,id,now?)`, `delete(botId,id,now?)`.
- `tick(now?)` returns the newly recorded fires; call it from the trusted worker's bounded periodic loop, including while another task runs. It does no model/network work itself.
- `status(botId?,now?)` returns state counts, earliest active `nextRunAt`, due count, policy constants and limits. Worker online status is separate; a next-run timestamp does not imply an online worker.
- `nextCronRun(expression,timeZone,after)` is available for validation/preview and returns the first matching instant strictly after `after`.

All mutation methods and `tick` accept an optional synthetic clock for deterministic tests; production omits it. Control-plane API mutations should require the same existing loopback/origin defenses as task submission. Never expose these methods directly to untrusted task code.

## Verification boundary

`tests/schedules.test.ts` uses actual SQLite, store reopen/restart, fault-injected rollback, synchronized independent worker threads, Bot scope, quotas, prompt/cron validation, once and cron behavior, pause/edit/delete, long outages, and transition cases for New York, Lord Howe and Apia. The tests prove control-plane behavior, not live deployment scheduling, real-model execution, OS suspend behavior or VPS timezone database freshness.
