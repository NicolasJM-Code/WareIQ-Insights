---
name: Notification page cursors
description: Precision and ordering requirements for PostgreSQL keyset cursors
---

PostgreSQL keyset cursors over timestamps should preserve the exact database timestamp text and pair it with a stable unique tie-breaker such as the row ID. Use an exclusive composite comparison matching the sort order.

**Why:** Converting a PostgreSQL timestamp to a JavaScript `Date` loses sub-millisecond precision. Reconstructing a cursor from that `Date` can move the boundary and skip rows that share a timestamp at database precision.

**How to apply:** When adding or changing cursor pagination over PostgreSQL timestamps, return an exact timestamp representation from SQL for the opaque cursor, keep the display timestamp separate, and include a deterministic unique tie-breaker in both ordering and the cursor predicate.
