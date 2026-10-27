---
name: Workspace type outputs
description: How stale TypeScript project-reference declarations affect artifact typechecks.
---

When an artifact reports missing exports from a workspace library, first run the root `pnpm run typecheck:libs` build. Artifact typechecks can read generated declaration output that is older than the library source, so the app may appear to have widespread type failures even though the workspace source already contains the exports.

**Why:** Artifact typechecks may resolve generated declarations rather than the latest library source. Editing correct application imports to work around stale output would hide the real source of the mismatch.

**How to apply:** Run this build before changing application imports or generated library files to address missing-export errors.
