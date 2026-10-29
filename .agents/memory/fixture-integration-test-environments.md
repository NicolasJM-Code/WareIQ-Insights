---
name: Fixture integration test environments
description: Keep disposable warehouse integration tests enabled without inheriting live WMS settings.
---

Disposable warehouse integration tests need a dedicated worker environment that retains only the fixture-specific switches and connection details. Include an always-running guard assertion so a suite cannot report success after all integration assertions were skipped.

**Why:** The regular authorization worker setup intentionally deletes every `WMS_*` variable. Reusing it for fixture tests silently skips tests guarded by environment flags.

**How to apply:** When adding warehouse integration suites that rely on temporary databases, give them an explicit fixture-only allowlist and a test that verifies the fixture mode and version are active.
