# Intake integration

- `intake.mjs` now sets `subscriptionEligible=false` for explicit human requests and never routes them directly to a thread subscription. `orchestration-store.mjs` ingest must create candidates when `input.gate.strength === 'explicit'` even if a subscription exists. Recovery agent has been notified.
- `sourceMessageSuperseded` is now freshness metadata only for assessment; it must not suppress valid direct reply delivery. Its remaining intake use only protects old messages from answering current attention / injecting stale subscription context. Keep this query until a coordinated rename is applied.
- Unavailable evaluations: use `database.candidates({status:'unavailable'})` and `getTrigger(candidate.triggerId)` for a durable once-only source notice. The runner invokes `requeueExpiredEvals()` each tick; its retry exhaustion produces this status. Ack/root agent owns notice queue wiring, not this task.
