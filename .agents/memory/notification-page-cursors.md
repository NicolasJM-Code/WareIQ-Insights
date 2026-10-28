---
name: Notification page cursors
description: Precision and ordering requirements for PostgreSQL keyset cursors
---

PostgreSQL keyset cursors over timestamps should preserve the exact database timestamp text and pair it with a stable unique tie-breaker such as the row ID. Use an exclusive composite comparison matching the sort order.

**Why:** Converting a PostgreSQL timestamp to a JavaScript `Date` loses sub-millisecond precision. Reconstructing a cursor from that `Date` can move the boundary and skip rows that share a timestamp at database precision.

**How to apply:** When adding or changing cursor pagination over PostgreSQL timestamps, return an exact timestamp representation from SQL for the opaque cursor, keep the display timestamp separate, and include a deterministic unique tie-breaker in both ordering and the cursor predicate.

In database-backed pagination tests, make at least one page boundary split a group of rows with the same timestamp.

**Why:** Rows can be correctly sorted within tied timestamps yet still be skipped or repeated at a page boundary if the cursor's ID tie-breaker is wrong. Groups aligned to the page size miss this failure.

**How to apply:** Choose fixture group sizes that do not divide the page size, then assert the complete ordered ID list across all pages.
