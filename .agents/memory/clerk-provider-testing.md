---
name: Clerk provider test boundaries
description: Avoid false positives when testing real Clerk token validation in development.
---

Do not equate a bare `__session` cookie with a complete signed-in development browser. Require a successful authenticated control before claiming that a transport verifies rejection of invalid credentials.

**Why:** Clerk development cookie authentication also depends on development-browser and client timestamp cookies. An incomplete cookie request can be denied even with a valid session JWT, making invalid-cookie checks falsely reassuring. A provider-signed bearer token can exercise the real cryptographic boundary without claiming browser handshake coverage.

**How to apply:** Keep provider-token checks distinct from browser sign-in/handshake checks. When adding another transport, prove a valid request works through that transport before asserting denial of altered, expired, or revoked credentials.
