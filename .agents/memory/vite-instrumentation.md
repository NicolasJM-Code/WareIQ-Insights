---
name: Vite instrumentation compatibility
description: Development metadata injection incompatibility with explicit JSX type arguments.
---

The development cartographer plugin can inject attributes before explicit JSX generic arguments, producing invalid JSX even though TypeScript checks pass.

**Why:** WareIQ startup failed on generic report components because the transformed markup placed metadata between the component name and its type argument. Removing the optional instrumentation restored rendering.

**How to apply:** If Vite reports JSX parse failures containing injected data-replit-metadata attributes, inspect the transformed error before changing valid source types. Keep optional instrumentation disabled when it cannot parse the application's JSX.
