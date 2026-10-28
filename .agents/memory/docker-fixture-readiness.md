---
name: Docker fixture readiness in Replit
description: Run local container fixtures without relying on container exec or an early open port.
---

Do not assume `docker exec` is available in this Replit runtime. Also, a published port can accept TCP before the database inside the container has finished initializing. For disposable local fixtures, poll the container logs for the final database listener-ready message, then connect through its loopback-only published port.

**Why:** Docker Compose could start and clean up a MySQL container, but container exec was unavailable and the host port proxy opened before MySQL was ready.

**How to apply:** In opt-in container integration runners, use `docker logs` to confirm the actual service is listening before launching client tests. Keep host port mappings explicitly bound to `127.0.0.1`.
