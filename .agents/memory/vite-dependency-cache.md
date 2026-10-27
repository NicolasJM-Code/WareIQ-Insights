---
name: Vite dependency cache
description: Why merged dependency changes need a runtime preview check beyond typechecking and production builds
---
Treat a successful production build as insufficient evidence that the development preview uses the current dependency versions after a merge.

**Why:** A dependency merge left the preview's prebundled React DOM at an older version while Node resolved matching updated React and React DOM packages. Typechecking and production bundling passed, but the preview failed with a version mismatch.

**How to apply:** Verify the actual preview after dependency merges. If only development fails with mismatched package versions, inspect Vite's optimized dependencies before changing correct application code or downgrading packages.
