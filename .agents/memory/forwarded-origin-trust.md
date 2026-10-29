---
name: Forwarded-origin trust
description: The API's trust rule and deployment configuration for forwarded host and protocol headers.
---

Forwarded `X-Forwarded-Host` and `X-Forwarded-Proto` are accepted only when the socket's immediate peer matches `TRUSTED_PROXY_CIDRS`. An unset value trusts no proxy; malformed CIDR configuration fails closed during startup. Configure only the actual ingress peer networks, and ensure the ingress replaces client-supplied forwarded origin headers.

**Why:** Host/protocol consistency checks do not authenticate the source of forwarded headers. The external ingress network cannot be inferred safely from request headers.

**How to apply:** Keep the trust middleware ahead of Clerk proxying and all application routes. When deploying behind a new ingress, verify its immediate peer range and forwarded-header overwrite behavior before adding its CIDR.
