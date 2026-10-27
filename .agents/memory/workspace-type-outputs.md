---
name: Workspace type outputs
description: How stale TypeScript project-reference declarations affect artifact typechecks.
---

When an artifact reports missing exports from a workspace library, first run the root `pnpm run typecheck:libs` build. Artifact typechecks can read generated declaration output that is older than the library source, so the app may appear to have widespread type failures even though the workspace source already contains the exports.

**Why:** A library build refreshed declarations and resolved the WareIQ typecheck errors without changing app code; remaining errors were from an unrelated authorization test suite.

**How to apply:** Run this build before changing application imports or generated library files to address missing-export errors.
