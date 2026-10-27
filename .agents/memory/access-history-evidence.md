---
name: Historical access-change evidence
description: Why interrupted provider updates must remain unconfirmed without causal evidence
---

Do not reconcile an interrupted access-change attempt as successful merely because
the current provider role matches its requested role.

**Why:** PostgreSQL and Clerk cannot share an atomic transaction. A later
administrator action can produce the same current role, so a current-role read
does not establish what an earlier interrupted request actually did.

**How to apply:** Preserve the unknown historical outcome unless there is causal
evidence for that specific attempt. Show current permissions separately and
retain the warning to refresh them before retrying.

Recovery-command actor identity is a terminal operator's explicit attestation,
not an authenticated application's administrator identity. Keep these evidence
levels visibly distinct. External provider state alone supplies neither actor
identity nor a historical change timestamp.

**Why:** First-administrator bootstrap cannot require an existing administrator
session. Treating its operator declaration as verified Clerk identity would
overstate the evidence; dashboard edits bypass the application entirely.

**How to apply:** Preserve the trusted owner recovery path, label its identity
provenance honestly, and never attribute external edits to an app administrator
without independent evidence.
