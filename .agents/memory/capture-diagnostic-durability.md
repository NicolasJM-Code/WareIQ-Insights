---
name: Capture diagnostic durability
description: Limits and ordering rules for durable signed-delivery warnings during application database outages.
---

Keep delivery diagnostics scoped to the environment and pinned Clerk instance,
not the signing key. Key rotation must not erase a storage warning.

**Why:** Signing material is sensitive and changes independently of delivery
storage health. Historical delivery evidence cannot establish current provider
subscription health.

**How to apply:** Persist only bounded, allowlisted diagnostic metadata. Commit
an uncertain-attempt marker before the evidence write and guard completion by
attempt identity so delayed workers cannot replace newer diagnostics. If the
database fails before any marker can commit, durable evidence of that new
attempt is impossible in that database; return a retryable failure and describe
unavailable diagnostics honestly rather than claiming success or inventing a
subscription failure. Never infer failure from quiet role-event traffic.

Keep a same-process failure warning when a total database outage prevents the
pending marker from committing; an older durable success must not hide it.
This process-local warning does not survive an application restart.

**Why:** After storage recovers, the diagnostic row can still describe a prior
success even though a later authenticated delivery failed before any write.

**How to apply:** Preserve the original failed-attempt timestamp until a later
delivery succeeds, scope it by environment and instance rather than signing
key, and reject out-of-order local completions. Another worker's durable success
may retire the local warning only when that attempt began strictly after the
local failure completed; older success, equal timestamps, and pending attempts
do not establish recovery. Keep the original failure timestamp until then.

**Why:** A delivery that started before the failure completed may represent
overlapping work, not recovery. Comparing attempt times conservatively requires
synchronized application/database clocks; clock skew can retain warnings longer.
This is cross-worker recovery, not restart durability of an unpersisted failure.

**How to apply:** When adopting durable recovery, fence delayed local completions
as well as clearing the warning. Do not use historical evidence or a diagnostic
completion timestamp as proof that a newer attempt succeeded.

When testing process-local completion ordering, make the newer failure happen
before its pending marker commits, and test both delayed success and delayed
failure.

**Why:** A durable failed diagnostic can conceal a broken local sequence guard;
the history endpoint may still report the expected warning for the wrong reason.

**How to apply:** Use deterministic barriers and private PostgreSQL failures,
then read administrator history after each completion. A process-local warning
must remain visible even when the durable diagnostic records historical success.
