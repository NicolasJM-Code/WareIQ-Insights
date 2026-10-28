---
name: Authorization fixtures
description: Why isolated positive authorization tests need verified identity and membership query fixtures.
---

Positive role-authorization test accounts must have a verified primary email, and membership reads should return controlled records rather than throwing by default.

**Why:** A fixture that omits a verified address is treated as unassigned even when its metadata says administrator. Fixing the address alone can reveal a second false failure if the isolated membership query stub throws instead of returning an empty membership.

**How to apply:** When role assertions fail unexpectedly in isolated API regressions, first compare the account fixture with current identity prerequisites and make the mock membership state explicit. Keep unauthorized/unverified cases separately asserted; do not weaken application guards to make incomplete fixtures pass.

Use a successful serialized-response control when extending a previously denial-only fixture.

**Why:** A denial can pass with incomplete records that were never serialized. Activating that same fixture may fail response validation rather than exercise the intended authorization transition.

**How to apply:** Check that newly exposed nested records satisfy the public response contract, and assert public fields rather than expecting database-only fields to survive serialization.
