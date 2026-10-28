---
name: Vitest subprocess boundaries
description: Account for nested Vitest startup time in offline boundary tests.
---

Vitest tests that launch multiple nested Vitest processes should set an explicit outer timeout that covers the complete subprocess sequence.

**Why:** Worker startup time varies, and several otherwise bounded child runs can exceed Vitest's default five-second test timeout even when each subprocess succeeds.

**How to apply:** When adding offline boundary checks that spawn Vitest, budget for all child launches in the enclosing test timeout; retain per-process timeouts as a separate safeguard.
