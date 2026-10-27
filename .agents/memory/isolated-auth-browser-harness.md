---
name: Isolated auth browser harness
description: Keep browser authorization checks independent from the production preview cache and report data
---
An opt-in authorization browser harness should have its own Vite dependency cache and must render only harmless protected markers instead of importing report datasets.

**Why:** The first isolated browser run fetched a stale/missing reporting module through the preview's shared optimized dependencies even while the source file existed. Separating the cache and catalog made the real browser handshake test reliable without loading report content.

**How to apply:** When changing browser authorization checks, preserve the separate optimization cache and harmless report-catalog boundary. Keep the production auth provider, hooks and guards real.
