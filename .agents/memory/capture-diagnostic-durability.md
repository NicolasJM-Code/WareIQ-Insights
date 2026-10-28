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
key, and reject out-of-order local completions. Do not describe this as a
cross-process or restart durability guarantee.
