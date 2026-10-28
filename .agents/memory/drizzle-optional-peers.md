---
name: Drizzle optional driver peers
description: Why database-driver peer dependencies must align across Drizzle consumers
---

Keep Drizzle's optional database-driver peer context aligned across workspace
consumers, even if an individual consumer only uses PostgreSQL.

**Why:** Adding mysql2 to the API alone made pnpm resolve two Drizzle instances.
Their branded SQL/column types were incompatible despite the same Drizzle version.
Providing the matching mysql2 development dependency to the shared DB package
aligned the peer context without changing its PostgreSQL persistence.

**How to apply:** After adding or changing a database driver, compare peer
contexts before diagnosing cross-package SQL type errors as query bugs. Keep
the shared DB's development peer version aligned with the API's runtime driver.
