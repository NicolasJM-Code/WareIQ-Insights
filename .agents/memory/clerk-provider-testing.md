---
name: Clerk provider test boundaries
description: Avoid false positives when testing real Clerk token validation in development.
---

Do not equate a bare `__session` cookie with a complete signed-in development browser. Require a successful authenticated control before claiming that a transport verifies rejection of invalid credentials.

**Why:** Clerk development cookie authentication also depends on development-browser and client timestamp cookies. An incomplete cookie request can be denied even with a valid session JWT, making invalid-cookie checks falsely reassuring. A provider-signed bearer token can exercise the real cryptographic boundary without claiming browser handshake coverage.

**How to apply:** Keep provider-token checks distinct from browser sign-in/handshake checks. When adding another transport, prove a valid request works through that transport before asserting denial of altered, expired, or revoked credentials.

## Ambiguous fixture creation

Treat a failed account-creation response without a returned ID as an unknown outcome, not proof that nothing was created. Do not automatically retry creation or guess an account to delete.

**Why:** A provider can commit account creation before a network timeout hides the response. A blind retry can create another fixture, while guessed cleanup can delete an unrelated account.

**How to apply:** Require exact generated email and private run-marker verification in the same Development instance before manual cleanup or another creation attempt. Recovery instructions must distinguish a usable journal, absent/partial persistence, and successful provider deletion followed by failed local journal removal.
